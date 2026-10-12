import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";
import {
  claudeNativeSessionRef,
  normalizeClaudeObservation,
} from "../normalizer";

const COMPLETE_TOOL = "mcp__qe-control-spike__qe_complete_step";
const ATTENTION_TOOL =
  "mcp__qe-control-spike__qe_request_human_assistance";
const MODEL = "claude-opus-4-6";

function configure(on: On): string[] {
  const registeredTools: string[] = [];
  mock.env(on, {
    QE_CLAUDE_MOD_PROTOCOL: "qe_claude_mod_spike_v1",
    QE_BRIDGE: "/qe/bridge-cli.mjs",
    QE_CLAUDE_MODEL: MODEL,
    QE_CLAUDE_EFFORT: "high",
    QE_CLAUDE_ALLOWED_TOOLS_JSON: JSON.stringify(["Read", "Edit", "Bash"]),
  });
  on("tool.register", ($, e) => {
    registeredTools.push(e.name);
    return { value: { tool: `mcp__qe-control-spike__${e.name}` } };
  });
  on("command.register", () => ({
    value: { command: "qe_mod_probe" },
  }));
  on("session.start", () => ({ cwd: "/workspace" }));
  return registeredTools;
}

async function start($: Engine) {
  return $.session.start({
    cwd: "/workspace",
    surface: null,
    isInteractive: false,
  });
}

test("headless initialization registers the QE tools and probe command", async ($, on) => {
  const registeredTools = configure(on);

  await start($);
  const probe = await $.command.run({
    command: "qe_mod_probe",
    args: "",
    origin: { kind: "sdk" },
    presentation: { isFullscreen: false, columns: 80 },
  });

  expect(registeredTools).toEqual([
    "qe_complete_step",
    "qe_request_human_assistance",
  ]);
  expect(JSON.parse(probe.text ?? "")).toEqual({
    protocol: "qe_claude_mod_spike_v1",
    ready: true,
    interactive: false,
  });
});

