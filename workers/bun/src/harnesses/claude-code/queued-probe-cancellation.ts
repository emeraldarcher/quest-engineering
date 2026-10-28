import { randomUUID } from "node:crypto";
import { inspect, isDeepStrictEqual } from "node:util";
import type {
  StreamedProcess,
  StreamedProcessHandle,
} from "../../execution-environment/types.ts";

export interface ProbeCancellationScope {
  runId: string;
  attemptId: string;
  actionId: string;
  lineageId: string;
  sessionId: string;
  process: StreamedProcess;
}
export interface QueuedProbeCancellationEvidence {
  request: "queued_cancel_request_sent" | "queued_cancel_request_unavailable";
  response:
    | "cancelled_true"
    | "cancelled_false"
    | "response_unavailable"
    | "response_malformed";
}

/** Operation-owned authority, NOT the lifecycle recorder's comparison binding.
 * No native input can supply its target. Only prepareProbe assigns the fresh
 * Worker-generated outbound UUID. Private operands never enter evidence.
 */
export class QueuedProbeCancellation {
  #scope: ProbeCancellationScope | null;
  #handle: StreamedProcessHandle | null;
  #current: (() => ProbeCancellationScope | null) | null;
  #probe: string | null = null;
  #request: string | null = null;
  #deadline: number | null = null;
  #probeAcknowledged = false;
  #attempted = false;
  #publish: ((value: QueuedProbeCancellationEvidence) => void) | null;
  #now: () => number;
  #evidence: QueuedProbeCancellationEvidence = {
    request: "queued_cancel_request_unavailable",
    response: "response_unavailable",
  };
  // An enumerable function makes structuredClone reject instead of copying a
  // capability-looking object. No secret is stored in own public properties.
  readonly nonTransferable = () => undefined;

  constructor(
    scope: ProbeCancellationScope,
    current: () => ProbeCancellationScope | null,
    publish: (value: QueuedProbeCancellationEvidence) => void,
    now: () => number = Date.now,
  ) {
    this.#publish = publish;
    this.#now = now;
    this.#scope = { ...scope };
    this.#handle = structuredClone(scope.process.handle);
    this.#current = current;
    Object.freeze(this);
  }

  /** Called only by the outbound writer, never by the native parser. */
  prepareProbe(
    message: Record<string, unknown>,
    process: StreamedProcess,
    sessionId: string,
  ): void {
    try {
      if (
        this.#probe ||
        !this.#scope ||
        !this.matches({ ...this.#scope, process, sessionId }) ||
        message.type !== "user" ||
        message.shouldQuery !== false ||
        message.session_id !== sessionId
      ) {
        this.invalidate();
        return;
      }
      this.#probe = randomUUID();
      message.uuid = this.#probe;
    } catch {
      this.invalidate();
    }
  }

  acknowledgeProbe(process: StreamedProcess, sessionId: string): void {
    try {
      if (
        this.#probe &&
        this.#scope &&
        this.matches({ ...this.#scope, process, sessionId })
      )
        this.#probeAcknowledged = true;
    } catch {
      this.invalidate();
    }
  }

  arm(deadline: number): void {
    if (
      this.#deadline === null &&
      this.#probe &&
      this.#probeAcknowledged &&
      Number.isFinite(deadline)
    )
      this.#deadline = deadline;
  }

  /** Synchronous single attempt; no timers, promises, ACK or response wait.
   * The caller must still issue its existing physical cancel immediately. */
  atTimeout(process: StreamedProcess): void {
    if (this.#attempted) return;
    this.#attempted = true;
    try {
      if (
        !this.#probe ||
        !this.#scope ||
        this.#deadline === null ||
        this.#now() < this.#deadline ||
        !this.matches({ ...this.#scope, process })
      ) {
        this.invalidate();
        return;
      }
      this.#request = randomUUID();
      const bytes = new TextEncoder().encode(
        `${JSON.stringify({
          type: "control_request",
          request_id: this.#request,
          request: {
            subtype: "cancel_async_message",
            message_uuid: this.#probe,
          },
        })}\n`,
      );
      if (process.tryWriteDiagnostic?.(bytes) === true)
        this.#evidence.request = "queued_cancel_request_sent";
      else this.invalidate();
    } catch {
      this.invalidate();
    } finally {
      this.save();
    }
  }

  /** Already-parsed JSON only. Consume timeout control replies, not init/result
   * frames; never feed the diagnostic reply into readiness or retain its body.
   * Wrong/missing correlation remains unavailable and never means false. */
  observe(frame: Record<string, unknown>, process: StreamedProcess): boolean {
    if (!this.#attempted || own(frame, "type") !== "control_response")
      return false;
    try {
      if (
        !this.#request ||
        !this.#scope ||
        !this.matches({ ...this.#scope, process })
      )
        return true;
      const response = object(own(frame, "response"));
      if (own(response, "request_id") !== this.#request) return true;
      for (const value of [
        frame,
        response,
        object(own(response, "response")),
      ]) {
        for (const key of ["command_uuid", "message_uuid"])
          if (has(value, key) && own(value, key) !== this.#probe) return true;
        if (
          has(value, "session_id") &&
          own(value, "session_id") !== this.#scope?.sessionId
        )
          return true;
        if (
          has(value, "request_id") &&
          own(value, "request_id") !== this.#request
        )
          return true;
      }
      if (this.#evidence.response !== "response_unavailable") return true;
      const payload = object(own(response, "response"));
      const cancelled = own(payload, "cancelled");
      this.#evidence.response =
        own(response, "subtype") === "success" && typeof cancelled === "boolean"
          ? cancelled
            ? "cancelled_true"
            : "cancelled_false"
          : "response_malformed";
      this.save();
    } catch {
      /* No exception, operand, or raw error crosses the observer. */
    }
    return true;
  }

  invalidate(): void {
    this.#scope = null;
    this.#handle = null;
    this.#current = null;
    this.#probe = null;
    this.#request = null;
    this.#deadline = null;
    this.#probeAcknowledged = false;
    this.#publish = null;
    this.#now = Date.now;
  }

  snapshot(): QueuedProbeCancellationEvidence {
    return { ...this.#evidence };
  }
  toJSON(): never {
    throw new TypeError("Operation capability cannot be serialized.");
  }
  [Symbol.toPrimitive](): never {
    throw new TypeError("Operation capability cannot be converted.");
  }
  [inspect.custom](): string {
    return "[QueuedProbeCancellation]";
  }

  private matches(scope: ProbeCancellationScope): boolean {
    const expected = this.#scope,
      current = this.#current?.();
    if (
      !expected ||
      !current ||
      !this.#handle ||
      !validAttachment(this.#handle)
    )
      return false;
    for (const candidate of [scope, current]) {
      if (
        candidate.process !== expected.process ||
        !isDeepStrictEqual(candidate.process.handle, this.#handle)
      )
        return false;
      for (const key of [
        "runId",
        "attemptId",
        "actionId",
        "lineageId",
        "sessionId",
      ] as const)
        if (
          typeof expected[key] !== "string" ||
          !expected[key] ||
          candidate[key] !== expected[key]
        )
          return false;
    }
    return true;
  }
  private save(): void {
    try {
      this.#publish?.(this.snapshot());
    } catch {
      /* Fail open, fixed metadata only. */
    }
  }
}
function validAttachment(handle: StreamedProcessHandle): boolean {
  const ref = handle.environment;
  const owner = ref?.owner;
  const owned =
    owner?.kind === "run"
      ? typeof owner.runId === "string" && owner.runId.length > 0
      : owner?.kind === "provider_account" &&
        typeof owner.providerAccountId === "string" &&
        owner.providerAccountId.length > 0 &&
        Number.isSafeInteger(owner.credentialGeneration) &&
        owner.credentialGeneration > 0;
  return (
    owned &&
    handle.contractVersion === 1 &&
    !!ref &&
    handle.backendKind === ref.backendKind &&
    [
      handle.backendKind,
      handle.processGeneration,
      handle.backendProcessId,
      handle.processStartIdentity,
      handle.executable,
      handle.observedExecutable,
      ref.workerId,
      ref.environmentId,
      ref.incarnation,
      ref.profile?.id,
      ref.profile?.digest,
    ].every((value) => typeof value === "string" && value.length > 0)
  );
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function own(value: Record<string, unknown> | null, key: string): unknown {
  if (!value) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function has(value: Record<string, unknown> | null, key: string): boolean {
  return value !== null && Object.hasOwn(value, key);
}
