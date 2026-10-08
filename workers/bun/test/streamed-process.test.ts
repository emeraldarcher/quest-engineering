import { expect, test } from "bun:test";
import {
  FakeExecutionEnvironmentBackend,
  FakeStreamedProcessTransport,
} from "../src/execution-environment/fake.ts";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import type {
  StreamedProcess,
  StreamedProcessCommand,
  StreamedProcessInfrastructureEvent,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";

const encoder = new TextEncoder();

function command(
  lease: Awaited<ReturnType<FakeExecutionEnvironmentBackend["ensure"]>>,
  overrides: Partial<StreamedProcessCommand> = {},
): StreamedProcessCommand {
  return {
    executable: "/usr/bin/python3",
    args: ["-u", "-c", "literal"],
    cwd: lease.paths.workspace,
    environment: {},
    ...overrides,
  };
}

function identity(label: string) {
  return {
    backendProcessId: `pid-${label}`,
    processStartIdentity: `start-${label}`,
    observedExecutable: "/usr/bin/python3",
  };
}

async function setup(runId = "run-streamed") {
  let transport: FakeStreamedProcessTransport | null = null;
  let requested: StreamedProcessCommand | null = null;
  const events: StreamedProcessInfrastructureEvent[] = [];
  const backend = new FakeExecutionEnvironmentBackend({
    spawnStreamed: (context) => {
      requested = context.command;
      transport = new FakeStreamedProcessTransport(
        identity(context.processGeneration),
      );
      return transport;
    },
    onStreamedProcessEvent: (event) => events.push(event),
  });
  const lease = await backend.ensure(spec(runId));
  return {
    backend,
    lease,
    events,
    get transport() {
      if (!transport) throw new Error("stream transport was not opened");
      return transport;
    },
    get requested() {
      if (!requested) throw new Error("stream command was not captured");
      return requested;
    },
  };
}

test("streamed process launches one exact executable with literal argv and no shell interpretation", async () => {
  const value = await setup("run-exact-launch");
  const hostileArgs = [
    "-u",
    "-c",
    "literal",
    "; echo not-a-command",
    "$(touch /host/nope)",
    "space preserved",
  ];
  const process = await value.lease.spawnStreamed(
    command(value.lease, {
      args: hostileArgs,
      environment: { EXPLICIT_VALUE: "bounded" },
    }),
  );

  expect(value.requested).toEqual({
    executable: "/usr/bin/python3",
    args: hostileArgs,
    cwd: value.lease.paths.workspace,
    environment: { EXPLICIT_VALUE: "bounded" },
  });
  expect(process.handle).toMatchObject({
    backendKind: "fake",
    environment: value.lease.ref,
    executable: "/usr/bin/python3",
    observedExecutable: "/usr/bin/python3",
  });
  expect(value.requested.executable).not.toMatch(/(?:^|\/)sh$/);
  await expect(
    value.lease.reconcileStreamedProcess({
      ...process.handle,
      backendProcessId: "replacement-pid",
    }),
  ).rejects.toMatchObject({
    code: "streamed_process_identity_mismatch",
    operation: "inspect_streamed",
  });
  await process.disconnect();
});

test("streamed process rejects PATH launch, cwd escape, invalid environment, and oversized argv", async () => {
  const value = await setup("run-input-validation");
  await expect(
    value.lease.spawnStreamed(command(value.lease, { executable: "python3" })),
  ).rejects.toMatchObject({
    code: "streamed_process_spawn_failed",
    operation: "spawn_streamed",
  });
  await expect(
    value.lease.spawnStreamed(command(value.lease, { cwd: "/host" })),
  ).rejects.toMatchObject({ code: "streamed_process_spawn_failed" });
  await expect(
    value.lease.spawnStreamed(
      command(value.lease, { environment: { "BAD-NAME": "value" } }),
    ),
  ).rejects.toMatchObject({ code: "streamed_process_spawn_failed" });
  await expect(
    value.lease.spawnStreamed(
      command(value.lease, {
        environment: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`VALUE_${index}`, "x"]),
        ),
      }),
    ),
  ).rejects.toMatchObject({ code: "streamed_process_spawn_failed" });
  await expect(
    value.lease.spawnStreamed(
      command(value.lease, { args: ["x".repeat(256 * 1024 + 1)] }),
    ),
  ).rejects.toMatchObject({ code: "streamed_process_spawn_failed" });
});

