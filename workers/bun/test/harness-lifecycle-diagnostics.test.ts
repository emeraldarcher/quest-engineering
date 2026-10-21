import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type {
  EnvironmentRef,
  StreamedProcessExit,
  StreamedProcessHandle,
} from "../src/execution-environment/types.ts";
import {
  LIFECYCLE_PROGRESS,
  ManagedHarnessLifecycle,
  ManagedHarnessLifecycleStore,
} from "../src/harnesses/lifecycle-diagnostics.ts";

const ref: EnvironmentRef = {
  backendKind: "fake-sbx",
  workerId: "worker-1",
  environmentId: "environment-1",
  incarnation: "incarnation-1",
  owner: {
    kind: "provider_account",
    providerAccountId: "account-1",
    credentialGeneration: 1,
  },
  profile: { id: "qe-claude-account-v2", digest: `sha256:${"a".repeat(64)}` },
};
const context = {
  harnessKind: "claude_code",
  harnessProtocol: "qe_claude_account_cell_v1",
  reservedNativeSessionId: "native-session-1",
  environment: ref,
};
const handle: StreamedProcessHandle = {
  contractVersion: 1,
  backendKind: ref.backendKind,
  environment: ref,
  backendProcessId: "123",
  processStartIdentity: "456",
  processGeneration: "process-1",
  executable: "/opt/qe/claude/claude",
};

for (const last of LIFECYCLE_PROGRESS) {
  test(`timeout/exit preserves last positive Worker progress: ${last}`, () => {
    const db = new Database(":memory:");
    const store = new ManagedHarnessLifecycleStore(db);
    const monitor = store.begin(context);
    expect(monitor).not.toBeNull();
    if (!monitor) throw new Error("fixture monitor unavailable");
    monitor.record("process_launch_requested");
    if (last !== "process_launch_requested") monitor.bindProcess(handle);
    for (const stage of LIFECYCLE_PROGRESS.slice(2)) {
      if (LIFECYCLE_PROGRESS.indexOf(stage) > LIFECYCLE_PROGRESS.indexOf(last))
        break;
      monitor.record(stage, handle);
    }
    if (last !== "process_launch_requested") {
      monitor.record("attestation_timeout_fired", handle);
      monitor.record("process_exit_observed", handle, {
        exit: { kind: "exited_nonzero", exitCode: 143 },
      });
      // An exit observed after the timer is not proof of timeout-time liveness.
      expect(monitor.snapshot().processStateAtTimeout).toBe("unknown");
    }
    expect(monitor.snapshot().lastProvenStage).toBe(last);
    expect(store.get(monitor.preparationId)?.lastProvenStage).toBe(last);
    expect(monitor.snapshot()).toMatchObject({
      modExecution: "unestablished",
      modEntrypoint: "unobservable_at_this_layer",
      modReady: "unobservable_at_this_layer",
      nativeProbeParsed: "unobservable_at_this_layer",
      nativeInitConstructed: "unobservable_at_this_layer",
      nativeInitSubmitted: "unobservable_at_this_layer",
    });
    db.close();
  });
}

test("absence, dropped breadcrumbs and self-asserted Mod events are never nonexecution proof", () => {
  const monitor = new ManagedHarnessLifecycle(context);
  monitor.record("process_launch_requested");
  monitor.bindProcess(handle);
  // Simulate an optional breadcrumb intentionally not delivered.
  monitor.record("probe_write_acknowledged", handle);
  monitor.record("mod_ready" as never, handle);
  monitor.observeInit(
    { type: "system", subtype: "ui_status", text: "mod_entrypoint_started" },
    handle,
  );
  monitor.record("attestation_timeout_fired", handle);
  const evidence = monitor.snapshot();
  expect(evidence.lastProvenStage).toBe("probe_write_acknowledged");
  expect(evidence.observations.stream_observation_registered).toBe(
    "not_observed",
  );
  expect(evidence.observations.protocol_frame_observed).toBe("not_observed");
  expect(evidence.nativeAttestationInterval).toBe("unknown");
  expect(evidence.modExecution).toBe("unestablished");
  expect(JSON.stringify(evidence)).not.toMatch(/did_not|not_loaded|never_ran/);
  monitor.observeInit(
    { type: "system", subtype: "init", session_id: "native-session-1" },
    handle,
  );
  // A late response cannot rewrite the last proven stage at the timeout.
  expect(monitor.snapshot().lastProvenStage).toBe("probe_write_acknowledged");
});

