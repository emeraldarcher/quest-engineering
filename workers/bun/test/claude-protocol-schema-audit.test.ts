import { expect, test } from "bun:test";
import type { StreamedProcessStreamEvent } from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
  claudeCodeCommand,
} from "../src/harnesses/claude-code/adapter.ts";
import { ClaudeOutputCensus } from "../src/harnesses/claude-code/output-census.ts";
import {
  AsyncFrameQueue,
  pump,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";

// Synthetic fixtures only. These describe source shapes, not retained Run data.
// No SDK runtime import, executable invocation, environment lease or account store.
const sessionId = "11111111-1111-4111-8111-111111111111";
const cwd = "/synthetic/empty-cwd";
function init() {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.292",
    cwd,
    apiKeySource: "oauth",
    model: CLAUDE_CODE_MODEL,
    permissionMode: "dontAsk",
    tools: [...CLAUDE_CODE_TOOLS],
    mcp_servers: [],
    skills: [],
    agents: [],
    plugins: [
      { name: "qe-account-cell", path: CLAUDE_CODE_PLUGIN_PATH },
      { name: "cc-plugin-sec-default", path: "builtin" },
    ],
  };
}
async function framed(values: unknown[]) {
  const census = new ClaudeOutputCensus(),
    frames = new AsyncFrameQueue();
  async function* stream(): AsyncIterable<StreamedProcessStreamEvent> {
    for (const value of values)
      yield {
        kind: "data",
        sequence: 0,
        data: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
      };
    yield { kind: "eof", sequence: 1 };
  }
  await pump(stream(), frames, undefined, (unit) =>
    census.observe(unit, sessionId),
  );
  // This argument means observer registered, not frame validated. Only the
  // enclosing lifecycle projection can derive its separate validation flag.
  return { frames, census: census.snapshot(true) };
}

const cases: Array<{ name: string; value: unknown; category: string }> = [
  {
    name: "init tag (not a validated init)",
    value: { type: "system", subtype: "init" },
    category: "system/init",
  },
  {
    name: "known system status",
    value: { type: "system", subtype: "status" },
    category: "system/status",
  },
  {
    name: "result success",
    value: { type: "result", subtype: "success" },
    category: "result/success",
  },
  {
    name: "result execution error",
    value: { type: "result", subtype: "error_during_execution" },
    category: "result/error_during_execution",
  },
  {
    name: "control request",
    value: { type: "control_request", request: { subtype: "initialize" } },
    category: "control_request",
  },
  {
    name: "control response",
    value: { type: "control_response", response: { subtype: "success" } },
    category: "control_response",
  },
  {
    name: "control cancellation",
    value: { type: "control_cancel_request" },
    category: "control_cancel_request",
  },
  { name: "keep alive", value: { type: "keep_alive" }, category: "keep_alive" },
  { name: "missing root discriminator", value: {}, category: "unknown" },
  ...[null, false, 42, [], {}].map((type) => ({
    name: `non-string root ${JSON.stringify(type)}`,
    value: { type },
    category: "unknown",
  })),
  {
    name: "unknown string discriminator",
    value: { type: "synthetic-unreviewed" },
    category: "unknown",
  },
  {
    name: "case spelling differs",
    value: { type: "System", subtype: "init" },
    category: "unknown",
  },
  {
    name: "known system, missing subtype",
    value: { type: "system" },
    category: "system/unknown",
  },
  {
    name: "known system, non-string subtype",
    value: { type: "system", subtype: 42 },
    category: "system/unknown",
  },
  {
    name: "known system, unknown subtype",
    value: { type: "system", subtype: "synthetic-unreviewed" },
    category: "system/unknown",
  },
  {
    name: "known result, missing subtype",
    value: { type: "result" },
    category: "result/unknown",
  },
  {
    name: "known result, non-string subtype",
    value: { type: "result", subtype: null },
    category: "result/unknown",
  },
  {
    name: "known result, unknown subtype",
    value: { type: "result", subtype: "synthetic-unreviewed" },
    category: "result/unknown",
  },
  // Pinned binary segment-1705 hF/yF + IF: real LOCAL private output family.
  // Investigation fixture retained; hardening now recognizes this family only diagnostically.
  {
    name: "2.1.292 local command lifecycle",
    value: {
      type: "command_lifecycle",
      command_uuid: "synthetic-command",
      state: "queued",
      uuid: "synthetic-event",
      session_id: sessionId,
    },
    category: "command_lifecycle",
  },
  // Source-supported only under other flags/transports; NOT enabled by QE argv.
  {
    name: "2.1.292 session mirror",
    value: {
      type: "transcript_mirror",
      filePath: "/synthetic/path",
      entries: [],
    },
    category: "transcript_mirror",
  },
  {
    name: "2.1.292 remote autocompact",
    value: {
      type: "autocompact_state",
      value: { enabled: false },
      uuid: "synthetic-event",
      session_id: sessionId,
    },
    category: "autocompact_state",
  },
  {
    name: "2.1.292 private system UI event",
    value: { type: "system", subtype: "ui_status", text: "synthetic" },
    category: "system/ui_status",
  },
  // Negative envelope tests. Native local stdio writes flat objects; a cloud
  // HTTP event envelope exists elsewhere, not in this configured stdout lane.
  {
    name: "nested message is not unwrapped",
    value: { message: init() },
    category: "unknown",
  },
  {
    name: "remote-style event envelope is not local init",
    value: { type: "event", data: init() },
    category: "unknown",
  },
];
for (const row of cases)
  test(`schema audit: ${row.name}`, async () => {
    const { census } = await framed([row.value]);
    expect(Object.keys(census.categories)).toEqual([row.category]);
    expect(census.counters.totalOutputUnits).toBe(1);
    expect(census.counters.validJsonUnits).toBe(1);
    expect(Object.hasOwn(census, "frameValidated")).toBe(false);
  });

