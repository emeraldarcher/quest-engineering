import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type { ProviderAccountRuntimeAuthority } from "../src/execution-environment/provider-account.ts";
import type {
  EnvironmentLease,
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessExit,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_EFFORT,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_NAME,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
  ClaudeCodeHarness,
} from "../src/harnesses/claude-code/adapter.ts";
import {
  CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
  CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
} from "../src/harnesses/claude-code/output-tags.ts";
import {
  AsyncFrameQueue,
  ClaudeProtocolTimeout,
} from "../src/harnesses/claude-code/protocol.ts";
import { ClaudeCodeSessionStore } from "../src/harnesses/claude-code/session-store.ts";
import type { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("ClaudeCodeHarness prepares credential generation 2 in the retained generation-1 cell with only a non-query message", async () => {
  const root = await testRoot();
  const candidate = claudeAction();
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "claude_code",
  );
  const accepted = registry.accept(candidate).dispatch;
  registry.occupy(accepted.lineageId as string, accepted.action.action_id);
  const lineage = registry.getLineage(accepted.lineageId as string);
  const environment = accountEnvironment();
  const process = syntheticInitProcess(environment);
  const writes: Array<Record<string, unknown>> = [];
  process.onWrite = (frame) => writes.push(frame);
  const lease = accountLease(environment, process);
  const binding = brokerBinding(accepted.action.action_id, environment);
  let originalAdmissionCurrent = true;
  let acquisitions = 0;
  let accountAuthority: ProviderAccountRuntimeAuthority = {
    providerAccountId: binding.providerAccountId,
    credentialGeneration: binding.credentialGeneration,
    ref: environment,
    assertCurrent: () => {
      if (!originalAdmissionCurrent)
        throw new Error("Previous admission revoked");
    },
  };
  const client = {
    sessionId: "broker-session-1",
    request: async () => {
      throw new Error(
        "No workspace request is permitted before prompt authorization.",
      );
    },
    close: async () => undefined,
  };
  const sessionStore = new ClaudeCodeSessionStore(root);
  const harness = new ClaudeCodeHarness(
    { workerId: "worker-test", dataRoot: root } as WorkerConfig,
    {
      prepare: async () => ({ materializedArtifacts: {} }),
    } as never,
    {
      claudeCodeRuntime: async (input: {
        providerAccountId: string;
        credentialGeneration: number;
        authority: ProviderAccountRuntimeAuthority;
      }) => {
        acquisitions++;
        expect(input).toEqual({
          providerAccountId: "account-1",
          credentialGeneration: 2,
          authority: accountAuthority,
        });
        expect(input.authority.ref.owner).toMatchObject({
          credentialGeneration: 1,
        });
        return {
          lease,
          ref: environment,
          configRoot: "/qe/state/claude/config",
          cwd: "/qe/state/claude/empty-cwd",
          assertCurrent: input.authority.assertCurrent,
        };
      },
      withSerializedAccount: async (
        _account: string,
        operation: () => Promise<unknown>,
      ) => operation(),
      retireClaudeAccountProcesses: async () => undefined,
    } as never,
    () =>
      ({
        boundClientForAction: () => ({ binding, client, accountAuthority }),
      }) as unknown as WorkspaceToolBroker,
    sessionStore,
  );

  const prepared = await harness.start(accepted, lineage);
  await harness.ready(accepted, prepared);
  expect(writes.filter((frame) => frame.type === "user")).toHaveLength(1);
  expect(
    writes.filter((frame) => frame.type === "control_request"),
  ).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    type: "user",
    shouldQuery: false,
    isSynthetic: true,
    session_id: prepared.handle.nativeSession?.payload.opaqueId,
  });
  expect(
    String((writes[0]?.message as { content?: string }).content),
  ).toContain("zero-inference");
  expect(await harness.inspect(lineage)).toMatchObject({
    state: "starting",
    activity: { state: "idle" },
    health: "healthy",
    nativeSession: prepared.handle.nativeSession,
  });
  expect(process.queryWrites).toBe(0);
  const originalAuthority = accountAuthority;
  originalAdmissionCurrent = false;
  accountAuthority = { ...accountAuthority, assertCurrent: () => undefined };
  expect(() => originalAuthority.assertCurrent()).toThrow(
    "Previous admission revoked",
  );
  const continued = await harness.continue(accepted, lineage);
  await harness.ready(accepted, continued);
  expect(continued.handle.nativeSession).toEqual(prepared.handle.nativeSession);
  expect(acquisitions).toBe(2);
  expect(writes.filter((frame) => frame.type === "user")).toHaveLength(1);
  expect(
    writes.filter((frame) => frame.type === "control_request"),
  ).toHaveLength(2);
  expect(process.queryWrites).toBe(0);
  await harness.close(lineage);
  const db = new (await import("bun:sqlite")).Database(
    join(root, "claude-code-sessions-v1.sqlite"),
    { readonly: true },
  );
  const row = db
    .query("SELECT evidence_json FROM managed_harness_lifecycle")
    .get() as { evidence_json: string };
  expect(JSON.parse(row.evidence_json)).toMatchObject({
    lastProvenStage: "protocol_frame_validated",
    context: { lineageId: lineage.lineageId },
    observations: {
      probe_write_acknowledged: "observed",
      process_exit_observed: "observed",
    },
    modExecution: "unestablished",
  });
  db.close();
  sessionStore.close();
  registry.close();
});

