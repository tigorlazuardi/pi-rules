import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Type from "typebox";
import Schema from "typebox/schema";
import { parseDocument } from "yaml";
import type { DiscoveryResult, Rule, RuleDiagnostic } from "./types.js";

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const RULE_SOURCE_SCHEMA = Type.Object({
  scope: Type.Union([Type.Literal("repo"), Type.Literal("user")]),
  kind: Type.Union([Type.Literal("pi"), Type.Literal("agents"), Type.Literal("claude")]),
});

export const RULE_CONFIG_SCHEMA = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  sources: Type.Array(RULE_SOURCE_SCHEMA),
  nudges: Type.Optional(Type.Object({ afterCommit: Type.Optional(Type.Boolean()) })),
});
export const RULE_CONFIG_PATCH_SCHEMA = Type.Partial(RULE_CONFIG_SCHEMA);

const RULE_CONFIG_VALIDATOR = Schema.Compile(RULE_CONFIG_SCHEMA);
const RULE_CONFIG_PATCH_VALIDATOR = Schema.Compile(RULE_CONFIG_PATCH_SCHEMA);

export type RuleSource = Type.Static<typeof RULE_SOURCE_SCHEMA>;
export type RuleConfig = Type.Static<typeof RULE_CONFIG_SCHEMA>;
export type RuleConfigPatch = Type.Static<typeof RULE_CONFIG_PATCH_SCHEMA>;

export const DEFAULT_RULE_SOURCES: RuleSource[] = [
  { scope: "repo", kind: "pi" },
  { scope: "repo", kind: "agents" },
  { scope: "repo", kind: "claude" },
  { scope: "user", kind: "pi" },
  { scope: "user", kind: "agents" },
  { scope: "user", kind: "claude" },
];

interface RuleRoot {
  directory: string;
  label: string;
}

interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  sources?: RuleSource[];
}

export interface RuleConfigResult {
  enabled: boolean;
  sources: RuleSource[];
  nudgeAfterCommit: boolean;
  configPath?: string;
  diagnostic?: RuleDiagnostic;
}

type ParseResult = { rule: Rule } | { diagnostic: RuleDiagnostic };

export function validateRuleConfigPatch(value: unknown): { config: RuleConfigPatch } | { reason: string } {
  if (RULE_CONFIG_PATCH_VALIDATOR.Check(value)) return { config: value };
  const [, errors] = RULE_CONFIG_PATCH_VALIDATOR.Errors(value);
  const first = errors[0];
  return { reason: first ? `${first.instancePath || "/"}: ${first.message}` : "schema validation failed" };
}

