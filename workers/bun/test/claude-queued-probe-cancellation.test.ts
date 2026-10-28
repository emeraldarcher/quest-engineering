import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Console } from "node:console";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import type {
  StreamedProcess,
  StreamedProcessExit,
} from "../src/execution-environment/types.ts";
import {
  AsyncFrameQueue,
  ClaudeProtocolTimeout,
  cancelClaudePreparation,
  observeClaudeProtocol,
  pump,
  sendMessage,
  waitForInit,
} from "../src/harnesses/claude-code/protocol.ts";
import {
  type ProbeCancellationScope,
  QueuedProbeCancellation,
} from "../src/harnesses/claude-code/queued-probe-cancellation.ts";
import { ManagedHarnessLifecycleStore } from "../src/harnesses/lifecycle-diagnostics.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function ticks() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
interface SyntheticReply extends Record<string, unknown> {
  response: {
    subtype: string;
    request_id?: unknown;
    response?: Record<string, unknown>;
    error?: string;
  };
}
const sessionId = "11111111-1111-4111-8111-111111111111";
function fixture(publish: (v: unknown) => void = () => undefined) {
  const requests: Record<string, unknown>[] = [],
    writes: Uint8Array[] = [],
    events: string[] = [];
  const end = deferred<StreamedProcessExit>(),
    cancelled = deferred<{
      certainty: "acknowledged";
      cancellationId: string;
    }>();
  let now = 0;
  const process = {
    handle: {
      contractVersion: 1,
      backendKind: "fake",
      environment: {
        backendKind: "fake",
        workerId: "worker",
        environmentId: "environment",
        incarnation: "incarnation",
        owner: {
          kind: "provider_account",
          providerAccountId: "account",
          credentialGeneration: 1,
        },
        profile: { id: "profile", digest: "digest" },
      },
      processGeneration: "generation",
      backendProcessId: "123",
      processStartIdentity: "start",
      executable: "/fixture/claude",
      observedExecutable: "/fixture/claude",
    },
    exit: end.promise,
    write: async (bytes: Uint8Array) => {
      writes.push(bytes);
      return {
        certainty: "acknowledged" as const,
        writeId: "fixture-write",
        byteLength: bytes.byteLength,
      };
    },
    tryWriteDiagnostic: (bytes: Uint8Array) => {
      events.push("diagnostic");
      requests.push(JSON.parse(new TextDecoder().decode(bytes)));
      return true;
    },
    cancel: () => {
      events.push("physical");
      return cancelled.promise;
    },
  } as unknown as StreamedProcess;
  const scope: ProbeCancellationScope = {
    runId: "run",
    attemptId: "attempt",
    actionId: "action",
    lineageId: "lineage",
    sessionId,
    process,
  };
  let current: ProbeCancellationScope | null = scope;
  const capability = new QueuedProbeCancellation(
    scope,
    () => current,
    publish,
    () => now,
  );
  return {
    scope,
    process,
    capability,
    requests,
    writes,
    events,
    end,
    cancelled,
    setCurrent: (value: ProbeCancellationScope | null) => {
      current = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    bind: async () => {
      await sendMessage(
        process,
        sessionId,
        "Quest Engineering fixed zero-inference initialization probe.",
        false,
        null,
        capability,
      );
      capability.arm(30_000);
    },
    timeout: () => {
      now = 30_000;
      capability.atTimeout(process);
    },
    reply: (value: unknown, requestId?: unknown) => ({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId ?? requests[0]?.request_id,
        response: { cancelled: value },
      },
    }),
  };
}

