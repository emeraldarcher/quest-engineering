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
import type { ExecuteAction } from "../src/protocol/types.ts";
import type { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import {
  preprobeRelay,
  rawReadyCases,
  readyIdentity,
} from "./support/preprobe-relay.ts";
import {
  productAcceptanceReceipt,
  productPreprobeAction,
} from "./support/product-preprobe-wire.ts";
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
    (actionId) => registry.get(actionId),
    () => "1:1",
    () => "1:1",
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
      code: "diagnostic_capability_unavailable",
    });
    expect(diagnosticWrites).toBe(0);
    expect(f.process.probeWrites).toBe(0);
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
      ).rejects.toMatchObject({
        code:
          handoff === "before_creation"
            ? "diagnostic_capability_unavailable"
            : "environment_attestation_failed",
      });
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

for (const loss of [
  "canonical_action",
  "all",
  "disconnect",
  "interrupt",
  "close",
] as const)
  test(`preprobe: ${loss} revocation while spawn awaits prevents resurrection before durable cancellation`, async () => {
    const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
    const spawn = f.lease.spawnStreamed;
    f.lease.spawnStreamed = async (...args) => {
      const process = await spawn(...args);
      if (loss === "canonical_action")
        f.harness.revokeDiagnosticCapabilities(f.dispatch.action.action_id);
      else if (loss === "all") f.harness.revokeDiagnosticCapabilities();
      else if (loss === "disconnect") f.harness.disconnect();
      else if (loss === "interrupt") await f.harness.interrupt(f.lineage);
      else await f.harness.close(f.lineage);
      return process;
    };
    try {
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({ code: "diagnostic_capability_unavailable" });
      expect(f.process.probeWrites).toBe(0);
      expect(f.process.cancelCalls).toBe(1);
      expect(f.process.queryWrites).toBe(0);
      expect(f.registry.get(f.dispatch.action.action_id).state).toBe(
        "accepted",
      );
    } finally {
      f.harness.disconnect();
      f.registry.close();
      f.store.close();
    }
  });

