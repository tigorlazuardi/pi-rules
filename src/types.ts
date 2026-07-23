export interface Rule {
  id: string;
  sourcePath: string;
  sourceLabel: string;
  body: string;
  paths?: string[];
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
}

export interface PendingRule {
  rule: Rule;
  targets: Set<string>;
}