test("distinct outbound authority targets exactly the unchanged 301-byte probe once", async () => {
  const f = fixture();
  await f.bind();
  expect(f.requests).toHaveLength(0);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.byteLength).toBe(301);
  const probe = JSON.parse(new TextDecoder().decode(f.writes[0]));
  f.timeout();
  f.timeout();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toEqual({
    type: "control_request",
    request_id: expect.any(String),
    request: { subtype: "cancel_async_message", message_uuid: probe.uuid },
  });
  expect(f.capability.snapshot()).toEqual({
    request: "queued_cancel_request_sent",
    response: "response_unavailable",
  });
});
for (const key of [
  "runId",
  "attemptId",
  "actionId",
  "lineageId",
  "sessionId",
] as const) {
  test(`capability rejects wrong ${key}`, async () => {
    const f = fixture();
    await f.bind();
    f.setNow(30_000);
    f.setCurrent({ ...f.scope, [key]: "wrong" });
    f.capability.atTimeout(f.process);
    expect(f.requests).toHaveLength(0);
    expect(f.capability.snapshot().request).toBe(
      "queued_cancel_request_unavailable",
    );
  });
  test(`capability rejects missing ${key}`, async () => {
    const f = fixture();
    await f.bind();
    f.setCurrent({ ...f.scope, [key]: "" });
    f.timeout();
    expect(f.requests).toHaveLength(0);
  });
}
for (const reason of [
  "wrong_attachment",
  "changed_handle",
  "terminal_ack",
  "teardown",
  "rebind",
  "recovery",
] as const)
  test(`capability revoked/fenced: ${reason}`, async () => {
    const f = fixture();
    await f.bind();
    if (reason === "wrong_attachment")
      f.setCurrent({ ...f.scope, process: { ...f.process } });
    else if (reason === "changed_handle")
      f.process.handle.processGeneration = "replacement";
    else if (reason === "terminal_ack") f.setCurrent(null);
    else f.capability.invalidate();
    f.timeout();
    expect(f.requests).toHaveLength(0);
  });
test("no early dispatch and no rearming/retry after an early misuse", async () => {
  const f = fixture();
  await f.bind();
  f.capability.atTimeout(f.process);
  f.timeout();
  expect(f.requests).toHaveLength(0);
});
test("no authority without an outbound probe/ACK", () => {
  const f = fixture();
  f.capability.arm(0);
  f.timeout();
  expect(f.requests).toHaveLength(0);
});
test("wrong byte-count ACK disables capability without changing probe bytes", async () => {
  const f = fixture();
  f.process.write = async () => ({
    certainty: "acknowledged",
    writeId: "fixture",
    byteLength: 1,
  });
  await f.bind();
  f.timeout();
  expect(f.requests).toHaveLength(0);
});
for (const kind of ["unsupported", "busy", "throws"] as const)
  test(`diagnostic dispatch ${kind} cannot prevent physical cancel`, async () => {
    const f = fixture();
    await f.bind();
    f.setNow(30_000);
    if (kind === "unsupported") delete f.process.tryWriteDiagnostic;
    else
      f.process.tryWriteDiagnostic = () => {
        if (kind === "throws") throw Error("private-transport-canary");
        return false;
      };
    const cancellation = cancelClaudePreparation(f.process, null, f.capability);
    expect(f.events).toEqual(["physical"]);
    expect(f.capability.snapshot()).toEqual({
      request: "queued_cancel_request_unavailable",
      response: "response_unavailable",
    });
    f.cancelled.resolve({
      certainty: "acknowledged",
      cancellationId: "fixture",
    });
    await cancellation;
  });
for (const value of [true, false])
  test(`only correlated literal cancelled:${value} is classified`, async () => {
    const f = fixture();
    await f.bind();
    f.timeout();
    expect(f.capability.observe(f.reply(value), f.process)).toBe(true);
    expect(f.capability.snapshot().response).toBe(
      value ? "cancelled_true" : "cancelled_false",
    );
  });
for (const value of [undefined, null, 0, 1, "false", [], {}])
  test(`correlated malformed cancelled ${JSON.stringify(value)}`, async () => {
    const f = fixture();
    await f.bind();
    f.timeout();
    f.capability.observe(f.reply(value), f.process);
    expect(f.capability.snapshot().response).toBe("response_malformed");
  });
