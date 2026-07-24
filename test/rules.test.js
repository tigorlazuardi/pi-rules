import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRules, loadRuleConfig, parseRuleFile } from "../dist/discovery.js";
import extension, {
  CUSTOM_MESSAGE_TYPE,
  CONFIG_EVENT,
  NUDGE_MESSAGE_TYPE,
  emitPiRulesConfig,
  isSuccessfulGitCommit,
} from "../dist/index.js";
import { extractTarget, ruleMatchesTarget } from "../dist/matching.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-rules-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRule(cwd, relativePath, content) {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function createFakePi() {
  const handlers = new Map();
  const customHandlers = new Map();
  const renderers = new Map();
  const sent = [];
  return {
    api: {
      events: {
        on(event, handler) {
          const eventHandlers = customHandlers.get(event) ?? [];
          eventHandlers.push(handler);
          customHandlers.set(event, eventHandlers);
          return () => customHandlers.set(event, eventHandlers.filter((candidate) => candidate !== handler));
        },
        emit(event, value) {
          for (const handler of customHandlers.get(event) ?? []) handler(value);
        },
      },
      on(event, handler) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerMessageRenderer(customType, renderer) {
        renderers.set(customType, renderer);
      },
      sendMessage(message, options) {
        sent.push({ message, options });
      },
    },
    handlers,
    renderers,
    sent,
    async emit(event, value, ctx = {}) {
      let result;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(value, ctx);
      }
      return result;
    },
  };
}

function toolResult(toolName, filePath, overrides = {}) {
  return {
    type: "tool_result",
    toolName,
    toolCallId: `${toolName}-1`,
    input: { path: filePath },
    content: [{ type: "text", text: "original output" }],
    details: { untouched: true },
    isError: false,
    ...overrides,
  };
}

function bashResult(command, overrides = {}) {
  return toolResult("bash", undefined, { input: { command }, ...overrides });
}

test("uses first non-empty rule root and sorts nested files", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/z.md", "Always Z");
    await writeRule(cwd, ".pi/rules/backend/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    await writeRule(cwd, ".agents/rules/a.md", "Ignored agents fallback");
    await writeRule(cwd, ".claude/rules/a.md", "Ignored Claude fallback");
    await writeRule(cwd, ".pi/rules/ignored.txt", "not markdown");

    const result = await discoverRules(cwd);

    assert.deepEqual(result.rules.map((rule) => rule.sourceLabel), [".pi/rules/backend/auth.md", ".pi/rules/z.md"]);
    assert.deepEqual(result.rules[0].paths, ["src/auth/**"]);
    assert.equal(result.rules[0].body, "Auth rule");
    assert.equal(result.rules[1].paths, undefined);
    assert.equal(result.diagnostics.length, 0);
  });
});

test("falls back through configured global rule roots", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    const piConfig = path.join(root, "pi-config");
    const codingAgent = path.join(root, "coding-agent");
    await mkdir(cwd, { recursive: true });
    await writeRule(root, "pi-config/agent/rules/pi.md", "PI config rule");
    await writeRule(root, "coding-agent/rules/agent.md", "Coding agent rule");
    await writeRule(root, "home/.claude/rules/claude.md", "Claude rule");
    await writeRule(root, "home/.agents/rules/agents.md", "Agents rule");

    const configured = await discoverRules(cwd, {
      home,
      env: { PI_CONFIG_DIR: piConfig, PI_CODING_AGENT_DIR: codingAgent },
    });
    const piConfigOnly = await discoverRules(cwd, { home, env: { PI_CONFIG_DIR: piConfig } });
    const codingAgentOnly = await discoverRules(cwd, { home, env: { PI_CODING_AGENT_DIR: codingAgent } });
    const agentsFallback = await discoverRules(cwd, { home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
    await rm(path.join(home, ".agents"), { recursive: true, force: true });
    const claudeFallback = await discoverRules(cwd, { home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
    await writeRule(root, "home/.pi/agent/rules/default-agent.md", "Default coding agent rule");
    const defaultCodingAgent = await discoverRules(cwd, { home, env: {} });

    assert.deepEqual(configured.rules.map((rule) => rule.body), ["Coding agent rule"]);
    assert.deepEqual(piConfigOnly.rules.map((rule) => rule.body), ["PI config rule"]);
    assert.deepEqual(codingAgentOnly.rules.map((rule) => rule.body), ["Coding agent rule"]);
    assert.deepEqual(agentsFallback.rules.map((rule) => rule.body), ["Agents rule"]);
    assert.deepEqual(claudeFallback.rules.map((rule) => rule.body), ["Claude rule"]);
    assert.deepEqual(defaultCodingAgent.rules.map((rule) => rule.body), ["Default coding agent rule"]);
  });
});

test("project config controls source order and reloads on compaction", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(
      cwd,
      ".pi/rules.json",
      JSON.stringify({ note: "extra fields are allowed", sources: [{ scope: "repo", kind: "claude", extra: true }] }),
    );
    await writeRule(cwd, ".pi/rules/pi.md", "PI rule");
    await writeRule(cwd, ".claude/rules/claude.md", "Claude rule");
    const fake = createFakePi();
    extension(fake.api);

    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const first = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(first.message.content, /Claude rule/);
    assert.doesNotMatch(first.message.content, /PI rule/);

    await writeRule(cwd, ".pi/rules.json", JSON.stringify({ version: 1, sources: [{ scope: "repo", kind: "pi" }] }));
    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.match(fake.sent[0].message.content, /PI rule/);
  });
});

