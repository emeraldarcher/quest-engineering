import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import {
  EnvironmentBackendError,
  type EnvironmentInspection,
  type EnvironmentReadiness,
  type EnvironmentRef,
  type EnvironmentSpec,
  type EnvironmentStopResult,
  type ExecutionEnvironmentBackend,
} from "../src/execution-environment/types.ts";
import {
  RunCleanupCoordinator,
  type RunCleanupCoordinatorDependencies,
  type RunCleanupRequest,
} from "../src/run-cleanup.ts";
import { RunCleanupStore } from "../src/run-cleanup-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const request: RunCleanupRequest = {
  runId: "run-cleanup",
  worktreeId: "worktree-cleanup",
  workspaceBindingId: "binding-cleanup",
  identityHash: "identity-cleanup",
};
const harnessTarget = {
  lineageId: "lineage-1",
  harnessKind: "fake",
  transportBinding: null,
  authorityDigest: "sha256:authority",
  nativeSessionDigest: "sha256:native-session",
};
const target: EnvironmentRef = {
  backendKind: "scripted",
  environmentId: "environment-cleanup",
  incarnation: "incarnation-cleanup",
  workerId: "worker-cleanup",
  runId: request.runId,
  profile: { id: "profile-cleanup", digest: "digest-cleanup" },
};

interface BackendState {
  physical: "running" | "stopped" | "absent" | "unavailable" | "replacement";
  stopIntent: boolean;
  stopCalls: number;
  reconcileCalls: number;
  removeCalls: number;
  removed: boolean;
}

class ScriptedBackend implements ExecutionEnvironmentBackend {
  readonly kind = "scripted";
  constructor(readonly state: BackendState) {}
  async readiness(): Promise<EnvironmentReadiness> {
    throw new Error("unused");
  }
  async currentEnvironment(runId: string): Promise<EnvironmentRef | null> {
    if (runId !== target.runId) return null;
    if (this.state.removed) return null;
    return this.state.physical === "replacement"
      ? {
          ...target,
          environmentId: "replacement-environment",
          incarnation: "replacement-incarnation",
        }
      : target;
  }
  async inspect(ref: EnvironmentRef): Promise<EnvironmentInspection> {
    this.assertCurrent(ref);
    const status = this.status();
    return {
      ref,
      state:
        this.state.physical === "stopped"
          ? "stopped"
          : this.state.physical === "absent"
            ? "missing"
            : this.state.physical === "unavailable"
              ? "degraded"
              : "running",
      usable: this.state.physical === "running" && !this.state.stopIntent,
      specDigest: "spec",
      paths: {
        workspace: "/workspace",
        state: "/state",
        control: "/control",
        home: "/home",
        cache: "/cache",
        temp: "/tmp",
      },
      capabilities: [],
      ...(this.state.stopIntent ? { stop: status } : {}),
    };
  }
  async stop(ref: EnvironmentRef): Promise<EnvironmentStopResult> {
    this.assertCurrent(ref);
    if (this.state.stopIntent) return this.reconcileStop(ref);
    this.state.stopIntent = true;
    if (this.state.physical === "running") this.state.stopCalls += 1;
    return { ref, ...this.status() };
  }
  async reconcileStop(ref: EnvironmentRef): Promise<EnvironmentStopResult> {
    this.assertCurrent(ref);
    this.state.reconcileCalls += 1;
    return { ref, ...this.status() };
  }
  async remove(ref: EnvironmentRef): Promise<void> {
    this.assertCurrent(ref);
    if (!["stopped", "absent"].includes(this.state.physical))
      throw new EnvironmentBackendError(
        "environment_not_usable",
        "not stopped",
        "remove",
      );
    if (this.state.physical === "stopped") this.state.removeCalls += 1;
    this.state.removed = true;
  }
  async ensure(_spec: EnvironmentSpec): Promise<never> {
    throw new Error("unused");
  }
  async recover(_ref: EnvironmentRef, _spec: EnvironmentSpec): Promise<never> {
    throw new Error("unused");
  }

  private assertCurrent(ref: EnvironmentRef): void {
    if (
      this.state.physical === "replacement" ||
      ref.environmentId !== target.environmentId ||
      ref.incarnation !== target.incarnation
    )
      throw new EnvironmentBackendError(
        "stale_environment_ref",
        "Frozen cleanup target is stale.",
        "inspect",
      );
  }

