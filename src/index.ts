import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverRules } from "./discovery.js";
import { extractTarget, ruleMatchesTarget } from "./matching.js";
import type { PendingRule, Rule, RuleInjectionDetails } from "./types.js";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";

export function makeExtension() {
  return (pi: ExtensionAPI): void => {
    let rules: Rule[] = [];
    const injectedRuleIds = new Set<string>();
    const pendingByRule = new Map<string, PendingRule>();

    pi.registerMessageRenderer<RuleInjectionDetails>(CUSTOM_MESSAGE_TYPE, (message, { expanded }, theme) => {
      const details = message.details;
      const summary = `↳ Rules: ${details?.sources.join(", ") ?? "(unknown)"}`;
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
      return new Text(`${theme.fg("accent", summary)}\n${theme.fg("dim", targetLines ?? "")}\n\n${content}`, 0, 0);
    });

    pi.on("session_start", async (_event, ctx) => {
      const discovery = await discoverRules(ctx.cwd);
      rules = discovery.rules;
      injectedRuleIds.clear();
      pendingByRule.clear();
      for (const diagnostic of discovery.diagnostics) {
        process.stderr.write(`[pi-rules] skipped ${diagnostic.sourceLabel}: ${diagnostic.reason}\n`);
      }
    });

    pi.on("before_agent_start", () => {
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const injection = createInjection(unconditional.map((rule) => ({ rule, targets: new Set<string>() })));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
      return { message: injection };
    });

    pi.on("tool_result", (event, ctx) => {
      collectMatches(event, ctx.cwd, rules, injectedRuleIds, pendingByRule);
    });

    pi.on("turn_end", () => {
      if (pendingByRule.size === 0) return;
      const pending = [...pendingByRule.values()].sort(comparePendingRules);
      const injection = createInjection(pending);
      pi.sendMessage(injection, { deliverAs: "steer" });
      for (const entry of pending) injectedRuleIds.add(entry.rule.id);
      pendingByRule.clear();
    });

    pi.on("session_compact", () => {
      injectedRuleIds.clear();
      pendingByRule.clear();
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const entries = unconditional.map((rule) => ({ rule, targets: new Set<string>() }));
      pi.sendMessage(createInjection(entries));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
    });
  };
}

export function collectMatches(
  event: ToolResultEvent,
  cwd: string,
  rules: Rule[],
  injectedRuleIds: Set<string>,
  pendingByRule: Map<string, PendingRule>,
): void {
  const target = extractTarget(event, cwd);
  if (!target) return;

  for (const rule of rules) {
    if (!rule.paths || injectedRuleIds.has(rule.id) || !ruleMatchesTarget(rule, target)) continue;
    const existing = pendingByRule.get(rule.id);
    if (existing) {
      existing.targets.add(target);
    } else {
      pendingByRule.set(rule.id, { rule, targets: new Set([target]) });
    }
  }
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
