import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { DiscoveryResult, Rule, RuleDiagnostic } from "./types.js";

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SUPPORTED_FIELDS = new Set(["paths"]);

interface RuleRoot {
  directory: string;
  label: string;
}

type ParseResult = { rule: Rule } | { diagnostic: RuleDiagnostic };

export async function discoverRules(cwd: string): Promise<DiscoveryResult> {
  const roots: RuleRoot[] = [
    { directory: path.join(cwd, ".agents", "rules"), label: ".agents/rules" },
    { directory: path.join(cwd, ".claude", "rules"), label: ".claude/rules" },
  ];
  const rules: Rule[] = [];
  const diagnostics: RuleDiagnostic[] = [];

  for (const root of roots) {
    const files = await findMarkdownFiles(root.directory);
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
  }

  return { rules, diagnostics };
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

  const document = parseDocument(frontmatter[1] ?? "", { logLevel: "silent" });
  if (document.errors.length > 0) {
    return {
      diagnostic: {
        sourceLabel,
        reason: `invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
      },
    };
  }

  const raw = document.toJS();
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { diagnostic: { sourceLabel, reason: "frontmatter must be a mapping" } };
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((field) => !SUPPORTED_FIELDS.has(field));
  if (unsupported.length > 0) {
    return {
      diagnostic: {
        sourceLabel,
        reason: `unsupported frontmatter field${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
      },
    };
  }

  const paths = normalizePaths(record.paths);
  if (paths && "reason" in paths) {
    return { diagnostic: { sourceLabel, reason: paths.reason } };
  }

  const rule: Rule = {
    id: sourcePath,
    sourcePath,
    sourceLabel,
    body: content.slice(frontmatter[0].length),
  };
  if (paths) {
    rule.paths = paths;
  }
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

function normalizePaths(raw: unknown): string[] | { reason: string } | undefined {
  if (raw === undefined) return undefined;
  const values = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return { reason: "paths must be a string or string list" };
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    return { reason: "paths must contain at least one non-empty glob" };
  }
  return normalized;
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "EUNKNOWN";
}
