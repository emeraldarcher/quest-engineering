import {
  EnvironmentBackendError,
  type EnvironmentRef,
  type EnvironmentStopResult,
  type ExecutionEnvironmentBackend,
} from "./types.ts";

export type RunEnvironmentCleanupState =
  | "cleanup_requested"
  | "stopping"
  | "stopped"
  | "removed"
  | "uncertain"
  | "failed";

export interface RunEnvironmentCleanupOutcome {
  state: RunEnvironmentCleanupState;
  issue?: { code: string; message: string };
}

/**
 * Advance teardown for one frozen Run-owned environment incarnation.
 *
 * This function deliberately has no backend-specific behavior. The first call
 * may cross the backend's exactly-once destructive stop boundary. Every call
 * after durable stop intent exists is read-only until stopped convergence, and
 * physical removal is attempted only after the backend reports stopped.
 */
export async function cleanupExecutionEnvironment(
  backend: ExecutionEnvironmentBackend,
  target: EnvironmentRef,
): Promise<RunEnvironmentCleanupOutcome> {
  try {
    const inspection = await backend.inspect(target);
    const stop = await advanceStop(backend, target, inspection.stop?.intent);
    if (stop.state !== "stopped") return stopOutcome(stop);

    // The backend remove contract resolves only after read-only provider evidence
    // proves this exact incarnation absent. Do not query or follow a replacement.
    await backend.remove(target);
    return { state: "removed" };
  } catch (error) {
    return failure(
      error instanceof EnvironmentBackendError
        ? error.code
        : "environment_operation_failed",
      "Execution environment cleanup could not continue safely.",
    );
  }
}

async function advanceStop(
  backend: ExecutionEnvironmentBackend,
  target: EnvironmentRef,
  intent: "not_recorded" | "recorded" | undefined,
): Promise<EnvironmentStopResult> {
  return intent === "recorded"
    ? backend.reconcileStop(target)
    : backend.stop(target);
}

function stopOutcome(
  stop: EnvironmentStopResult,
): RunEnvironmentCleanupOutcome {
  if (stop.state === "stopping") return { state: "stopping" };
  if (stop.state === "uncertain")
    return {
      state: "uncertain",
      issue: {
        code: stop.errorCode ?? "environment_observation_unavailable",
        message:
          "Execution environment stop is unresolved; cleanup will reconcile without another stop request.",
      },
    };
  if (stop.errorCode)
    return failure(
      stop.errorCode,
      "Execution environment stop could not be initiated safely.",
    );
  return { state: "cleanup_requested" };
}

function failure(code: string, message: string): RunEnvironmentCleanupOutcome {
  return { state: "failed", issue: { code, message } };
}
