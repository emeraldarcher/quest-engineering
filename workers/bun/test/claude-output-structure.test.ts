import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessExit,
  StreamedProcessIoSnapshot,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
} from "../src/harnesses/claude-code/adapter.ts";
import {
  CLAUDE_OUTPUT_RESULT_SUBTYPES,
  CLAUDE_OUTPUT_SIMPLE_TYPES,
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
  ClaudeOutputCensus,
  MAX_CLAUDE_CENSUS_BUCKETS,
  MAX_CLAUDE_CENSUS_COUNT,
} from "../src/harnesses/claude-code/output-census.ts";
import {
  AsyncFrameQueue,
  observeClaudeProtocol,
  sendMessage,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import {
  ManagedHarnessLifecycle,
  ManagedHarnessLifecycleStore,
} from "../src/harnesses/lifecycle-diagnostics.ts";

const reserved = "11111111-1111-4111-8111-111111111111";
const ref: EnvironmentRef = {
  backendKind: "fixture",
  environmentId: "cell",
  incarnation: "incarnation",
  workerId: "worker",
  owner: { kind: "run", runId: "fixture" },
  profile: { id: "profile", digest: "sha256:fixture" },
};
const context = {
  harnessKind: "claude_code",
  harnessProtocol: "qe_claude_account_cell_v1",
  reservedNativeSessionId: reserved,
  environment: ref,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const probe = "Quest Engineering fixed zero-inference initialization probe.";
function init(sessionId = reserved) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.292",
    apiKeySource: "oauth",
    cwd: "/fixture",
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
function fixture() {
  let out!: ReadableStreamDefaultController<Uint8Array>,
    err!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (value: StreamedProcessExit) => void;
  let outputBytes = 0,
    errorBytes = 0,
    ioCalls = 0,
    ended = false;
  const writes: Uint8Array[] = [],
    order: string[] = [];
  const process: StreamedProcess = {
    handle: {
      contractVersion: 1,
      backendKind: ref.backendKind,
      environment: ref,
      processGeneration: "generation",
      backendProcessId: "123",
      processStartIdentity: "456",
      executable: "/fixture/executable",
      observedExecutable: "/fixture/executable",
      observedExecutableIdentity: "1:2",
    },
    stdout: stream(
      new ReadableStream({
        start(c) {
          out = c;
        },
      }),
    ),
    stderr: stream(
      new ReadableStream({
        start(c) {
          err = c;
        },
      }),
    ),
    exit: new Promise((resolve) => {
      finish = resolve;
    }),
    write: async (bytes) => {
      order.push("write");
      writes.push(bytes);
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: bytes.byteLength,
      };
    },
    observeIo: async () => {
      order.push("io");
      ioCalls++;
      return {
        status: "available",
        handle: process.handle,
        receivedAt: new Date().toISOString(),
        sample: {
          observedAt: new Date().toISOString(),
          elapsedMs: ioCalls,
          stdin: { status: "observed", unreadBytes: 0 },
          stdoutBytes: outputBytes,
          stderrBytes: errorBytes,
          terminal: ended ? "observed" : "not_observed",
        },
        beforeCancellation: null,
      };
    },
    closeStdin: async () => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: 0,
    }),
    cancel: async () => {
      if (!ended) {
        ended = true;
        out.close();
        err.close();
        finish({ kind: "signaled", signal: "SIGTERM" });
      }
      return { certainty: "acknowledged", cancellationId: crypto.randomUUID() };
    },
    inspect: async () => ({
      handle: process.handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    disconnect: async () => {
      await process.cancel();
    },
  };
  return {
    process,
    writes,
    order,
    output(value: string | Uint8Array) {
      const bytes =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      outputBytes += bytes.byteLength;
      out.enqueue(bytes);
    },
    stderr(value: string) {
      const bytes = new TextEncoder().encode(value);
      errorBytes += bytes.byteLength;
      err.enqueue(bytes);
    },
  };
}
async function* stream(
  readable: ReadableStream<Uint8Array>,
): AsyncIterable<StreamedProcessStreamEvent> {
  const reader = readable.getReader();
  for (;;) {
    const e = await reader.read();
    if (e.done) break;
    yield { kind: "data", sequence: 0, data: e.value };
  }
  yield { kind: "eof", sequence: 1 };
}
function observe(
  f: ReturnType<typeof fixture>,
  diag: ManagedHarnessLifecycle | null,
) {
  diag?.bindProcess(f.process.handle);
  const frames = new AsyncFrameQueue();
  observeClaudeProtocol(f.process, frames, diag, () => true);
  return frames;
}

for (const startup of [true, false])
  test(`pre-probe baseline separates ${startup ? "startup" : "post-probe"} output without content`, async () => {
    const f = fixture(),
      diag = new ManagedHarnessLifecycle(context),
      frames = observe(f, diag);
    const unit = `${JSON.stringify({ type: "keep_alive" }).padEnd(197, " ")}\n`;
    if (startup) f.output(unit);
    const write = f.process.write;
    f.process.write = async (data) => {
      if (!startup) f.output(unit);
      return write(data);
    };
    await sendMessage(f.process, reserved, probe, false, diag);
    await tick();
    const evidence = diag.snapshot();
    expect(f.order).toEqual(["io", "write", "io"]);
    expect(f.writes[0]?.byteLength).toBe(301);
    expect(evidence.ioObservations[0]).toMatchObject({
      checkpoint: "before_probe_write",
      status: "available",
      sample: { stdoutBytes: startup ? 198 : 0 },
    });
    expect(evidence.ioObservations[1]).toMatchObject({
      checkpoint: "probe_write_acknowledged",
      status: "available",
      sample: { stdoutBytes: 198 },
    });
    expect(evidence.probeIoDelta).toEqual({
      status: "available",
      stdoutBytes: startup ? 0 : 198,
      stderrBytes: 0,
    });
    expect(evidence.outputCensus.categories.keep_alive?.count).toBe(1);
    await expect(waitForInit(frames, 10)).rejects.toThrow("timed out");
    await f.process.cancel();
  });

test("unavailable/throwing baseline never rejects the probe and never fabricates a delta", async () => {
  for (const mode of ["unavailable", "throwing", "foreign"]) {
    const f = fixture(),
      diag = new ManagedHarnessLifecycle(context);
    observe(f, diag);
    const real = f.process.observeIo;
    let calls = 0;
    f.process.observeIo = async () => {
      calls++;
      if (calls > 1) return real();
      if (mode === "throwing") throw new Error("PRIVATE");
      if (mode === "foreign") {
        const v = await real();
        return v.status === "available"
          ? { ...v, handle: { ...v.handle, observedExecutableIdentity: "9:9" } }
          : v;
      }
      return { status: "unavailable", reason: "unsupported" };
    };
    await sendMessage(f.process, reserved, probe, false, diag);
    await tick();
    expect(f.writes).toHaveLength(1);
    expect(diag.snapshot().ioObservations[0]?.status).toBe("unavailable");
    expect(diag.snapshot().probeIoDelta).toEqual({
      status: "unavailable",
      reason: "baseline_unavailable",
    });
    await f.process.cancel();
  }
});

test("hung baseline is bounded at three seconds; a late response is not relabeled pre-probe", async () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context);
  observe(f, diag);
  const real = f.process.observeIo;
  let release!: (v: StreamedProcessIoSnapshot) => void,
    calls = 0;
  f.process.observeIo = () =>
    ++calls === 1
      ? new Promise((r) => {
          release = r;
        })
      : real();
  await sendMessage(f.process, reserved, probe, false, diag);
  await tick();
  expect(f.writes).toHaveLength(1);
  expect(diag.snapshot().ioObservations[0]).toMatchObject({
    checkpoint: "before_probe_write",
    status: "unavailable",
    reason: "timed_out",
  });
  release(await real());
  await tick();
  expect(diag.snapshot().ioObservations[0]).toMatchObject({
    status: "unavailable",
    reason: "timed_out",
  });
  await f.process.cancel();
}, 10_000);

