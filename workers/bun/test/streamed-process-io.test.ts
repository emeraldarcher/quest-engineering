import { expect, test } from "bun:test";
import { FakeStreamedProcessTransport } from "../src/execution-environment/fake.ts";
import {
  StreamedProcessManager,
  type StreamedProcessTransportIoSnapshot,
} from "../src/execution-environment/streamed-process.ts";
import {
  type StreamedProcessIoSample,
  safeIoSample,
} from "../src/execution-environment/streamed-process-io.ts";
import {
  EnvironmentBackendError,
  type EnvironmentRef,
  type StreamedProcessHandle,
} from "../src/execution-environment/types.ts";
import { ManagedHarnessLifecycle } from "../src/harnesses/lifecycle-diagnostics.ts";

const ref: EnvironmentRef = {
  backendKind: "fixture",
  workerId: "worker",
  environmentId: "environment",
  incarnation: "incarnation",
  owner: { kind: "run", runId: "run" },
  profile: { id: "profile", digest: "sha256:fixture" },
};
const paths = {
  workspace: "/workspace",
  state: "/state",
  control: "/control",
  home: "/home",
  cache: "/cache",
  temp: "/tmp",
};
const sample: StreamedProcessIoSample = {
  observedAt: "2026-10-24T00:00:00.000Z",
  elapsedMs: 5,
  stdin: { status: "observed", unreadBytes: 37 },
  stdoutBytes: 17,
  stderrBytes: 9,
  terminal: "not_observed",
};
async function fixture() {
  let valid = true;
  let queries = 0;
  const manager = new StreamedProcessManager({
    backendKind: ref.backendKind,
    validate: () => {
      if (!valid)
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          "not diagnostic prose",
        );
    },
  });
  const transport = new FakeStreamedProcessTransport({
    backendProcessId: "123",
    processStartIdentity: "456",
    observedExecutable: "/usr/bin/python3.14",
    observedExecutableIdentity: "1:222",
  });
  let response!: StreamedProcessTransportIoSnapshot;
  const query = async () => {
    queries++;
    return response;
  };
  const attached = Object.assign(transport, { observeIo: query });
  const process = await manager.spawn(
    ref,
    paths,
    {
      executable: "/usr/bin/python3",
      args: [],
      cwd: paths.workspace,
      environment: {},
    },
    {},
    async ({ processGeneration }) => {
      response = {
        status: "available",
        processGeneration,
        identity: transport.identity,
        sample,
        beforeCancellation: null,
      };
      return attached;
    },
  );
  return {
    manager,
    process,
    attached,
    get response() {
      return response;
    },
    set response(value) {
      response = value;
    },
    get queries() {
      return queries;
    },
    invalidate() {
      valid = false;
    },
  };
}

test("generic snapshot is bounded read-only metadata, not a stdout consumer or side effect", async () => {
  const f = await fixture();
  const value = await f.process.observeIo();
  expect(value).toMatchObject({
    status: "available",
    handle: f.process.handle,
    sample,
  });
  expect(
    f.attached.writes.length +
      f.attached.cancellationIds.length +
      f.attached.closeStdinIds.length,
  ).toBe(0);
  expect(f.queries).toBe(1);
  await f.process.disconnect();
});

test("all exact handle fences reject before a backend observation; never PID-only", async () => {
  const f = await fixture();
  const h = f.process.handle;
  const wrong: StreamedProcessHandle[] = [
    { ...h, backendKind: "other" },
    { ...h, processGeneration: "other" },
    { ...h, backendProcessId: "other" },
    { ...h, processStartIdentity: "other" },
    { ...h, executable: "/other" },
    { ...h, observedExecutable: "/other" },
    { ...h, observedExecutableIdentity: "1:333" },
    ...["environmentId", "incarnation", "workerId", "backendKind"].map(
      (key) => ({ ...h, environment: { ...h.environment, [key]: "other" } }),
    ),
    {
      ...h,
      environment: { ...h.environment, owner: { kind: "run", runId: "other" } },
    },
    {
      ...h,
      environment: {
        ...h.environment,
        profile: { id: "other", digest: h.environment.profile.digest },
      },
    },
    {
      ...h,
      environment: {
        ...h.environment,
        profile: { ...h.environment.profile, digest: "other" },
      },
    },
  ];
  for (const handle of wrong)
    expect((await f.manager.observeIo(handle)).status).toBe("unavailable");
  expect(f.queries).toBe(0);
  expect(await f.manager.observeIo(h)).toMatchObject({ status: "available" });
  await f.process.disconnect();
});