test("preprobe: another Action's revocation cannot remove this pending preparation", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const spawn = f.lease.spawnStreamed;
  f.lease.spawnStreamed = async (...args) => {
    const process = await spawn(...args);
    f.harness.revokeDiagnosticCapabilities("other-action");
    return process;
  };
  try {
    await f.harness.start(f.dispatch, f.lineage);
    expect(f.process.probeWrites).toBe(1);
    expect(f.process.queryWrites).toBe(0);
  } finally {
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

test("preprobe: supported live metadata permits one unchanged Product-initial probe, not inference", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const writes: Uint8Array[] = [];
  const write = f.process.write.bind(f.process);
  f.process.write = async (bytes, guard) => {
    writes.push(bytes);
    return write(bytes, guard);
  };
  try {
    const prepared = await f.harness.start(f.dispatch, f.lineage);
    await f.harness.ready(f.dispatch, prepared);
    expect(f.process.probeWrites).toBe(1);
    expect(writes[0]?.byteLength).toBe(301);
    expect(f.nativeSpawns()).toBe(1);
    const evidence = await preprobeEvidence(f.storeRoot);
    expect(evidence.probeDiagnosticCapability).toBe("supported");
    expect(evidence.outputCensus.frameValidated).toBe(true);
    expect(
      f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
    ).toBeNull();
    expect(f.process.queryWrites).toBe(0);
  } finally {
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});
for (const feature of [
  "unsupported",
  "unavailable",
  "missing",
  "malformed",
  "throws",
] as const)
  test(`preprobe: ${feature} live negotiation blocks before observer/probe and cancels once`, async () => {
    const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
    let diagnosticWrites = 0;
    f.process.tryWriteDiagnostic = () => {
      diagnosticWrites++;
      return true;
    };
    if (feature === "missing") delete f.process.negotiatedCapabilities;
    else
      f.process.negotiatedCapabilities = (() => {
        if (feature === "throws") throw Error("synthetic-private-error");
        return {
          nonblockingDiagnosticWrite:
            feature === "malformed" ? "truthy" : feature,
        };
      }) as never;
    try {
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({
        code: "diagnostic_capability_unavailable",
        phase: "prepare",
        classification: "terminal_not_recoverable",
        sideEffectCertainty: "not_submitted",
      });
      expect(f.process.probeWrites).toBe(0);
      expect(diagnosticWrites).toBe(0);
      expect(f.process.cancelCalls).toBe(1);
      expect(f.nativeSpawns()).toBe(1);
      const evidence = await preprobeEvidence(f.storeRoot);
      expect(evidence.probeDiagnosticCapability).toBe(
        feature === "unsupported" ? "unsupported" : "unavailable",
      );
      expect(evidence.observations.stream_observation_registered).toBe(
        "not_observed",
      );
      expect(evidence.observations.probe_write_requested).toBe("not_observed");
      expect(evidence.outputCensus.frameValidated).toBe(false);
      expect(evidence.queuedProbeCancellation).toBeUndefined();
      expect(
        f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
      ).toBeNull();
      expect(f.process.queryWrites).toBe(0);
    } finally {
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    }
  });
for (const replacement of [
  "feature",
  "handle",
  "attachment",
  "connection_epoch",
  "registration_epoch",
  "terminal_ack",
] as const)
  test(`preprobe: ${replacement} replacement during pre-probe baseline cannot reuse earlier support`, async () => {
    let generation = 1;
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => generation,
    );
    const executor = new DispatchExecutor(
      f.registry,
      f.harness,
      async () => false,
    );
    f.process.observeIo = async () => {
      if (replacement === "feature")
        f.process.negotiatedCapabilities = () => ({
          nonblockingDiagnosticWrite: "unsupported",
        });
      if (replacement === "handle")
        f.process.handle.processGeneration = "replacement";
      if (replacement === "attachment") {
        const active = (
          f.harness as unknown as {
            active: Map<string, { process: StreamedProcess }>;
          }
        ).active.get(f.lineage.lineageId);
        if (active)
          active.process = {
            ...f.process,
            negotiatedCapabilities: () => ({
              nonblockingDiagnosticWrite: "unavailable",
            }),
          };
      }
      if (
        replacement === "connection_epoch" ||
        replacement === "registration_epoch"
      )
        generation = 2;
      if (replacement === "terminal_ack") {
        f.registry.fail(f.dispatch.action.action_id, { code: "fixture" });
        void executor.acknowledgeTerminal(f.dispatch.action.action_id);
      }
      return { status: "unavailable", reason: "unsupported" };
    };
    try {
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({ code: "diagnostic_capability_unavailable" });
      expect(f.process.probeWrites).toBe(0);
      expect(f.process.queryWrites).toBe(0);
      expect(f.process.cancelCalls).toBe(1);
      const evidence = await preprobeEvidence(f.storeRoot);
      expect(evidence.outputCensus.frameValidated).toBe(false);
    } finally {
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    }
  });
for (const shape of [
  "human_fresh",
  "retry",
  "missing_metadata",
  "replayed_acceptance",
] as const)
  test(`preprobe: ${shape} with supported relay cannot own timeout cancellation`, async () => {
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => 1,
      (candidate) => {
        if (shape === "missing_metadata") delete candidate.operational_recovery;
        else if (candidate.operational_recovery) {
          if (shape === "retry")
            candidate.operational_recovery.attempt_in_epoch = 2;
          if (shape.startsWith("human"))
            Object.assign(candidate.operational_recovery, {
              authorization_kind: "human",
              epoch_number: 1,
              source_attempt_id: "synthetic-previous",
              request_id: "synthetic-request",
              continuation_mode: "fresh",
              retained_lineage_id: null,
            });
        }
      },
    );
    if (shape === "replayed_acceptance") f.setFreshAcceptance(false);
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
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({
        code:
          shape === "replayed_acceptance"
            ? "diagnostic_capability_unavailable"
            : "environment_attestation_failed",
      });
      expect(f.process.probeWrites).toBe(
        shape === "replayed_acceptance" ? 0 : 1,
      );
      expect(diagnosticWrites).toBe(0);
      expect(f.process.queryWrites).toBe(0);
      expect(
        (await preprobeEvidence(f.storeRoot)).queuedProbeCancellation,
      ).toEqual(
        shape === "replayed_acceptance"
          ? undefined
          : {
              request: "queued_cancel_request_unavailable",
              response: "response_unavailable",
            },
      );
    } finally {
      clock.mockRestore();
      next.mockRestore();
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    }
  });