test("pre/post counter regressions are unavailable, never negative or fabricated zero", async () => {
  for (const regression of ["stdout", "stderr", "elapsed"]) {
    const f = fixture(),
      diag = new ManagedHarnessLifecycle(context);
    observe(f, diag);
    const real = f.process.observeIo;
    let calls = 0;
    f.process.observeIo = async () => {
      const value = await real();
      calls++;
      if (value.status !== "available") return value;
      if (calls === 1)
        expect(diag.snapshot().observations.probe_write_requested).toBe(
          "not_observed",
        );
      return {
        ...value,
        sample: {
          ...value.sample,
          stdoutBytes: calls > 1 && regression === "stdout" ? 19 : 20,
          stderrBytes: calls > 1 && regression === "stderr" ? 19 : 20,
          elapsedMs: calls > 1 && regression === "elapsed" ? 19 : 20,
        },
      };
    };
    await sendMessage(f.process, reserved, probe, false, diag);
    await tick();
    expect(diag.snapshot().probeIoDelta).toEqual({
      status: "unavailable",
      reason: "counter_regression",
    });
    await f.process.cancel();
  }
});

test("only the bounded pre-probe method can own the baseline checkpoint", async () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context);
  diag.bindProcess(f.process.handle);
  await diag.capturePreProbeIo(f.process);
  expect(f.order).toEqual([]);
  observe(f, diag);
  diag.captureIo("before_probe_write", f.process);
  await tick();
  expect(f.order).toEqual([]);
  await sendMessage(f.process, reserved, probe, false, diag);
  await tick();
  await diag.capturePreProbeIo(f.process);
  expect(f.order).toEqual(["io", "write", "io"]);
  await f.process.cancel();
});