test("Claude init requires OAuth provenance in addition to the exact Mod and tool inventory", () => {
  const frame = initFrame("11111111-1111-4111-8111-111111111111");
  expect(() =>
    attestClaudeInit(frame, {
      sessionId: frame.session_id as string,
      cwd: frame.cwd as string,
      model: CLAUDE_CODE_MODEL,
    }),
  ).not.toThrow();
  frame.apiKeySource = "apiKeyHelper";
  expect(() =>
    attestClaudeInit(frame, {
      sessionId: frame.session_id as string,
      cwd: frame.cwd as string,
      model: CLAUDE_CODE_MODEL,
    }),
  ).toThrow();
});

for (const applied of [
  { model: CLAUDE_CODE_MODEL, effort: "high" },
  { model: CLAUDE_CODE_MODEL },
  { model: CLAUDE_CODE_MODEL, effort: null },
  { model: CLAUDE_CODE_MODEL, effort: "medium" },
  { model: CLAUDE_CODE_MODEL, effort: "unsupported" },
  { model: "claude-sonnet-4-6", effort: "high" },
]) {
  test(`real managed preparation requires independent native applied configuration: ${JSON.stringify(applied)}`, async () => {
    const fixture = await effortHarness(applied);
    const preparing = fixture.harness.start(fixture.dispatch, fixture.lineage);
    if (applied.model === CLAUDE_CODE_MODEL && applied.effort === "high") {
      const prepared = await preparing;
      await fixture.harness.ready(fixture.dispatch, prepared);
    } else {
      await expect(preparing).rejects.toMatchObject({
        code: "environment_attestation_failed",
        phase: "readiness",
      });
    }
    expect(fixture.process.queryWrites).toBe(0);
    await fixture.harness.close(fixture.lineage);
    fixture.registry.close();
    fixture.store.close();
  });
}

test("a previously ready continuation rejects an effective-effort override instead of reusing its ready flag", async () => {
  const fixture = await effortHarness({
    model: CLAUDE_CODE_MODEL,
    effort: "high",
  });
  const prepared = await fixture.harness.start(
    fixture.dispatch,
    fixture.lineage,
  );
  await fixture.harness.ready(fixture.dispatch, prepared);
  fixture.process.appliedSettings.effort = "low";
  await expect(
    fixture.harness.continue(fixture.dispatch, fixture.lineage),
  ).rejects.toMatchObject({
    code: "environment_attestation_failed",
    phase: "readiness",
  });
  await expect(
    fixture.harness.ready(fixture.dispatch, prepared),
  ).rejects.toThrow("Claude Code execution is not active.");
  expect(fixture.process.queryWrites).toBe(0);
  await fixture.harness.close(fixture.lineage);
  fixture.registry.close();
  fixture.store.close();
});