test("preprobe: generation loss after probe ACK before timeout invalidates the fresh-initial capability", async () => {
  let generation = 1;
  const f = await effortHarness(
    { model: CLAUDE_CODE_MODEL, effort: "high" },
    "high",
    () => generation,
  );
  f.process.probeFrames = () => [];
  let now = 0,
    diagnostics = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
    async () => {
      generation = 2;
      now = 30_000;
      throw new ClaudeProtocolTimeout();
    },
  );
  f.process.tryWriteDiagnostic = () => {
    diagnostics++;
    return true;
  };
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "environment_attestation_failed",
    });
    expect(f.process.probeWrites).toBe(1);
    expect(diagnostics).toBe(0);
    expect(f.process.cancelCalls).toBe(1);
  } finally {
    clock.mockRestore();
    next.mockRestore();
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});
test("preprobe: two preparations cannot borrow negotiated support from each other", async () => {
  const a = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" }),
    b = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  b.process.negotiatedCapabilities = () => ({
    nonblockingDiagnosticWrite: "unavailable",
  });
  try {
    const results = await Promise.allSettled([
      a.harness.start(a.dispatch, a.lineage),
      b.harness.start(b.dispatch, b.lineage),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(a.process.probeWrites).toBe(1);
    expect(b.process.probeWrites).toBe(0);
  } finally {
    for (const f of [a, b]) {
      await f.harness.close(f.lineage);
      f.registry.close();
      f.store.close();
    }
  }
});
test("preprobe: actual restored-session recovery uses its own READY but never creates fresh diagnostic authority", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  await f.harness.start(f.dispatch, f.lineage);
  f.harness.disconnect();
  const b = syntheticInitProcess(accountEnvironment());
  b.probeFrames = () => [];
  f.lease.spawnStreamed = async () => b;
  let now = 0,
    diagnosticWrites = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
    async () => {
      now = 30_000;
      throw new ClaudeProtocolTimeout();
    },
  );
  b.tryWriteDiagnostic = () => {
    diagnosticWrites++;
    return true;
  };
  try {
    expect((await f.harness.recover(f.lineage, f.dispatch)).found).toBe(false);
    expect(b.probeWrites).toBe(1);
    expect(diagnosticWrites).toBe(0);
    expect(b.cancelCalls).toBe(1);
    expect(b.queryWrites).toBe(0);
    expect(
      (await preprobeEvidence(f.storeRoot)).queuedProbeCancellation,
    ).toEqual({
      request: "queued_cancel_request_unavailable",
      response: "response_unavailable",
    });
  } finally {
    clock.mockRestore();
    next.mockRestore();
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

// Cross-language fixture generation is explicit; ordinary Worker-only runs do
// not pretend a manually reconstructed Product fixture is equivalent coverage.
const productWireTest = test.skipIf(!process.env.QE_PREPROBE_WIRE_DIR);

// Combined integration: no fake negotiatedCapabilities at the adapter boundary.
// Raw READY -> real SBX transport -> real manager -> full harness preparation.
for (const [name, fields, expected] of rawReadyCases)
  productWireTest(`raw READY integration: ${name}`, async () => {
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => 1,
      () => undefined,
      productPreprobeAction("fresh"),
    );
    const relay = preprobeRelay(f.lease, fields, initFrame);
    try {
      const preparation = f.harness.start(f.dispatch, f.lineage);
      if (expected === "supported") {
        await preparation;
        expect(relay.counts.probes).toBe(1);
        expect(relay.counts.bytes).toBe(301);
        expect(
          (await preprobeEvidence(f.storeRoot)).observations
            .stream_observation_registered,
        ).toBe("observed");
      } else {
        await expect(preparation).rejects.toMatchObject({
          code:
            expected === "rejected"
              ? "streamed_process_spawn_failed"
              : "diagnostic_capability_unavailable",
        });
        expect(relay.counts.probes).toBe(0);
        expect(relay.counts.bytes).toBe(0);
        expect(relay.counts.cancels).toBe(expected === "rejected" ? 0 : 1);
        expect(relay.counts.kills).toBe(expected === "rejected" ? 1 : 0);
        const evidence = await preprobeEvidence(f.storeRoot);
        expect(evidence.observations.stream_observation_registered).toBe(
          "not_observed",
        );
        expect(evidence.observations.probe_write_requested).toBe(
          "not_observed",
        );
        expect(evidence.outputCensus.frameValidated).toBe(false);
        expect(evidence.probeDiagnosticCapability).toBe(
          expected === "rejected" ? undefined : expected,
        );
      }
      expect(relay.counts.opens).toBe(1);
      expect(relay.counts.diagnostics).toBe(0);
      expect(relay.counts.queries).toBe(0);
      expect(
        f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
      ).toBeNull();
    } finally {
      await f.harness.close(f.lineage);
      await relay.close();
      f.registry.close();
      f.store.close();
    }
  });

for (const race of [
  "baseline_epoch",
  "baseline_attachment",
  "baseline_exit",
  "writer_epoch",
  "writer_marker",
  "spawn_marker",
] as const)
  productWireTest(`raw READY integration revocation: ${race}`, async () => {
    let epoch = 1;
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => epoch,
      () => undefined,
      productPreprobeAction("fresh"),
    );
    const relay = preprobeRelay(
      f.lease,
      '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
      initFrame,
    );
    let retainedFrames: AsyncFrameQueue | undefined;
    const fail = AsyncFrameQueue.prototype.fail;
    const next = spyOn(AsyncFrameQueue.prototype, "fail").mockImplementation(
      function (this: AsyncFrameQueue, error: Error) {
        retainedFrames = this;
        fail.call(this, error);
      },
    );
    // No native output should be available before a probe. Exit races are
    // delivered by the real manager, not by a replacement capability method.
    if (race.startsWith("baseline"))
      relay.onBaseline(() => {
        if (race === "baseline_epoch") epoch++;
        else if (race === "baseline_exit") relay.finish();
        else {
          const active = (
            f.harness as unknown as {
              active: Map<string, { process: StreamedProcess }>;
            }
          ).active.get(f.lineage.lineageId);
          const p = relay.process();
          if (active && p)
            active.process = {
              ...p,
              handle: { ...p.handle, processGeneration: "replacement-B" },
            };
        }
      });
    if (race.startsWith("writer"))
      relay.onWriter(() => {
        if (race === "writer_epoch") epoch++;
        else
          f.harness.revokeDiagnosticCapabilities(f.dispatch.action.action_id);
      });
    if (race === "spawn_marker") {
      const spawn = f.lease.spawnStreamed;
      f.lease.spawnStreamed = async (...args) => {
        const p = await spawn(...args);
        f.harness.revokeDiagnosticCapabilities(f.dispatch.action.action_id);
        return p;
      };
    }
    try {
      await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toThrow();
      expect(relay.counts.opens).toBe(1);
      expect(relay.counts.probes).toBe(0);
      expect(relay.counts.bytes).toBe(0);
      expect(relay.counts.diagnostics).toBe(0);
      expect(relay.counts.queries).toBe(0);
      // An already observed exit can make cancel validation reject before opcode
      // submission. It is not evidence that a cancellation was physically sent.
      expect(relay.counts.cancels).toBe(race === "baseline_exit" ? 0 : 1);
      await relay.process()?.exit;
      const evidence = await preprobeEvidence(f.storeRoot);
      expect(evidence.observations.cancellation_requested).toBe("observed");
      expect(evidence.outputCensus.frameValidated).toBe(false);
      expect(evidence.observations.stream_observation_registered).toBe(
        race === "spawn_marker" ? "not_observed" : "observed",
      );
      expect(
        (
          f.harness as unknown as {
            active: Map<string, unknown>;
            diagnosticPreparations: Map<string, unknown>;
          }
        ).active.size,
      ).toBe(0);
      expect(
        (
          f.harness as unknown as {
            diagnosticPreparations: Map<string, unknown>;
          }
        ).diagnosticPreparations.size,
      ).toBe(0);
      expect(
        f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
      ).toBeNull();
      // Observer queues and census are per-preparation, not reusable handles.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (race === "spawn_marker") expect(retainedFrames).toBeUndefined();
      else expect(retainedFrames?.closed).toBe(true);
    } finally {
      next.mockRestore();
      await relay.close();
      f.registry.close();
      f.store.close();
    }
  });

productWireTest(
  "raw READY Product timeout: exact probe owns one synchronous diagnostic before cancellation",
  async () => {
    const f = await effortHarness(
      { model: CLAUDE_CODE_MODEL, effort: "high" },
      "high",
      () => 1,
      () => undefined,
      productPreprobeAction("fresh"),
    );
    const relay = preprobeRelay(
      f.lease,
      '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
      initFrame,
    );
    relay.suppressInit();
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const next = spyOn(AsyncFrameQueue.prototype, "next").mockImplementation(
      async () => {
        now = 30_000;
        throw new ClaudeProtocolTimeout();
      },
    );
    try {
      await expect(
        f.harness.start(f.dispatch, f.lineage),
      ).rejects.toMatchObject({
        code: "environment_attestation_failed",
      });
      expect(relay.counts.probes).toBe(1);
      expect(relay.counts.bytes).toBe(301);
      expect(relay.counts.diagnostics).toBe(1);
      expect(relay.counts.diagnosticMatchesProbe).toBe(true);
      expect(relay.counts.cancellationOrder).toEqual([24, 22]);
      expect(relay.counts.opens).toBe(1);
      expect(relay.counts.queries).toBe(0);
      expect(
        f.registry.get(f.dispatch.action.action_id).promptAuthorizedAt,
      ).toBeNull();
    } finally {
      next.mockRestore();
      clock.mockRestore();
      await relay.close();
      f.registry.close();
      f.store.close();
    }
  },
);

test("review-fix adversarial: preparation failure clears marker and cannot remint a consumed receipt", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const manager = (
    f.harness as unknown as { runManager: { prepare: () => Promise<unknown> } }
  ).runManager;
  const prepare = manager.prepare;
  manager.prepare = async () => {
    throw new Error("synthetic preparation failure");
  };
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toThrow(
      "synthetic preparation failure",
    );
    expect(
      (f.harness as unknown as { diagnosticPreparations: Map<string, unknown> })
        .diagnosticPreparations.size,
    ).toBe(0);
    manager.prepare = prepare;
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "diagnostic_capability_unavailable",
    });
    expect(f.process.probeWrites).toBe(0);
    expect(f.process.cancelCalls).toBe(1);
  } finally {
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

test("review-fix adversarial: retained writer callback is unusable after marker revocation and cleanup", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  let retained: (() => void) | undefined;
  const write = f.process.write;
  f.process.write = async (bytes, guard) => {
    retained = guard;
    f.harness.revokeDiagnosticCapabilities(f.dispatch.action.action_id);
    return write(bytes, guard);
  };
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "diagnostic_capability_unavailable",
    });
    expect(retained).toBeDefined();
    expect(() => retained?.()).toThrow();
    expect(f.process.probeWrites).toBe(0);
    expect(f.process.cancelCalls).toBe(1);
    // The stale callback cannot authorize another invocation either. Its durable
    // failed reservation also blocks a fresh spawn before the gate is reached.
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toThrow(
      "Fresh Claude execution cannot reuse any prior native session record.",
    );
    expect(() => retained?.()).toThrow();
  } finally {
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

test("review-fix adversarial: rejected backend cancellation leaves observer inert, not falsely terminated", async () => {
  let epoch = 1;
  const f = await effortHarness(
    { model: CLAUDE_CODE_MODEL, effort: "high" },
    "high",
    () => epoch,
  );
  const relay = preprobeRelay(
    f.lease,
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    initFrame,
  );
  let frames: AsyncFrameQueue | undefined;
  relay.rejectCancellation();
  relay.onBaseline(() => {
    frames = (
      f.harness as unknown as {
        active: Map<string, { frames: AsyncFrameQueue }>;
      }
    ).active.get(f.lineage.lineageId)?.frames;
    epoch++;
  });
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "diagnostic_capability_unavailable",
    });
    expect(frames?.closed).toBe(true);
    expect(relay.counts.cancels).toBe(1);
    expect(relay.counts.kills).toBe(0); // no terminal proof at failed cancellation
    expect(relay.counts.probes).toBe(0);
    expect(relay.counts.diagnostics).toBe(0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const before = await preprobeEvidence(f.storeRoot);
    expect(before.observations.cancellation_acknowledged).toBe("not_observed");
    relay.emitOutput(initFrame("late-unowned-session"));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const after = await preprobeEvidence(f.storeRoot);
    expect(after.outputCensus).toEqual(before.outputCensus);
    expect(after.observations.protocol_frame_observed).toBe("not_observed");
    await expect(frames?.next(null)).rejects.toThrow();
  } finally {
    await relay.close();
    f.registry.close();
    f.store.close();
  }
});

