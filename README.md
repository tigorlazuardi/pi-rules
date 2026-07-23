# pi-rules

Claude-compatible project rules for [Pi](https://pi.dev/) agents and subagents.

## Rule locations

Rules are discovered recursively from the current project:

- `.agents/rules/**/*.md`
- `.claude/rules/**/*.md`

`AGENTS.md` remains Pi's broad project and directory context. Skills remain the place for intent-triggered guidance.

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

- Unconditional rules inject eagerly once per compaction epoch.
- Path rules inject lazily after matching `read`, `edit`, or `write` results.
- Parallel matches aggregate into one custom message.
- Tool output remains unchanged.
- Collapsed TUI output shows only source filenames: `↳ Rules: .agents/rules/typescript.md`.
- Expanded output shows targets and full rule bodies.
- Compaction resets rule activation and immediately restores unconditional rules.

The extension follows normal Pi extension loading. Default subagents inherit globally loaded packages. A subagent configured with an empty extension list or an allowlist that excludes `pi-rules` remains clean.

## Development

```sh
npm install
npm run check
```

Tests use Node's built-in `node:test` runner.
