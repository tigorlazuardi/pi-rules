# pi-rules

Claude-compatible project rules for [Pi](https://pi.dev/) agents and subagents.

## Rule locations

Rules are discovered recursively from the first non-empty directory in this order:

1. `<repo>/.pi/rules/`
2. `<repo>/.agents/rules/`
3. `<repo>/.claude/rules/`
4. `${PI_CODING_AGENT_DIR}/rules/`, or `${PI_CONFIG_DIR}/agent/rules/` when unset (default: `~/.pi/agent/rules/`)
5. `~/.agents/rules/`
6. `${CLAUDE_CONFIG_DIR}/rules/` or `~/.claude/rules/`

`PI_CODING_AGENT_DIR` points directly at the agent directory. Otherwise it resolves to `${PI_CONFIG_DIR:-~/.pi}/agent`. `AGENTS.md` remains Pi's broad project and directory context. Skills remain the place for intent-triggered guidance.

## Configuration

Configure ordered sources in `<repo>/.pi/rules.json` or `<agent-dir>/rules.json`. Project config wins without merging. Missing config uses the default order above.

```json
{
  "sources": [
    { "scope": "repo", "kind": "pi" },
    { "scope": "repo", "kind": "agents" },
    { "scope": "repo", "kind": "claude" },
    { "scope": "user", "kind": "pi" },
    { "scope": "user", "kind": "agents" },
    { "scope": "user", "kind": "claude" }
  ]
}
```

Array order controls precedence; first non-empty source wins. Remove a source to disable it, or use an empty array to disable all rules. Unknown fields are allowed. Config is TypeBox-validated at session start and compaction. Invalid JSON/schema writes a warning, injects no rules, and never crashes Pi.

## Rule format

Markdown without frontmatter is unconditional and reaches the model before its first call:

```md
Always run focused tests after changing production code.
```

Add optional `paths` frontmatter to load a rule after Pi successfully reads, edits, or writes a matching project file:

```md
---
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
---
Use strict TypeScript. Keep tests beside the behavior they verify.
```

`paths` accepts one glob string or a list. No other frontmatter fields are supported.

## Behavior

- Rules without `paths` inject eagerly once per compaction epoch.
- Path rules inject lazily once per compaction epoch after matching `read`, `edit`, or `write` results.
- Rule files reload at every injection boundary and turn end, so edits and newly added rules reach the next eligible injection.
- Parallel matches aggregate into one custom message.
- Tool output remains unchanged.
- Collapsed TUI output shows one source per line under `Loaded rules:`.
- Expanded output shows targets and full rule bodies.
- Compaction resets rule activation and immediately restores unconditional rules.

The extension follows normal Pi extension loading. Default subagents inherit globally loaded packages. A subagent configured with an empty extension list or an allowlist that excludes `pi-rules` remains clean.

## Development

```sh
npm install
npm run check
```

Tests use Node's built-in `node:test` runner.