test("review-fix adversarial: real supported attachment A cannot authorize real unavailable attachment B", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  const leaseB = { ...f.lease };
  const b = preprobeRelay(
    leaseB,
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    initFrame,
    readyIdentity.replace(',"observedExecutableIdentity":"1:2"', ""),
  );
  const processB = await leaseB.spawnStreamed({
    executable: "/opt/qe/claude/claude",
    args: [],
    cwd: leaseB.paths.state,
    environment: {},
  });
  expect(processB.negotiatedCapabilities?.().nonblockingDiagnosticWrite).toBe(
    "unavailable",
  );
  const a = preprobeRelay(
    f.lease,
    '"protocolVersion":2,"nonblockingDiagnosticWrite":true',
    initFrame,
  );
  let historical: unknown;
  a.onBaseline(() => {
    historical = a.process()?.negotiatedCapabilities?.();
    const active = (
      f.harness as unknown as {
        active: Map<string, { process: StreamedProcess }>;
      }
    ).active.get(f.lineage.lineageId);
    if (active) active.process = processB;
  });
  try {
    await expect(f.harness.start(f.dispatch, f.lineage)).rejects.toMatchObject({
      code: "diagnostic_capability_unavailable",
    });
    expect(historical).toEqual({ nonblockingDiagnosticWrite: "supported" });
    expect(a.counts.probes + b.counts.probes).toBe(0);
    expect(a.counts.diagnostics + b.counts.diagnostics).toBe(0);
    expect(a.counts.cancels).toBe(1);
  } finally {
    await a.close();
    await b.close();
    f.registry.close();
    f.store.close();
  }
});

