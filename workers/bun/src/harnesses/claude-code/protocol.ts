import { randomUUID } from "node:crypto";
import type {
  StreamedProcess,
  StreamedProcessStreamEvent,
} from "../../execution-environment/types.ts";
import type { ManagedHarnessLifecycle } from "../lifecycle-diagnostics.ts";
import type { ClaudeOutputUnit } from "./output-census.ts";
import {
  decodeClaudeOutputTag,
  hasClaudeRoot,
  isClaudeInit,
} from "./output-tags.ts";
import type {
  QueuedProbeCancellation,
  QueuedProbeCancellationEvidence,
} from "./queued-probe-cancellation.ts";

export class ClaudeProtocolTimeout extends Error {
  constructor() {
    super("Claude Code protocol frame timed out.");
  }
}

export class AsyncFrameQueue {
  private readonly values: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  cursor = 0;
  closed = false;
  private error: Error | null = null;

  push(value: Record<string, unknown>): void {
    if (this.closed) return;
    this.cursor += 1;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else this.values.push(value);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** Preparation teardown discards buffered native frames; never reusable. */
  retire(): void {
    this.values.length = 0;
    this.fail(new Error("Claude protocol observation was retired."));
  }

  next(timeoutMs: number | null): Promise<Record<string, unknown>> {
    const value = this.values.shift();
    if (value) return Promise.resolve(value);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      if (timeoutMs !== null)
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ClaudeProtocolTimeout());
        }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

export function observeClaudeProtocol(
  process: StreamedProcess,
  frames: AsyncFrameQueue,
  diagnostics: ManagedHarnessLifecycle | null,
  disconnected: () => boolean,
  queuedCancellation?: QueuedProbeCancellation,
): () => void {
  let binding: {
    process: StreamedProcess;
    frames: AsyncFrameQueue;
    diagnostics: ManagedHarnessLifecycle | null;
    disconnected: () => boolean;
    queuedCancellation: QueuedProbeCancellation | undefined;
  } | null = { process, frames, diagnostics, disconnected, queuedCancellation };
  void pump(
    process.stdout,
    frames,
    (frame) => {
      const b = binding;
      b?.diagnostics?.observeInit(frame, b.process.handle);
    },
    (unit) => {
      const b = binding;
      b?.diagnostics?.observeClaudeOutput(unit, b.process.handle);
    },
    (frame) => {
      const b = binding;
      return b?.queuedCancellation?.observe(frame, b.process) ?? false;
    },
    () => binding !== null,
  )
    .catch(() => {
      const b = binding;
      if (!b) return;
      b.diagnostics?.record("protocol_observation_failed", b.process.handle);
      // JSON/UTF-8 parser exceptions can contain native input excerpts.
      b.frames.fail(
        new Error("Claude Code stdout protocol observation failed."),
      );
    })
    .finally(() => binding?.queuedCancellation?.invalidate());
  void process.exit.then((exit) => {
    const b = binding;
    if (!b) return;
    b.queuedCancellation?.invalidate();
    b.diagnostics?.record("process_exit_observed", b.process.handle, { exit });
    b.diagnostics?.captureIo("process_exit_observed", b.process);
    if (!b.disconnected() && !b.frames.closed)
      b.frames.fail(
        new Error(
          exit.kind === "observation_unavailable"
            ? "Claude Code process observation became unavailable before protocol settlement."
            : "Claude Code exited before protocol settlement.",
        ),
      );
  });
  diagnostics?.record("stream_observation_registered", process.handle);
  return () => {
    const b = binding;
    binding = null;
    b?.queuedCancellation?.invalidate();
    b?.diagnostics?.retireProbeCommand();
    b?.frames.retire();
  };
}

export async function pump(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
  frames: AsyncFrameQueue,
  onFrame: (frame: Record<string, unknown>) => void = () => undefined,
  onUnit: (unit: ClaudeOutputUnit) => void = () => undefined,
  consumeDiagnostic: (frame: Record<string, unknown>) => boolean = () => false,
  observing: () => boolean = () => true,
): Promise<void> {
  const observe = (unit: ClaudeOutputUnit) => {
    try {
      onUnit(unit);
    } catch {
      /* Diagnostic loss must never change parser behavior. */
    }
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for await (const event of stream) {
    // Keep draining the owned iterator without parsing/observing. Returning
    // early could disconnect transport ahead of the owner's physical cancel.
    if (!observing()) continue;
    if (event.kind === "transport_error")
      throw new Error("Claude Code stdout transport failed.");
    if (event.kind !== "data") continue;
    try {
      buffered += decoder.decode(event.data, { stream: true });
    } catch (error) {
      observe({ kind: "invalid_utf8" });
      throw error;
    }
    if (Buffer.byteLength(buffered, "utf8") > 2 * 1024 * 1024) {
      observe({ kind: "buffer_limit" });
      throw new Error("Claude Code stream frame exceeded its bound.");
    }
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line) {
        observe({ kind: "empty" });
        continue;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        // Decoded UTF-8 unit size includes LF. Raw relay byte counts stay separate
        // (the decoder can strip a BOM); no text leaves this parser boundary.
        observe({
          kind: "non_json",
          decodedUtf8Bytes: Buffer.byteLength(line, "utf8") + 1,
        });
        throw new Error("Claude Code emitted invalid JSON.");
      }
      observe({ kind: "json", value: frame });
      if (decodeClaudeOutputTag(frame).kind === "non_object")
        throw new Error("Claude Code emitted a malformed frame.");
      const object = frame as Record<string, unknown>;
      // Observation is not authority and must never alter protocol settlement.
      try {
        onFrame(object);
      } catch {
        // Drop only the diagnostic breadcrumb, never the real frame.
      }
      try {
        if (consumeDiagnostic(object)) continue;
      } catch {
        /* Observer failure cannot reject a real protocol frame. */
      }
      if (observing()) frames.push(object);
    }
  }
  try {
    buffered += decoder.decode();
  } catch (error) {
    observe({ kind: "invalid_utf8" });
    throw error;
  }
  if (buffered.length > 0) {
    observe({
      kind: "incomplete_eof",
      decodedUtf8Bytes: Buffer.byteLength(buffered, "utf8"),
    });
    throw new Error("Claude Code stdout ended inside a frame.");
  }
  frames.fail(new Error("Claude Code stdout ended before settlement."));
}