test("census failure is a fixed unavailable category and never retains thrown prose", () => {
  const c = new ClaudeOutputCensus(),
    secret = `observer-${crypto.randomUUID()}`;
  const value = Object.defineProperty({}, "type", {
    get() {
      throw new Error(secret);
    },
  });
  c.observe({ kind: "json", value }, reserved);
  expect(c.snapshot(true).unavailableReason).toBe("observer_failed");
  expect(JSON.stringify(c.snapshot(true)).includes(secret)).toBe(false);
});

for (const match of [true, false])
  test(`real parser + init validator, reserved-session match=${match}`, async () => {
    const db = new Database(":memory:"),
      store = new ManagedHarnessLifecycleStore(db),
      diag = store.begin(context);
    if (!diag) throw new Error("fixture");
    const f = fixture(),
      frames = observe(f, diag),
      secret = `foreign-${crypto.randomUUID()}`;
    f.output(
      `${JSON.stringify({ ...init(match ? reserved : secret), value: secret })}\n`,
    );
    const frame = await waitForInit(frames, 1_000);
    if (match) {
      attestClaudeInit(frame, {
        sessionId: reserved,
        cwd: "/fixture",
        model: CLAUDE_CODE_MODEL,
      });
      diag.record("protocol_frame_validated", f.process.handle);
    } else {
      expect(() =>
        attestClaudeInit(frame, {
          sessionId: reserved,
          cwd: "/fixture",
          model: CLAUDE_CODE_MODEL,
        }),
      ).toThrow();
      diag.record("protocol_frame_rejected", f.process.handle);
    }
    await tick();
    const c = diag.snapshot().outputCensus;
    expect(c.counters.systemInitCandidateCount).toBe(1);
    expect(c.counters.sessionIdPresentCount).toBe(1);
    expect(c.counters.reservedSessionMatchCount).toBe(match ? 1 : 0);
    expect(c.counters.reservedSessionMismatchCount).toBe(match ? 0 : 1);
    expect(c.frameValidated).toBe(match);
    expect(diag.snapshot().observations.protocol_frame_observed).toBe(
      match ? "observed" : "not_observed",
    );
    expect(
      JSON.stringify(
        db.query("SELECT * FROM managed_harness_lifecycle").all(),
      ).includes(secret),
    ).toBe(false);
    await f.process.cancel();
    db.close();
  });