// Native segment-0080 ylo/co, AST-expanded without running vendor schemas.
// All 23 system tags present in the pinned raw schema but absent from the
// public SDK declaration used by the current census. Classification only;
// these minimal fixtures do not claim full payload validity or mode reachability.
const nativePrivateSystemSubtypes = [
  "code_change_published",
  "vcs_state_changed",
  "feedback_draft_queued",
  "ui_invalidate",
  "ui_log",
  "ui_toast",
  "ui_status",
  "cloud_session_delta",
  "dev_intent",
  "session_title_changed",
  "turn_handoff_available",
  "turn_preempted",
  "peer_message_hold",
  "per_turn_effort_changed",
  "permission_check_status",
  "ui_panes",
  "ui_scroll",
  "ui_focus",
  "instruction_size_warning",
  "file_attachments_missing",
  "post_turn_summary",
  "task_summary",
  "session_metadata",
] as const;
for (const subtype of nativePrivateSystemSubtypes)
  test(`pinned raw system schema is diagnostically recognized: ${subtype}`, async () => {
    const { census, frames } = await framed([{ type: "system", subtype }]);
    expect(census.categories[`system/${subtype}`]?.count).toBe(1);
    expect(census.structure.systemSubtypes.known_native_private_subtype).toBe(
      1,
    );
    expect(census.categories.unknown).toBeUndefined();
    expect(census.counters.systemInitCandidateCount).toBe(0);
    await expect(waitForInit(frames, 100)).rejects.toThrow();
  });

test("all six native lifecycle states remain non-authoritative diagnostic categories", async () => {
  const states = [
    "queued",
    "started",
    "completed",
    "cancelled",
    "discarded",
    "refused",
  ];
  const { census, frames } = await framed(
    states.map((state) => ({
      type: "command_lifecycle",
      state,
      command_uuid: "synthetic-command",
      uuid: "synthetic-event",
      session_id: sessionId,
    })),
  );
  expect(census.categories.command_lifecycle?.count).toBe(6);
  for (const state of states)
    expect(
      census.commandLifecycle.states[
        state as keyof typeof census.commandLifecycle.states
      ],
    ).toBe(1);
  expect(census.counters.systemInitCandidateCount).toBe(0);
  expect(Object.hasOwn(census, "frameValidated")).toBe(false);
  await expect(waitForInit(frames, 100)).rejects.toThrow();
});

