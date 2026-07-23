import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_RULE_SOURCES, discoverRules, loadRuleConfig } from "./discovery.js";
import type { RuleSource } from "./discovery.js";
import { extractTarget, ruleMatchesTarget } from "./matching.js";
import type { PendingRule, Rule, RuleInjectionDetails } from "./types.js";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";

export function makeExtension() {
  return (pi: ExtensionAPI): void => {
    let rules: Rule[] = [];
    let sources: RuleSource[] = DEFAULT_RULE_SOURCES;
    const injectedRuleIds = new Set<string>();
    const turnTargets = new Set<string>();

    pi.registerMessageRenderer<RuleInjectionDetails>(CUSTOM_MESSAGE_TYPE, (message, { expanded }, theme) => {
      const details = message.details;
      const sourceLines = (details?.sources ?? ["(unknown)"]).map((source) => `↳ ${source}`).join("\n");
      const summary = `Loaded rules:\n${sourceLines}`;
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

    const reloadConfig = async (cwd: string): Promise<void> => {
      const result = await loadRuleConfig(cwd);
      sources = result.sources;
      if (result.diagnostic) {
        process.stderr.write(`[pi-rules] invalid config ${result.diagnostic.sourceLabel}: ${result.diagnostic.reason}\n`);
      }
    };

    const reloadRules = async (cwd: string): Promise<Rule[]> => {
      const discovery = await discoverRules(cwd, { sources });
      for (const diagnostic of discovery.diagnostics) {
        process.stderr.write(`[pi-rules] skipped ${diagnostic.sourceLabel}: ${diagnostic.reason}\n`);
      }
      return discovery.rules;
    };

    pi.on("session_start", async (_event, ctx) => {
      await reloadConfig(ctx.cwd);
      rules = await reloadRules(ctx.cwd);
      injectedRuleIds.clear();
      turnTargets.clear();
    });

    pi.on("before_agent_start", async (_event, ctx) => {
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const injection = createInjection(unconditional.map((rule) => ({ rule, targets: new Set<string>() })));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
      return { message: injection };
    });

    pi.on("tool_result", (event, ctx) => {
      const target = extractTarget(event, ctx.cwd);
      if (target) turnTargets.add(target);
    });

    pi.on("turn_end", async (_event, ctx) => {
      rules = await reloadRules(ctx.cwd);
      const pending = rules
        .flatMap((rule) => {
          if (injectedRuleIds.has(rule.id)) return [];
          if (!rule.paths) return [{ rule, targets: new Set<string>() }];
          const targets = new Set([...turnTargets].filter((target) => ruleMatchesTarget(rule, target)));
          return targets.size > 0 ? [{ rule, targets }] : [];
        })
        .sort(comparePendingRules);
      turnTargets.clear();
      if (pending.length === 0) return;
      pi.sendMessage(createInjection(pending), { deliverAs: "steer" });
      for (const entry of pending) injectedRuleIds.add(entry.rule.id);
    });

    pi.on("session_compact", async (_event, ctx) => {
      injectedRuleIds.clear();
      turnTargets.clear();
      await reloadConfig(ctx.cwd);
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const entries = unconditional.map((rule) => ({ rule, targets: new Set<string>() }));
      pi.sendMessage(createInjection(entries));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
    });
  };
}

export function createInjection(entries: PendingRule[]) {
  const sorted = [...entries].sort(comparePendingRules);
  const sources = sorted.map((entry) => entry.rule.sourceLabel);
  const targets = Object.fromEntries(sorted.map((entry) => [entry.rule.sourceLabel, [...entry.targets].sort()]));
  const body = sorted
    .map((entry) => `## Rule: ${entry.rule.sourceLabel}\n\n${entry.rule.body}`)
    .join("\n\n---\n\n");

  return {
    customType: CUSTOM_MESSAGE_TYPE,
    content: body,
    display: true,
    details: { sources, targets } satisfies RuleInjectionDetails,
  };
}

function freshUnconditionalRules(rules: Rule[], injectedRuleIds: Set<string>): Rule[] {
  return rules.filter((rule) => !rule.paths && !injectedRuleIds.has(rule.id));
}

function comparePendingRules(left: PendingRule, right: PendingRule): number {
  return left.rule.sourceLabel.localeCompare(right.rule.sourceLabel);
}

export default makeExtension();