test("unknown discriminators, missing session, arrays and arbitrary native data stay finite and content-free", () => {
  const secret = `native-${crypto.randomUUID()}`,
    c = new ClaudeOutputCensus();
  const values = [
    { type: secret, subtype: secret, session_id: secret },
    { type: "system", subtype: secret, errors: secret },
    { type: "result", subtype: secret, model: secret },
    { type: "system", subtype: "init", session_id: secret },
    { type: "system", subtype: "init" },
    [secret],
    secret,
    null,
  ];
  for (const value of values) c.observe({ kind: "json", value }, reserved);
  const s = c.snapshot(true);
  expect(s.counters.totalOutputUnits).toBe(values.length);
  expect(s.counters.unknownDiscriminatorUnits).toBe(3);
  expect(s.categories.unknown?.count).toBe(1);
  expect(s.categories["system/unknown"]?.count).toBe(1);
  expect(s.categories["result/unknown"]?.count).toBe(1);
  expect(s.counters.sessionIdMissingCount).toBe(1);
  expect(JSON.stringify(s).includes(secret)).toBe(false);
});

test("all reviewed discriminator buckets are fixed-size; many unknown values cannot grow storage", () => {
  const c = new ClaudeOutputCensus();
  for (const type of CLAUDE_OUTPUT_SIMPLE_TYPES)
    c.observe({ kind: "json", value: { type } }, reserved);
  for (const subtype of CLAUDE_OUTPUT_SYSTEM_SUBTYPES)
    c.observe({ kind: "json", value: { type: "system", subtype } }, reserved);
  for (const subtype of CLAUDE_OUTPUT_RESULT_SUBTYPES)
    c.observe({ kind: "json", value: { type: "result", subtype } }, reserved);
  for (let i = 0; i < 1_000; i++)
    c.observe({ kind: "json", value: { type: `unknown-${i}` } }, reserved);
  expect(Object.keys(c.snapshot(true).categories).length).toBeLessThanOrEqual(
    MAX_CLAUDE_CENSUS_BUCKETS,
  );
  expect(c.snapshot(true).categories.unknown?.count).toBe(1_000);
  c.observe(
    { kind: "non_json", decodedUtf8Bytes: MAX_CLAUDE_CENSUS_COUNT },
    reserved,
  );
  c.observe({ kind: "non_json", decodedUtf8Bytes: 1 }, reserved);
  expect(c.snapshot(true).observation).toBe("unavailable");
  expect(c.snapshot(true).unavailableReason).toBe("counter_overflow");
});

test("fragmented JSON and split UTF-8 are not non-JSON before LF; EOF tails stay incomplete", async () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context),
    frames = observe(f, diag);
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: "system", subtype: "status", ignored: "λ" }),
  );
  for (const byte of bytes) f.output(Uint8Array.of(byte));
  await tick();
  expect(diag.snapshot().outputCensus.counters.totalOutputUnits).toBe(0);
  f.output("\n");
  await tick();
  expect(frames.cursor).toBe(1);
  expect(diag.snapshot().outputCensus.categories["system/status"]?.count).toBe(
    1,
  );
  expect(diag.snapshot().outputCensus.counters.nonJsonUnits).toBe(0);
  f.output('{"unfinished":');
  await f.process.cancel();
  await tick();
  expect(diag.snapshot().outputCensus.counters.incompleteEofCount).toBe(1);
  expect(diag.snapshot().outputCensus.counters.nonJsonUnits).toBe(0);
});