test("structured completion crosses the existing local-control process transport", async ($, on) => {
  configure(on);
  on("process.run", ($, e) => {
    expect(e.argv).toEqual(["/qe/bridge-cli.mjs", "local-control"]);
    expect(JSON.parse(e.init?.stdin ?? "")).toEqual({
      type: "complete_step",
      outputs: { summary: "done" },
    });
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({
          accepted: true,
          semanticAccepted: true,
        }),
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  await start($);
  const answer = await $.tool.call({
    tool: COMPLETE_TOOL,
    outputs: { summary: "done" },
  });

  expect(JSON.parse(String(answer.result))).toEqual({
    accepted: true,
    duplicate: false,
    semanticAccepted: true,
  });
});

test("HumanAttention can block a tool call on a streamed local process", async ($, on) => {
  configure(on);
  on("process.spawn", async function* ($, e) {
    expect(e.argv).toEqual(["/qe/bridge-cli.mjs", "local-control-wait"]);
    expect(JSON.parse(e.input ?? "")).toEqual({
      type: "request_human_assistance_and_wait",
      category: "needs_input",
      message: "Which target?",
      interaction: "choice",
      responseSchema: { enum: ["a", "b"] },
    });
    yield {
      stream: "stdout",
      text: JSON.stringify({
        accepted: true,
        humanResponse: { outcome: "completed", value: "b" },
      }),
    };
    return { value: { code: 0, signal: null } };
  });

  await start($);
  const answer = await $.tool.call({
    tool: ATTENTION_TOOL,
    category: "needs_input",
    message: "Which target?",
    interaction: "choice",
    responseSchema: { enum: ["a", "b"] },
  });

  expect(JSON.parse(String(answer.result))).toEqual({
    outcome: "completed",
    value: "b",
  });
});

test("tool mediation allows only the exact QE policy and preserves a deny below", async ($, on) => {
  configure(on);
  let coreCalls = 0;
  on("tool.call", () => {
    coreCalls += 1;
    return { result: "read" };
  });
  on("tool.check", ($, e) =>
    e.tool === "Edit"
      ? { decision: "deny", reason: "managed deny" }
      : { decision: "ask", reason: "ordinary prompt" },
  );

  await start($);
  const read = await $.tool.call({ tool: "Read", file_path: "README.md" });
  const denied = await $.tool.call({
    tool: "WebFetch",
    url: "https://example.com",
    prompt: "Fetch",
  });
  const readPermission = await $.tool.check({ tool: "Read", input: {} });
  const editPermission = await $.tool.check({ tool: "Edit", input: {} });

  expect(read.result).toBe("read");
  expect(denied.deny).toContain("did not authorize");
  expect(coreCalls).toBe(1);
  expect(readPermission.decision).toBe("allow");
  expect(editPermission).toEqual({
    decision: "deny",
    reason: "managed deny",
  });
});

test("prompt, turn-start, and turn-complete lifecycle events pass through with QE context", async ($, on) => {
  configure(on);
  on("prompt.submit", ($, e) => ({
    text: e.text,
    context: e.context,
    origin: e.origin,
  }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", ($, e) => ({ text: e.answer, usage: e.usage }));

  await start($);
  const prompt = await $.prompt.submit({
    text: "Implement the step",
    wait: false,
    origin: { kind: "sdk" },
  });
  const turn = await $.turn.start({
    text: prompt.text ?? "",
    turnId: "turn-1",
  });
  const completed = await $.turn.complete({
    turnId: "turn-1",
    answer: "done",
    durationMs: 5,
    isAborted: false,
    reason: "answer",
  });

  expect(prompt.origin).toEqual({ kind: "sdk" });
  expect(prompt.context?.[0]).toContain("Quest Engineering control contract");
  expect(turn.turnId).toBe("turn-1");
  expect(completed.text).toBe("done");
});

test("the Mod passes only the exact model and effort to the mocked request", async ($, on) => {
  configure(on);
  on("turn.step", async function* ($, e) {
    expect(e.model).toBe(MODEL);
    expect(e.effort).toBe("high");
    yield { kind: "text", index: 0, text: "ok" };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "ok",
      toolUses: [],
      stopReason: "end_turn",
      usage: {
        model: MODEL,
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });

  await start($);
  const stream = $.turn.step({
    turnId: "turn-1",
    index: 0,
    model: MODEL,
    effort: "high",
    messageCount: 1,
  });
  const chunks = [];
  let item = await stream.next();
  while (item.done !== true) {
    chunks.push(item.value);
    item = await stream.next();
  }

  expect(chunks).toEqual([{ kind: "text", index: 0, text: "ok" }]);
  expect(item.value.answer).toBe("ok");
  expect(item.value.usage?.model).toBe(MODEL);
});

test("a model or effort mismatch is refused before a mocked request", async ($, on) => {
  configure(on);
  let modelRequests = 0;
  on("turn.step", async function* ($, e) {
    modelRequests += 1;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "unexpected",
      toolUses: [],
      stopReason: "end_turn",
      usage: null,
    };
  });

  await start($);
  const stream = $.turn.step({
    turnId: "turn-1",
    index: 0,
    model: "untrusted-alias",
    effort: "low",
    messageCount: 1,
  });
  let item = await stream.next();
  while (item.done !== true) item = await stream.next();

  expect(modelRequests).toBe(0);
  expect(item.value).toMatchObject({
    answer: "",
    toolUses: [],
    stopReason: "refusal",
    usage: null,
  });
});

test("native Stop maps QE continuation to a blocking correction", async ($, on) => {
  configure(on);
  on("process.run", ($, e) => {
    expect(e.argv).toEqual(["/qe/bridge-cli.mjs", "hook", "stop"]);
    expect(JSON.parse(e.init?.stdin ?? "")).toEqual({
      terminationReason: "answer",
      fullyIdle: true,
      modelName: MODEL,
    });
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "continue",
          reason: "Call qe_complete_step.",
        }),
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("turn.complete", ($, e) => ({ text: e.answer, usage: e.usage }));
  on("classic.Stop", () => ({}));

  await start($);
  await $.turn.complete({
    turnId: "turn-1",
    answer: "done",
    durationMs: 5,
    isAborted: false,
    reason: "answer",
    usage: {
      model: MODEL,
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  const stop = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: "done",
  });

  expect(stop).toEqual({ block: "Call qe_complete_step." });
});

test("native session identity and lifecycle normalize without a terminal", () => {
  const inspection = { fixture: true };
  const nativeSession = claudeNativeSessionRef("session-123");

  expect(nativeSession).toEqual({
    schemaVersion: 1,
    harnessKind: "claude-code",
    payload: { identityKind: "id", opaqueId: "session-123" },
  });
  expect(
    normalizeClaudeObservation(
      { kind: "prompt_accepted", observedAt: "2026-10-12T00:00:00Z" },
      inspection,
    ),
  ).toEqual([
    {
      type: "prompt_accepted",
      acceptedAt: "2026-10-12T00:00:00Z",
      inspection,
    },
  ]);
  expect(
    normalizeClaudeObservation(
      { kind: "turn_complete", observedAt: "2026-10-12T00:00:01Z" },
      inspection,
    ),
  ).toEqual([
    {
      type: "provider_turn_settled",
      observedAt: "2026-10-12T00:00:01Z",
      inspection,
    },
    {
      type: "native_idle",
      observedAt: "2026-10-12T00:00:01Z",
      inspection,
    },
  ]);
});

test("subagents are neither offered nor permitted to spawn", async ($, on) => {
  configure(on);

  await start($);
  const offer = await $.agent.offer({
    agent: "Explore",
    description: "Explore code",
    source: "built-in",
    provider: { plugin: "engine", tier: "core" },
  });
  const spawn = await $.agent.spawn({
    tool_use_id: "tool-1",
    prompt: "Explore",
    description: "Explore",
    subagentType: "Explore",
    provider: { plugin: "engine", tier: "core" },
    parentModel: MODEL,
    permissionMode: "default",
    background: false,
    fork: false,
  });

  expect(offer.isOffered).toBe(false);
  expect(spawn.deny).toContain("disables Claude subagents");
});