export async function loadRuleConfig(cwd: string, options: DiscoveryOptions = {}): Promise<RuleConfigResult> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const piCodingAgentDirectory = resolvePiCodingAgentDirectory(env, home);
  const candidates = [path.join(cwd, ".pi", "rules.json"), path.join(piCodingAgentDirectory, "rules.json")];

  for (const configPath of candidates) {
    let content: string;
    try {
      content = await readFile(configPath, "utf8");
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT") continue;
      return invalidConfig(configPath, labelPath(configPath, cwd, home), `unreadable: ${code}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalidConfig(configPath, labelPath(configPath, cwd, home), `invalid JSON: ${message}`);
    }

    if (!RULE_CONFIG_VALIDATOR.Check(value)) {
      const [, errors] = RULE_CONFIG_VALIDATOR.Errors(value);
      const first = errors[0];
      const reason = first ? `${first.instancePath || "/"}: ${first.message}` : "schema validation failed";
      return invalidConfig(configPath, labelPath(configPath, cwd, home), reason);
    }

    return {
      enabled: value.enabled ?? true,
      sources: value.sources,
      nudgeAfterCommit: value.nudges?.afterCommit ?? false,
      configPath,
    };
  }

  return { enabled: true, sources: DEFAULT_RULE_SOURCES, nudgeAfterCommit: false };
}

export async function discoverRules(cwd: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const roots = (options.sources ?? DEFAULT_RULE_SOURCES).map((source) => resolveRuleRoot(source, cwd, env, home));

  for (const root of roots) {
    const files = await findMarkdownFiles(root.directory);
    if (files.length === 0) continue;

    const rules: Rule[] = [];
    const diagnostics: RuleDiagnostic[] = [];
    for (const relativePath of files) {
      const sourcePath = path.join(root.directory, ...relativePath.split("/"));
      const sourceLabel = `${root.label}/${relativePath}`;
      const parsed = await parseRuleFile(sourcePath, sourceLabel);
      if ("rule" in parsed) {
        rules.push(parsed.rule);
      } else {
        diagnostics.push(parsed.diagnostic);
      }
    }
    return { rules, diagnostics };
  }

  return { rules: [], diagnostics: [] };
}

export async function parseRuleFile(sourcePath: string, sourceLabel: string): Promise<ParseResult> {
  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch (error) {
    const code = getErrorCode(error);
    return { diagnostic: { sourceLabel, reason: `unreadable: ${code}` } };
  }

  const frontmatter = content.match(FRONTMATTER_RE);
  if (!frontmatter) {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(content)) {
      return { diagnostic: { sourceLabel, reason: "unclosed frontmatter" } };
    }
    return {
      rule: {
        id: sourcePath,
        sourcePath,
        sourceLabel,
        body: content.replace(/^\uFEFF/, ""),
      },
    };
  }

  let raw: unknown;
  try {
    const document = parseDocument(frontmatter[1] ?? "", { logLevel: "silent" });
    if (document.errors.length > 0) {
      return {
        diagnostic: {
          sourceLabel,
          reason: `invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
        },
      };
    }
    raw = document.toJS();
  } catch (error) {
    return {
      diagnostic: {
        sourceLabel,
        reason: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { diagnostic: { sourceLabel, reason: "frontmatter must be a mapping" } };
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const paths = normalizeStringList(record.paths, "paths");
  if (paths && "reason" in paths) {
    return { diagnostic: { sourceLabel, reason: paths.reason } };
  }
  const skills = normalizeStringList(record.skills, "skills");
  if (skills && "reason" in skills) {
    return { diagnostic: { sourceLabel, reason: skills.reason } };
  }

  const rule: Rule = {
    id: sourcePath,
    sourcePath,
    sourceLabel,
    body: content.slice(frontmatter[0].length),
  };
  if (paths) rule.paths = paths;
  if (skills) rule.skills = skills;
  return { rule };
}

async function findMarkdownFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const nested = await findMarkdownFiles(path.join(directory, entry.name));
      files.push(...nested.map((relativePath) => `${entry.name}/${relativePath}`));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entry.name);
    }
  }
  return files;
}

function resolvePiCodingAgentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return env.PI_CODING_AGENT_DIR || path.join(env.PI_CONFIG_DIR || path.join(home, ".pi"), "agent");
}

function resolveRuleRoot(source: RuleSource, cwd: string, env: NodeJS.ProcessEnv, home: string): RuleRoot {
  if (source.scope === "repo") {
    return { directory: path.join(cwd, `.${source.kind}`, "rules"), label: `.${source.kind}/rules` };
  }

  if (source.kind === "pi") {
    const directory = path.join(resolvePiCodingAgentDirectory(env, home), "rules");
    return { directory, label: labelDirectory(directory, home) };
  }
  if (source.kind === "agents") {
    return { directory: path.join(home, ".agents", "rules"), label: "~/.agents/rules" };
  }

  const directory = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "rules");
  return { directory, label: labelDirectory(directory, home) };
}

function invalidConfig(configPath: string, sourceLabel: string, reason: string): RuleConfigResult {
  return { enabled: false, sources: [], nudgeAfterCommit: false, configPath, diagnostic: { sourceLabel, reason } };
}

function labelPath(target: string, cwd: string, home: string): string {
  const relative = path.relative(cwd, target);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return labelDirectory(target, home);
}

function normalizeStringList(raw: unknown, field: "paths" | "skills"): string[] | { reason: string } | undefined {
  if (raw === undefined) return undefined;
  const values = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return { reason: `${field} must be a string or string list` };
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    const item = field === "paths" ? "glob" : "skill name";
    return { reason: `${field} must contain at least one non-empty ${item}` };
  }
  return [...new Set(normalized)];
}

function labelDirectory(directory: string, home: string): string {
  const relative = path.relative(home, directory);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return directory.split(path.sep).join("/");
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "EUNKNOWN";
}