for (const kind of [
  "wrong_request",
  "missing_request",
  "wrong_session",
  "wrong_command",
  "missing_body",
  "native_error",
  "late_response",
  "wrong_source",
] as const)
  test(`response ${kind} is never optimistically attributed`, async () => {
    const f = fixture();
    await f.bind();
    f.timeout();
    const frame: SyntheticReply = f.reply(false);
    if (kind === "wrong_request") frame.response.request_id = "foreign-request";
    if (kind === "missing_request") delete frame.response.request_id;
    if (kind === "wrong_session") frame.session_id = "foreign-session";
    if (kind === "wrong_command" && frame.response.response)
      frame.response.response.command_uuid = "foreign-command";
    if (kind === "missing_body") delete frame.response.response;
    if (kind === "native_error")
      frame.response = {
        ...frame.response,
        subtype: "error",
        error: "private-error-canary",
      };
    if (kind === "late_response") f.capability.invalidate();
    f.capability.observe(
      frame,
      kind === "wrong_source" ? { ...f.process } : f.process,
    );
    expect(f.capability.snapshot().response).toBe(
      ["missing_body", "native_error"].includes(kind)
        ? "response_malformed"
        : "response_unavailable",
    );
  });
test("foreign reply does not prevent a later reliably correlated reply", async () => {
  const f = fixture();
  await f.bind();
  f.timeout();
  f.capability.observe(f.reply(false, "foreign"), f.process);
  f.capability.observe(f.reply(true), f.process);
  expect(f.capability.snapshot().response).toBe("cancelled_true");
});
test("no reply before shutdown remains unavailable; terminal ACK invalidates", async () => {
  const f = fixture();
  await f.bind();
  f.setNow(30_000);
  const p = cancelClaudePreparation(f.process, null, f.capability);
  expect(f.events).toEqual(["diagnostic", "physical"]);
  f.cancelled.resolve({ certainty: "acknowledged", cancellationId: "fixture" });
  await p;
  f.capability.observe(f.reply(true), f.process);
  expect(f.capability.snapshot().response).toBe("response_unavailable");
});

test("capability and projected evidence expose no identifier through serialization/inspection/errors/SQLite", async () => {
  const db = new Database(":memory:");
  const store = new ManagedHarnessLifecycleStore(db);
  const outputs: unknown[] = [];
  const f = fixture((v) => {
    outputs.push(v);
    diagnostics?.recordQueuedProbeCancellation(v as never, f.process.handle);
  });
  // The pre-existing canonical reservation is intentionally independent of this
  // new diagnostic artifact. No new copy of the capability's session is saved.
  const diagnostics = store.begin({
    harnessKind: "claude_code",
    harnessProtocol: "fixture",
    reservedNativeSessionId: "existing-reservation",
    environment: f.process.handle.environment,
  });
  diagnostics?.bindProcess(f.process.handle);
  diagnostics?.record("stream_observation_registered", f.process.handle);
  await f.bind();
  diagnostics?.record("attestation_timeout_fired", f.process.handle);
  f.timeout();
  const probe = JSON.parse(new TextDecoder().decode(f.writes[0]));
  const response: SyntheticReply = f.reply(true);
  response.uuid = "native-event-canary";
  Object.assign(response.response.response ?? {}, {
    private: "private-payload-canary",
  });
  f.capability.observe(response, f.process);
  diagnostics?.record("cancellation_requested", f.process.handle); // existing persistence checkpoint
  let logs = "";
  const logger = new Console({
    stdout: new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  });
  logger.log(f.capability);
  logger.warn(f.capability);
  logger.error(f.capability);
  logger.dir(f.capability, { showHidden: true, depth: 20 });
  const exposed = [
    logs,
    inspect(f.capability),
    inspect(f.capability, {
      showHidden: true,
      customInspect: false,
      depth: 10,
    }),
    Bun.inspect(f.capability),
    Bun.inspect(f.capability, { depth: 20, colors: false }),
    JSON.stringify(Object.getOwnPropertyDescriptors(f.capability)),
    JSON.stringify(outputs),
    JSON.stringify(diagnostics?.snapshot()),
    JSON.stringify(
      db.query("SELECT evidence_json FROM managed_harness_lifecycle").all(),
    ),
  ].join("\n");
  for (const secret of [
    probe.uuid,
    f.requests[0]?.request_id,
    sessionId,
    "native-event-canary",
    "private-payload-canary",
  ])
    expect(exposed).not.toContain(secret as string);
  for (const operation of [
    () => JSON.stringify(f.capability),
    () => structuredClone(f.capability),
    () => createHash("sha256").update(f.capability as never),
    () => String(f.capability),
  ]) {
    let text = "";
    try {
      operation();
    } catch (e) {
      text = inspect(e);
    }
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(probe.uuid);
    expect(text).not.toContain(sessionId);
  }
  expect(Object.isFrozen(f.capability)).toBe(true);
  db.close();
});

