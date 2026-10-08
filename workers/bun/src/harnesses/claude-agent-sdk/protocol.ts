import type {
  StreamedProcess,
  StreamedProcessExit,
  StreamedProcessStreamEvent,
} from "../../execution-environment/types.ts";
import type { JsonValue } from "../../protocol/types.ts";
import { OperationalExecutionError } from "../types.ts";

export const CLAUDE_WRAPPER_PROTOCOL_VERSION = 1 as const;
export const CLAUDE_WRAPPER_MAX_FRAME_BYTES = 512 * 1024;
const MAX_PENDING_EVENTS = 1_024;
const MAX_PENDING_EVENT_BYTES = 2 * 1024 * 1024;

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeSemanticTool =
  | "workspace.filesystem"
  | "workspace.search"
  | "terminal.shell";

export interface ClaudeRuntimeModel {
  id: string;
  effort: ClaudeEffort[];
}

export interface ClaudeWrapperConfiguration {
  backend: "sdk" | "fake";
  wrapper_version: string;
  sdk_version: string;
  claude_code_version: string;
  runtime_sha256: string;
  claude_executable: string;
  sdk_module: string;
  sdk_package_json: string;
  zod_module: string;
  workspace: string;
  workspace_access: "none" | "read_only" | "read_write";
  config_dir: string;
  control_descriptor: string;
  temp_dir: string;
  model: string;
  effort: ClaudeEffort;
  tools: ClaudeSemanticTool[];
  native_session_id: string | null;
  runtime_models: ClaudeRuntimeModel[];
  fake: {
    authenticated: boolean;
    models: ClaudeRuntimeModel[];
    turns: Array<Array<Record<string, JsonValue>>>;
  } | null;
}

interface EventEnvelope {
  protocol_version: 1;
  generation: string;
  request_id: string;
}

export type ClaudeWrapperEvent =
  | (EventEnvelope & {
      type: "ready";
      wrapper_version: string;
      sdk_version: string;
      claude_code_version: string;
      runtime_sha256: string;
      authentication: "authenticated" | "authentication_required";
      setup_available: boolean;
      streamed_process: "attached_only";
      models: Array<{
        id: string;
        account_availability:
          | "verified_available"
          | "verified_unavailable"
          | "unknown";
        effort: ClaudeEffort[];
      }>;
    })
  | (EventEnvelope & {
      type: "native_session";
      turn_id: string;
      session_id: string;
    })
  | (EventEnvelope & {
      type: "native_activity";
      turn_id: string;
      state: "working";
      activity: string;
      tool?: { capability: string; decision: "allow" | "deny" };
    })
  | (EventEnvelope & {
      type: "human_attention_request";
      turn_id: string;
      native_request_id: string;
      attention_id: string;
      category:
        | "needs_input"
        | "needs_permission"
        | "needs_authentication"
        | "needs_confirmation"
        | "blocked_external";
      interaction: "confirmation" | "text" | "choice" | "multiline_response";
      message: string;
      response_schema?: JsonValue;
      tool_use_id?: string;
    })
  | (EventEnvelope & {
      type: "human_attention_resolved";
      turn_id: string;
      native_request_id: string;
      attention_id: string;
    })
  | (EventEnvelope & {
      type: "qe_complete_step";
      turn_id: string;
      tool_call_id: string;
      outputs: Record<string, JsonValue>;
    })
  | (EventEnvelope & {
      type: "usage";
      turn_id: string;
      models: Array<{
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        reasoning_tokens: number;
      }>;
      result_count: number;
      estimated_cost_usd: number | null;
    })
  | (EventEnvelope & {
      type: "turn_settled";
      turn_id: string;
      outcome: "completed" | "cancelled";
      terminal_reason: string;
      completion_acknowledged: boolean;
      observed_model: string;
      effort_attestation: ClaudeEffort;
      cancellation?: string;
    })
  | (EventEnvelope & {
      type: "fatal_error";
      code: string;
      message: string;
      side_effect_certainty:
        | "not_submitted"
        | "submitted"
        | "native_accepted"
        | "ambiguous";
    })
  | (EventEnvelope & { type: "shutdown"; accepted: true });