  private status(): Omit<EnvironmentStopResult, "ref"> {
    if (this.state.physical === "stopped")
      return {
        state: "stopped",
        intent: this.state.stopIntent ? "recorded" : "not_recorded",
        invocation: this.state.stopCalls ? "acknowledged" : "not_invoked",
        observation: "stopped",
      };
    if (this.state.physical === "absent")
      return {
        state: "stopped",
        intent: this.state.stopIntent ? "recorded" : "not_recorded",
        invocation: this.state.stopCalls ? "acknowledged" : "not_invoked",
        observation: "absent",
      };
    if (this.state.physical === "unavailable")
      return {
        state: "uncertain",
        intent: "recorded",
        invocation: "acknowledged",
        observation: "unavailable",
        errorCode: "backend_unavailable",
      };
    return {
      state: this.state.stopIntent ? "stopping" : "running",
      intent: this.state.stopIntent ? "recorded" : "not_recorded",
      invocation: this.state.stopIntent ? "acknowledged" : "not_invoked",
      observation: "running",
    };
  }
}

async function fixture(
  physical: BackendState["physical"] = "running",
  sharedState?: BackendState,
) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-cleanup-"));
  roots.push(root);
  const state =
    sharedState ??
    ({
      physical,
      stopIntent: false,
      stopCalls: 0,
      reconcileCalls: 0,
      removeCalls: 0,
      removed: false,
    } satisfies BackendState);
  const backend = new ScriptedBackend(state);
  const store = new RunCleanupStore(root);
  const events: string[] = [];
  const reports: Array<{
    harness: string;
    environment: string;
    host: string;
  }> = [];
  let active = false;
  let hostFails = false;
  let harnessUnavailable = false;
  let harnessClose: (() => Promise<void>) | null = null;
  const dependencies: RunCleanupCoordinatorDependencies = {
    assertRunIdle: () => {
      if (active) throw new Error("active Run");
    },
    assertHostIdentity: (value) => {
      if (JSON.stringify(value) !== JSON.stringify(request))
        throw new Error("identity mismatch");
    },
    requestHostCleanup: () => events.push("host_requested"),
    cleanupHostRepository: async () => {
      events.push("host_remove");
      return hostFails
        ? {
            state: "failed",
            issue: { code: "host_remove_failed", message: "Host failure." },
          }
        : { state: "removed" };
    },
    harnessTargets: () => [harnessTarget],
    closeHarnessTargets: async (_runId, targets) => {
      expect(targets).toEqual([harnessTarget]);
      events.push("harness_retire");
      await harnessClose?.();
      return harnessUnavailable
        ? {
            state: "unavailable",
            issue: {
              code: "harness_cleanup_unavailable",
              message: "Harness closure is unavailable.",
            },
          }
        : { state: "retired" };
    },
    currentEnvironment: (runId) => backend.currentEnvironment(runId),
    cleanupEnvironment: async (ref) => {
      events.push("environment_advance");
      return cleanupExecutionEnvironment(backend, ref);
    },
    report: async (record) => {
      reports.push({
        harness: record.harness.state,
        environment: record.executionEnvironment.state,
        host: record.hostRunRepository.state,
      });
    },
  };
  return {
    root,
    state,
    backend,
    store,
    coordinator: new RunCleanupCoordinator(store, dependencies),
    events,
    reports,
    setActive: (value: boolean) => {
      active = value;
    },
    failHost: () => {
      hostFails = true;
    },
    failHarness: () => {
      harnessUnavailable = true;
    },
    setHarnessClose: (value: () => Promise<void>) => {
      harnessClose = value;
    },
  };
}

test("terminal Run cleanup stops once, removes environment, then removes host repository without changing semantic success", async () => {
  const value = await fixture();
  let productStatus = "completed";
  await value.coordinator.request(request, false);

  expect(value.state.stopCalls).toBe(1);
  expect(value.store.get(request.runId)).toMatchObject({
    harness: { state: "retired" },
    executionEnvironment: { state: "stopping" },
    hostRunRepository: { state: "cleanup_requested" },
  });
  expect(value.events).not.toContain("host_remove");

  value.state.physical = "stopped";
  await value.coordinator.reconcilePending();
  expect(value.events.indexOf("environment_advance")).toBeLessThan(
    value.events.indexOf("host_remove"),
  );
  expect(value.store.get(request.runId)).toMatchObject({
    executionEnvironment: { state: "removed" },
    hostRunRepository: { state: "removed" },
  });
  expect(value.state.stopCalls).toBe(1);
  expect(value.state.removeCalls).toBe(1);
  expect(productStatus).toBe("completed");
  productStatus = "completed";
});

test("acknowledged stop and unavailable observation remain truthful with no replay or premature removal, then converge", async () => {
  const value = await fixture();
  await value.coordinator.request(request, false);
  value.state.physical = "unavailable";
  await value.coordinator.reconcilePending();

  expect(value.store.get(request.runId)).toMatchObject({
    executionEnvironment: {
      state: "uncertain",
      issue: { code: "backend_unavailable" },
    },
    hostRunRepository: { state: "cleanup_requested" },
  });
  expect(value.state.stopCalls).toBe(1);
  expect(value.state.removeCalls).toBe(0);
  expect(value.events).not.toContain("host_remove");

  value.state.physical = "stopped";
  await value.coordinator.reconcilePending();
  expect(value.store.get(request.runId)).toMatchObject({
    executionEnvironment: { state: "removed" },
    hostRunRepository: { state: "removed" },
  });
  expect(value.state.stopCalls).toBe(1);
});