for (const value of [true, false])
  test(`diagnostic ${value} stays out of readiness frame queue and validation`, async () => {
    const f = fixture();
    await f.bind();
    f.timeout();
    const db = new Database(":memory:");
    const store = new ManagedHarnessLifecycleStore(db);
    const d = store.begin({
      harnessKind: "claude_code",
      harnessProtocol: "fixture",
      reservedNativeSessionId: sessionId,
      environment: f.process.handle.environment,
    });
    d?.bindProcess(f.process.handle);
    d?.record("stream_observation_registered", f.process.handle);
    d?.record("attestation_timeout_fired", f.process.handle);
    const frames = new AsyncFrameQueue();
    async function* stream() {
      yield {
        kind: "data" as const,
        sequence: 0,
        data: new TextEncoder().encode(`${JSON.stringify(f.reply(value))}\n`),
      };
    }
    await pump(
      stream(),
      frames,
      (frame) => d?.observeInit(frame, f.process.handle),
      (unit) => d?.observeClaudeOutput(unit, f.process.handle),
      (frame) => f.capability.observe(frame, f.process),
    );
    expect(frames.cursor).toBe(0);
    expect(d?.snapshot().outputCensus.frameValidated).toBe(false);
    expect(d?.snapshot().outputCensus.counters.systemInitCandidateCount).toBe(
      0,
    );
    await expect(waitForInit(frames, 30_000)).rejects.toThrow();
    db.close();
  });
test("partial shutdown response is never classified as false", async () => {
  const f = fixture();
  await f.bind();
  f.timeout();
  const frames = new AsyncFrameQueue();
  async function* stream() {
    yield {
      kind: "data" as const,
      sequence: 0,
      data: new TextEncoder().encode('{"type":"control_response"'),
    };
  }
  await expect(
    pump(stream(), frames, undefined, undefined, (frame) =>
      f.capability.observe(frame, f.process),
    ),
  ).rejects.toThrow();
  expect(f.capability.snapshot().response).toBe("response_unavailable");
});

for (const key of [
  "processGeneration",
  "backendProcessId",
  "processStartIdentity",
  "executable",
  "backendKind",
] as const)
  test(`missing physical identity ${key} is unavailable`, async () => {
    const f = fixture();
    f.process.handle[key] = "";
    await f.bind();
    f.timeout();
    expect(f.requests).toHaveLength(0);
  });

test("native-provided identities cannot choose the cancellation target", async () => {
  const f = fixture();
  const message = {
    type: "user",
    shouldQuery: false,
    session_id: sessionId,
    uuid: "native-command-canary",
  };
  f.capability.prepareProbe(message, f.process, sessionId);
  f.capability.acknowledgeProbe(f.process, sessionId);
  f.capability.arm(30_000);
  f.timeout();
  expect(message.uuid).not.toBe("native-command-canary");
  expect(f.requests[0]?.request).toEqual({
    subtype: "cancel_async_message",
    message_uuid: message.uuid,
  });
});