export class ClaudeWrapperClient {
  private readonly encoder = new TextEncoder();
  private readonly events: Array<{
    event: ClaudeWrapperEvent;
    bytes: number;
  }> = [];
  private pendingEventBytes = 0;
  private readonly waiters: Array<{
    resolve: (event: ClaudeWrapperEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  private terminalError: Error | null = null;
  private readonly reader: Promise<void>;
  private readonly stderrReader: Promise<void>;

  constructor(
    readonly process: StreamedProcess,
    readonly generation: string,
  ) {
    this.reader = this.readStdout();
    this.stderrReader = this.drainStderr();
    void process.exit.then((exit) => this.observeExit(exit));
  }

  async send(frame: Record<string, JsonValue>): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const payload = `${JSON.stringify({
      protocol_version: CLAUDE_WRAPPER_PROTOCOL_VERSION,
      generation: this.generation,
      ...frame,
    })}\n`;
    if (Buffer.byteLength(payload, "utf8") > CLAUDE_WRAPPER_MAX_FRAME_BYTES)
      throw wrapperError(
        "oversized_frame",
        "Claude wrapper command exceeded the protocol frame bound.",
        "not_submitted",
      );
    try {
      await this.process.write(this.encoder.encode(payload));
    } catch (error) {
      throw wrapperError(
        "submission_uncertain",
        error instanceof Error
          ? error.message
          : "Claude wrapper command acknowledgement was unavailable.",
        "ambiguous",
      );
    }
  }

  next(timeoutMs: number | null = 30_000): Promise<ClaudeWrapperEvent> {
    const current = this.events.shift();
    if (current) {
      this.pendingEventBytes -= current.bytes;
      return Promise.resolve(current.event);
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
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
          reject(
            wrapperError(
              "wait_timeout",
              "Claude wrapper protocol response timed out.",
              "ambiguous",
            ),
          );
        }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async shutdown(requestId: string): Promise<void> {
    await this.send({ type: "shutdown", request_id: requestId });
  }

  async disconnect(): Promise<void> {
    await this.process.disconnect();
    await Promise.allSettled([this.reader, this.stderrReader]);
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder("utf8", { fatal: true });
    let buffered = "";
    try {
      for await (const event of this.process.stdout) {
        if (event.kind === "transport_error")
          throw wrapperError(
            "stream_lost",
            `Claude stdout transport failed (${event.errorCode}).`,
            "ambiguous",
          );
        if (event.kind === "eof") break;
        buffered += decoder.decode(event.data, { stream: true });
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const bytes = Buffer.byteLength(line, "utf8");
          this.push(decodeEvent(line, this.generation), bytes);
        }
        if (Buffer.byteLength(buffered, "utf8") > CLAUDE_WRAPPER_MAX_FRAME_BYTES)
          throw wrapperError(
            "oversized_frame",
            "Claude wrapper emitted an oversized or unterminated frame.",
            "ambiguous",
          );
      }
      buffered += decoder.decode();
      if (buffered.trim())
        this.push(
          decodeEvent(buffered, this.generation),
          Buffer.byteLength(buffered, "utf8"),
        );
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : wrapperError(
              "malformed_frame",
              "Claude wrapper output could not be decoded.",
              "ambiguous",
            ),
      );
    }
  }

