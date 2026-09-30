import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ApiError,
  type LocalSessionAttachmentDescriptor,
} from "../api/contracts";

const HERDR_RUNTIME_UNAVAILABLE =
  "Compatible Quest Engineering Herdr runtime unavailable.";
const HERDR_CONTEXT_ERRORS = [
  "Compatible Quest Engineering Herdr session context unavailable.",
  "The desktop Herdr session context does not match the Worker context.",
  "The configured Herdr session namespace does not contain the referenced Worker session.",
] as const;

export type SessionOpenMode = "observe" | "takeover" | "recovery";

export interface LocalSessionOwner {
  runId: string;
  occurrenceId: string;
  attemptId: string;
  sessionId: string;
}

export interface LocalObservationSession extends LocalSessionOwner {
  localSessionId: string;
  terminalSessionId: string;
  paneId: string;
  terminalId: string | null;
  mode: SessionOpenMode;
  state: "attached" | "detaching" | "detached" | "unavailable";
  reason: string | null;
}

const LOCAL_OBSERVATION_EVENT = "qe://local-observation-state";

export function canOpenLocalLiveSession(): boolean {
  return isTauri();
}

/** Native code validates local Herdr identity and owns command construction. */
export async function openLocalLiveSession(
  attachment: LocalSessionAttachmentDescriptor,
  mode: SessionOpenMode,
  owner: LocalSessionOwner,
): Promise<LocalObservationSession> {
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
    return await invoke<LocalObservationSession>("open_live_session", {
      descriptor: {
        mode: attachment.mode,
        backendKind: attachment.terminal.backend_kind,
        terminalSessionId: attachment.terminal.terminal_session_id,
        localContextId: attachment.terminal.local_context_id,
        paneId: attachment.terminal.pane_id,
        terminalId: attachment.terminal.terminal_id,
        workerId: attachment.worker_id,
        sessionId: attachment.session_id,
        takeoverAllowed: attachment.takeover_allowed,
        recoveryAllowed: attachment.recovery_allowed,
      },
      interactionMode: mode,
      owner,
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
    if (HERDR_CONTEXT_ERRORS.some((prefix) => message.startsWith(prefix)))
      throw new ApiError("local_herdr_context_mismatch", message);
    throw cause;
  }
}

export async function closeLocalLiveSession(
  session: LocalObservationSession,
): Promise<LocalObservationSession> {
  if (!isTauri())
    throw new Error(
      "Live sessions can only be closed from the local desktop app.",
    );
  return invoke<LocalObservationSession>("close_live_session", { session });
}

export async function watchLocalLiveSessions(
  observer: (session: LocalObservationSession) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  try {
    return await listen<LocalObservationSession>(
      LOCAL_OBSERVATION_EVENT,
      (event) => observer(event.payload),
    );
  } catch (cause) {
    throw new ApiError(
      "local_session_event_initialization_failed",
      "Native live-session events could not be initialized.",
      [],
      {
        operation: "plugin:event|listen",
        native_error: nativeErrorMessage(cause),
      },
    );
  }
}

function nativeErrorMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
