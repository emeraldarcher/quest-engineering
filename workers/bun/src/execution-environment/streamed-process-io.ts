import type { StreamedProcessHandle } from "./types.ts";

/** Internal diagnostic bounds, never execution/attestation deadlines. */
export const STREAMED_PROCESS_IO_TIMEOUT_MS = 3_000;
export const STREAMED_PROCESS_IO_UNAVAILABLE = [
  "unsupported",
  "identity_mismatch",
  "environment_unavailable",
  "attachment_unavailable",
  "busy",
  "timed_out",
  "malformed_observation",
  "observation_failed",
] as const;
export type StreamedProcessIoUnavailableReason =
  (typeof STREAMED_PROCESS_IO_UNAVAILABLE)[number];
export type StreamedProcessIoUnavailable = {
  status: "unavailable";
  reason: StreamedProcessIoUnavailableReason;
};
export const STDIN_PIPE_UNAVAILABLE = [
  "unsupported_ioctl",
  "not_pipe",
  "closed",
  "process_exited",
  "observation_failed",
] as const;
export type StdinPipeObservation =
  | { status: "observed"; unreadBytes: number }
  | { status: "unavailable"; reason: (typeof STDIN_PIPE_UNAVAILABLE)[number] };

/** Guest relay facts only. Byte counts are bytes read by the relay, not parsed frames. */
export interface StreamedProcessIoSample {
  observedAt: string;
  elapsedMs: number;
  stdin: StdinPipeObservation;
  stdoutBytes: number;
  stderrBytes: number;
  /** No inferred liveness; this is whether the relay has observed terminal exit. */
  terminal: "not_observed" | "observed";
}
export type StreamedProcessIoSnapshot =
  | StreamedProcessIoUnavailable
  | {
      status: "available";
      handle: StreamedProcessHandle;
      receivedAt: string;
      sample: StreamedProcessIoSample;
      /** Captured in the guest immediately before its existing cancellation action. */
      beforeCancellation: StreamedProcessIoSample | null;
    };

export function ioUnavailable(
  reason: StreamedProcessIoUnavailableReason,
): StreamedProcessIoUnavailable {
  return { status: "unavailable", reason };
}

/** Allowlisted reconstruction, not copying or redacting arbitrary backend objects. */
export function safeIoSample(value: unknown): StreamedProcessIoSample | null {
  try {
    const v = object(value);
    const input = object(v.stdin);
    if (
      typeof v.observedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.observedAt) ||
      !Number.isFinite(Date.parse(v.observedAt)) ||
      !count(v.elapsedMs) ||
      !count(v.stdoutBytes) ||
      !count(v.stderrBytes) ||
      (v.terminal !== "not_observed" && v.terminal !== "observed")
    )
      return null;
    let stdin: StdinPipeObservation;
    if (input.status === "observed" && count(input.unreadBytes))
      stdin = { status: "observed", unreadBytes: input.unreadBytes };
    else if (
      input.status === "unavailable" &&
      STDIN_PIPE_UNAVAILABLE.includes(input.reason as never)
    )
      stdin = {
        status: "unavailable",
        reason: input.reason as (typeof STDIN_PIPE_UNAVAILABLE)[number],
      };
    else return null;
    return {
      observedAt: v.observedAt,
      elapsedMs: v.elapsedMs,
      stdin,
      stdoutBytes: v.stdoutBytes,
      stderrBytes: v.stderrBytes,
      terminal: v.terminal,
    };
  } catch {
    return null;
  }
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid I/O metadata.");
  return value as Record<string, unknown>;
}
