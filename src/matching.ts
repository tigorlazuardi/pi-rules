import path from "node:path";
import picomatch from "picomatch";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Rule } from "./types.js";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

export function extractTarget(event: ToolCallEvent | ToolResultEvent, cwd: string): string | undefined {
  if (("isError" in event && event.isError) || !FILE_TOOLS.has(event.toolName)) return undefined;
  const rawPath = (event.input as { path?: unknown }).path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return undefined;

  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const absolutePath = path.resolve(cwd, withoutAt);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return toPosixPath(relativePath);
}

export function ruleMatchesTarget(rule: Rule, target: string): boolean {
  if (!rule.paths) return false;
  const patterns = rule.paths.map(normalizePattern);
  return picomatch.isMatch(target, patterns, { dot: true });
}

function normalizePattern(pattern: string): string {
  return toPosixPath(pattern).replace(/^\.\//, "");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