test("full managed readiness with native applied proof succeeds with diagnostic evidence unavailable", async () => {
  const fixture = await effortHarness({
    model: CLAUDE_CODE_MODEL,
    effort: "high",
  });
  fixture.store.lifecycle.begin = () => null;
  const prepared = await fixture.harness.start(
    fixture.dispatch,
    fixture.lineage,
  );
  await fixture.harness.ready(fixture.dispatch, prepared);
  expect(fixture.process.queryWrites).toBe(0);
  await fixture.harness.close(fixture.lineage);
  fixture.registry.close();
  fixture.store.close();
});

for (const io of ["hung", "throwing"] as const) {
  test(`full managed readiness and close survive ${io} I/O diagnostics with only the bounded pre-probe wait`, async () => {
    const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
    f.process.observeIo =
      io === "hung"
        ? () => new Promise(() => {})
        : async () => {
            throw new Error("PRIVATE_DIAGNOSTIC_ERROR");
          };
    const prepared = await f.harness.start(f.dispatch, f.lineage);
    await f.harness.ready(f.dispatch, prepared);
    expect(f.process.queryWrites).toBe(0);
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  });
}

for (const reasoning of [null, "low", "medium", "xhigh", "unsupported"]) {
  test(`configured QE effort ${reasoning} fails before native launch, without fallback`, async () => {
    const fixture = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      reasoning,
    );
    await expect(
      fixture.harness.start(fixture.dispatch, fixture.lineage),
    ).rejects.toMatchObject({
      code: "incompatible_continuation_configuration",
    });
    expect(fixture.nativeSpawns()).toBe(0);
    expect(fixture.process.queryWrites).toBe(0);
    fixture.registry.close();
    fixture.store.close();
  });
}

// Full production prepare/ready path under in-memory streams and fake leases.
// No native executable, SDK, Product entity or infrastructure operation.
for (const family of [
  ...CLAUDE_NATIVE_PRIVATE_ROOT_TYPES.map((type) => ({ type })),
  ...CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES.map((subtype) => ({
    type: "system",
    subtype,
  })),
])
  for (const withInit of [false, true]) {
    test(`native-private family cannot grant readiness: ${JSON.stringify(family)}, separate init=${withInit}`, async () => {
      const f = await effortHarness({
        model: CLAUDE_CODE_MODEL,
        effort: "high",
      });
      const writes: Record<string, unknown>[] = [];
      f.process.onWrite = (frame) => writes.push(frame);
      f.process.probeFrames = (sessionId) => [
        {
          ...initFrame(sessionId),
          ...family,
          state: "queued",
          command_uuid: writes[0]?.uuid,
        },
        ...(withInit ? [initFrame(sessionId)] : []),
      ];
      f.process.endProbeOutput = !withInit;
      if (withInit) {
        const prepared = await f.harness.start(f.dispatch, f.lineage);
        await f.harness.ready(f.dispatch, prepared);
        expect(prepared.handle.nativeSession).toBeDefined();
      } else {
        await expect(
          f.harness.start(f.dispatch, f.lineage),
        ).rejects.toMatchObject({
          code: "environment_attestation_failed",
          phase: "readiness",
        });
        await expect(
          f.harness.ready(f.dispatch, { lineage: f.lineage } as never),
        ).rejects.toThrow("not active");
        expect(f.store.get(writes[0]?.session_id as string)?.state).toBe(
          "uncertain",
        );
      }
      expect(writes.filter((x) => x.type === "control_request")).toHaveLength(
        withInit ? 1 : 0,
      );
      expect(f.process.queryWrites).toBe(0);
      const db = new (await import("bun:sqlite")).Database(
        join(f.storeRoot, "claude-code-sessions-v1.sqlite"),
        { readonly: true },
      );
      const row = db
        .query("SELECT evidence_json FROM managed_harness_lifecycle")
        .get() as { evidence_json: string };
      const evidence = JSON.parse(row.evidence_json);
      expect(evidence.outputCensus.frameValidated).toBe(withInit);
      expect(evidence.outputCensus.counters.systemInitCandidateCount).toBe(
        withInit ? 1 : 0,
      );
      expect(evidence.observations.protocol_frame_observed).toBe(
        withInit ? "observed" : "not_observed",
      );
      expect(row.evidence_json.includes(writes[0]?.uuid as string)).toBe(false);
      db.close();
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    });
  }