test("loads user config from resolved Pi coding-agent directory", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    const piConfig = path.join(root, "pi-config");
    await mkdir(cwd, { recursive: true });
    await writeRule(
      root,
      "pi-config/agent/rules.json",
      JSON.stringify({
        version: 1,
        enabled: false,
        sources: [{ scope: "user", kind: "agents" }],
        nudges: { afterCommit: true, future: "allowed" },
      }),
    );
    await writeRule(root, "home/.agents/rules/user.md", "User agents rule");

    const config = await loadRuleConfig(cwd, { home, env: { PI_CONFIG_DIR: piConfig } });
    const result = await discoverRules(cwd, { home, env: { PI_CONFIG_DIR: piConfig }, sources: config.sources });

    assert.equal(config.configPath, path.join(piConfig, "agent", "rules.json"));
    assert.equal(config.enabled, false);
    assert.equal(config.nudgeAfterCommit, true);
    assert.deepEqual(result.rules.map((rule) => rule.body), ["User agents rule"]);
  });
});

test("warns without crashing when config fails TypeBox validation", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules.json", JSON.stringify({ version: 1, sources: [{ scope: "repo", kind: "nope" }] }));
    await writeRule(cwd, ".pi/rules/base.md", "Must not inject");
    const fake = createFakePi();
    const warnings = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };

    try {
      extension(fake.api);
      await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
      const injection = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
      assert.equal(injection, undefined);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(warnings.join(""), /\[pi-rules\] invalid config \.pi\/rules\.json:/);
  });
});

test("accepts path and skill lists, ignores unknown fields, and diagnoses malformed frontmatter", async () => {
  await withTempDirectory(async (cwd) => {
    const valid = path.join(cwd, "valid.md");
    const extra = path.join(cwd, "extra.md");
    const malformed = path.join(cwd, "malformed.md");
    await writeFile(valid, "---\npaths:\n  - src/**/*.ts\n  - tests/**\nskills:\n  - tdd\n  - code-review\n---\nTyped", "utf8");
    await writeFile(extra, "---\ndescription: old schema\nalwaysApply: true\n---\nOld", "utf8");
    await writeFile(malformed, "---\npaths: [src/**\n---\nBad", "utf8");

    const validResult = await parseRuleFile(valid, "valid.md");
    const extraResult = await parseRuleFile(extra, "extra.md");
    const malformedResult = await parseRuleFile(malformed, "malformed.md");

    assert.deepEqual(validResult.rule.paths, ["src/**/*.ts", "tests/**"]);
    assert.deepEqual(validResult.rule.skills, ["tdd", "code-review"]);
    assert.equal(extraResult.rule.body, "Old");
    assert.match(malformedResult.diagnostic.reason, /invalid YAML/);
  });
});

