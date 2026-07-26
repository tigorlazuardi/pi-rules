import { readFile } from "node:fs/promises";
import { stripFrontmatter, type ExtensionAPI, type Skill, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_RULE_SOURCES, discoverRules, loadRuleConfig, validateRuleConfigPatch } from "./discovery.js";
import type { RuleConfigPatch } from "./discovery.js";
import { extractTarget, ruleMatchesTarget, ruleMatchesToolCallEvent } from "./matching.js";
import type { PendingRule, Rule, RuleInjectionDetails } from "./types.js";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";
export const NUDGE_MESSAGE_TYPE = "pi-rules-nudge";
export const CONFIG_EVENT = "pi-rules:config";

export function emitPiRulesConfig(
  pi: Pick<ExtensionAPI, "events">,
  config: RuleConfigPatch,
): void {
  pi.events.emit(CONFIG_EVENT, config);
}

const NUDGE_CONTENT = `A successful git commit just completed. Review the committed work for a durable, repository-specific convention that future agents would otherwise miss. If one exists, create or update the smallest appropriate rule and prefer paths frontmatter when its scope is limited. Do nothing when no durable rule is warranted. Do not commit or push changes created by this nudge.`;

export function makeExtension() {
  return (pi: ExtensionAPI): void => {
    let config: RuleConfigPatch = {
      enabled: true,
      sources: DEFAULT_RULE_SOURCES,
      nudges: { afterCommit: false },
    };
    let rules: Rule[] = [];
    let pendingRuleNudge = false;
    let reportWarning = (message: string): void => {
      process.stderr.write(`${message}\n`);
    };
    const injectedRuleIds = new Set<string>();
    const injectedSkillNames = new Set<string>();
    const availableSkills = new Map<string, Skill>();
    const pendingRules = new Map<string, PendingRule>();

    const stopConfigListener = pi.events.on(CONFIG_EVENT, (value) => {
      const validation = validateRuleConfigPatch(value);
      if ("reason" in validation) {
        reportWarning(`[pi-rules] rejected ${CONFIG_EVENT}: ${validation.reason}`);
        return;
      }
      config = { ...config, ...validation.config };
      if (config.enabled === false) {
        pendingRuleNudge = false;
        pendingRules.clear();
      }
    });
    pi.on("session_shutdown", stopConfigListener);

    pi.registerMessageRenderer<RuleInjectionDetails>(CUSTOM_MESSAGE_TYPE, (message, { expanded }, theme) => {
      const details = message.details;
      const sourceLines = (details?.sources ?? ["(unknown)"]).map((source) => `↳ ${source}`).join("\n");
      const skillLines = (details?.skills ?? []).map((skill) => `↳ ${skill}`).join("\n");
      const summary = `Loaded rules:\n${sourceLines}${skillLines ? `\nLoaded skills:\n${skillLines}` : ""}`;
      if (!expanded) {
        return new Text(theme.fg("muted", summary), 0, 0);
      }

      const targetLines = details?.sources
        .map((source) => {
          const targets = details.targets[source] ?? [];
          return targets.length > 0 ? `${source} → ${targets.join(", ")}` : `${source} → unconditional`;
        })
        .join("\n");
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
      return new Text(
        `${theme.fg("accent", "Loaded rules:")}\n${theme.fg("muted", sourceLines)}\n\n${theme.fg("dim", targetLines ?? "")}\n\n${content}`,
        0,
        0,
      );
    });

    pi.registerMessageRenderer(NUDGE_MESSAGE_TYPE, (message, { expanded }, theme) => {
      const summary = "Rule nudge: review committed work";
      if (!expanded) return new Text(theme.fg("muted", summary), 0, 0);
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
      return new Text(`${theme.fg("accent", summary)}\n\n${content}`, 0, 0);
    });

    const reloadConfig = async (cwd: string): Promise<void> => {
      const result = await loadRuleConfig(cwd);
      config = {
        enabled: result.enabled,
        sources: result.sources,
        nudges: { afterCommit: result.nudgeAfterCommit },
      };
      if (result.diagnostic) {
        reportWarning(`[pi-rules] invalid config ${result.diagnostic.sourceLabel}: ${result.diagnostic.reason}`);
      }
    };

    const reloadRules = async (cwd: string): Promise<Rule[]> => {
      const discovery = await discoverRules(cwd, { sources: config.sources ?? DEFAULT_RULE_SOURCES });
      for (const diagnostic of discovery.diagnostics) {
        reportWarning(`[pi-rules] skipped ${diagnostic.sourceLabel}: ${diagnostic.reason}`);
      }
      return discovery.rules;
    };

    const createRuleInjection = async (entries: PendingRule[]) => {
      const skillBlocks = await loadSkillBlocks(entries, availableSkills, injectedSkillNames, reportWarning);
      for (const skill of skillBlocks) injectedSkillNames.add(skill.name);
      return createInjection(entries, skillBlocks);
    };

    pi.on("session_start", async (_event, ctx) => {
      reportWarning = ctx.hasUI
        ? (message) => ctx.ui.notify(message, "warning")
        : (message) => process.stderr.write(`${message}\n`);
      await reloadConfig(ctx.cwd);
      rules = config.enabled !== false ? await reloadRules(ctx.cwd) : [];
      pendingRuleNudge = false;
      injectedRuleIds.clear();
      injectedSkillNames.clear();
      availableSkills.clear();
      pendingRules.clear();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      availableSkills.clear();
      for (const skill of event.systemPromptOptions?.skills ?? []) availableSkills.set(skill.name, skill);
      if (config.enabled === false) return;
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds)
        .filter((rule) => !pendingRules.has(rule.id))
        .map((rule) => ({ rule, targets: new Set<string>() }));
      const entries = [...pendingRules.values(), ...unconditional];
      if (entries.length === 0) return;
      const injection = await createRuleInjection(entries);
      for (const entry of entries) injectedRuleIds.add(entry.rule.id);
      pendingRules.clear();
      return { message: injection };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (config.enabled === false) return;
      const target = extractTarget(event, ctx.cwd);
      if (!target) return;
      rules = await reloadRules(ctx.cwd);

      let shouldBlock = false;
      for (const rule of rules) {
        if (injectedRuleIds.has(rule.id)) continue;
        if (rule.paths && !ruleMatchesTarget(rule, target)) continue;
        if (!ruleMatchesToolCallEvent(rule, event.toolName)) continue;
        shouldBlock = true;
        const pending = pendingRules.get(rule.id);
        const isScoped = Boolean(rule.paths || rule.events);
        if (pending) {
          if (isScoped) pending.targets.add(target);
        } else {
          pendingRules.set(rule.id, { rule, targets: new Set(isScoped ? [target] : []) });
        }
      }
      if (!shouldBlock) return;

      // ponytail: Pi cannot add context before an already-issued tool call, so block once and let the model retry.
      return { block: true, reason: "Matching rules queued for injection; retry after they load." };
    });

    pi.on("tool_result", (event) => {
      if (config.enabled === false) return;
      if (config.nudges?.afterCommit && isSuccessfulGitCommit(event)) pendingRuleNudge = true;
    });

    pi.on("agent_settled", () => {
      if (!pendingRuleNudge) return;
      pendingRuleNudge = false;
      if (config.enabled === false || !config.nudges?.afterCommit) return;
      pi.sendMessage(
        { customType: NUDGE_MESSAGE_TYPE, content: NUDGE_CONTENT, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });

    pi.on("turn_end", async (_event, ctx) => {
      if (config.enabled === false) {
        pendingRules.clear();
        return;
      }
      rules = await reloadRules(ctx.cwd);
      for (const rule of freshUnconditionalRules(rules, injectedRuleIds)) {
        if (!pendingRules.has(rule.id)) pendingRules.set(rule.id, { rule, targets: new Set<string>() });
      }
      const pending = [...pendingRules.values()].sort(comparePendingRules);
      if (pending.length === 0) return;
      pi.sendMessage(await createRuleInjection(pending), { deliverAs: "steer" });
      for (const entry of pending) injectedRuleIds.add(entry.rule.id);
      pendingRules.clear();
    });

    pi.on("session_compact", async (_event, ctx) => {
      injectedRuleIds.clear();
      injectedSkillNames.clear();
      pendingRules.clear();
      await reloadConfig(ctx.cwd);
      if (config.enabled === false) {
        rules = [];
        return;
      }
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const entries = unconditional.map((rule) => ({ rule, targets: new Set<string>() }));
      pi.sendMessage(await createRuleInjection(entries));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
    });
  };
}

export function isSuccessfulGitCommit(event: ToolResultEvent): boolean {
  if (event.toolName !== "bash" || event.isError) return false;
  const command = event.input.command;
  if (typeof command !== "string") return false;
  // ponytail: recognize direct git/rtk commands; compare HEAD if alias and wrapper support becomes necessary.
  return /(?:^|(?:&&|\|\||[;\n(])\s*)(?:rtk\s+)?git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+commit(?:\s|$)/.test(command);
}

interface SkillBlock {
  name: string;
  content: string;
}

export function createInjection(entries: PendingRule[], skillBlocks: SkillBlock[] = []) {
  const sorted = [...entries].sort(comparePendingRules);
  const sources = sorted.map((entry) => entry.rule.sourceLabel);
  const targets = Object.fromEntries(sorted.map((entry) => [entry.rule.sourceLabel, [...entry.targets].sort()]));
  const ruleBody = sorted
    .map((entry) => `## Rule: ${entry.rule.sourceLabel}\n\n${entry.rule.body}`)
    .join("\n\n---\n\n");
  const skillBody = skillBlocks.map((skill) => skill.content).join("\n\n");

  return {
    customType: CUSTOM_MESSAGE_TYPE,
    content: skillBody ? `${ruleBody}\n\n---\n\n${skillBody}` : ruleBody,
    display: true,
    details: { sources, targets, skills: skillBlocks.map((skill) => skill.name) } satisfies RuleInjectionDetails,
  };
}

async function loadSkillBlocks(
  entries: PendingRule[],
  availableSkills: Map<string, Skill>,
  injectedSkillNames: Set<string>,
  reportWarning: (message: string) => void,
): Promise<SkillBlock[]> {
  const names = [...new Set(entries.flatMap((entry) => entry.rule.skills ?? []))]
    .filter((name) => !injectedSkillNames.has(name))
    .sort();
  const blocks: SkillBlock[] = [];
  for (const name of names) {
    const skill = availableSkills.get(name);
    if (!skill) {
      reportWarning(`[pi-rules] skill not found: ${name}`);
      continue;
    }
    try {
      const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
      blocks.push({
        name,
        content: `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reportWarning(`[pi-rules] failed to load skill ${name}: ${reason}`);
    }
  }
  return blocks;
}

function freshUnconditionalRules(rules: Rule[], injectedRuleIds: Set<string>): Rule[] {
  return rules.filter((rule) => !rule.paths && !rule.events && !injectedRuleIds.has(rule.id));
}

function comparePendingRules(left: PendingRule, right: PendingRule): number {
  return left.rule.sourceLabel.localeCompare(right.rule.sourceLabel);
}

export default makeExtension();