  private async drainStderr(): Promise<void> {
    try {
      for await (const event of this.process.stderr) {
        if (event.kind === "transport_error")
          throw wrapperError(
            "stream_lost",
            `Claude stderr transport failed (${event.errorCode}).`,
            "ambiguous",
          );
        // Deliberately discard bytes. Native stderr can contain prompts,
        // credentials, provider bodies, or repository content.
      }
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : wrapperError(
              "stream_lost",
              "Claude stderr observation was lost.",
              "ambiguous",
            ),
      );
    }
  }

  private observeExit(exit: StreamedProcessExit): void {
    if (exit.kind === "exited" && exit.exitCode === 0) return;
    this.fail(
      wrapperError(
        exit.kind === "identity_mismatch"
          ? "ownership_mismatch"
          : "stream_lost",
        `Claude wrapper process terminated (${exit.kind}).`,
        "ambiguous",
      ),
    );
  }

  private push(event: ClaudeWrapperEvent, bytes: number): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    if (
      this.events.length >= MAX_PENDING_EVENTS ||
      this.pendingEventBytes + bytes > MAX_PENDING_EVENT_BYTES
    ) {
      this.fail(
        wrapperError(
          "protocol_backpressure",
          "Claude wrapper event queue exceeded its bound.",
          "ambiguous",
        ),
      );
      return;
    }
    this.events.push({ event, bytes });
    this.pendingEventBytes += bytes;
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export function decodeEvent(
  serialized: string,
  generation: string,
): ClaudeWrapperEvent {
  if (Buffer.byteLength(serialized, "utf8") > CLAUDE_WRAPPER_MAX_FRAME_BYTES)
    throw wrapperError(
      "oversized_frame",
      "Claude wrapper event exceeded the protocol frame bound.",
      "ambiguous",
    );
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw wrapperError(
      "malformed_frame",
      "Claude wrapper emitted malformed JSON.",
      "ambiguous",
    );
  }
  if (
    !record(value) ||
    value.protocol_version !== CLAUDE_WRAPPER_PROTOCOL_VERSION ||
    value.generation !== generation ||
    !safeToken(value.request_id, 128) ||
    !safeToken(value.type, 64)
  )
    throw wrapperError(
      "stale_generation",
      "Claude wrapper event envelope or generation is invalid.",
      "ambiguous",
    );
  validateEvent(value);
  return value as unknown as ClaudeWrapperEvent;
}

function validateEvent(value: Record<string, unknown>): void {
  const type = value.type;
  const common = ["protocol_version", "generation", "request_id", "type"];
  if (type === "ready") {
    exact(value, [
      ...common,
      "wrapper_version",
      "sdk_version",
      "claude_code_version",
      "runtime_sha256",
      "authentication",
      "setup_available",
      "streamed_process",
      "models",
    ]);
    if (
      !safeToken(value.wrapper_version, 32) ||
      !safeToken(value.sdk_version, 32) ||
      !safeToken(value.claude_code_version, 32) ||
      typeof value.runtime_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.runtime_sha256) ||
      !["authenticated", "authentication_required"].includes(
        String(value.authentication),
      ) ||
      typeof value.setup_available !== "boolean" ||
      value.streamed_process !== "attached_only" ||
      !validModels(value.models)
    )
      invalid();
    return;
  }
  if (type === "native_session") {
    exact(value, [...common, "turn_id", "session_id"]);
    if (!safeToken(value.turn_id, 128) || !safeToken(value.session_id, 128))
      invalid();
    return;
  }
  if (type === "native_activity") {
    const allowed = new Set([...common, "turn_id", "state", "activity", "tool"]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      !safeToken(value.turn_id, 128) ||
      value.state !== "working" ||
      !safeToken(value.activity, 64)
    )
      invalid();
    if (value.tool !== undefined) {
      if (
        !record(value.tool) ||
        !hasExactKeys(value.tool, ["capability", "decision"]) ||
        !safeToken(value.tool.capability, 128) ||
        !["allow", "deny"].includes(String(value.tool.decision))
      )
        invalid();
    }
    return;
  }
  if (type === "human_attention_request") {
    const allowed = new Set([
      ...common,
      "turn_id",
      "native_request_id",
      "attention_id",
      "category",
      "interaction",
      "message",
      "response_schema",
      "tool_use_id",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      !safeToken(value.turn_id, 128) ||
      !safeToken(value.native_request_id, 128) ||
      !safeToken(value.attention_id, 128) ||
      ![
        "needs_input",
        "needs_permission",
        "needs_authentication",
        "needs_confirmation",
        "blocked_external",
      ].includes(String(value.category)) ||
      !["confirmation", "text", "choice", "multiline_response"].includes(
        String(value.interaction),
      ) ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 240 ||
      (value.response_schema !== undefined && !jsonValue(value.response_schema)) ||
      (value.tool_use_id !== undefined && !safeToken(value.tool_use_id, 128))
    )
      invalid();
    return;
  }
  if (type === "human_attention_resolved") {
    exact(value, [
      ...common,
      "turn_id",
      "native_request_id",
      "attention_id",
    ]);
    if (
      !safeToken(value.turn_id, 128) ||
      !safeToken(value.native_request_id, 128) ||
      !safeToken(value.attention_id, 128)
    )
      invalid();
    return;
  }
  if (type === "qe_complete_step") {
    exact(value, [...common, "turn_id", "tool_call_id", "outputs"]);
    if (
      !safeToken(value.turn_id, 128) ||
      !safeToken(value.tool_call_id, 128) ||
      !record(value.outputs) ||
      !jsonValue(value.outputs)
    )
      invalid();
    return;
  }
  if (type === "usage") {
    exact(value, [
      ...common,
      "turn_id",
      "models",
      "result_count",
      "estimated_cost_usd",
    ]);
    if (
      !safeToken(value.turn_id, 128) ||
      !Array.isArray(value.models) ||
      !value.models.every(validUsage) ||
      !natural(value.result_count) ||
      !(
        value.estimated_cost_usd === null ||
        (typeof value.estimated_cost_usd === "number" &&
          Number.isFinite(value.estimated_cost_usd) &&
          value.estimated_cost_usd >= 0)
      )
    )
      invalid();
    return;
  }
  if (type === "turn_settled") {
    const allowed = new Set([
      ...common,
      "turn_id",
      "outcome",
      "terminal_reason",
      "completion_acknowledged",
      "observed_model",
      "effort_attestation",
      "cancellation",
    ]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      !safeToken(value.turn_id, 128) ||
      !["completed", "cancelled"].includes(String(value.outcome)) ||
      typeof value.terminal_reason !== "string" ||
      value.terminal_reason.length > 128 ||
      typeof value.completion_acknowledged !== "boolean" ||
      !safeToken(value.observed_model, 160) ||
      !effort(value.effort_attestation) ||
      (value.cancellation !== undefined &&
        typeof value.cancellation !== "string")
    )
      invalid();
    return;
  }
  if (type === "fatal_error") {
    exact(value, [
      ...common,
      "code",
      "message",
      "side_effect_certainty",
    ]);
    if (
      !safeToken(value.code, 64) ||
      typeof value.message !== "string" ||
      value.message.length > 320 ||
      ![
        "not_submitted",
        "submitted",
        "native_accepted",
        "ambiguous",
      ].includes(String(value.side_effect_certainty))
    )
      invalid();
    return;
  }
  if (type === "shutdown") {
    exact(value, [...common, "accepted"]);
    if (value.accepted !== true) invalid();
    return;
  }
  invalid();
}