test("warns and skips non-string paths without blocking valid sibling rules", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/bad-object.md", "---\npaths:\n  include: src/**\n---\nBad object");
    await writeRule(cwd, ".pi/rules/bad-list.md", "---\npaths: [src/**, 42]\n---\nBad list");
    await writeRule(cwd, ".pi/rules/valid.md", "Valid sibling");
    const warnings = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message, level) => warnings.push({ message, level }) } };
    const fake = createFakePi();
    extension(fake.api);

    await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const injection = await fake.emit("before_agent_start", { type: "before_agent_start" }, ctx);

    assert.match(injection.message.content, /Valid sibling/);
    assert.doesNotMatch(injection.message.content, /Bad object|Bad list/);
    assert.equal(warnings.every(({ level }) => level === "warning"), true);
    assert.equal(warnings.some(({ message }) => /bad-object\.md: paths must be a string or string list/.test(message)), true);
    assert.equal(warnings.some(({ message }) => /bad-list\.md: paths must be a string or string list/.test(message)), true);
  });
});

test("extracts only successful project-local read/edit/write targets", () => {
  const cwd = path.resolve("/workspace/project");
  assert.equal(extractTarget(toolResult("read", "@src/a.ts"), cwd), "src/a.ts");
  assert.equal(extractTarget(toolResult("edit", "/workspace/project/src/a.ts"), cwd), "src/a.ts");
  assert.equal(extractTarget(toolResult("write", "../outside.ts"), cwd), undefined);
  assert.equal(extractTarget(toolResult("bash", "src/a.ts"), cwd), undefined);
  assert.equal(extractTarget(toolResult("read", "src/a.ts", { isError: true }), cwd), undefined);
});

test("recognizes successful direct git commit commands", () => {
  assert.equal(isSuccessfulGitCommit(bashResult("git commit -m 'feat: ship'")), true);
  assert.equal(isSuccessfulGitCommit(bashResult("rtk git commit -m 'feat: ship' && rtk git push")), true);
  assert.equal(isSuccessfulGitCommit(bashResult("cd repo && git -C nested commit --amend")), true);
  assert.equal(isSuccessfulGitCommit(bashResult("git status")), false);
  assert.equal(isSuccessfulGitCommit(bashResult("git commit -m nope", { isError: true })), false);
});

test("matches Claude-style project-relative globs including dotfiles", () => {
  const rule = {
    id: "rule",
    sourcePath: "/workspace/.agents/rules/typescript.md",
    sourceLabel: ".agents/rules/typescript.md",
    body: "Typed",
    paths: ["./src/**/*.{ts,tsx}", ".github/**"],
  };
  assert.equal(ruleMatchesTarget(rule, "src/app.tsx"), true);
  assert.equal(ruleMatchesTarget(rule, ".github/workflows/ci.yml"), true);
  assert.equal(ruleMatchesTarget(rule, "README.md"), false);
});

test("injects unconditional rules before first model call", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/base.md", "Always follow base rule.");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    const first = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const second = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });

    assert.equal(first.message.customType, CUSTOM_MESSAGE_TYPE);
    assert.equal(first.message.display, true);
    assert.match(first.message.content, /Always follow base rule\./);
    assert.deepEqual(first.message.details.sources, [".agents/rules/base.md"]);
    assert.deepEqual(first.message.details.targets, { ".agents/rules/base.md": [] });
    assert.equal(second, undefined);
  });
});

test("loads linked skills from Pi registry regardless model invocation setting", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/a.md", "---\npaths: src/a/**\nskills: [hidden-skill, missing-skill]\n---\nRule A");
    await writeRule(cwd, ".pi/rules/b.md", "---\npaths: src/b/**\nskills: hidden-skill\n---\nRule B");
    const skillPath = path.join(cwd, ".pi/skills/hidden-skill/SKILL.md");
    await writeRule(
      cwd,
      ".pi/skills/hidden-skill/SKILL.md",
      "---\nname: hidden-skill\ndescription: Hidden from model discovery\ndisable-model-invocation: true\n---\n# Hidden workflow\n\nFollow hidden steps.",
    );
    const fake = createFakePi();
    const warnings = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message) => warnings.push(message) } };
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await fake.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        systemPromptOptions: {
          skills: [{
            name: "hidden-skill",
            description: "Hidden from model discovery",
            filePath: skillPath,
            baseDir: path.dirname(skillPath),
            disableModelInvocation: true,
          }],
        },
      },
      ctx,
    );

    await fake.emit("tool_result", toolResult("read", "src/a/file.ts"), ctx);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);

    assert.match(fake.sent[0].message.content, /Rule A/);
    assert.match(fake.sent[0].message.content, /<skill name="hidden-skill"/);
    assert.match(fake.sent[0].message.content, /Follow hidden steps\./);
    assert.doesNotMatch(fake.sent[0].message.content, /disable-model-invocation/);
    assert.deepEqual(fake.sent[0].message.details.skills, ["hidden-skill"]);
    assert.equal(warnings.some((warning) => /skill not found: missing-skill/.test(warning)), true);

    await fake.emit("tool_result", toolResult("read", "src/b/file.ts"), ctx);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);
    assert.match(fake.sent[1].message.content, /Rule B/);
    assert.doesNotMatch(fake.sent[1].message.content, /<skill name=/);
    assert.deepEqual(fake.sent[1].message.details.skills, []);

    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, ctx);
    await fake.emit("tool_result", toolResult("read", "src/b/again.ts"), ctx);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);
    assert.match(fake.sent[2].message.content, /<skill name="hidden-skill"/);
  });
});

test("reads fresh rule content at each injection boundary", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base v1");
    await writeRule(cwd, ".pi/rules/scoped.md", "---\npaths: src/**\n---\nScoped v1");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await writeRule(cwd, ".pi/rules/base.md", "Base v2");
    const eager = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(eager.message.content, /Base v2/);
    assert.doesNotMatch(eager.message.content, /Base v1/);

    await fake.emit("tool_result", toolResult("read", "src/a.ts"), { cwd });
    await writeRule(cwd, ".pi/rules/scoped.md", "---\npaths: src/**\n---\nScoped v2");
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.match(fake.sent[0].message.content, /Scoped v2/);
    assert.doesNotMatch(fake.sent[0].message.content, /Scoped v1/);
  });
});

test("discovers new unconditional and matching path rules at turn end", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/seed.md", "---\npaths: never/**\n---\nSeed");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const eager = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.equal(eager, undefined);

    await writeRule(cwd, ".pi/rules/new-base.md", "New base rule");
    await writeRule(cwd, ".pi/rules/new-path.md", "---\npaths: src/**\n---\nNew path rule");
    await fake.emit("tool_result", toolResult("read", "src/new.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.deepEqual(fake.sent[0].message.details.sources, [
      ".pi/rules/new-base.md",
      ".pi/rules/new-path.md",
    ]);
    assert.match(fake.sent[0].message.content, /New base rule/);
    assert.match(fake.sent[0].message.content, /New path rule/);

    await fake.emit("tool_result", toolResult("read", "src/again.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);
  });
});

test("parallel matches aggregate once without modifying tool results", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/**/*.ts\n---\nAuth rule");
    await writeRule(cwd, ".agents/rules/typescript.md", "---\npaths: src/**\n---\nTypeScript rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    const first = toolResult("read", "src/a.ts", { toolCallId: "read-a" });
    const second = toolResult("edit", "src/b.ts", { toolCallId: "edit-b" });
    const before = structuredClone([first, second]);
    await Promise.all([
      fake.emit("tool_result", first, { cwd }),
      fake.emit("tool_result", second, { cwd }),
    ]);

    assert.deepEqual([first, second], before);
    assert.equal(fake.sent.length, 0);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0].options, { deliverAs: "steer" });
    assert.deepEqual(fake.sent[0].message.details.sources, [
      ".agents/rules/auth.md",
      ".agents/rules/typescript.md",
    ]);
    assert.deepEqual(fake.sent[0].message.details.targets, {
      ".agents/rules/auth.md": ["src/a.ts", "src/b.ts"],
      ".agents/rules/typescript.md": ["src/a.ts", "src/b.ts"],
    });
    assert.match(fake.sent[0].message.content, /Auth rule/);
    assert.match(fake.sent[0].message.content, /TypeScript rule/);

    await fake.emit("tool_result", toolResult("read", "src/c.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);
  });
});

