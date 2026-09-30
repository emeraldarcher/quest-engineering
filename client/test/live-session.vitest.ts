import { beforeEach, expect, test, vi } from "vitest";
import type { LocalSessionAttachmentDescriptor } from "../src/api/contracts";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import {
  closeLocalLiveSession,
  type LocalObservationSession,
  openLocalLiveSession,
  watchLocalLiveSessions,
} from "../src/platform/live-session";

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(true);
  tauri.listen.mockReset();
});

const owner = {
  runId: "run-1",
  occurrenceId: "occurrence-1",
  attemptId: "attempt-1",
  sessionId: "lineage-1",
};

function observation(
  state: LocalObservationSession["state"] = "attached",
): LocalObservationSession {
  return {
    ...owner,
    localSessionId: "local-observation-1",
    terminalSessionId: "worker-session",
    paneId: "w2:p2",
    terminalId: "terminal-1",
    mode: "observe",
    state,
    reason: null,
  };
}

function attachment(): LocalSessionAttachmentDescriptor {
  return {
    descriptor_token: "short-lived-token",
    expires_at: "2099-01-01T00:00:00Z",
    mode: "local_native_terminal",
    worker_id: "worker-1",
    worker_generation: 4,
    session_id: "lineage-1",
    state: "waiting_for_human",
    takeover_allowed: true,
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
}

test("passes the exact Product pane and owner to native observation", async () => {
  tauri.invoke.mockResolvedValueOnce(observation());
  await openLocalLiveSession(attachment(), "observe", owner);

  expect(tauri.invoke).toHaveBeenCalledOnce();
  expect(tauri.invoke).toHaveBeenCalledWith("open_live_session", {
    descriptor: {
      mode: "local_native_terminal",
      backendKind: "herdr",
      terminalSessionId: "worker-session",
      localContextId: `sha256:${"a".repeat(64)}`,
      paneId: "w2:p2",
      terminalId: "terminal-1",
      workerId: "worker-1",
      sessionId: "lineage-1",
      takeoverAllowed: true,
      recoveryAllowed: false,
    },
    interactionMode: "observe",
    owner,
  });
});

test("Take Control resolves the same exact pane ID with a distinct mode", async () => {
  tauri.invoke.mockResolvedValueOnce({ ...observation(), mode: "takeover" });
  await openLocalLiveSession(attachment(), "takeover", owner);

  expect(tauri.invoke).toHaveBeenCalledWith(
    "open_live_session",
    expect.objectContaining({
      descriptor: expect.objectContaining({ paneId: "w2:p2" }),
      interactionMode: "takeover",
      owner,
    }),
  );
});

test("surfaces a split Worker/desktop Herdr context as an actionable local error", async () => {
  tauri.invoke.mockRejectedValueOnce(
    "The desktop Herdr session context does not match the Worker context. Ensure the Worker and desktop use the same QE_HERDR_BIN, XDG_CONFIG_HOME, and HERDR_CONFIG_PATH.",
  );

  await expect(
    openLocalLiveSession(attachment(), "observe", owner),
  ).rejects.toMatchObject({
    code: "local_herdr_context_mismatch",
    message: expect.stringContaining("XDG_CONFIG_HOME"),
  });
});

test("surfaces configured Herdr resolution failures without misclassifying the session", async () => {
  tauri.invoke.mockRejectedValueOnce(
    "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.",
  );

  await expect(
    openLocalLiveSession(attachment(), "observe", owner),
  ).rejects.toMatchObject({
    code: "local_herdr_runtime_unavailable",
    message:
      "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.",
  });
});

test("closes only the exact native observation handle", async () => {
  const closed = { ...observation("detached"), reason: "explicit_close" };
  tauri.invoke.mockResolvedValueOnce(closed);

  await expect(closeLocalLiveSession(observation())).resolves.toEqual(closed);
  expect(tauri.invoke).toHaveBeenCalledWith("close_live_session", {
    session: observation(),
  });
});

test("live-session event registration failures retain the native operation", async () => {
  tauri.listen.mockRejectedValueOnce("native event listener failed");

  await expect(watchLocalLiveSessions(vi.fn())).rejects.toMatchObject({
    code: "local_session_event_initialization_failed",
    message: "Native live-session events could not be initialized.",
    meta: {
      operation: "plugin:event|listen",
      native_error: "native event listener failed",
    },
  });
});

test("forwards authoritative manual and unexpected close events", async () => {
  const stop = vi.fn();
  let callback:
    | ((event: { payload: LocalObservationSession }) => void)
    | undefined;
  tauri.listen.mockImplementationOnce(
    async (
      _name: string,
      listener: (event: { payload: LocalObservationSession }) => void,
    ) => {
      callback = listener;
      return stop;
    },
  );
  const observer = vi.fn();
  await expect(watchLocalLiveSessions(observer)).resolves.toBe(stop);

  const closed = {
    ...observation("detached"),
    reason: "terminal_closed",
  };
  if (!callback) throw new Error("Expected native event callback");
  callback({ payload: closed });
  expect(observer).toHaveBeenCalledWith(closed);
});