export async function sendMessage(
  process: StreamedProcess,
  sessionId: string,
  content: string,
  shouldQuery: boolean,
  diagnostics: ManagedHarnessLifecycle | null = null,
  queuedCancellation?: QueuedProbeCancellation,
  beforeProbe?: () => void,
): Promise<void> {
  if (!shouldQuery && diagnostics) {
    try {
      await diagnostics.capturePreProbeIo(process);
    } catch {
      /* Unavailable baseline is not a prerequisite for probe submission. */
    }
  }
  if (!shouldQuery) beforeProbe?.();
  const message = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    client_composed: true,
    ...(shouldQuery ? {} : { shouldQuery: false, isSynthetic: true }),
  };
  if (!shouldQuery) {
    // Distinct operation authority creates its own Worker UUID on this outbound
    // object. The recorder still gets only its independent comparison binding.
    queuedCancellation?.prepareProbe(message, process, sessionId);
    try {
      diagnostics?.bindProbeCommand(message.uuid, sessionId, process.handle);
    } catch {
      /* Correlation loss cannot reject or suppress the probe. */
    }
    // The owned command UUID is comparison-only, never diagnostic output.
    diagnostics?.record("probe_write_requested", process.handle);
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
  const receipt = await process.write(
    bytes,
    shouldQuery ? undefined : beforeProbe,
  );
  if (
    !shouldQuery &&
    receipt.certainty === "acknowledged" &&
    receipt.byteLength === bytes.byteLength
  ) {
    queuedCancellation?.acknowledgeProbe(process, sessionId);
    diagnostics?.record("probe_write_acknowledged", process.handle, {
      operationId: receipt.writeId,
    });
    diagnostics?.captureIo("probe_write_acknowledged", process);
  } else if (!shouldQuery) queuedCancellation?.invalidate();
}

export async function waitForInit(
  frames: AsyncFrameQueue,
  timeoutMs: number,
  onTimeout: () => void = () => undefined,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (let count = 0; count < 64 && Date.now() < deadline; count += 1) {
      const frame = await frames.next(Math.max(1, deadline - Date.now()));
      const tag = decodeClaudeOutputTag(frame);
      if (isClaudeInit(tag)) return frame;
      rejectServerToolEvidence(frame);
      if (hasClaudeRoot(tag, "result") && frame.is_error === true)
        throw new Error(
          "Claude Code failed before zero-inference init attestation.",
        );
    }
  } catch (error) {
    if (error instanceof ClaudeProtocolTimeout) {
      try {
        onTimeout();
      } catch {
        // A failed evidence sink cannot change the timeout outcome.
      }
    }
    throw error;
  }
  throw new Error("Claude Code did not emit bounded init attestation.");
}

export async function cancelClaudePreparation(
  process: StreamedProcess,
  diagnostics: ManagedHarnessLifecycle | null,
  queuedCancellation?: QueuedProbeCancellation | null,
): Promise<void> {
  // Called with this capability ONLY for the existing init readiness timeout.
  // Synchronous best-effort dispatch, never an ordinary/queued async write.
  if (queuedCancellation !== undefined) {
    let evidence: QueuedProbeCancellationEvidence = {
      request: "queued_cancel_request_unavailable",
      response: "response_unavailable",
    };
    try {
      queuedCancellation?.atTimeout(process);
      if (queuedCancellation) evidence = queuedCancellation.snapshot();
    } catch {
      /* Still cancel physically; never retain an exception. */
    }
    diagnostics?.recordQueuedProbeCancellation(evidence, process.handle);
  }
  diagnostics?.record("cancellation_requested", process.handle);
  try {
    const receipt = await process.cancel();
    // ACK proves submission, not the precise native signal submission timestamp.
    if (receipt.certainty === "acknowledged")
      diagnostics?.record("cancellation_acknowledged", process.handle, {
        operationId: receipt.cancellationId,
      });
  } finally {
    try {
      queuedCancellation?.invalidate();
    } catch {
      /* Diagnostic revocation cannot replace cancellation outcome. */
    }
  }
}

export function rejectServerToolEvidence(frame: Record<string, unknown>): void {
  const encoded = JSON.stringify(frame);
  if (
    encoded.includes("server_tool_use") ||
    encoded.includes("web_search_20250305") ||
    encoded.includes("advisor_20260301") ||
    encoded.includes("agent_toolset_20260401")
  )
    throw new Error(
      "Claude provider/server tool evidence violated exact policy.",
    );
}
