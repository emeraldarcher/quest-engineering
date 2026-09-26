import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ApiError,
  type LocalSessionAttachmentDescriptor,
} from "../api/contracts";

const HERDR_RUNTIME_UNAVAILABLE =
  "Compatible Quest Engineering Herdr runtime unavailable.";

export type SessionOpenMode = "observe" | "takeover" | "recovery";

export function canOpenLocalLiveSession(): boolean {
  return isTauri();
}

/** Native code validates local Herdr identity and owns command construction. */
export async function openLocalLiveSession(
  attachment: LocalSessionAttachmentDescriptor,
  mode: SessionOpenMode,
): Promise<void> {
  if (!isTauri())
    throw new Error(
      "Live sessions can only be opened from the local desktop app.",
    );
  if (Date.parse(attachment.expires_at) <= Date.now())
    throw new Error("The live-session attachment descriptor expired.");
  if (mode === "takeover" && !attachment.takeover_allowed)
    throw new Error("Interactive takeover is not available for this session.");
  if (mode === "recovery" && !attachment.recovery_allowed)
    throw new Error("Interactive recovery is not available for this session.");
  try {
    await invoke("open_live_session", {
      descriptor: {
        mode: attachment.mode,
        backendKind: attachment.terminal.backend_kind,
        terminalSessionId: attachment.terminal.terminal_session_id,
        paneId: attachment.terminal.pane_id,
        terminalId: attachment.terminal.terminal_id,
        workerId: attachment.worker_id,
        sessionId: attachment.session_id,
        takeoverAllowed: attachment.takeover_allowed,
        recoveryAllowed: attachment.recovery_allowed,
      },
      interactionMode: mode,
    });
  } catch (cause) {
    const message =
      typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : "";
    if (message.startsWith(HERDR_RUNTIME_UNAVAILABLE))
      throw new ApiError("local_herdr_runtime_unavailable", message);
    throw cause;
  }
}