test("review-fix adversarial: terminal revocation before process creation fences a suspended Promise continuation", async () => {
  const f = await effortHarness({ model: CLAUDE_CODE_MODEL, effort: "high" });
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = (
    f.harness as unknown as { runManager: { prepare: () => Promise<unknown> } }
  ).runManager;
  const prepare = manager.prepare;
  manager.prepare = async () => {
    entered();
    await pending;
    return prepare();
  };
  const outcome = f.harness
    .start(f.dispatch, f.lineage)
    .catch((error) => error);
  try {
    await ready;
    f.harness.revokeDiagnosticCapabilities(f.dispatch.action.action_id);
    expect(
      (f.harness as unknown as { diagnosticPreparations: Map<string, unknown> })
        .diagnosticPreparations.size,
    ).toBe(0);
    release();
    expect(await outcome).toMatchObject({
      code: "diagnostic_capability_unavailable",
    });
    expect(f.process.probeWrites).toBe(0);
    expect(f.process.cancelCalls).toBe(1);
  } finally {
    release();
    await outcome;
    await f.harness.close(f.lineage);
    f.registry.close();
    f.store.close();
  }
});

async function preprobeEvidence(root: string) {
  const db = new (await import("bun:sqlite")).Database(
    join(root, "claude-code-sessions-v1.sqlite"),
    { readonly: true },
  );
  try {
    const row = db
      .query(
        "SELECT evidence_json FROM managed_harness_lifecycle ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { evidence_json: string };
    return JSON.parse(row.evidence_json);
  } finally {
    db.close();
  }
}

async function effortHarness(
  applied: Record<string, unknown>,
  reasoning: string | null = "high",
  diagnosticGeneration: () => number | null = () => 1,
  configureAction: (candidate: ExecuteAction) => void = () => undefined,
  productAction?: ExecuteAction,
) {
  const root = await testRoot();
  const candidate = productAction ?? claudeAction();
  candidate.execution.configuration.reasoning = reasoning;
  configureAction(candidate);
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "claude_code",
  );
  const acceptance = registry.accept(candidate);
  const dispatch = acceptance.dispatch;
  const productReceipt = productAction
    ? productAcceptanceReceipt(candidate, acceptance.created, true, 1)
    : null;
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
  const binding = {
    ...brokerBinding(dispatch.action.action_id, environment),
    runId: candidate.run_id,
    occurrenceId: candidate.occurrence_id,
    attemptId: candidate.attempt_id,
    workspaceId: candidate.execution.logical_workspace.workspace_id,
    worktreeId: candidate.execution.execution_workspace.worktree_id,
    workspaceBindingId:
      candidate.execution.execution_workspace.workspace_binding_id,
    workspaceAccess: candidate.execution.execution_workspace.access,
  };
  const store = new ClaudeCodeSessionStore(root);
  const accountAuthority = {
    providerAccountId: binding.providerAccountId,
    credentialGeneration: binding.credentialGeneration,
    ref: environment,
    assertCurrent: () => undefined,
  };
  let ownershipReads = 0,
    freshClaimed = false,
    allowFresh = true;
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
      retireClaudeAccountProcesses: async () => undefined,
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
    () => {
      if (freshClaimed || !allowFresh) return null;
      freshClaimed = true;
      if (productReceipt) return productReceipt.claim();
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
    setFreshAcceptance: (value: boolean) => {
      allowFresh = value;
    },
    lease,
    storeRoot: root,
  };
}

function claudeAction() {
  const base = action();
  return action({
    operational_recovery: {
      authorization_kind: "initial",
      continuation_mode: "fresh",
      epoch_number: 0,
      attempt_in_epoch: 1,
      attempt_allowance: 1,
      retained_lineage_id: null,
      source_attempt_id: null,
      request_id: null,
    },
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
  probeWrites: number;
  cancelCalls: number;
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
    probeWrites: 0,
    cancelCalls: 0,
    negotiatedCapabilities: () =>
      Object.freeze({
        nonblockingDiagnosticWrite: cancelled ? "unavailable" : "supported",
      }),
    appliedSettings: { model: CLAUDE_CODE_MODEL, effort: CLAUDE_CODE_EFFORT },
    probeFrames: null,
    endProbeOutput: false,
    emitFrame: (frame) =>
      stdoutController.enqueue(
        new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
      ),
    write: async (data, beforeWrite) => {
      beforeWrite?.();
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
        process.probeWrites++;
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
      process.cancelCalls++;
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