function validModels(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (model) =>
        record(model) &&
        hasExactKeys(model, ["id", "account_availability", "effort"]) &&
        safeToken(model.id, 160) &&
        ["verified_available", "verified_unavailable", "unknown"].includes(
          String(model.account_availability),
        ) &&
        Array.isArray(model.effort) &&
        model.effort.every(effort),
    )
  );
}

function validUsage(value: unknown): boolean {
  return (
    record(value) &&
    hasExactKeys(value, [
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
    ]) &&
    safeToken(value.model, 160) &&
    natural(value.input_tokens) &&
    natural(value.output_tokens) &&
    natural(value.cache_read_tokens) &&
    natural(value.cache_write_tokens) &&
    natural(value.reasoning_tokens)
  );
}

function effort(value: unknown): value is ClaudeEffort {
  return ["low", "medium", "high", "xhigh", "max"].includes(String(value));
}
function natural(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function safeToken(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[a-zA-Z0-9._:@/+\-]+$/.test(value)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) invalid();
}
function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}
function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 512 && value.every((item) => jsonValue(item, depth + 1));
  return (
    record(value) &&
    Object.keys(value).length <= 128 &&
    Object.values(value).every((item) => jsonValue(item, depth + 1))
  );
}
function invalid(): never {
  throw wrapperError(
    "malformed_frame",
    "Claude wrapper event failed strict schema validation.",
    "ambiguous",
  );
}
function wrapperError(
  code: string,
  message: string,
  certainty: "not_submitted" | "submitted" | "native_accepted" | "ambiguous",
): OperationalExecutionError {
  return new OperationalExecutionError(
    message,
    code === "wait_timeout" ? "auto_retryable" : "operator_recovery_required",
    code,
    undefined,
    {
      phase: "observe",
      sideEffectCertainty: certainty,
      capability: "process.streamed",
    },
  );
}