test("local private lifecycle is observable yet cannot replace the authoritative init", async () => {
  const lifecycle = {
    type: "command_lifecycle",
    command_uuid: "synthetic-probe",
    state: "queued",
    uuid: "synthetic-event",
    session_id: sessionId,
  };
  const only = await framed([lifecycle]);
  await expect(waitForInit(only.frames, 100)).rejects.toThrow();
  const mixed = await framed([
    lifecycle,
    { type: "system", subtype: "status", status: null },
    { type: "result", subtype: "success", is_error: false, num_turns: 0 },
    init(),
  ]);
  const candidate = await waitForInit(mixed.frames, 100);
  expect(() =>
    attestClaudeInit(candidate, { sessionId, cwd, model: CLAUDE_CODE_MODEL }),
  ).not.toThrow();
  expect(mixed.census.categories.command_lifecycle?.count).toBe(1);
  expect(mixed.census.counters.reservedSessionMatchCount).toBe(1);
});

for (const [name, value, present, match, mismatch, missing] of [
  ["matching", sessionId, 1, 1, 0, 0],
  ["mismatching", "22222222-2222-4222-8222-222222222222", 1, 0, 1, 0],
  ["null present", null, 1, 0, 1, 0],
  ["missing", undefined, 0, 0, 0, 1],
] as const)
  test(`init classification is not validation: ${name}`, async () => {
    const frame: Record<string, unknown> = init();
    if (value === undefined) delete frame.session_id;
    else frame.session_id = value;
    const { census, frames } = await framed([frame]);
    expect(census.counters).toMatchObject({
      systemInitCandidateCount: 1,
      sessionIdPresentCount: present,
      reservedSessionMatchCount: match,
      reservedSessionMismatchCount: mismatch,
      sessionIdMissingCount: missing,
    });
    const candidate = await waitForInit(frames, 100);
    const validate = () =>
      attestClaudeInit(candidate, { sessionId, cwd, model: CLAUDE_CODE_MODEL });
    if (match) expect(validate).not.toThrow();
    else expect(validate).toThrow();
    if (mismatch && typeof value === "string")
      expect(JSON.stringify(census).includes(value)).toBe(false);
  });

test("a matching tag/session still requires the production policy/version/model inventory", async () => {
  const { census, frames } = await framed([
    { type: "system", subtype: "init", session_id: sessionId },
  ]);
  expect(census.counters.reservedSessionMatchCount).toBe(1);
  const frame = await waitForInit(frames, 100);
  expect(() =>
    attestClaudeInit(frame, { sessionId, cwd, model: CLAUDE_CODE_MODEL }),
  ).toThrow();
});

test("unknown/missing/non-string and envelope cases cannot leak canaries or attest", async () => {
  const canary = `synthetic-sensitive-${crypto.randomUUID()}`;
  const values = [
    { type: canary },
    { type: { secret: canary } },
    { error: canary },
    { type: "system", subtype: canary },
    { type: "result", subtype: canary },
    { message: { ...init(), session_id: canary } },
  ];
  const { census, frames } = await framed(values);
  expect(JSON.stringify(census).includes(canary)).toBe(false);
  expect(census.counters.systemInitCandidateCount).toBe(0);
  await expect(waitForInit(frames, 100)).rejects.toThrow();
});

test("pure invocation builder requests flat local stream-json, not a hosted or alternate output mode", () => {
  const command = claudeCodeCommand(
    { configRoot: "/synthetic/config", cwd },
    sessionId,
    false,
    "/synthetic/mailbox",
    "synthetic-not-a-credential",
  );
  expect(command.executable).toBe("/opt/qe/claude/claude");
  expect(command.args).toEqual([
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--model",
    CLAUDE_CODE_MODEL,
    "--effort",
    "high",
    "--session-id",
    sessionId,
    "--tools",
    CLAUDE_CODE_TOOLS.join(","),
  ]);
  expect(command.cwd).toBe(cwd);
  expect(command.environment).toMatchObject({
    HOME: "/synthetic/config",
    CLAUDE_CONFIG_DIR: "/synthetic/config",
    TMPDIR: "/synthetic/config/tmp",
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  });
  for (const key of [
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ])
    expect(Object.hasOwn(command.environment, key)).toBe(false);
  const resumed = claudeCodeCommand(
    { configRoot: "/synthetic/config", cwd },
    sessionId,
    true,
    "/synthetic/mailbox",
    "synthetic-not-a-credential",
  );
  expect(resumed.args).toContain("--resume");
  expect(resumed.args).not.toContain("--session-id");
});
