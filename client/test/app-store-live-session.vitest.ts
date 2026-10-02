import { get } from "svelte/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiClient } from "../src/api/client";
import type {
  LocalSessionAttachmentDescriptor,
  RunProjection,
} from "../src/api/contracts";
import { createFixture } from "../src/fixtures/fixtures";
import type { LocalObservationSession } from "../src/platform/live-session";
import * as liveSessionPlatform from "../src/platform/live-session";
import {
  createAppStore,
  type LiveSessionActionTarget,
} from "../src/state/app-store";
import { attachTestLiveSession } from "./live-session-fixture";

afterEach(() => vi.restoreAllMocks());

let localObservationListener:
  | ((session: LocalObservationSession) => void)
  | null = null;

beforeEach(() => {
  localObservationListener = null;
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  vi.spyOn(liveSessionPlatform, "watchLocalLiveSessions").mockImplementation(
    async (observer) => {
      localObservationListener = observer;
      return () => undefined;
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

function setup(canObserve: boolean, canTakeover: boolean) {
  const fixture = createFixture("work-yard-running");
  if (!fixture?.selectedRunId) throw new Error("Expected running fixture");
  const run = fixture.runs[fixture.selectedRunId];
  const step = run?.steps.at(-1);
  if (!run || !step?.attempt) throw new Error("Expected current Attempt");
  const session = attachTestLiveSession(step, { canObserve, canTakeover });
  const target: LiveSessionActionTarget = {
    runId: run.id,
    occurrenceId: step.occurrence_id,
    attemptId: step.attempt.id,
    sessionId: session.id,
  };
  const descriptor: LocalSessionAttachmentDescriptor = {
    descriptor_token: "descriptor-token",
    expires_at: "2099-01-01T00:00:00Z",
    mode: "local_native_terminal",
    worker_id: session.worker.id,
    worker_generation: 4,
    session_id: session.id,
    state: session.state,
    takeover_allowed: canTakeover,
    recovery_allowed: false,
    terminal: {
      attachment_mode: "local_native_terminal",
      backend_kind: "herdr",
      terminal_session_id: "worker-session",
      local_context_id: `sha256:${"a".repeat(64)}`,
      pane_id: "w2:p2",
      terminal_id: "terminal-1",
      supports_observation: true,
      supports_takeover: true,
    },
  };
  const localObservation: LocalObservationSession = {
    localSessionId: "local-observation-1",
    runId: target.runId,
    occurrenceId: target.occurrenceId,
    attemptId: target.attemptId,
    sessionId: target.sessionId,
    terminalSessionId: descriptor.terminal.terminal_session_id,
    paneId: descriptor.terminal.pane_id,
    terminalId: descriptor.terminal.terminal_id,
    mode: "observe",
    state: "attached",
    reason: null,
  };
  const api = {
    getSessionAttachment: vi.fn(async () => descriptor),
    recordSessionOpened: vi.fn(async () => session.id),
    authorizeExecutionPrompt: vi.fn(),
    cancelExecutionAttempt: vi.fn(),
  };
  const store = createAppStore(
    api as unknown as ApiClient,
    "ws://fixture.invalid/socket",
    fixture,
  );
  const nativeOpen = vi
    .spyOn(liveSessionPlatform, "openLocalLiveSession")
    .mockResolvedValue(localObservation);
  const nativeClose = vi
    .spyOn(liveSessionPlatform, "closeLocalLiveSession")
    .mockImplementation(async (value) => ({
      ...value,
      state: "detached",
      reason: "explicit_close",
    }));
  return {
    api,
    descriptor,
    fixture,
    localObservation,
    nativeClose,
    nativeOpen,
    run,
    step,
    store,
    target,
  };
}

test("observe-only Product authority opens once and never invokes takeover", async () => {
  const { api, descriptor, nativeOpen, store, target } = setup(true, false);

  expect(await store.openSession(target)).toBe(true);
  expect(nativeOpen).toHaveBeenCalledOnce();
  expect(nativeOpen).toHaveBeenCalledWith(descriptor, "observe", target);
  expect(api.recordSessionOpened).toHaveBeenCalledWith(
    "descriptor-token",
    "observe",
  );

  expect(await store.takeControl(target)).toBe(false);
  expect(api.getSessionAttachment).toHaveBeenCalledTimes(1);
  expect(nativeOpen).toHaveBeenCalledTimes(1);
  expect(get(store.error)?.code).toBe("session_takeover_unavailable");
});

test("concurrent observation requests share one native attachment", async () => {
  const { api, localObservation, nativeOpen, store, target } = setup(
    true,
    false,
  );
  const response = deferred<LocalObservationSession>();
  nativeOpen.mockImplementation(async () => response.promise);

  const first = store.openSession(target);
  const second = store.openSession(target);
  await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
  response.resolve(localObservation);

  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(api.getSessionAttachment).toHaveBeenCalledOnce();
  expect(api.recordSessionOpened).toHaveBeenCalledOnce();
  expect(nativeOpen).toHaveBeenCalledOnce();
});

test("a Product open-recording failure closes the exact local attachment", async () => {
  const { api, localObservation, nativeClose, store, target } = setup(
    true,
    false,
  );
  api.recordSessionOpened.mockRejectedValueOnce(
    new Error("Product open record failed"),
  );

  expect(await store.openSession(target)).toBe(false);
  expect(nativeClose).toHaveBeenCalledOnce();
  expect(nativeClose).toHaveBeenCalledWith(localObservation);
  expect(get(store.localObservations)).toEqual({});
});

test("dual authority keeps observation and takeover on distinct native modes", async () => {
  const { api, descriptor, nativeOpen, store, target } = setup(true, true);

  expect(await store.openSession(target)).toBe(true);
  expect(await store.takeControl(target)).toBe(true);

  expect(nativeOpen.mock.calls).toEqual([
    [descriptor, "observe", target],
    [descriptor, "takeover", target],
  ]);
  expect(api.recordSessionOpened.mock.calls).toEqual([
    ["descriptor-token", "observe"],
    ["descriptor-token", "takeover"],
  ]);
});

test("no attachment authority blocks both observation and takeover", async () => {
  const { api, nativeOpen, store, target } = setup(false, false);

  expect(await store.openSession(target)).toBe(false);
  expect(await store.takeControl(target)).toBe(false);

  expect(api.getSessionAttachment).not.toHaveBeenCalled();
  expect(nativeOpen).not.toHaveBeenCalled();
});

test("takeover authority does not imply observation authority", async () => {
  const { api, descriptor, nativeOpen, store, target } = setup(false, true);

  expect(await store.openSession(target)).toBe(false);
  expect(await store.takeControl(target)).toBe(true);

  expect(api.getSessionAttachment).toHaveBeenCalledTimes(1);
  expect(nativeOpen).toHaveBeenCalledOnce();
  expect(nativeOpen).toHaveBeenCalledWith(descriptor, "takeover", target);
});

test("a replacement Attempt fences a descriptor before native attachment", async () => {
  const { api, descriptor, fixture, nativeOpen, run, store, target } = setup(
    true,
    false,
  );
  const response = deferred<LocalSessionAttachmentDescriptor>();
  api.getSessionAttachment.mockImplementation(async () => response.promise);

  const opening = store.openSession(target);
  await vi.waitFor(() =>
    expect(api.getSessionAttachment).toHaveBeenCalledOnce(),
  );
  const replacement: RunProjection = structuredClone(run);
  const replacementStep = replacement.steps.find(
    (step) => step.occurrence_id === target.occurrenceId,
  );
  if (!replacementStep?.attempt)
    throw new Error("Expected replacement Attempt");
  replacementStep.attempt.id = "replacement-attempt";
  fixture.runs[run.id] = replacement;
  store.selectedRun.set(replacement);
  response.resolve(descriptor);

  expect(await opening).toBe(false);
  expect(nativeOpen).not.toHaveBeenCalled();
  expect(api.recordSessionOpened).not.toHaveBeenCalled();
  expect(get(store.error)?.code).toBe("stale_session_attachment");
});

test("normal observer detach is local, idempotent, and never cancels or takes over", async () => {
  const { api, localObservation, nativeClose, nativeOpen, store, target } =
    setup(true, false);

  expect(await store.openSession(target)).toBe(true);
  expect(get(store.localObservations)[target.sessionId]).toEqual(
    localObservation,
  );
  expect(await store.detachSession(target)).toBe(true);
  expect(await store.detachSession(target)).toBe(true);

  expect(nativeOpen).toHaveBeenCalledTimes(1);
  expect(nativeClose).toHaveBeenCalledTimes(2);
  expect(nativeClose).toHaveBeenNthCalledWith(1, localObservation);
  expect(api.authorizeExecutionPrompt).not.toHaveBeenCalled();
  expect(api.cancelExecutionAttempt).not.toHaveBeenCalled();
  expect(nativeOpen.mock.calls.some((call) => call[1] === "takeover")).toBe(
    false,
  );
  expect(get(store.localObservations)[target.sessionId]).toMatchObject({
    localSessionId: localObservation.localSessionId,
    state: "detached",
    reason: "explicit_close",
  });
});

test("manual and unexpected observer exits reconcile truthful local state", async () => {
  const { localObservation, store, target } = setup(true, false);
  expect(await store.openSession(target)).toBe(true);
  expect(localObservationListener).not.toBeNull();

  localObservationListener?.({
    ...localObservation,
    state: "detached",
    reason: "terminal_closed",
  });
  expect(get(store.localObservations)[target.sessionId]).toMatchObject({
    state: "detached",
    reason: "terminal_closed",
  });

  localObservationListener?.({
    ...localObservation,
    state: "unavailable",
    reason: "attach_client_exited_unexpectedly",
  });
  expect(get(store.localObservations)[target.sessionId]).toMatchObject({
    state: "unavailable",
    reason: "attach_client_exited_unexpectedly",
  });
});

test("a stale observer close cannot detach a newer local observation", async () => {
  const { localObservation, nativeClose, nativeOpen, store, target } = setup(
    true,
    false,
  );
  expect(await store.openSession(target)).toBe(true);
  expect(await store.detachSession(target)).toBe(true);

  const newer = {
    ...localObservation,
    localSessionId: "local-observation-2",
    state: "attached" as const,
  };
  nativeOpen.mockResolvedValueOnce(newer);
  expect(await store.openSession(target)).toBe(true);
  localObservationListener?.({
    ...localObservation,
    state: "detached",
    reason: "late_old_close",
  });

  expect(get(store.localObservations)[target.sessionId]).toEqual(newer);
  expect(nativeClose).toHaveBeenCalledTimes(1);
});

test("open result remains non-optimistic until realtime Product state reconciles", async () => {
  const { run, store, target } = setup(true, false);
  const before = get(store.selectedRun);
  const sessionBefore = before?.steps.find(
    (step) => step.occurrence_id === target.occurrenceId,
  )?.session;

  expect(await store.openSession(target)).toBe(true);
  expect(
    get(store.selectedRun)?.steps.find(
      (step) => step.occurrence_id === target.occurrenceId,
    )?.session?.events,
  ).toEqual(sessionBefore?.events);

  const reconciled = structuredClone(run);
  const reconciledSession = reconciled.steps.find(
    (step) => step.occurrence_id === target.occurrenceId,
  )?.session;
  if (!reconciledSession) throw new Error("Expected reconciled session");
  reconciledSession.events.push({
    id: "opened-event",
    type: "local_session_opened",
    attention_id: null,
    metadata: { interaction_mode: "observe" },
    occurred_at: "2026-09-26T00:00:00Z",
  });
  store.selectedRun.set(reconciled);

  expect(
    get(store.selectedRun)
      ?.steps.find((step) => step.occurrence_id === target.occurrenceId)
      ?.session?.events.at(-1)?.type,
  ).toBe("local_session_opened");
});