test("fences environment, incarnation, owner, profile, PID/start, generation and native session", () => {
  const monitor = new ManagedHarnessLifecycle(context);
  monitor.bindProcess(handle);
  const mismatches: StreamedProcessHandle[] = [
    { ...handle, processGeneration: "other-process" },
    { ...handle, backendProcessId: "999" },
    { ...handle, processStartIdentity: "other-start" },
    { ...handle, backendKind: "other-backend" },
    { ...handle, environment: { ...ref, environmentId: "other-environment" } },
    { ...handle, environment: { ...ref, incarnation: "other-incarnation" } },
    { ...handle, environment: { ...ref, workerId: "other-worker" } },
    {
      ...handle,
      environment: { ...ref, owner: { kind: "run", runId: "other-run" } },
    },
    {
      ...handle,
      environment: {
        ...ref,
        profile: { ...ref.profile, digest: `sha256:${"b".repeat(64)}` },
      },
    },
  ];
  for (const wrong of mismatches)
    monitor.record("stream_observation_registered", wrong);
  monitor.observeInit(
    { type: "system", subtype: "init", session_id: "wrong-session" },
    handle,
  );
  expect(monitor.snapshot().observations.stream_observation_registered).toBe(
    "not_observed",
  );
  expect(monitor.snapshot().observations.protocol_frame_observed).toBe(
    "not_observed",
  );
  monitor.observeInit(
    { type: "system", subtype: "init", session_id: "native-session-1" },
    handle,
  );
  expect(monitor.snapshot().nativeAttestationInterval).toBe(
    "response_observed",
  );
  expect(monitor.snapshot().modExecution).toBe("unestablished");
});

for (const exit of [
  { kind: "exited", exitCode: 0 },
  { kind: "exited_nonzero", exitCode: 7 },
  { kind: "signaled", signal: "SIGTERM" },
  {
    kind: "observation_unavailable",
    errorCode: "streamed_process_stream_unavailable",
  },
] satisfies StreamedProcessExit[]) {
  test(`retains only safe ${exit.kind} terminal metadata`, () => {
    const monitor = new ManagedHarnessLifecycle(context);
    monitor.bindProcess(handle);
    monitor.record("process_exit_observed", handle, { exit });
    monitor.record("attestation_timeout_fired", handle);
    expect(monitor.snapshot().events.at(-2)?.exit).toEqual(exit);
    expect(monitor.snapshot().processStateAtTimeout).toBe(
      exit.kind === "observation_unavailable" ? "unknown" : "terminal_observed",
    );
  });
}

test("bounded first-observation persistence excludes surrounding native canaries", () => {
  const secret = "NATIVE_SECRET_CANARY_https://secret.invalid/code?token=abc";
  const db = new Database(":memory:");
  const store = new ManagedHarnessLifecycleStore(db);
  const monitor = store.begin({ ...context, prompt: secret } as never);
  if (!monitor) throw new Error("fixture monitor unavailable");
  monitor.bindProcess({ ...handle, rawOutput: secret } as never);
  const init = {
    type: "system",
    subtype: "init",
    session_id: "native-session-1",
    provider_output: secret,
    credentials: secret,
    error: secret,
  };
  monitor.observeInit(init, handle);
  for (let i = 0; i < 100; i++) monitor.observeInit(init, handle);
  monitor.record("process_exit_observed", handle, {
    exit: { kind: "exited_nonzero", exitCode: 7, stderr: secret } as never,
  });
  const row = db
    .query("SELECT evidence_json FROM managed_harness_lifecycle")
    .get();
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(JSON.stringify(monitor.snapshot())).not.toContain(secret);
  expect(store.get(monitor.preparationId)?.events).toHaveLength(3);
  db.close();
});

test("failed persistence never makes lifecycle recording a correctness dependency", () => {
  const monitor = new ManagedHarnessLifecycle(context, () => {
    throw new Error("SENSITIVE_PERSISTENCE_ERROR_CANARY");
  });
  expect(() => monitor.bindProcess(handle)).not.toThrow();
  expect(() =>
    monitor.record("probe_write_acknowledged", handle),
  ).not.toThrow();
  expect(monitor.snapshot()).toMatchObject({
    lastProvenStage: "probe_write_acknowledged",
    persistence: "unknown",
  });
});
