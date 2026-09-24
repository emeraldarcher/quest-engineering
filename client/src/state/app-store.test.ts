import { expect, mock, test } from "bun:test";
import { get } from "svelte/store";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  type ExecutionCancellation,
  type RunProjection,
} from "../api/contracts";
import { createFixture } from "../fixtures/fixtures";
import { createAppStore, type ExecutionAttemptIdentity } from "./app-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function prePromptFixture() {
  const fixture = createFixture("work-yard-running");
  if (!fixture?.selectedRunId) throw new Error("Expected running fixture");
  const run = fixture.runs[fixture.selectedRunId];
  const step = run?.steps.at(-1);
  if (!run || !step?.attempt) throw new Error("Expected current Attempt");
  step.attempt.can_cancel = true;
  step.recovery = {
    can_retry: false,
    can_mark_failed: false,
    can_authorize_prompt: true,
    message: "Explicit authorization is required.",
  };
  return {
    fixture,
    run,
    step,
    identity: {
      runId: run.id,
      occurrenceId: step.occurrence_id,
      attemptId: step.attempt.id,
    } satisfies ExecutionAttemptIdentity,
  };
}

function storeWith(
  api: Partial<ApiClient>,
  fixture: ReturnType<typeof prePromptFixture>["fixture"],
) {
  return createAppStore(
    api as ApiClient,
    "ws://fixture.invalid/socket",
    fixture,
  );
}

function authorizationProjection(run: RunProjection): RunProjection {
  const projection = structuredClone(run);
  const step = projection.steps.at(-1);
  if (!step) throw new Error("Expected Step");
  step.recovery = null;
  return projection;
}

function cancelledProjection(run: RunProjection): RunProjection {
  const projection = structuredClone(run);
  const step = projection.steps.at(-1);
  if (!step?.attempt) throw new Error("Expected Attempt");
  projection.status = "cancelled";
  step.state = "cancelled";
  step.recovery = null;
  step.attempt.state = "cancelled";
  step.attempt.can_cancel = false;
  step.attempt.resolution = "cancelled";
  step.attempt.cancellation = {
    state: "cancelled",
    request_id: "cancel-request",
    origin: "product_operator",
    reason: null,
    requested_generation: 3,
    requested_at: "2026-09-23T00:00:00Z",
    cancelled_at: "2026-09-23T00:00:01Z",
  };
  return projection;
}

function cancellationResult(
  identity: ExecutionAttemptIdentity,
  state: ExecutionCancellation["state"] = "cancellation_requested",
): ExecutionCancellation {
  return {
    action_id: "action-current",
    worker_id: "worker-current",
    occurrence_id: identity.occurrenceId,
    attempt_id: identity.attemptId,
    request_id: "cancel-request",
    origin: "product_operator",
    reason: null,
    requested_generation: 3,
    requested_at: "2026-09-23T00:00:00Z",
    state,
    delivery: state === "cancellation_requested" ? "sent" : "not_repeated",
    idempotent_replay: state !== "cancellation_requested",
  };
}