test("stdout and stderr preserve ordered chunks, binary bytes, explicit EOF, and terminal exit", async () => {
  const value = await setup("run-byte-streams");
  const process = await value.lease.spawnStreamed(command(value.lease));
  const stdout = collect(process.stdout);
  const stderr = collect(process.stderr);

  value.transport.emitStdout(new Uint8Array([0xff, 0x00]));
  value.transport.emitStdout(new Uint8Array([0x01, 0x02]));
  value.transport.emitStderr(new Uint8Array([0x80]));
  value.transport.emitStderr(new Uint8Array([0x81, 0x82]));
  value.transport.emitEof("stdout");
  value.transport.emitEof("stderr");
  value.transport.emitExit({ kind: "exited", exitCode: 0 });

  expect(await stdout).toEqual([
    { kind: "data", sequence: 0, data: new Uint8Array([0xff, 0x00]) },
    { kind: "data", sequence: 1, data: new Uint8Array([0x01, 0x02]) },
    { kind: "eof", sequence: 2 },
  ]);
  expect(await stderr).toEqual([
    { kind: "data", sequence: 0, data: new Uint8Array([0x80]) },
    { kind: "data", sequence: 1, data: new Uint8Array([0x81, 0x82]) },
    { kind: "eof", sequence: 2 },
  ]);
  expect(await process.exit).toEqual({ kind: "exited", exitCode: 0 });
});

test("stdin distinguishes acknowledged, rejected-before-ack, and ambiguous writes without replay", async () => {
  const value = await setup("run-write-certainty");
  const process = await value.lease.spawnStreamed(command(value.lease));
  const acknowledged = encoder.encode("first\n");
  expect(await process.write(acknowledged)).toMatchObject({
    certainty: "acknowledged",
    byteLength: acknowledged.byteLength,
  });

  value.transport.nextWriteOutcome("rejected");
  await expect(
    process.write(encoder.encode("rejected\n")),
  ).rejects.toMatchObject({
    code: "streamed_process_write_rejected",
    operation: "write_streamed",
  });

  value.transport.nextWriteOutcome("ambiguous");
  await expect(
    process.write(encoder.encode("uncertain\n")),
  ).rejects.toMatchObject({
    code: "streamed_process_write_uncertain",
    operation: "write_streamed",
  });
  const writesAfterAmbiguity = value.transport.writes.length;
  await expect(
    process.write(encoder.encode("must-not-replay\n")),
  ).rejects.toMatchObject({ code: "streamed_process_write_rejected" });
  expect(value.transport.writes).toHaveLength(writesAfterAmbiguity);
  expect(value.events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      "stdin_write_requested",
      "stdin_write_acknowledged",
      "stdin_write_ambiguous",
    ]),
  );
  expect(
    value.events.some((event) =>
      Object.values(event).some((item) => item === "uncertain\n"),
    ),
  ).toBe(false);
  await process.disconnect();
});

test("exit outcomes keep nonzero and physical cancellation distinct from semantic completion", async () => {
  const nonzero = await setup("run-nonzero");
  const failed = await nonzero.lease.spawnStreamed(command(nonzero.lease));
  nonzero.transport.emitEof("stdout");
  nonzero.transport.emitEof("stderr");
  nonzero.transport.emitExit({ kind: "exited_nonzero", exitCode: 23 });
  expect(await failed.exit).toEqual({ kind: "exited_nonzero", exitCode: 23 });

  const cancelled = await setup("run-cancelled");
  const process = await cancelled.lease.spawnStreamed(command(cancelled.lease));
  expect(await process.cancel()).toMatchObject({ certainty: "acknowledged" });
  expect(await process.exit).toEqual({ kind: "signaled", signal: "SIGTERM" });
  expect(cancelled.transport.cancellationIds).toHaveLength(1);
  expect(cancelled.events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      "process_cancel_requested",
      "process_cancelled",
      "process_exit_observed",
    ]),
  );
});

test("stale process handles cannot touch a replacement environment incarnation", async () => {
  const value = await setup("run-replacement-fence");
  const process = await value.lease.spawnStreamed(command(value.lease));
  await value.backend.stop(value.lease.ref);
  await value.backend.remove(value.lease.ref);
  const cancelledBeforeReplacementCalls =
    value.transport.cancellationIds.length;
  const replacement = await value.backend.ensure(spec("run-replacement-fence"));
  expect(replacement.ref.incarnation).not.toBe(value.lease.ref.incarnation);

  await expect(process.write(encoder.encode("stale"))).rejects.toMatchObject({
    code: "stale_environment_ref",
  });
  await expect(process.cancel()).rejects.toMatchObject({
    code: "stale_environment_ref",
  });
  await expect(process.inspect()).rejects.toMatchObject({
    code: "stale_environment_ref",
  });
  expect(value.transport.cancellationIds).toHaveLength(
    cancelledBeforeReplacementCalls,
  );
});

