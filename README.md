# pi-rules

Claude-compatible, file-scoped project rules for [Pi](https://pi.dev/) agents and subagents.

Use Markdown files to give Pi durable instructions for an entire repository or only for matching files. Existing `.claude/rules/` and `.agents/rules/` directories can work without duplication.

## Install

```sh
pi install npm:@tigorhutasuhut/pi-rules
```

For one project only:

```sh
pi install -l npm:@tigorhutasuhut/pi-rules
```

Already running Pi? Use `/reload` after installation.

## Quick start

Create `.pi/rules/project.md` in your repository:

```md
Run focused tests after changing production code.
Never commit secrets or generated build output.
```

Start or reload Pi. Rules without `paths` frontmatter load before the model's first call:

```text
Loaded rules:
↳ .pi/rules/project.md
```

### Scope a rule to files

Add `paths` frontmatter when guidance only applies to part of the repository:

```md
---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
Use strict TypeScript.
Keep tests close to the behavior they verify.
```

Path-scoped rules activate after Pi successfully reads, edits, or writes a matching project file. Globs are repository-relative, use `/` separators, and match dotfiles.

`paths` accepts one glob string or a list:

```md
---
paths: "docs/**/*.md"
---
Use concise headings and relative links.
```

Only `paths` frontmatter is supported. Markdown without frontmatter is unconditional.

## Rule discovery

Rules are read recursively from the **first non-empty directory** in this order:

1. `<repo>/.pi/rules/`
2. `<repo>/.agents/rules/`
3. `<repo>/.claude/rules/`
4. `${PI_CODING_AGENT_DIR}/rules/`, or `${PI_CONFIG_DIR}/agent/rules/` when unset
5. `~/.agents/rules/`
6. `${CLAUDE_CONFIG_DIR}/rules/`, or `~/.claude/rules/` when unset

Default Pi user rules live in `~/.pi/agent/rules/`.

Sources are fallbacks, not merged layers. For example, when `.pi/rules/` contains any Markdown file, `.agents/rules/`, `.claude/rules/`, and user sources are ignored. Files inside the selected directory are sorted and loaded together. Symlinks are ignored.

`PI_CODING_AGENT_DIR` points directly to Pi's agent directory. When unset, the directory resolves to `${PI_CONFIG_DIR:-~/.pi}/agent`.

## Configure source priority

Configuration can live at either level:

| Level | Path |
| --- | --- |
| Repository | `<repo>/.pi/rules.json` |
| User | `${PI_CODING_AGENT_DIR}/rules.json`, or `${PI_CONFIG_DIR:-~/.pi}/agent/rules.json` when unset |

Repository configuration wins whenever `<repo>/.pi/rules.json` exists. Configurations are not merged, and an invalid repository configuration does not fall back to user configuration.

```json
{
  "enabled": true,
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

Array order controls precedence. Remove a source to disable that fallback. Use an empty array to disable all rule discovery:

```json
{ "sources": [] }
```

Supported values:

| Field | Values |
| --- | --- |
| `scope` | `repo`, `user` |
| `kind` | `pi`, `agents`, `claude` |

`enabled` defaults to `true`. When `false`, rule and nudge injections are skipped. Unknown configuration fields are allowed. Invalid JSON or invalid configuration values emit a warning, inject no rules, and do not crash Pi. File configuration reloads at session start and after compaction.

## Commit nudges

Commit nudges are opt-in. Enable them in project or user `rules.json`:

```json
{
  "sources": [
    { "scope": "repo", "kind": "pi" },
    { "scope": "repo", "kind": "agents" },
    { "scope": "repo", "kind": "claude" },
    { "scope": "user", "kind": "pi" },
    { "scope": "user", "kind": "agents" },
    { "scope": "user", "kind": "claude" }
  ],
  "nudges": {
    "afterCommit": true
  }
}
```

After a successful direct `git commit` or `rtk git commit` command settles, Pi reviews the committed work for a durable repository-specific convention. It creates or updates the smallest appropriate rule only when one is warranted. Nudge-created changes are never committed or pushed automatically.

Nudges are disabled by default. `pi-rules` does not infer session roles.

## Runtime configuration

Other extensions can shallow-merge any configuration field into the current runtime through `pi-rules:config`:

```ts
import { emitPiRulesConfig } from "@tigorhutasuhut/pi-rules";

pi.on("session_start", () => {
  emitPiRulesConfig(pi, { enabled: false });
});
```

Partial patches are accepted. Top-level fields use shallow-copy semantics, so a supplied `nudges` object replaces the previous `nudges` object:

```ts
emitPiRulesConfig(pi, {
  sources: [{ scope: "repo", kind: "claude" }],
  nudges: { afterCommit: false }
});
```

The event bus is already scoped to the current Pi runtime, so no `ExtensionContext` needs to cross extension boundaries. Raw emitters may call `pi.events.emit("pi-rules:config", patch)`. Updates that fail the TypeBox configuration schema are rejected and shown through Pi's warning notification, or stderr when no UI exists. Patches apply immediately; emitters own event timing.

## Runtime behavior

- Unconditional rules inject once per compaction epoch before the first model call.
- Path-scoped rules inject once per compaction epoch after a successful matching `read`, `edit`, or `write`.
- Rule files are rediscovered at injection boundaries and turn end, so new rules and edits to not-yet-loaded rules reach the next eligible injection. Already-loaded rules refresh after compaction.
- Parallel path matches are combined into one message.
- Tool results are never modified.
- Collapsed messages list loaded rule sources; expanded messages show matched targets and full rule bodies.
- Compaction resets activation and immediately restores unconditional rules.
- Each loaded session maintains independent rule activation and nudge state.
- Opt-in commit nudges wait for `agent_settled`, avoiding interruption of remaining tools or queued follow-ups.

Package inheritance and extension allowlists determine which Pi sessions load these rules.

## Choosing between rules, AGENTS.md, and skills

- Use **rules** for always-on or file-scoped repository constraints.
- Use **`AGENTS.md`** for broad project and directory context Pi should discover natively.
- Use **skills** for guidance loaded by task intent rather than file access.

## Troubleshooting

### Rules do not load

1. Confirm package is enabled with `pi list` or `pi config`.
2. Run `/reload` after installation or configuration changes.
3. Check whether an earlier non-empty source directory is winning.
4. Read stderr for `[pi-rules] invalid config` or `[pi-rules] skipped` warnings.

### Path rule does not activate

- Make glob repository-relative: `src/**/*.ts`, not an absolute path.
- Confirm Pi successfully used `read`, `edit`, or `write` on matching file.
- Files outside current repository do not activate project rules.
- Rule already loaded in current compaction epoch will not load again until compaction.

### Claude rules are ignored

An earlier `.pi/rules/` or `.agents/rules/` directory contains Markdown. Remove it or change source priority in `.pi/rules.json`.

## Development

Requires Node.js 20.6 or newer.

```sh
npm install
npm run check
npm pack --dry-run
```

Tests use Node's built-in `node:test` runner.

## License

[MIT](LICENSE)
