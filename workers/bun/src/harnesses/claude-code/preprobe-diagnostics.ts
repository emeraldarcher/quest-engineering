import { inspect, isDeepStrictEqual } from "node:util";
import type {
  StreamedProcess,
  StreamedProcessHandle,
  StreamedProcessNegotiatedCapabilities,
} from "../../execution-environment/types.ts";
import type { ExecuteAction } from "../../protocol/types.ts";
import { OperationalExecutionError } from "../types.ts";

export interface ProbeExecutionContinuity {
  /** One-use receipt from new acceptance in this Worker epoch, NOT wire metadata. */
  freshAcceptance: boolean;
  continuation: boolean;
  recovering: boolean;
  priorSession: boolean;
}

/** Product initial epoch 0 / first attributed Attempt. Presence of recovery
 * metadata is normal; a missing object cannot prove first-attempt semantics.
 * Metadata selects eligibility only, never the cancellation target/authority. */
export function isFreshInitialProbeExecution(
  action: ExecuteAction,
  continuity: ProbeExecutionContinuity,
): boolean {
  try {
    if (
      continuity.freshAcceptance !== true ||
      continuity.continuation !== false ||
      continuity.recovering !== false ||
      continuity.priorSession !== false ||
      action.execution.context.mode !== "fresh" ||
      action.execution.context.source_occurrence_id !== null ||
      action.context_requirement.selector !== "fresh" ||
      action.context_lineage_occurrence_id !== null
    )
      return false;
    const recovery = action.operational_recovery;
    return (
      recovery !== null &&
      typeof recovery === "object" &&
      recovery.authorization_kind === "initial" &&
      recovery.continuation_mode === "fresh" &&
      recovery.epoch_number === 0 &&
      recovery.attempt_in_epoch === 1 &&
      (recovery.attempt_allowance === null ||
        (Number.isSafeInteger(recovery.attempt_allowance) &&
          recovery.attempt_allowance > 0)) &&
      recovery.retained_lineage_id === null &&
      recovery.source_attempt_id === null &&
      recovery.request_id === null
    );
  } catch {
    return false;
  }
}

export class ClaudeDiagnosticCapabilityUnavailable extends OperationalExecutionError {
  constructor(
    readonly negotiation: "unsupported" | "unavailable" = "unavailable",
  ) {
    super(
      "Claude Code pre-probe diagnostic capability was not proven for the current attachment and Worker epoch.",
      "terminal_not_recoverable",
      "diagnostic_capability_unavailable",
      { diagnostic_capability: negotiation },
      { phase: "prepare", sideEffectCertainty: "not_submitted" },
    );
  }
}

/** Ephemeral pre-write guard. A past supported snapshot is not authority.
 * Rechecks exact attachment + memory-only operation/epoch fences after the
 * existing pre-probe observation await. No target command is issued here. */
export class ClaudePreProbeGate {
  #process: StreamedProcess | null;
  #handle: StreamedProcessHandle | null = null;
  #current: (() => boolean) | null;
  #publish:
    | ((
        status: StreamedProcessNegotiatedCapabilities["nonblockingDiagnosticWrite"],
      ) => void)
    | null;
  readonly nonTransferable = () => undefined;
  constructor(
    process: StreamedProcess,
    current: () => boolean,
    publish: (
      status: StreamedProcessNegotiatedCapabilities["nonblockingDiagnosticWrite"],
    ) => void,
  ) {
    this.#process = process;
    this.#current = current;
    this.#publish = publish;
    try {
      this.#handle = structuredClone(process.handle);
    } catch {
      /* unavailable */
    }
    Object.freeze(this);
  }
  check(): void {
    let status: StreamedProcessNegotiatedCapabilities["nonblockingDiagnosticWrite"] =
      "unavailable";
    try {
      if (
        this.#process &&
        this.#handle &&
        this.#current?.() === true &&
        isDeepStrictEqual(this.#process.handle, this.#handle)
      ) {
        const value = this.#process.negotiatedCapabilities?.();
        const field =
          value &&
          Object.getOwnPropertyDescriptor(value, "nonblockingDiagnosticWrite");
        if (
          field &&
          "value" in field &&
          ["supported", "unsupported", "unavailable"].includes(field.value)
        )
          status = field.value;
      }
    } catch {
      /* No raw transport/identity exception crosses this gate. */
    }
    try {
      this.#publish?.(status);
    } catch {
      /* Projection is not authority. */
    }
    if (status !== "supported")
      throw new ClaudeDiagnosticCapabilityUnavailable(status);
    // A projection callback cannot preserve support after synchronous revocation.
    let stillCurrent = false;
    try {
      stillCurrent = Boolean(
        this.#process &&
          this.#handle &&
          this.#current?.() === true &&
          isDeepStrictEqual(this.#process.handle, this.#handle),
      );
    } catch {
      /* unavailable */
    }
    if (!stillCurrent) throw new ClaudeDiagnosticCapabilityUnavailable();
  }
  invalidate(): void {
    this.#process = null;
    this.#handle = null;
    this.#current = null;
    this.#publish = null;
  }
  toJSON(): never {
    throw new TypeError("Probe gate cannot be serialized.");
  }
  [Symbol.toPrimitive](): never {
    throw new TypeError("Probe gate cannot be converted.");
  }
  [inspect.custom](): string {
    return "[ClaudePreProbeGate]";
  }
}