for (const kind of [
  "non_json",
  "non_object",
  "invalid_utf8",
  "buffer_limit",
] as const)
  test(`real parser retains original ${kind} failure and records only structure`, async () => {
    const f = fixture(),
      diag = new ManagedHarnessLifecycle(context),
      frames = observe(f, diag);
    const secret = `sensitive-${crypto.randomUUID()}`;
    f.output(
      kind === "non_json"
        ? `${secret}\n`
        : kind === "non_object"
          ? `${JSON.stringify(secret)}\n`
          : kind === "invalid_utf8"
            ? Uint8Array.of(0xff, 10)
            : "x".repeat(2 * 1024 * 1024 + 1),
    );
    await expect(waitForInit(frames, 1_000)).rejects.toThrow();
    await tick();
    const c = diag.snapshot().outputCensus;
    if (kind === "non_json") {
      expect(c.counters.nonJsonUnits).toBe(1);
      expect(c.counters.nonJsonDecodedUtf8Bytes).toBe(
        Buffer.byteLength(secret) + 1,
      );
    }
    if (kind === "non_object") expect(c.counters.nonObjectJsonUnits).toBe(1);
    if (kind === "invalid_utf8") expect(c.counters.invalidUtf8Count).toBe(1);
    if (kind === "buffer_limit") expect(c.counters.bufferLimitCount).toBe(1);
    expect(JSON.stringify(diag.snapshot()).includes(secret)).toBe(false);
    await f.process.cancel();
  });

test("observer/persistence loss cannot drop init; census cannot set validation or native milestones", async () => {
  for (const failed of ["observer", "sink"]) {
    const f = fixture(),
      diag = new ManagedHarnessLifecycle(context, () => {
        if (failed === "sink") throw new Error("PRIVATE");
        return true;
      });
    if (failed === "observer")
      diag.observeClaudeOutput = () => {
        throw new Error("PRIVATE");
      };
    const frames = observe(f, diag);
    f.output(`${JSON.stringify(init())}\n`);
    const frame = await waitForInit(frames, 1_000);
    attestClaudeInit(frame, {
      sessionId: reserved,
      cwd: "/fixture",
      model: CLAUDE_CODE_MODEL,
    });
    expect(diag.snapshot().outputCensus.frameValidated).toBe(false);
    expect(diag.snapshot().modExecution).toBe("unestablished");
    diag.record("protocol_frame_validated", f.process.handle);
    expect(diag.snapshot().outputCensus.frameValidated).toBe(true);
    await f.process.cancel();
  }
});

test("census rejects every foreign attachment identity and timeout progress remains frozen", () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context);
  observe(f, diag);
  const h = f.process.handle;
  const wrong = [
    { ...h, processGeneration: "wrong" },
    { ...h, backendProcessId: "999" },
    { ...h, processStartIdentity: "999" },
    { ...h, observedExecutableIdentity: "9:9" },
    { ...h, executable: "/wrong" },
    { ...h, observedExecutable: "/wrong" },
    { ...h, environment: { ...ref, incarnation: "wrong" } },
    {
      ...h,
      environment: { ...ref, owner: { kind: "run" as const, runId: "wrong" } },
    },
    {
      ...h,
      environment: { ...ref, profile: { id: "wrong", digest: "wrong" } },
    },
  ];
  for (const source of wrong)
    diag.observeClaudeOutput({ kind: "json", value: init() }, source);
  expect(diag.snapshot().outputCensus.counters.totalOutputUnits).toBe(0);
  diag.record("probe_write_acknowledged", h);
  diag.record("attestation_timeout_fired", h);
  diag.observeClaudeOutput({ kind: "json", value: init() }, h);
  diag.observeInit(init(), h);
  expect(diag.snapshot().outputCensus.counters.reservedSessionMatchCount).toBe(
    1,
  );
  expect(diag.snapshot().lastProvenStage).toBe("probe_write_acknowledged");
  expect(diag.snapshot().nativeAttestationInterval).toBe("unknown");
});

