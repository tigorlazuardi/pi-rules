export type RuleToolName = "read" | "edit" | "write";

export interface RuleEvents {
  tool_call: RuleToolName[];
}

export interface Rule {
  id: string;
  sourcePath: string;
  sourceLabel: string;
  body: string;
  paths?: string[];
  events?: RuleEvents;
  skills?: string[];
}

export interface RuleDiagnostic {
  sourceLabel: string;
  reason: string;
}

export interface DiscoveryResult {
  rules: Rule[];
  diagnostics: RuleDiagnostic[];
}

export interface RuleInjectionDetails {
  sources: string[];
  targets: Record<string, string[]>;
  skills?: string[];
}

export interface PendingRule {
  rule: Rule;
  targets: Set<string>;
}
