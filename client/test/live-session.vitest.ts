import { beforeEach, expect, test, vi } from "vitest";
import type { LocalSessionAttachmentDescriptor } from "../src/api/contracts";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

import { openLocalLiveSession } from "../src/platform/live-session";

beforeEach(() => {
  tauri.invoke.mockClear();
  tauri.isTauri.mockReturnValue(true);
});

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
      pane_id: "w2:p2",
      terminal_id: "terminal-1",
      supports_observation: true,
      supports_takeover: true,
    },
  };
}

test("passes the exact Product pane ID to native observation without mutation", async () => {
  await openLocalLiveSession(attachment(), "observe");

  expect(tauri.invoke).toHaveBeenCalledOnce();
  expect(tauri.invoke).toHaveBeenCalledWith("open_live_session", {
    descriptor: {
      mode: "local_native_terminal",
      backendKind: "herdr",
      terminalSessionId: "worker-session",
      paneId: "w2:p2",
      terminalId: "terminal-1",
      workerId: "worker-1",
      sessionId: "lineage-1",
      takeoverAllowed: true,
      recoveryAllowed: false,
    },
    interactionMode: "observe",
  });
});

test("Take Control resolves the same exact pane ID with a distinct mode", async () => {
  await openLocalLiveSession(attachment(), "takeover");

  expect(tauri.invoke).toHaveBeenCalledWith(
    "open_live_session",
    expect.objectContaining({
      descriptor: expect.objectContaining({ paneId: "w2:p2" }),
      interactionMode: "takeover",
    }),
  );
});

test("surfaces configured Herdr resolution failures without misclassifying the session", async () => {
  tauri.invoke.mockRejectedValueOnce(
    "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.",
  );

  await expect(
    openLocalLiveSession(attachment(), "observe"),
  ).rejects.toMatchObject({
    code: "local_herdr_runtime_unavailable",
    message:
      "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.",
  });
});