for (const cancelled of [true, false])
  for (const lateInit of [false, true])
    test(`timeout diagnostic ${cancelled}, late independent init=${lateInit}: failure and authority remain unchanged`, async () => {
      const f = await effortHarness({
        model: CLAUDE_CODE_MODEL,
        effort: "high",
      });
      f.process.probeFrames = () => [];
      const priorNativeRef = f.registry.getLineage(
        f.lineage.lineageId,
      ).nativeSession;
      const events: string[] = [];
      let now = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
        async () => {
          now = 30_000;
          throw new ClaudeProtocolTimeout();
        },
      );
      let release!: () => void;
      const physical = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalCancel = f.process.cancel;
      f.process.cancel = async () => {
        events.push("physical");
        await physical;
        return originalCancel();
      };
      f.process.tryWriteDiagnostic = (bytes) => {
        events.push("diagnostic");
        const request = JSON.parse(new TextDecoder().decode(bytes));
        f.process.emitFrame({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: request.request_id,
            response: {
              cancelled,
              applied: { model: CLAUDE_CODE_MODEL, effort: "high" },
            },
          },
        });
        if (lateInit) {
          const reservation = f.store.forLineage(f.lineage.lineageId);
          f.process.emitFrame(
            initFrame(reservation?.nativeSessionId ?? "missing"),
          );
        }
        return true;
      };
      try {
        const outcome = f.harness.start(f.dispatch, f.lineage).then(
          (value) => value,
          (error) => error,
        );
        for (let i = 0; i < 120; i++) await Promise.resolve();
        expect(events).toEqual(["diagnostic", "physical"]);
        expect(now).toBe(30_000);
        expect(f.ownershipReads()).toBe(1);
        // Native response can arrive while physical cancellation is pending.
        const before = (
          f.harness as unknown as {
            active: Map<string, { initialized: boolean }>;
          }
        ).active.get(f.lineage.lineageId);
        expect(before?.initialized).toBe(false);
        release();
        expect(await outcome).toMatchObject({
          code: "environment_attestation_failed",
          phase: "readiness",
        });
        await expect(
          f.harness.ready(f.dispatch, { lineage: f.lineage } as never),
        ).rejects.toThrow("not active");
        const db = new (await import("bun:sqlite")).Database(
          join(f.storeRoot, "claude-code-sessions-v1.sqlite"),
          { readonly: true },
        );
        const row = db
          .query("SELECT evidence_json FROM managed_harness_lifecycle")
          .get() as { evidence_json: string };
        const evidence = JSON.parse(row.evidence_json);
        expect(evidence.queuedProbeCancellation).toEqual({
          request: "queued_cancel_request_sent",
          response: cancelled ? "cancelled_true" : "cancelled_false",
        });
        expect(evidence.outputCensus.frameValidated).toBe(false);
        expect(
          f.registry.getLineage(f.lineage.lineageId).nativeSession,
        ).toEqual(priorNativeRef);
        expect(
          f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
        ).toBeNull();
        expect(
          f.registry.get(f.dispatch.action.action_id).promptIntentAt,
        ).toBeNull();
        expect(f.store.forLineage(f.lineage.lineageId)?.state).toBe(
          "uncertain",
        );
        expect(f.process.queryWrites).toBe(0);
        db.close();
      } finally {
        release();
        clock.mockRestore();
        next.mockRestore();
        await f.harness.close(f.lineage);
        f.registry.close();
        f.store.close();
      }
    });

