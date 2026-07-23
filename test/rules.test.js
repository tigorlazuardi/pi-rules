import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverRules, parseRuleFile } from "../dist/discovery.js";
import extension, { CUSTOM_MESSAGE_TYPE } from "../dist/index.js";
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
  const renderers = new Map();
  const sent = [];
  return {
    api: {
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

test("discovers nested .agents and .claude rules in deterministic order", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/z.md", "Always Z");
    await writeRule(cwd, ".agents/rules/backend/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    await writeRule(cwd, ".claude/rules/a.md", "Always A");
    await writeRule(cwd, ".agents/rules/ignored.txt", "not markdown");

    const result = await discoverRules(cwd);

    assert.deepEqual(
      result.rules.map((rule) => rule.sourceLabel),
      [".agents/rules/backend/auth.md", ".agents/rules/z.md", ".claude/rules/a.md"],
    );
    assert.deepEqual(result.rules[0].paths, ["src/auth/**"]);
    assert.equal(result.rules[0].body, "Auth rule");
    assert.equal(result.rules[1].paths, undefined);
    assert.equal(result.diagnostics.length, 0);
  });
});

test("accepts path lists and diagnoses unsupported or malformed frontmatter", async () => {
  await withTempDirectory(async (cwd) => {
    const valid = path.join(cwd, "valid.md");
    const unsupported = path.join(cwd, "unsupported.md");
    const malformed = path.join(cwd, "malformed.md");
    await writeFile(valid, "---\npaths:\n  - src/**/*.ts\n  - tests/**\n---\nTyped", "utf8");
    await writeFile(unsupported, "---\ndescription: old schema\n---\nOld", "utf8");
    await writeFile(malformed, "---\npaths: [src/**\n---\nBad", "utf8");

    const validResult = await parseRuleFile(valid, "valid.md");
    const unsupportedResult = await parseRuleFile(unsupported, "unsupported.md");
    const malformedResult = await parseRuleFile(malformed, "malformed.md");

    assert.deepEqual(validResult.rule.paths, ["src/**/*.ts", "tests/**"]);
    assert.match(unsupportedResult.diagnostic.reason, /unsupported frontmatter field: description/);
    assert.match(malformedResult.diagnostic.reason, /invalid YAML/);
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

    const first = await fake.emit("before_agent_start", { type: "before_agent_start" });
    const second = await fake.emit("before_agent_start", { type: "before_agent_start" });

    assert.equal(first.message.customType, CUSTOM_MESSAGE_TYPE);
    assert.equal(first.message.display, true);
    assert.match(first.message.content, /Always follow base rule\./);
    assert.deepEqual(first.message.details.sources, [".agents/rules/base.md"]);
    assert.deepEqual(first.message.details.targets, { ".agents/rules/base.md": [] });
    assert.equal(second, undefined);
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
    await fake.emit("turn_end", { type: "turn_end" });

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
    await fake.emit("turn_end", { type: "turn_end" });
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
    await fake.emit("turn_end", { type: "turn_end" });

    assert.equal(fake.sent.length, 0);
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

  const collapsed = renderer(message, { expanded: false }, theme).render(200).join("\n").trimEnd();
  const expanded = renderer(message, { expanded: true }, theme).render(200).join("\n").trimEnd();

  assert.equal(collapsed, "↳ Rules: .agents/rules/auth.md, .agents/rules/typescript.md");
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

    await fake.emit("before_agent_start", { type: "before_agent_start" });
    await fake.emit("tool_result", toolResult("read", "src/auth/user.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" });
    assert.equal(fake.sent.length, 1);

    await fake.emit("session_compact", { type: "session_compact", willRetry: true });
    assert.equal(fake.sent.length, 2);
    assert.match(fake.sent[1].message.content, /Base rule/);
    assert.equal(fake.sent[1].options, undefined);

    await fake.emit("tool_result", toolResult("read", "src/auth/session.ts"), { cwd });
    await fake.emit("turn_end", { type: "turn_end" });
    assert.equal(fake.sent.length, 3);
    assert.match(fake.sent[2].message.content, /Auth rule/);
  });
});