test("no path match produces no row or message", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await fake.emit("tool_result", toolResult("read", "src/ui/button.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.equal(fake.sent.length, 0);
  });
});

test("nudges only after a successful commit settles", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(
      cwd,
      ".pi/rules.json",
      JSON.stringify({ sources: [], nudges: { afterCommit: true } }),
    );
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await fake.emit("tool_result", bashResult("rtk git commit -m 'feat: ship'"), { cwd });
    assert.equal(fake.sent.length, 0);
    await fake.emit("agent_settled", { type: "agent_settled" }, { cwd });

    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].message.customType, NUDGE_MESSAGE_TYPE);
    assert.equal(fake.sent[0].message.display, true);
    assert.match(fake.sent[0].message.content, /durable, repository-specific convention/);
    assert.deepEqual(fake.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

    await fake.emit("agent_settled", { type: "agent_settled" }, { cwd });
    assert.equal(fake.sent.length, 1);
  });
});

test("config event shallow-merges valid patches and rejects invalid updates", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(
      cwd,
      ".pi/rules.json",
      JSON.stringify({ sources: [], nudges: { afterCommit: true } }),
    );
    const fake = createFakePi();
    const notices = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message, level) => notices.push({ message, level }) } };
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await fake.emit("tool_result", bashResult("git commit -m first"), ctx);

    emitPiRulesConfig(fake.api, { enabled: false });
    fake.api.events.emit(CONFIG_EVENT, { enabled: "true" });
    await fake.emit("agent_settled", { type: "agent_settled" }, ctx);
    await fake.emit("tool_result", bashResult("git commit -m suppressed"), ctx);
    await fake.emit("agent_settled", { type: "agent_settled" }, ctx);
    assert.equal(fake.sent.length, 0);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    assert.match(notices[0].message, /rejected pi-rules:config/);

    fake.api.events.emit(CONFIG_EVENT, { enabled: true });
    await fake.emit("tool_result", bashResult("git commit -m enabled"), ctx);
    await fake.emit("agent_settled", { type: "agent_settled" }, { cwd });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].message.customType, NUDGE_MESSAGE_TYPE);
  });
});

