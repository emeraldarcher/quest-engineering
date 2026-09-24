import { createServer, type Server, type Socket } from "node:net";
import type { JsonValue } from "../../protocol/types.ts";
import type { HarnessControlAuthority } from "./authority.ts";
import {
  HARNESS_CONTROL_PROTOCOL_VERSION,
  HarnessControlError,
  type HarnessControlOperation,
  type HarnessControlRequest,
  type HarnessControlResponse,
} from "./types.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

/** Loopback-only JSONL IPC. This is not a Product/Phoenix control API. */
export class HarnessControlServer {
  private server: Server | null = null;

  constructor(private readonly authority: HarnessControlAuthority) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Harness control bridge did not bind a TCP endpoint.");
    }
    this.server = server;
    this.authority.setEndpoint({ host: "127.0.0.1", port: address.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        this.reply(
          socket,
          this.authority.failure(
            new HarnessControlError(
              "invalid_request",
              "Harness control request is too large.",
            ),
          ),
        );
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = input.slice(0, newline);
      void this.process(line).then((response) => this.reply(socket, response));
    });
    socket.on("error", () => undefined);
  }

  private async process(line: string): Promise<HarnessControlResponse> {
    try {
      const request = decodeRequest(JSON.parse(line));
      const result = await this.authority.handle(request);
      return {
        protocolVersion: HARNESS_CONTROL_PROTOCOL_VERSION,
        ok: true,
        result,
      };
    } catch (error) {
      return this.authority.failure(error);
    }
  }

  private reply(socket: Socket, response: HarnessControlResponse): void {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

function decodeRequest(
  value: unknown,
): Omit<HarnessControlRequest, "protocolVersion"> {
  const request = record(value);
  if (request.protocolVersion !== HARNESS_CONTROL_PROTOCOL_VERSION)
    throw new HarnessControlError(
      "invalid_request",
      "Harness control protocol version is invalid.",
    );
  const bridgeGeneration = nonEmpty(request.bridgeGeneration);
  const contextToken = nonEmpty(request.contextToken);
  const requestId = nonEmpty(request.requestId);
  const raw = record(request.operation);
  const operation = decodeOperation(raw);
  return { bridgeGeneration, contextToken, requestId, operation };
}

function decodeOperation(
  raw: Record<string, unknown>,
): HarnessControlOperation {
  switch (raw.type) {
    case "complete_step":
      return {
        type: "complete_step",
        outputs: record(raw.outputs) as Record<string, JsonValue>,
      };
    case "report_completion_failure": {
      const failure = record(raw.failure);
      if (
        !["semantic_validation", "stale_context", "infrastructure"].includes(
          String(failure.kind),
        ) ||
        !controlErrorCode(failure.code) ||
        typeof failure.message !== "string"
      )
        throw new HarnessControlError(
          "invalid_request",
          "Completion failure payload is invalid.",
        );
      return {
        type: "report_completion_failure",
        failure: {
          kind: failure.kind as Extract<
            HarnessControlOperation,
            { type: "report_completion_failure" }
          >["failure"]["kind"],
          code: failure.code,
          message: failure.message.slice(0, 500),
        },
      };
    }
    case "request_human_assistance":
      if (
        ![
          "needs_input",
          "needs_permission",
          "needs_authentication",
          "needs_confirmation",
          "blocked_external",
          "interactive_prompt",
          "unknown_interactive_block",
        ].includes(String(raw.category)) ||
        typeof raw.message !== "string"
      )
        throw new HarnessControlError(
          "invalid_request",
          "Human assistance payload is invalid.",
        );
      return {
        type: "request_human_assistance",
        category: raw.category as Extract<
          HarnessControlOperation,
          { type: "request_human_assistance" }
        >["category"],
        message: raw.message,
        ...(raw.interaction === "confirmation" ||
        raw.interaction === "conversational_intervention"
          ? { interaction: raw.interaction }
          : {}),
      };
    case "resolve_human_assistance":
      if (raw.outcome !== "completed" && raw.outcome !== "cannot_complete")
        throw new HarnessControlError(
          "invalid_request",
          "Human assistance outcome is invalid.",
        );
      return {
        type: "resolve_human_assistance",
        attentionId: nonEmpty(raw.attentionId),
        outcome: raw.outcome,
      };
    case "yield_to_human":
    case "automation_resumed":
      return {
        type: raw.type,
        attentionId: nonEmpty(raw.attentionId),
        ...(typeof raw.nativeSessionId === "string"
          ? { nativeSessionId: raw.nativeSessionId }
          : {}),
      };
    case "report_state":
      if (
        ![
          "starting",
          "running",
          "waiting_for_human",
          "recovering",
          "retained",
          "closed",
          "unavailable",
        ].includes(String(raw.state))
      )
        throw new HarnessControlError(
          "invalid_request",
          "Harness state is invalid.",
        );
      return {
        type: "report_state",
        state: raw.state as Extract<
          HarnessControlOperation,
          { type: "report_state" }
        >["state"],
        ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
      };
    case "completion_status":
      return { type: "completion_status" };
    case "native_stop":
      return {
        type: "native_stop",
        terminationReason: nonEmpty(raw.terminationReason),
        fullyIdle: raw.fullyIdle === true,
      };
    default:
      throw new HarnessControlError(
        "invalid_request",
        "Harness control operation is unsupported.",
      );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HarnessControlError(
      "invalid_request",
      "Harness control request must be an object.",
    );
  return value as Record<string, unknown>;
}

function controlErrorCode(
  value: unknown,
): value is Extract<
  HarnessControlOperation,
  { type: "report_completion_failure" }
>["failure"]["code"] {
  return [
    "invalid_request",
    "bridge_generation_mismatch",
    "unknown_control_context",
    "stale_control_context",
    "replayed_request",
    "invalid_step_result",
    "invalid_attention",
    "bridge_unavailable",
    "bridge_timeout",
    "invalid_bridge_response",
    "harness_contract_violation",
  ].includes(String(value));
}

function nonEmpty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new HarnessControlError(
      "invalid_request",
      "Harness control request is missing a required string.",
    );
  return value;
}