test("missing capability at the timeout records unavailability and still cancels", async () => {
  const f = fixture();
  const db = new Database(":memory:");
  const store = new ManagedHarnessLifecycleStore(db);
  const d = store.begin({
    harnessKind: "claude_code",
    harnessProtocol: "fixture",
    reservedNativeSessionId: sessionId,
    environment: f.process.handle.environment,
  });
  d?.bindProcess(f.process.handle);
  d?.record("attestation_timeout_fired", f.process.handle);
  const p = cancelClaudePreparation(f.process, d, null);
  expect(f.events).toEqual(["physical"]);
  expect(d?.snapshot().queuedProbeCancellation).toEqual({
    request: "queued_cancel_request_unavailable",
    response: "response_unavailable",
  });
  f.cancelled.resolve({ certainty: "acknowledged", cancellationId: "fixture" });
  await p;
  db.close();
});

test("legacy lifecycle rows remain byte-for-byte documents without new defaults", () => {
  const db = new Database(":memory:");
  const store = new ManagedHarnessLifecycleStore(db);
  const legacy = {
    schemaVersion: 1,
    protocol: "managed_harness_lifecycle_v1",
    preparationId: "historical",
    historical: "unchanged",
  };
  db.query("INSERT INTO managed_harness_lifecycle VALUES (?,?)").run(
    "historical",
    JSON.stringify(legacy),
  );
  expect(JSON.stringify(store.get("historical"))).toBe(JSON.stringify(legacy));
  expect(
    Object.hasOwn(store.get("historical") ?? {}, "queuedProbeCancellation"),
  ).toBe(false);
  db.close();
});

for (const terminal of ["stdout_eof", "process_exit"] as const)
  test(`protocol ${terminal} revokes capability without a response wait`, async () => {
    const f = fixture();
    await f.bind();
    f.timeout();
    async function* stream() {
      if (terminal === "stdout_eof")
        yield { kind: "eof" as const, sequence: 0 };
      else await new Promise<void>(() => {});
    }
    Object.defineProperty(f.process, "stdout", { value: stream() });
    observeClaudeProtocol(
      f.process,
      new AsyncFrameQueue(),
      null,
      () => true,
      f.capability,
    );
    if (terminal === "process_exit")
      f.end.resolve({ kind: "signaled", signal: "SIGTERM" });
    await ticks();
    f.capability.observe(f.reply(true), f.process);
    expect(f.capability.snapshot().response).toBe("response_unavailable");
    f.end.resolve({ kind: "signaled", signal: "SIGTERM" });
  });

// Virtual scheduler: the real production waitForInit timer fires, but no wall
// clock sleep/transport-response/grace period is involved.
test("deadline -> diagnostic attempt -> physical cancel in the same virtual instant, without response wait", async () => {
  const f = fixture();
  await f.bind();
  let now = 0;
  const tasks = new Map<object, () => void>();
  const saved = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void) => {
    const token = { unref() {} };
    tasks.set(token, callback);
    return token;
  }) as never;
  globalThis.clearTimeout = ((token: object) => {
    tasks.delete(token);
  }) as never;
  try {
    const frames = new AsyncFrameQueue();
    const waiting = (async () => {
      try {
        await waitForInit(frames, 30_000, () => f.events.push("timeout"));
      } catch (error) {
        await cancelClaudePreparation(f.process, null, f.capability);
        throw error;
      }
    })();
    const outcome = waiting.then(
      () => null,
      (error) => error,
    );
    expect(tasks.size).toBe(1);
    now = 30_000;
    f.setNow(now);
    for (const task of [...tasks.values()]) task();
    await ticks();
    expect(f.events).toEqual(["timeout", "diagnostic", "physical"]);
    expect(now).toBe(30_000);
    // No native response is supplied and physical cancellation is already issued.
    expect(f.capability.snapshot().response).toBe("response_unavailable");
    f.cancelled.resolve({
      certainty: "acknowledged",
      cancellationId: "fixture",
    });
    expect(await outcome).toBeInstanceOf(ClaudeProtocolTimeout);
  } finally {
    Date.now = saved.now;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
  }
});