test("actual terminal ACK path revokes probe capability before subsequent timeout", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const executor = new DispatchExecutor(
    f.registry,
    f.harness,
    async () => false,
  );
  f.process.probeFrames = () => [];
  let now = 0,
    diagnosticWrites = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
    async () => {
      now = 30_000;
      throw new ClaudeProtocolTimeout();
    },
  );
  f.process.tryWriteDiagnostic = () => {
    diagnosticWrites++;
    return true;
  };
  f.process.onWrite = (frame) => {
    if (frame.shouldQuery === false) {
      f.registry.fail(f.dispatch.action.action_id, {
        code: "fixture_terminal",
      });
      void executor.acknowledgeTerminal(f.dispatch.action.action_id);
    }
  };
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "environment_attestation_failed",
    });
    expect(
      f.registry.get(f.dispatch.action.action_id).serverAcknowledgedAt,
    ).not.toBeNull();
    expect(diagnosticWrites).toBe(0);
    expect(f.process.queryWrites).toBe(0);
  } finally {
    clock.mockRestore();
    next.mockRestore();
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

test("terminal ACK before capability creation cannot resurrect diagnostic authority", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const executor = new DispatchExecutor(
    f.registry,
    f.harness,
    async () => false,
  );
  f.registry.fail(f.dispatch.action.action_id, { code: "fixture_terminal" });
  await executor.acknowledgeTerminal(f.dispatch.action.action_id);
  f.process.probeFrames = () => [];
  let now = 0,
    diagnosticWrites = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
    async () => {
      now = 30_000;
      throw new ClaudeProtocolTimeout();
    },
  );
  f.process.tryWriteDiagnostic = () => {
    diagnosticWrites++;
    return true;
  };
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "environment_attestation_failed",
    });
    expect(diagnosticWrites).toBe(0);
    expect(f.ownershipReads()).toBe(1);
  } finally {
    clock.mockRestore();
    next.mockRestore();
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

for (const handoff of [
  "disconnected",
  "new_generation",
  "before_creation",
] as const)
  test(`review: generation handoff ${handoff} cannot retain or reconstruct probe authority`, async () => {
    let generation: number | null = 1;
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => generation,
    );
    f.process.probeFrames = () => [];
    let now = 0,
      writes = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
      async () => {
        now = 30_000;
        throw new ClaudeProtocolTimeout();
      },
    );
    f.process.tryWriteDiagnostic = () => {
      writes++;
      return true;
    };
    if (handoff === "before_creation")
      f.lease.spawnStreamed = async () => {
        generation = 2;
        return f.process;
      };
    else
      f.process.onWrite = (frame) => {
        if (frame.shouldQuery === false)
          generation = handoff === "disconnected" ? null : 2;
      };
    try {
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({ code: "environment_attestation_failed" });
      expect(writes).toBe(0);
      expect(f.process.queryWrites).toBe(0);
    } finally {
      clock.mockRestore();
      next.mockRestore();
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    }
  });