test("backend generation and PID/start/executable metadata cannot cross attachments", async () => {
  const f = await fixture();
  const good = f.response;
  if (good.status !== "available") throw new Error("fixture");
  for (const patch of [
    { processGeneration: "wrong" },
    ...[
      "backendProcessId",
      "processStartIdentity",
      "observedExecutable",
      "observedExecutableIdentity",
    ].map((key) => ({ identity: { ...good.identity, [key]: "wrong" } })),
  ]) {
    f.response = { ...good, ...patch };
    expect(await f.process.observeIo()).toEqual({
      status: "unavailable",
      reason: "identity_mismatch",
    });
  }
  await f.process.disconnect();
});

test("replacement during collection invalidates the snapshot without cancellation or retry", async () => {
  const f = await fixture();
  f.attached.observeIo = async () => {
    f.invalidate();
    return f.response;
  };
  expect(await f.process.observeIo()).toEqual({
    status: "unavailable",
    reason: "environment_unavailable",
  });
  expect(f.attached.cancellationIds).toHaveLength(0);
  await f.process.disconnect();
});

test("unsupported, throwing, disconnected and malformed observations fail open diagnostically", async () => {
  const f = await fixture();
  for (const result of [
    { status: "unavailable", reason: "unsupported" },
    { status: "unavailable", reason: "untrusted-private-error" },
    { ...f.response, sample: { ...sample, stdoutBytes: -1 } },
    {
      ...f.response,
      beforeCancellation: {
        ...sample,
        stderrBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ]) {
    f.response = result as StreamedProcessTransportIoSnapshot;
    expect((await f.process.observeIo()).status).toBe("unavailable");
    expect(await f.process.write(Uint8Array.of(1))).toMatchObject({
      certainty: "acknowledged",
    });
  }
  f.attached.observeIo = async () => {
    throw new Error("untrusted-private-error");
  };
  expect(await f.process.observeIo()).toEqual({
    status: "unavailable",
    reason: "observation_failed",
  });
  // Capability absence is distinct from failure; there is no fallback implementation.
  Object.assign(f.attached, { observeIo: undefined });
  expect(await f.process.observeIo()).toEqual({
    status: "unavailable",
    reason: "unsupported",
  });
  await f.process.disconnect();
  expect(await f.process.observeIo()).toEqual({
    status: "unavailable",
    reason: "attachment_unavailable",
  });
});

test("one in-flight observation is bounded, and a hung diagnostic cannot block write/cancel", async () => {
  const f = await fixture();
  f.attached.observeIo = () => new Promise(() => {});
  const pending = f.process.observeIo();
  expect(await f.process.observeIo()).toEqual({
    status: "unavailable",
    reason: "busy",
  });
  expect(await f.process.write(Uint8Array.of(1))).toMatchObject({
    certainty: "acknowledged",
  });
  expect(await f.process.cancel()).toMatchObject({ certainty: "acknowledged" });
  expect(await f.process.exit).toEqual({ kind: "signaled", signal: "SIGTERM" });
  expect(await pending).toEqual({ status: "unavailable", reason: "timed_out" });
  await f.process.disconnect();
});

test("sample projection accepts typed pipe-unavailable but rejects malformed scalars and drops canaries", () => {
  const canary = `synthetic-${crypto.randomUUID()}`;
  const projected = safeIoSample({
    ...sample,
    content: canary,
    hash: canary,
    stdin: { ...sample.stdin, bytes: canary },
  });
  expect(JSON.stringify(projected).includes(canary)).toBe(false);
  for (const reason of [
    "unsupported_ioctl",
    "not_pipe",
    "closed",
    "process_exited",
    "observation_failed",
  ])
    expect(
      safeIoSample({ ...sample, stdin: { status: "unavailable", reason } })
        ?.stdin.status,
    ).toBe("unavailable");
  for (const bad of [
    { ...sample, stdoutBytes: -1 },
    { ...sample, stderrBytes: 0.5 },
    { ...sample, elapsedMs: Infinity },
    { ...sample, observedAt: canary },
    {
      ...sample,
      stdin: { status: "observed", unreadBytes: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...sample, terminal: canary },
    { ...sample, stdin: { status: "unavailable", reason: canary } },
  ])
    expect(safeIoSample(bad)).toBeNull();
});

test("lifecycle persistence is allowlisted/bounded and I/O never advances native/Mod/protocol proof", async () => {
  const f = await fixture();
  const canaries = Array.from(
    { length: 3 },
    () => `synthetic-${crypto.randomUUID()}`,
  );
  const rows: unknown[] = [];
  const diag = new ManagedHarnessLifecycle(
    {
      harnessKind: "fixture",
      harnessProtocol: "fixture",
      reservedNativeSessionId: "reserved",
      environment: ref,
    },
    (row) => {
      rows.push(row);
      return true;
    },
  );
  diag.bindProcess(f.process.handle);
  diag.record("probe_write_acknowledged", f.process.handle);
  const value = f.response;
  if (value.status !== "available") throw new Error("fixture");
  f.response = {
    ...value,
    sample: {
      ...sample,
      rawStdin: canaries[0],
      rawStdout: canaries[1],
      rawStderr: canaries[2],
    },
  } as typeof value;
  diag.captureIo("probe_write_acknowledged", f.process);
  await new Promise<void>((resolve) => setImmediate(resolve));
  diag.record("attestation_timeout_fired", f.process.handle);
  for (let i = 0; i < 100; i++)
    diag.captureIo("probe_write_acknowledged", f.process);
  diag.captureIo("attestation_timeout_fired", f.process);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const evidence = diag.snapshot();
  expect(evidence.ioObservations).toHaveLength(2);
  expect(evidence.ioObservations[0]).toMatchObject({
    status: "available",
    sample,
  });
  expect(evidence).toMatchObject({
    lastProvenStage: "probe_write_acknowledged",
    processStateAtTimeout: "unknown",
    modExecution: "unestablished",
    nativeProbeParsed: "unobservable_at_this_layer",
    nativeAttestationInterval: "unknown",
  });
  expect(evidence.observations.protocol_frame_observed).toBe("not_observed");
  expect(canaries.some((s) => JSON.stringify(rows).includes(s))).toBe(false);
  await f.process.disconnect();
});

test("lifecycle refuses foreign snapshot executables and survives failed sinks and getters", async () => {
  const f = await fixture();
  const diag = new ManagedHarnessLifecycle({
    harnessKind: "fixture",
    harnessProtocol: "fixture",
    reservedNativeSessionId: "reserved",
    environment: ref,
  });
  diag.bindProcess(f.process.handle);
  const io = f.process.observeIo.bind(f.process);
  f.process.observeIo = async () => {
    const result = await io();
    return result.status === "available"
      ? {
          ...result,
          handle: { ...result.handle, observedExecutableIdentity: "3:444" },
        }
      : result;
  };
  diag.captureIo("probe_write_acknowledged", f.process);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(diag.snapshot().ioObservations[0]).toMatchObject({
    status: "unavailable",
    reason: "identity_mismatch",
  });
  f.process.observeIo = async () => {
    throw new Error("private-error");
  };
  diag.captureIo("attestation_timeout_fired", f.process);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(diag.snapshot().ioObservations[1]).toMatchObject({
    status: "unavailable",
    reason: "observation_failed",
  });
  const failing = new ManagedHarnessLifecycle(
    {
      harnessKind: "fixture",
      harnessProtocol: "fixture",
      reservedNativeSessionId: "reserved",
      environment: ref,
    },
    () => {
      throw new Error("private-error");
    },
  );
  failing.bindProcess(f.process.handle);
  expect(() =>
    failing.captureIo("probe_write_acknowledged", f.process),
  ).not.toThrow();
  expect(await f.process.cancel()).toMatchObject({ certainty: "acknowledged" });
  await f.process.disconnect();
});