test("disabled config suppresses rule injection until re-enabled", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules.json", JSON.stringify({ sources: [{ scope: "repo", kind: "pi" }], nudges: { afterCommit: true } }));
    await writeRule(cwd, ".pi/rules/base.md", "Shared base rule");
    await writeRule(cwd, ".claude/rules/base.md", "Claude base rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    emitPiRulesConfig(fake.api, {
      enabled: false,
      sources: [{ scope: "repo", kind: "claude" }],
      nudges: { afterCommit: false },
    });
    const disabled = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.equal(disabled, undefined);

    emitPiRulesConfig(fake.api, { enabled: true });
    const enabled = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(enabled.message.content, /Claude base rule/);
    assert.doesNotMatch(enabled.message.content, /Shared base rule/);
    await fake.emit("tool_result", bashResult("git commit -m no-nudge"), { cwd });
    await fake.emit("agent_settled", { type: "agent_settled" }, { cwd });
    assert.equal(fake.sent.length, 0);
  });
});

test("separate extension instances inject independently", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Shared base rule");
    const parent = createFakePi();
    const subagent = createFakePi();
    extension(parent.api);
    extension(subagent.api);

    await parent.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    await subagent.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const parentInjection = await parent.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const subagentInjection = await subagent.emit("before_agent_start", { type: "before_agent_start" }, { cwd });

    assert.match(parentInjection.message.content, /Shared base rule/);
    assert.match(subagentInjection.message.content, /Shared base rule/);
  });
});

test("renderer collapses to sources and expands targets plus full body", () => {
  const fake = createFakePi();
  extension(fake.api);
  const renderer = fake.renderers.get(CUSTOM_MESSAGE_TYPE);
  const message = {
    role: "custom",
    customType: CUSTOM_MESSAGE_TYPE,
    content: "## Rule: .agents/rules/auth.md\n\nFull body",
    display: true,
    details: {
      sources: [".agents/rules/auth.md", ".agents/rules/typescript.md"],
      targets: {
        ".agents/rules/auth.md": ["src/auth.ts"],
        ".agents/rules/typescript.md": [],
      },
    },
    timestamp: Date.now(),
  };
  const theme = { fg: (_color, text) => text };

  const collapsed = renderer(message, { expanded: false }, theme)
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
  const expanded = renderer(message, { expanded: true }, theme).render(200).join("\n").trimEnd();

  assert.equal(
    collapsed,
    "Loaded rules:\n↳ .agents/rules/auth.md\n↳ .agents/rules/typescript.md",
  );
  assert.match(expanded, /\.agents\/rules\/auth\.md → src\/auth\.ts/);
  assert.match(expanded, /\.agents\/rules\/typescript\.md → unconditional/);
  assert.match(expanded, /Full body/);
});

test("compaction re-injects unconditional rules and permits lazy re-injection", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/base.md", "Base rule");
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    await fake.emit("tool_result", toolResult("read", "src/auth/user.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);

    await writeRule(cwd, ".agents/rules/base.md", "Fresh base rule");
    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.equal(fake.sent.length, 2);
    assert.match(fake.sent[1].message.content, /Fresh base rule/);
    assert.equal(fake.sent[1].options, undefined);

    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nFresh auth rule");
    await fake.emit("tool_result", toolResult("read", "src/auth/session.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 3);
    assert.match(fake.sent[2].message.content, /Fresh auth rule/);
  });
});