test("bounded queues backpressure producers and consumer disconnect closes the attachment", async () => {
  const value = await setup("run-backpressure");
  const process = await value.lease.spawnStreamed(command(value.lease), {
    bufferBytes: 4,
  });
  value.transport.emitStdout(encoder.encode("aaaa"));
  value.transport.emitStdout(encoder.encode("bbbb"));
  value.transport.emitStdout(encoder.encode("cccc"));
  await turn();
  expect(value.transport.deliveredEvents).toBe(2);

  const iterator = process.stdout[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({
    done: false,
    value: { kind: "data", data: encoder.encode("aaaa") },
  });
  await turn();
  expect(value.transport.deliveredEvents).toBe(3);
  await iterator.return?.();
  expect(value.transport.disconnected).toBe(true);
  expect(await process.exit).toEqual({
    kind: "observation_unavailable",
    errorCode: "streamed_process_stream_unavailable",
  });
});

test("Run teardown retires streams before environment stop/remove", async () => {
  const value = await setup("run-teardown");
  const process = await value.lease.spawnStreamed(command(value.lease));
  expect(
    await cleanupExecutionEnvironment(value.backend, value.lease.ref),
  ).toEqual({ state: "removed" });
  expect(value.transport.cancellationIds).toHaveLength(1);
  expect(value.transport.disconnected).toBe(true);
  expect(await process.exit).toEqual({ kind: "signaled", signal: "SIGTERM" });
  expect(
    await value.backend.currentEnvironment(value.lease.ref.runId),
  ).toBeNull();
});

test("backend loss is an explicit stream error and unavailable terminal observation", async () => {
  const value = await setup("run-backend-loss");
  const process = await value.lease.spawnStreamed(command(value.lease));
  const stdout = collect(process.stdout);
  const stderr = collect(process.stderr);
  value.transport.failTransport("backend_unavailable");

  expect(await stdout).toContainEqual({
    kind: "transport_error",
    sequence: 0,
    errorCode: "backend_unavailable",
  });
  expect(await stderr).toContainEqual({
    kind: "transport_error",
    sequence: 0,
    errorCode: "backend_unavailable",
  });
  expect(await process.exit).toEqual({
    kind: "observation_unavailable",
    errorCode: "backend_unavailable",
  });
});

test("detached reconciliation separates process evidence from non-recoverable stdio", async () => {
  const value = await setup("run-restart-classification");
  const process = await value.lease.spawnStreamed(command(value.lease));
  const handle = structuredClone(process.handle);
  await process.disconnect();

  expect(await value.lease.reconcileStreamedProcess(handle)).toEqual({
    handle,
    process: "unavailable",
    streamAttachment: "unavailable",
    streamRecovery: "not_recoverable",
  });
});

test("a byte consumer can decode ordered newline-delimited events across arbitrary chunks", async () => {
  const value = await setup("run-framing-consumer");
  const process = await value.lease.spawnStreamed(command(value.lease));
  const decoded = decodeJsonLines(process.stdout);
  value.transport.emitStdout(encoder.encode('{"event":"sta'));
  value.transport.emitStdout(
    new Uint8Array([
      ...encoder.encode('rted"}\n{"event":"done","binary":"'),
      ...encoder.encode("safe"),
    ]),
  );
  value.transport.emitStdout(encoder.encode('"}\n'));
  value.transport.emitEof("stdout");
  value.transport.emitEof("stderr");
  value.transport.emitExit({ kind: "exited", exitCode: 0 });

  expect(await decoded).toEqual([
    { event: "started" },
    { event: "done", binary: "safe" },
  ]);
});

async function collect(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
): Promise<StreamedProcessStreamEvent[]> {
  const events: StreamedProcessStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function decodeJsonLines(
  stream: StreamedProcess["stdout"],
): Promise<unknown[]> {
  const decoder = new TextDecoder();
  let buffered = "";
  const values: unknown[] = [];
  for await (const event of stream) {
    if (event.kind === "data")
      buffered += decoder.decode(event.data, { stream: true });
    if (event.kind === "transport_error")
      throw new Error(`transport failed: ${event.errorCode}`);
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) values.push(JSON.parse(line));
    }
  }
  return values;
}

async function turn(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function spec(runId: string) {
  return {
    workerId: "worker-streamed-test",
    runId,
    workspace: {
      workspaceId: `workspace-${runId}`,
      access: "read_write" as const,
      materialization: {
        kind: "disposable_fixture" as const,
        sourceIdentity: `fixture:${runId}`,
        frozenBase: { kind: "fixture", value: "streamed-v1" },
      },
    },
    profile: { id: "qe-streamed-test-v1", digest: "sha256:profile" },
    resourcePolicy: { id: "test", digest: "sha256:policy" },
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [],
  };
}