test("Worker restart resumes frozen cleanup read-only and duplicate requests have no duplicate side effects", async () => {
  const value = await fixture();
  await Promise.all([
    value.coordinator.request(request, false),
    value.coordinator.request(request, false),
  ]);
  expect(value.state.stopCalls).toBe(1);
  value.store.close();

  value.state.physical = "stopped";
  const restartedStore = new RunCleanupStore(value.root);
  const restartedBackend = new ScriptedBackend(value.state);
  let hostRemovals = 0;
  const restarted = new RunCleanupCoordinator(restartedStore, {
    assertRunIdle: () => undefined,
    assertHostIdentity: () => undefined,
    requestHostCleanup: () => undefined,
    cleanupHostRepository: async () => {
      hostRemovals += 1;
      return { state: "removed" };
    },
    harnessTargets: () => {
      throw new Error("frozen identities must be reused");
    },
    closeHarnessTargets: async () => {
      throw new Error("retired harness must not be replayed");
    },
    currentEnvironment: () => {
      throw new Error("frozen environment must be reused");
    },
    cleanupEnvironment: (ref) =>
      cleanupExecutionEnvironment(restartedBackend, ref),
    report: async () => undefined,
  });
  await restarted.reconcilePending();
  await restarted.request(request, true);

  expect(value.state.stopCalls).toBe(1);
  expect(value.state.removeCalls).toBe(1);
  expect(hostRemovals).toBe(1);
  expect(restartedStore.get(request.runId)).toMatchObject({
    executionEnvironment: { state: "removed" },
    hostRunRepository: { state: "removed" },
  });
  restartedStore.close();
});

test("already stopped and authoritatively absent environments remove without a destructive stop", async () => {
  for (const physical of ["stopped", "absent"] as const) {
    const value = await fixture(physical);
    await value.coordinator.request(request, false);
    expect(value.state.stopCalls).toBe(0);
    expect(value.store.get(request.runId)).toMatchObject({
      executionEnvironment: { state: "removed" },
      hostRunRepository: { state: "removed" },
    });
    expect(value.state.removeCalls).toBe(physical === "stopped" ? 1 : 0);
    value.store.close();
  }
});

test("frozen stale incarnation fails closed and leaves replacement and host repository untouched", async () => {
  const value = await fixture();
  value.setHarnessClose(async () => {
    value.state.physical = "replacement";
  });
  await value.coordinator.request(request, false);

  expect(value.store.get(request.runId)).toMatchObject({
    executionEnvironment: {
      state: "failed",
      issue: { code: "stale_environment_ref" },
    },
    hostRunRepository: { state: "cleanup_requested" },
  });
  expect(value.state.stopCalls).toBe(0);
  expect(value.state.removeCalls).toBe(0);
  expect(value.events).not.toContain("host_remove");
});

test("unavailable harness retirement blocks environment and host removal", async () => {
  const value = await fixture("stopped");
  value.failHarness();
  await value.coordinator.request(request, false);
  expect(value.store.get(request.runId)).toMatchObject({
    harness: {
      state: "unavailable",
      issue: { code: "harness_cleanup_unavailable" },
    },
    executionEnvironment: { state: "cleanup_requested" },
    hostRunRepository: { state: "cleanup_requested" },
  });
  expect(value.state.stopCalls).toBe(0);
  expect(value.state.removeCalls).toBe(0);
  expect(value.events).not.toContain("host_remove");
});

test("host repository failure is independent after environment removal", async () => {
  const value = await fixture("stopped");
  value.failHost();
  await value.coordinator.request(request, false);
  expect(value.store.get(request.runId)).toMatchObject({
    harness: { state: "retired" },
    executionEnvironment: { state: "removed" },
    hostRunRepository: {
      state: "failed",
      issue: { code: "host_remove_failed" },
    },
  });
});

test("environment failure blocks host removal and active Runs are rejected before any cleanup side effect", async () => {
  const stale = await fixture("replacement");
  await stale.coordinator.request(request, false);
  expect(stale.events).not.toContain("host_remove");
  expect(stale.store.get(request.runId)?.executionEnvironment.state).toBe(
    "failed",
  );

  const active = await fixture();
  active.setActive(true);
  await expect(active.coordinator.request(request, false)).rejects.toThrow(
    "active Run",
  );
  expect(active.events).toEqual([]);
  expect(active.state.stopCalls).toBe(0);
  expect(active.store.get(request.runId)).toBeNull();
});