test("owned probe correlation stays private through real serializer, parser, lifecycle and SQLite", async () => {
  const db = new Database(":memory:"),
    store = new ManagedHarnessLifecycleStore(db);
  const diag = store.begin(context);
  if (!diag) throw new Error("fixture");
  const f = fixture(),
    frames = observe(f, diag),
    secret = `native-${crypto.randomUUID()}`;
  await sendMessage(f.process, reserved, probe, false, diag);
  const command = JSON.parse(new TextDecoder().decode(f.writes[0]));
  const foreignId = crypto.randomUUID();
  for (const command_uuid of [command.uuid, foreignId, undefined, secret])
    f.output(
      `${JSON.stringify({ type: "command_lifecycle", state: "queued", command_uuid, uuid: secret, session_id: secret, extra: secret })}\n`,
    );
  await tick();
  const evidence = diag.snapshot();
  expect(evidence.outputCensus.commandLifecycle.probeCorrelation).toEqual({
    match: 1,
    mismatch: 1,
    missing_or_invalid: 2,
    unavailable: 0,
  });
  expect(evidence.outputCensus.frameValidated).toBe(false);
  expect(evidence.observations.protocol_frame_observed).toBe("not_observed");
  expect(evidence.lastProvenStage).toBe("probe_write_acknowledged");
  expect(evidence.nativeAttestationInterval).toBe("unknown");
  expect(
    evidence.events.find((e) => e.stage === "probe_write_requested")
      ?.operationId,
  ).toBeUndefined();
  const serialized = JSON.stringify(
    db.query("SELECT * FROM managed_harness_lifecycle").all(),
  );
  for (const id of [command.uuid, foreignId, secret]) {
    expect(serialized.includes(id)).toBe(false);
    expect(JSON.stringify(diag).includes(id)).toBe(false);
  }
  await expect(waitForInit(frames, 10)).rejects.toThrow();
  await f.process.cancel();
  db.close();
});

test("probe binding requires exact observed attachment/session, is immutable, and cannot bind late", async () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context),
    h = f.process.handle;
  const owned = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  diag.bindProcess(h);
  diag.bindProbeCommand(foreign, reserved, h); // observer not registered
  observe(f, diag);
  for (const wrong of [
    { ...h, processGeneration: "wrong" },
    { ...h, environment: { ...ref, incarnation: "wrong" } },
  ])
    diag.bindProbeCommand(foreign, reserved, wrong);
  diag.bindProbeCommand(foreign, "wrong-session", h);
  diag.bindProbeCommand("invalid", reserved, h);
  diag.bindProbeCommand(owned, reserved, h);
  diag.bindProbeCommand(foreign, reserved, h); // cannot rebind
  diag.observeClaudeOutput(
    { kind: "json", value: { type: "command_lifecycle", command_uuid: owned } },
    h,
  );
  expect(
    diag.snapshot().outputCensus.commandLifecycle.probeCorrelation,
  ).toEqual({ match: 1, mismatch: 0, missing_or_invalid: 0, unavailable: 0 });
  const late = new ManagedHarnessLifecycle(context);
  late.bindProcess(h);
  late.record("stream_observation_registered", h);
  late.record("probe_write_requested", h, { operationId: foreign });
  late.bindProbeCommand(foreign, reserved, h);
  late.observeClaudeOutput(
    {
      kind: "json",
      value: { type: "command_lifecycle", command_uuid: foreign },
    },
    h,
  );
  expect(
    late.snapshot().outputCensus.commandLifecycle.probeCorrelation.unavailable,
  ).toBe(1);
  expect(JSON.stringify(late.snapshot()).includes(foreign)).toBe(false);
  const timedOut = new ManagedHarnessLifecycle(context);
  timedOut.bindProcess(h);
  timedOut.record("stream_observation_registered", h);
  timedOut.record("attestation_timeout_fired", h);
  timedOut.bindProbeCommand(foreign, reserved, h);
  timedOut.observeClaudeOutput(
    {
      kind: "json",
      value: { type: "command_lifecycle", command_uuid: foreign },
    },
    h,
  );
  expect(
    timedOut.snapshot().outputCensus.commandLifecycle.probeCorrelation
      .unavailable,
  ).toBe(1);
  await f.process.cancel();
});

test("throwing probe-correlation observer cannot suppress or alter fixed probe submission", async () => {
  const f = fixture(),
    diag = new ManagedHarnessLifecycle(context),
    secret = `observer-${crypto.randomUUID()}`;
  observe(f, diag);
  diag.bindProbeCommand = () => {
    throw new Error(secret);
  };
  await sendMessage(f.process, reserved, probe, false, diag);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.byteLength).toBe(301);
  expect(diag.snapshot().observations.probe_write_acknowledged).toBe(
    "observed",
  );
  expect(JSON.stringify(diag.snapshot()).includes(secret)).toBe(false);
  await f.process.cancel();
});