test("review: canonical cancellation revokes before a pending HumanAttention cleanup await", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  f.process.probeFrames = () => [];
  let now = 0,
    writes = 0,
    releaseAttention!: () => void,
    enteredAttention!: () => void,
    rejectFrame!: (error: Error) => void,
    enteredRead!: () => void;
  const attention = new Promise<void>((resolve) => {
    releaseAttention = resolve;
  });
  const attentionEntered = new Promise<void>((resolve) => {
    enteredAttention = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  const control = {
    cancelPendingHumanAttention: () => {
      enteredAttention();
      return attention;
    },
  };
  const executor = new DispatchExecutor(
    f.registry,
    f.harness,
    async () => false,
    async () => false,
    control as never,
  );
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
    () => {
      enteredRead();
      return new Promise((_resolve, reject) => {
        rejectFrame = reject;
      });
    },
  );
  f.process.tryWriteDiagnostic = () => {
    writes++;
    return true;
  };
  const outcome = f.harness.start(f.dispatch, f.lineage).then(
    (value) => value,
    (error) => error,
  );
  let cancel: Promise<void> | undefined;
  try {
    await reading;
    cancel = executor.cancel({
      type: "cancel_dispatch",
      protocol_version: f.dispatch.action.protocol_version,
      worker_id: f.dispatch.action.worker_id,
      connection_generation: 1,
      action_id: f.dispatch.action.action_id,
      run_id: f.dispatch.action.run_id,
      occurrence_id: f.dispatch.action.occurrence_id,
      attempt_id: f.dispatch.action.attempt_id,
      cancellation: {
        request_id: "review-cancel",
        origin: "product_operator",
        reason: null,
        requested_at: new Date().toISOString(),
      },
    });
    await attentionEntered;
    expect(f.registry.get(f.dispatch.action.action_id).state).toBe("failed");
    now = 30_000;
    rejectFrame(new ClaudeProtocolTimeout());
    expect(await outcome).toMatchObject({
      code: "environment_attestation_failed",
    });
    expect(writes).toBe(0);
  } finally {
    releaseAttention();
    await cancel;
    clock.mockRestore();
    next.mockRestore();
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

async function effortHarness(
  applied: Record<string, unknown>,
  reasoning: string | null = "high",
  diagnosticGeneration: () => number | null = () => 1,
) {
  const root = await testRoot();
  const candidate = claudeAction();
  candidate.execution.configuration.reasoning = reasoning;
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "claude_code",
  );
  const dispatch = registry.accept(candidate).dispatch;
  registry.occupy(dispatch.lineageId as string, dispatch.action.action_id);
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const environment = accountEnvironment();
  const process = syntheticInitProcess(environment);
  process.appliedSettings = applied;
  const lease = accountLease(environment, process);
  let spawns = 0;
  lease.spawnStreamed = async () => {
    spawns++;
    return process;
  };
  const binding = brokerBinding(dispatch.action.action_id, environment);
  const store = new ClaudeCodeSessionStore(root);
  const accountAuthority = {
    providerAccountId: binding.providerAccountId,
    credentialGeneration: binding.credentialGeneration,
    ref: environment,
    assertCurrent: () => undefined,
  };
  let ownershipReads = 0;
  const harness = new ClaudeCodeHarness(
    { workerId: "worker-test", dataRoot: root } as WorkerConfig,
    { prepare: async () => ({ materializedArtifacts: {} }) } as never,
    {
      claudeCodeRuntime: async () => ({
        lease,
        ref: environment,
        configRoot: "/qe/state/claude/config",
        cwd: "/qe/state/claude/empty-cwd",
        assertCurrent: accountAuthority.assertCurrent,
      }),
      withSerializedAccount: async (_id: string, run: () => Promise<unknown>) =>
        run(),
    } as never,
    () =>
      ({
        boundClientForAction: () => ({
          binding,
          accountAuthority,
          client: {
            sessionId: "broker-session-1",
            close: async () => undefined,
          },
        }),
      }) as unknown as WorkspaceToolBroker,
    store,
    (actionId) => {
      ownershipReads++;
      return registry.get(actionId);
    },
    () => {
      const generation = diagnosticGeneration();
      return generation === null ? null : `1:${generation}`;
    },
  );
  return {
    harness,
    dispatch,
    lineage,
    process,
    registry,
    store,
    nativeSpawns: () => spawns,
    ownershipReads: () => ownershipReads,
    lease,
    storeRoot: root,
  };
}

function claudeAction() {
  const base = action();
  return action({
    execution: {
      ...base.execution,
      configuration: {
        ...base.execution.configuration,
        harness_kind: "claude_code",
        model: { provider: "anthropic", model: CLAUDE_CODE_MODEL },
        reasoning: CLAUDE_CODE_EFFORT,
        reasoning_capability: {
          kind: "enumerated",
          values: [CLAUDE_CODE_EFFORT],
        },
        tool_policy: {
          kind: "exact",
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
        tool_enforcement: "exact",
        resolved_tool_profile: {
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
      },
    },
  });
}

function accountEnvironment(): EnvironmentRef {
  return {
    backendKind: "fake-sbx",
    environmentId: "claude-account-environment-1",
    incarnation: "claude-account-incarnation-1",
    workerId: "worker-test",
    owner: {
      kind: "provider_account",
      providerAccountId: "account-1",
      credentialGeneration: 1,
    },
    profile: { id: "qe-claude-account-v2", digest: `sha256:${"a".repeat(64)}` },
  };
}

function accountLease(
  ref: EnvironmentRef,
  process: SyntheticInitProcess,
): EnvironmentLease {
  return {
    ref,
    paths: {
      workspace: "/qe/workspaces/default",
      state: "/qe/state",
      control: "/qe/control",
      home: "/home/agent",
      cache: "/qe/cache",
      temp: "/qe/tmp",
    },
    capabilities: [
      { kind: "credentials", mode: "account_private_claude_oauth" },
      { kind: "network_policy", mode: "anthropic_account_only" },
      { kind: "harness_runtime", mode: "claude_code_managed_mod_v1" },
      { kind: "control_channel", mode: "worker_account_mailbox_v1" },
      { kind: "process.streamed", mode: "attached_only" },
    ],
    exec: async (command: Parameters<EnvironmentLease["exec"]>[0]) => {
      if (command.args[0] === "auth")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
            analyticsDisabled: true,
            projectsDirectory: "/qe/state/claude/config/projects",
            configDirectory: "/qe/state/claude/config",
            email: null,
            orgId: null,
            orgName: null,
            subscriptionType: null,
          }),
          stderr: "",
        };
      return { exitCode: 0, stdout: "[]\n", stderr: "" };
    },
    workerExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    spawnStreamed: async () => process,
    writeFile: async (input: Parameters<EnvironmentLease["writeFile"]>[0]) => ({
      path: input.path,
      byteLength: input.data.byteLength,
      sha256: "a".repeat(64),
    }),
    readFile: async () => new Uint8Array(),
    reconcileStreamedProcess: async () => ({
      handle: process.handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    retireStreamedProcesses: async () => undefined,
    launcher: async () => {
      throw new Error("not used");
    },
  } as unknown as EnvironmentLease;
}

function brokerBinding(actionId: string, environment: EnvironmentRef) {
  return {
    authorizationId: "authorization-1",
    sessionId: "broker-session-1",
    brokerGeneration: 1,
    providerAccountId: "account-1",
    credentialGeneration: 2,
    accountEnvironmentGeneration: 1,
    accountEnvironment: {
      backendKind: environment.backendKind,
      environmentId: environment.environmentId,
      incarnation: environment.incarnation,
    },
    runEnvironment: {
      backendKind: "fake-run",
      environmentId: "run-environment-1",
      incarnation: "run-incarnation-1",
    },
    runId: "run-1",
    actionId,
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    operationalEpoch: 0,
    operationalAttempt: 1,
    physicalLineageId: "physical-lineage-1",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    worktreeId: "00000000-0000-4000-8000-000000000002",
    workspaceBindingId: "00000000-0000-4000-8000-000000000003",
    workspaceAccess: "read_write" as const,
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    workerId: "worker-test",
    workerGeneration: 1,
  };
}

interface SyntheticInitProcess extends StreamedProcess {
  onWrite: (frame: Record<string, unknown>) => void;
  queryWrites: number;
  appliedSettings: Record<string, unknown>;
  probeFrames: ((sessionId: string) => Record<string, unknown>[]) | null;
  endProbeOutput: boolean;
  emitFrame(frame: Record<string, unknown>): void;
}

function syntheticInitProcess(
  environment: EnvironmentRef,
): SyntheticInitProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => (stdoutController = controller),
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => (stderrController = controller),
  });
  let settleExit!: (value: StreamedProcessExit) => void;
  const exit = new Promise<StreamedProcessExit>(
    (resolve) => (settleExit = resolve),
  );
  let sequence = 0,
    stdoutClosed = false,
    cancelled = false;
  const handle = {
    contractVersion: 1 as const,
    backendKind: environment.backendKind,
    environment,
    backendProcessId: "1000",
    processStartIdentity: "start-1",
    processGeneration: "process-generation-1",
    executable: "/opt/qe/claude/claude",
    observedExecutable: "/opt/qe/claude/claude",
  };
  const process: SyntheticInitProcess = {
    handle,
    stdout: stream(stdout, () => ++sequence),
    stderr: stream(stderr, () => ++sequence),
    exit,
    onWrite: () => undefined,
    queryWrites: 0,
    appliedSettings: { model: CLAUDE_CODE_MODEL, effort: CLAUDE_CODE_EFFORT },
    probeFrames: null,
    endProbeOutput: false,
    emitFrame: (frame) =>
      stdoutController.enqueue(
        new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
      ),
    write: async (data) => {
      const frame = JSON.parse(new TextDecoder().decode(data)) as Record<
        string,
        unknown
      >;
      process.onWrite(frame);
      if (frame.type === "control_request") {
        expect(frame.request).toEqual({ subtype: "get_settings" });
        stdoutController.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: frame.request_id,
                response: { applied: process.appliedSettings },
              },
            })}\n`,
          ),
        );
      } else if (frame.shouldQuery !== false) process.queryWrites += 1;
      else {
        const sessionId = frame.session_id as string;
        for (const output of process.probeFrames?.(sessionId) ?? [
          initFrame(sessionId),
        ])
          stdoutController.enqueue(
            new TextEncoder().encode(`${JSON.stringify(output)}\n`),
          );
        if (process.endProbeOutput) {
          stdoutClosed = true;
          stdoutController.close();
        }
      }
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: data.byteLength,
      };
    },
    closeStdin: async () => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: 0,
    }),
    cancel: async () => {
      if (!cancelled) {
        cancelled = true;
        if (!stdoutClosed) {
          stdoutClosed = true;
          stdoutController.close();
        }
        stderrController.close();
        settleExit({ kind: "signaled", signal: "SIGTERM" });
      }
      return { certainty: "acknowledged", cancellationId: crypto.randomUUID() };
    },
    inspect: async () => ({
      handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    observeIo: async () => ({ status: "unavailable", reason: "unsupported" }),
    disconnect: async () => undefined,
  };
  return process;
}

function initFrame(sessionId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.292",
    apiKeySource: "oauth",
    cwd: "/qe/state/claude/empty-cwd",
    model: CLAUDE_CODE_MODEL,
    permissionMode: "dontAsk",
    tools: [...CLAUDE_CODE_TOOLS],
    mcp_servers: [],
    skills: [],
    agents: [],
    plugins: [
      {
        name: CLAUDE_CODE_PLUGIN_NAME,
        path: CLAUDE_CODE_PLUGIN_PATH,
        version: "1.0.0",
      },
      { name: "cc-plugin-sec-default", path: "builtin" },
    ],
  };
}

async function* stream(
  readable: ReadableStream<Uint8Array>,
  nextSequence: () => number,
): AsyncIterable<StreamedProcessStreamEvent> {
  const reader = readable.getReader();
  for (;;) {
    const value = await reader.read();
    if (value.done) break;
    yield { kind: "data", sequence: nextSequence(), data: value.value };
  }
  yield { kind: "eof", sequence: nextSequence() };
}

async function testRoot(): Promise<string> {
  const parent = resolve(import.meta.dir, "../.pi/tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-code-adapter-"));
  roots.push(root);
  return root;
}
