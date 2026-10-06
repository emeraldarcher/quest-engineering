import type { RunEnvironmentCleanupOutcome } from "./execution-environment/run-cleanup.ts";
import type { EnvironmentRef } from "./execution-environment/types.ts";
import type {
  CleanupIssue,
  HarnessCleanupTarget,
  RunCleanupRecord,
  RunCleanupStore,
} from "./run-cleanup-store.ts";

export interface RunCleanupRequest {
  runId: string;
  worktreeId: string;
  workspaceBindingId: string;
  identityHash: string;
}

export interface RunCleanupCoordinatorDependencies {
  assertRunIdle(runId: string): void;
  assertHostIdentity(request: RunCleanupRequest): void;
  requestHostCleanup(worktreeId: string): void;
  cleanupHostRepository(worktreeId: string): Promise<{
    state: "removed" | "failed";
    issue?: CleanupIssue;
  }>;
  harnessTargets(runId: string): HarnessCleanupTarget[];
  closeHarnessTargets(
    runId: string,
    frozenTargets: readonly HarnessCleanupTarget[],
  ): Promise<{
    state: "retired" | "unavailable";
    issue?: CleanupIssue;
  }>;
  currentEnvironment(runId: string): Promise<EnvironmentRef | null>;
  cleanupEnvironment(
    target: EnvironmentRef,
  ): Promise<RunEnvironmentCleanupOutcome>;
  report(record: RunCleanupRecord): Promise<void>;
}

/**
 * Worker-local owner of explicit whole-Run physical cleanup.
 *
 * Resource identities are frozen durably before retirement starts. Independent
 * resource projections keep Product semantics out of this orchestration. A
 * pass never removes the host Run repository until the exact environment is
 * authoritatively removed.
 */
export class RunCleanupCoordinator {
  private readonly operations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: RunCleanupStore,
    private readonly dependencies: RunCleanupCoordinatorDependencies,
  ) {}

  request(request: RunCleanupRequest, retryFailures: boolean): Promise<void> {
    const existing = this.operations.get(request.runId);
    if (existing) return existing;
    const operation = this.advance(request, retryFailures).finally(() => {
      if (this.operations.get(request.runId) === operation)
        this.operations.delete(request.runId);
    });
    this.operations.set(request.runId, operation);
    return operation;
  }

  async reconcilePending(): Promise<void> {
    for (const cleanup of this.store.listReconcilable()) {
      try {
        await this.request(
          {
            runId: cleanup.runId,
            worktreeId: cleanup.worktreeId,
            workspaceBindingId: cleanup.workspaceBindingId,
            identityHash: cleanup.identityHash,
          },
          false,
        );
      } catch {
        // One fenced or temporarily unavailable Run must not starve unrelated
        // durable cleanup reconciliation. Its projection remains pending.
      }
    }
  }

  private async advance(
    request: RunCleanupRequest,
    retryFailures: boolean,
  ): Promise<void> {
    this.dependencies.assertRunIdle(request.runId);
    this.dependencies.assertHostIdentity(request);

    let cleanup = this.store.get(request.runId);
    if (!cleanup) cleanup = await this.freeze(request);
    else
      cleanup = this.store.begin({
        ...request,
        harnessTargets: cleanup.harnessTargets,
        environmentRef: cleanup.environmentRef,
        environmentAbsenceProven: cleanup.environmentAbsenceProven,
      });

    try {
      this.dependencies.requestHostCleanup(request.worktreeId);
    } catch {
      cleanup = this.store.updateHostRepository(request.runId, "failed", {
        code: "run_repository_cleanup_not_safe",
        message: "The host Run repository could not enter cleanup safely.",
      });
      await this.dependencies.report(cleanup);
      return;
    }

    if (
      ["retained", "retiring"].includes(cleanup.harness.state) ||
      (retryFailures && cleanup.harness.state === "unavailable")
    ) {
      cleanup = this.store.updateHarness(request.runId, "retiring");
      let harness: {
        state: "retired" | "unavailable";
        issue?: CleanupIssue;
      };
      try {
        harness = await this.dependencies.closeHarnessTargets(
          request.runId,
          cleanup.harnessTargets,
        );
      } catch {
        harness = {
          state: "unavailable",
          issue: {
            code: "harness_cleanup_unavailable",
            message:
              "The frozen Run harness identities could not be closed safely.",
          },
        };
      }
      cleanup = this.store.updateHarness(
        request.runId,
        harness.state,
        harness.issue,
      );
      await this.dependencies.report(cleanup);
    }

    const environmentState = cleanup.executionEnvironment.state;
    if (
      cleanup.harness.state === "retired" &&
      cleanup.environmentRef &&
      (["cleanup_requested", "stopping", "stopped", "uncertain"].includes(
        environmentState,
      ) ||
        (retryFailures && environmentState === "failed"))
    ) {
      let environment: RunEnvironmentCleanupOutcome;
      try {
        environment = await this.dependencies.cleanupEnvironment(
          cleanup.environmentRef,
        );
      } catch {
        environment = {
          state: "failed",
          issue: {
            code: "environment_cleanup_failed",
            message:
              "The frozen execution environment could not be reconciled safely.",
          },
        };
      }
      cleanup = this.store.updateEnvironment(
        request.runId,
        environment.state,
        environment.issue,
      );
      await this.dependencies.report(cleanup);
    }

    if (
      cleanup.harness.state === "retired" &&
      cleanup.executionEnvironment.state === "removed" &&
      (cleanup.hostRunRepository.state === "cleanup_requested" ||
        (retryFailures && cleanup.hostRunRepository.state === "failed"))
    ) {
      let repository: {
        state: "removed" | "failed";
        issue?: CleanupIssue;
      };
      try {
        repository = await this.dependencies.cleanupHostRepository(
          request.worktreeId,
        );
      } catch {
        repository = {
          state: "failed",
          issue: {
            code: "run_repository_cleanup_failed",
            message: "The host Run repository could not be removed safely.",
          },
        };
      }
      cleanup = this.store.updateHostRepository(
        request.runId,
        repository.state,
        repository.issue,
      );
      await this.dependencies.report(cleanup);
    }
  }

  private async freeze(request: RunCleanupRequest): Promise<RunCleanupRecord> {
    const harnessTargets = this.dependencies.harnessTargets(request.runId);
    let environmentRef: EnvironmentRef | null = null;
    let environmentAbsenceProven = false;
    let ownershipIssue: CleanupIssue | undefined;
    try {
      environmentRef = await this.dependencies.currentEnvironment(
        request.runId,
      );
      environmentAbsenceProven = environmentRef === null;
    } catch {
      ownershipIssue = {
        code: "environment_identity_unavailable",
        message:
          "The exact Run-owned execution environment identity could not be proven.",
      };
    }
    let cleanup = this.store.begin({
      ...request,
      harnessTargets,
      environmentRef,
      environmentAbsenceProven,
    });
    if (ownershipIssue)
      cleanup = this.store.updateEnvironment(
        request.runId,
        "failed",
        ownershipIssue,
      );
    await this.dependencies.report(cleanup);
    return cleanup;
  }
}