test("authorizePrompt submits exact identity without optimistic lifecycle state", async () => {
  const { fixture, run, step, identity } = prePromptFixture();
  const response = deferred<RunProjection>();
  const authorizeExecutionPrompt = mock(
    async (
      _runId: string,
      _occurrenceId: string,
      _attemptId: string,
      _requestId: string,
    ) => response.promise,
  );
  const store = storeWith({ authorizeExecutionPrompt }, fixture);

  const operation = store.authorizePrompt(identity);

  expect(get(store.executionCommands)).toEqual([
    expect.objectContaining({
      operation: "authorize",
      identity,
      status: "pending",
    }),
  ]);
  expect(
    get(store.selectedRun)?.steps.at(-1)?.recovery?.can_authorize_prompt,
  ).toBe(true);
  const request = authorizeExecutionPrompt.mock.calls[0];
  expect(request?.slice(0, 3)).toEqual([
    run.id,
    step.occurrence_id,
    identity.attemptId,
  ]);
  expect(request?.[3]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  response.resolve(authorizationProjection(run));
  expect(await operation).toBe(true);
  expect(get(store.executionCommands)).toEqual([]);
  expect(
    get(store.selectedRun)?.steps.at(-1)?.recovery?.can_authorize_prompt,
  ).toBeUndefined();
});

test("cancelExecution deduplicates pending submission and accepts idempotent terminal truth", async () => {
  const { fixture, run, identity } = prePromptFixture();
  const response = deferred<{
    cancellation: ExecutionCancellation;
    run: RunProjection;
  }>();
  const cancelExecutionAttempt = mock(
    async (
      _runId: string,
      _occurrenceId: string,
      _attemptId: string,
      _requestId: string,
    ) => response.promise,
  );
  const store = storeWith({ cancelExecutionAttempt }, fixture);

  const first = store.cancelExecution(identity);
  const duplicate = await store.cancelExecution(identity);
  expect(duplicate).toBeNull();
  expect(cancelExecutionAttempt).toHaveBeenCalledTimes(1);
  expect(cancelExecutionAttempt.mock.calls[0]?.slice(0, 3)).toEqual([
    identity.runId,
    identity.occurrenceId,
    identity.attemptId,
  ]);
  expect(get(store.selectedRun)?.steps.at(-1)?.attempt?.state).toBe("running");

  response.resolve({
    cancellation: cancellationResult(identity, "already_terminal"),
    run: cancelledProjection(run),
  });
  expect(await first).toMatchObject({
    state: "already_terminal",
    idempotent_replay: true,
  });
  expect(get(store.selectedRun)?.status).toBe("cancelled");
  expect(get(store.selectedRun)?.steps.at(-1)?.attempt?.can_cancel).toBe(false);
  expect(get(store.executionCommands)).toEqual([]);
});

test("pending commands are isolated by exact Attempt identity", async () => {
  const { fixture, run, identity: secondIdentity } = prePromptFixture();
  const firstStep = run.steps[0];
  if (!firstStep?.attempt) throw new Error("Expected concurrent Attempt");
  firstStep.attempt.can_cancel = true;
  const firstIdentity = {
    runId: run.id,
    occurrenceId: firstStep.occurrence_id,
    attemptId: firstStep.attempt.id,
  };
  const firstResponse = deferred<{
    cancellation: ExecutionCancellation;
    run: RunProjection;
  }>();
  const secondResponse = deferred<{
    cancellation: ExecutionCancellation;
    run: RunProjection;
  }>();
  const cancelExecutionAttempt = mock(
    async (
      _runId: string,
      occurrenceId: string,
      _attemptId: string,
      _requestId: string,
    ) =>
      occurrenceId === firstIdentity.occurrenceId
        ? firstResponse.promise
        : secondResponse.promise,
  );
  const store = storeWith({ cancelExecutionAttempt }, fixture);

  const first = store.cancelExecution(firstIdentity);
  const second = store.cancelExecution(secondIdentity);
  expect(cancelExecutionAttempt).toHaveBeenCalledTimes(2);
  expect(get(store.executionCommands)).toHaveLength(2);

  firstResponse.resolve({
    cancellation: cancellationResult(firstIdentity),
    run: structuredClone(run),
  });
  secondResponse.resolve({
    cancellation: cancellationResult(secondIdentity),
    run: structuredClone(run),
  });
  await Promise.all([first, second]);
  expect(get(store.executionCommands)).toEqual([]);
});

test("execution commands reject stale identity locally and never target a replacement Attempt", async () => {
  const { fixture, run, identity } = prePromptFixture();
  const authorizeExecutionPrompt = mock(async () => run);
  const store = storeWith({ authorizeExecutionPrompt }, fixture);
  const replacement = structuredClone(run);
  const step = replacement.steps.at(-1);
  if (!step?.attempt) throw new Error("Expected Attempt");
  step.attempt.id = "replacement-attempt";
  store.selectedRun.set(replacement);

  expect(await store.authorizePrompt(identity)).toBe(false);
  expect(authorizeExecutionPrompt).not.toHaveBeenCalled();
  expect(get(store.executionCommands)).toEqual([
    expect.objectContaining({
      operation: "authorize",
      status: "error",
      error: expect.objectContaining({ code: "stale_execution_attempt" }),
    }),
  ]);
});

test("a realtime replacement wins over an older mutation response", async () => {
  const { fixture, run, identity } = prePromptFixture();
  const response = deferred<RunProjection>();
  const latest = structuredClone(run);
  const replacementStep = latest.steps.at(-1);
  if (!replacementStep?.attempt) throw new Error("Expected Attempt");
  replacementStep.attempt.id = "replacement-attempt";
  replacementStep.recovery = null;
  const api = {
    authorizeExecutionPrompt: mock(async () => response.promise),
    getRun: mock(async () => latest),
  };
  const store = storeWith(api, fixture);

  const operation = store.authorizePrompt(identity);
  store.selectedRun.set(latest);
  response.resolve(authorizationProjection(run));

  expect(await operation).toBe(true);
  expect(get(store.selectedRun)?.steps.at(-1)?.attempt?.id).toBe(
    "replacement-attempt",
  );
  expect(api.getRun).toHaveBeenCalledWith(run.id);
});

test("transport failures stay scoped to the exact operation and clear on retry success", async () => {
  const { fixture, run, identity } = prePromptFixture();
  let fail = true;
  const api = {
    cancelExecutionAttempt: mock(async () => {
      if (fail)
        throw new ApiError(
          "network_unavailable",
          "Quest Engineering is unavailable.",
        );
      return {
        cancellation: cancellationResult(identity),
        run: cancelledProjection(run),
      };
    }),
    getRun: mock(async () => run),
  };
  const store = storeWith(api, fixture);

  expect(await store.cancelExecution(identity)).toBeNull();
  expect(get(store.error)).toBeNull();
  expect(get(store.executionCommands)).toEqual([
    expect.objectContaining({
      operation: "cancel",
      status: "error",
      error: expect.objectContaining({ code: "network_unavailable" }),
    }),
  ]);

  fail = false;
  expect(await store.cancelExecution(identity)).toMatchObject({
    state: "cancellation_requested",
  });
  expect(get(store.executionCommands)).toEqual([]);
  expect(get(store.selectedRun)?.status).toBe("cancelled");
});
