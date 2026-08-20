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

Try without installing:

```sh
pi -e npm:@tigorhutasuhut/pi-rules
```

Pin, update, or remove the package:

```sh
pi install npm:@tigorhutasuhut/pi-rules@0.5.2
pi update npm:@tigorhutasuhut/pi-rules
pi remove npm:@tigorhutasuhut/pi-rules
```

Versioned installs stay pinned during `pi update --extensions` and `pi update --all`. Use the unversioned install command again to resume package updates.

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

Path-scoped rules activate around matching project-file reads, edits, and writes. Reads execute normally, then the rule enters model context before Pi processes the result. Edits and writes pause before execution so the rule can load; the agent then retries the mutation. Globs are repository-relative, use `/` separators, and match dotfiles.

`paths` accepts one glob string or a list:

```md
---
paths: "docs/**/*.md"
---
Use concise headings and relative links.
```

### Choose activation tools

Use non-standard `events` frontmatter to limit activation to selected tools:

```md
---
paths: "docs/**/*.md"
events:
  tool_call: read
---
Apply this guidance before reading documentation.
```

This rule activates after matching `read` calls, but not for `edit` or `write`. `events` keys are Pi event names; `tool_call` values filter its `toolName` payload. It accepts one of `read`, `edit`, or `write`, or a list. Omitting `events` preserves the default: all three tools. A rule with `events` but no `paths` applies to every project-local file target for the selected calls.

Only the blockable `tool_call` Pi event is supported. Unsupported event or tool names skip the rule with a warning.

### Load skills with a rule

Use non-standard `skills` frontmatter to force-load full Pi skills when the rule activates:

```md
---
paths: "src/frontend/**"
skills:
  - frontend-design
  - ui-spacing
---
Follow the linked frontend workflows.
```

`skills` accepts one skill name or a list. Names resolve against Pi's discovered skill registry, so normal project trust, configured skill paths, collision handling, and `--no-skills` still apply. A linked skill loads even when its own frontmatter sets `disable-model-invocation: true`; the rule link acts as explicit invocation. Missing or unreadable skills emit a warning without blocking the rule.

Rules and linked skills each inject once per compaction epoch. Unconditional rules load their skills before the first model call; scoped rules block the first matching `tool_call`, load their skills, then allow retries.

`paths`, `events`, and `skills` frontmatter are supported. Markdown without frontmatter is unconditional.

## Rule discovery

Rules are read recursively from every configured source in priority order:

1. `<repo>/.pi/rules/`
2. `<repo>/.agents/rules/`
3. `<repo>/.claude/rules/`
4. `${PI_CODING_AGENT_DIR}/rules/`, or `${PI_CONFIG_DIR}/agent/rules/` when unset
5. `~/.agents/rules/`
6. `${CLAUDE_CONFIG_DIR}/rules/`, or `~/.claude/rules/` when unset

Default Pi user rules live in `~/.pi/agent/rules/`.

Rules from all sources are merged. The filename stem is the rule name: both `backend/auth.md` and `auth.md` are named `auth`. The first source containing a name wins; later rules with that name are skipped. Files are sorted within each source, so the first same-name file there wins too. Symlinked files and directories are followed with the same precedence; directory cycles are skipped.

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

Array order controls duplicate-name precedence. Remove a source to exclude it. Use an empty array to disable all rule discovery:

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

Pi 0.80.10 and newer use the `typebox` package name for extension schemas. Import from `typebox` and `typebox/schema`; do not use the old `@sinclair/typebox` package name. Packages that deep-import `typebox/schema` should keep `typebox` as a runtime dependency so package loaders resolve the matching subpath implementation.

## Runtime behavior

- Unconditional rules and their linked skills inject once per compaction epoch before the first model call.
- Scoped rules and their linked skills inject once per compaction epoch around matching `read`, `edit`, or `write` calls. Reads execute first and continue without retry; edits and writes pause before execution and ask the agent to retry after injection. `events.tool_call` can limit activation.
- Rule files are rediscovered before governed tool calls and at turn end, so new rules and edits to not-yet-loaded rules reach the next eligible injection. Already-loaded rules refresh after compaction.
- Parallel path matches are combined into one message; duplicate linked skills are injected once.
- Tool results are never modified.
- Collapsed messages list loaded rule sources; expanded messages show matched targets and full rule bodies.
- Compaction resets activation and immediately restores unconditional rules.
- Each loaded session maintains independent rule activation and nudge state.
- Opt-in commit nudges wait for `agent_settled`, avoiding interruption of remaining tools or queued follow-ups.

Package inheritance and extension allowlists determine which Pi sessions load these rules.

## Choosing between rules, AGENTS.md, and skills

- Use **rules** for always-on or file-scoped repository constraints.
- Use **`AGENTS.md`** for broad project and directory context Pi should discover natively.
- Use standalone **skills** for guidance loaded by task intent. Link them from rule `skills` frontmatter when file access must force activation.

## Troubleshooting

### Rules do not load

1. Confirm package is enabled with `pi list` or `pi config`.
2. Run `/reload` after installation or configuration changes.
3. Check whether a higher-priority source contains the same rule filename stem.
4. Read stderr for `[pi-rules] invalid config` or `[pi-rules] skipped` warnings.

### Path rule does not activate

- Make glob repository-relative: `src/**/*.ts`, not an absolute path.
- Confirm Pi attempted `read`, `edit`, or `write` on a matching file and that `events.tool_call`, when present, includes that tool name. Matching reads should execute and then inject the rule; matching edits or writes should pause, inject, then retry.
- Files outside current repository do not activate project rules.
- Rule already loaded in current compaction epoch will not load again until compaction.

### A Claude rule is missing

A higher-priority source contains the same rule filename stem. Rename one rule or change source priority in `.pi/rules.json`. Unique Claude rules merge normally.

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
