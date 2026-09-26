import { get } from "svelte/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiClient } from "../src/api/client";
import type {
  LocalSessionAttachmentDescriptor,
  RunProjection,
} from "../src/api/contracts";
import { createFixture } from "../src/fixtures/fixtures";
import * as liveSessionPlatform from "../src/platform/live-session";
import {
  createAppStore,
  type LiveSessionActionTarget,
} from "../src/state/app-store";
import { attachTestLiveSession } from "./live-session-fixture";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
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
      pane_id: "w2:p2",
      terminal_id: "terminal-1",
      supports_observation: true,
      supports_takeover: true,
    },
  };
  const api = {
    getSessionAttachment: vi.fn(async () => descriptor),
    recordSessionOpened: vi.fn(async () => session.id),
  };
  const store = createAppStore(
    api as unknown as ApiClient,
    "ws://fixture.invalid/socket",
    fixture,
  );
  const nativeOpen = vi
    .spyOn(liveSessionPlatform, "openLocalLiveSession")
    .mockResolvedValue();
  return { api, descriptor, fixture, nativeOpen, run, step, store, target };
}

test("observe-only Product authority opens once and never invokes takeover", async () => {
  const { api, descriptor, nativeOpen, store, target } = setup(true, false);

  expect(await store.openSession(target)).toBe(true);
  expect(nativeOpen).toHaveBeenCalledOnce();
  expect(nativeOpen).toHaveBeenCalledWith(descriptor, "observe");
  expect(api.recordSessionOpened).toHaveBeenCalledWith(
    "descriptor-token",
    "observe",
  );

  expect(await store.takeControl(target)).toBe(false);
  expect(api.getSessionAttachment).toHaveBeenCalledTimes(1);
  expect(nativeOpen).toHaveBeenCalledTimes(1);
  expect(get(store.error)?.code).toBe("session_takeover_unavailable");
});

test("dual authority keeps observation and takeover on distinct native modes", async () => {
  const { api, descriptor, nativeOpen, store, target } = setup(true, true);

  expect(await store.openSession(target)).toBe(true);
  expect(await store.takeControl(target)).toBe(true);

  expect(nativeOpen.mock.calls).toEqual([
    [descriptor, "observe"],
    [descriptor, "takeover"],
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
  expect(nativeOpen).toHaveBeenCalledWith(descriptor, "takeover");
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
