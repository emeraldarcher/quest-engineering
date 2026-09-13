import { createConnection } from "node:net";
import type { JsonValue } from "../../protocol/types.ts";
import {
  HARNESS_CONTROL_PATH_ENV,
  readControlDescriptor,
} from "./descriptor.ts";
import {
  HARNESS_CONTROL_PROTOCOL_VERSION,
  HarnessControlError,
  type HarnessControlOperation,
  type HarnessControlResponse,
  type HarnessControlResult,
} from "./types.ts";

export class HarnessControlClient {
  constructor(private readonly descriptorPath: string) {}

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): HarnessControlClient {
    const path = env[HARNESS_CONTROL_PATH_ENV]?.trim();
    if (!path)
      throw new HarnessControlError(
        "bridge_unavailable",
        `${HARNESS_CONTROL_PATH_ENV} is missing.`,
      );
    return new HarnessControlClient(path);
  }

  completeStep(
    outputs: Record<string, JsonValue>,
    requestId: string = crypto.randomUUID(),
  ) {
    return this.call({ type: "complete_step", outputs }, requestId);
  }

  requestHumanAssistance(
    input: Omit<
      Extract<HarnessControlOperation, { type: "request_human_assistance" }>,
      "type"
    >,
    requestId: string = crypto.randomUUID(),
  ) {
    return this.call({ type: "request_human_assistance", ...input }, requestId);
  }

  resolveHumanAssistance(
    attentionId: string,
    outcome: "completed" | "cannot_complete",
    requestId: string = crypto.randomUUID(),
  ) {
    return this.call(
      { type: "resolve_human_assistance", attentionId, outcome },
      requestId,
    );
  }

  yieldToHuman(attentionId: string, nativeSessionId?: string) {
    return this.call({
      type: "yield_to_human",
      attentionId,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    });
  }

  automationResumed(attentionId: string, nativeSessionId?: string) {
    return this.call({
      type: "automation_resumed",
      attentionId,
      ...(nativeSessionId ? { nativeSessionId } : {}),
    });
  }

  completionStatus() {
    return this.call({ type: "completion_status" });
  }

  nativeStop(terminationReason: string, fullyIdle: boolean) {
    return this.call({ type: "native_stop", terminationReason, fullyIdle });
  }

  async call(
    operation: HarnessControlOperation,
    requestId: string = crypto.randomUUID(),
  ): Promise<HarnessControlResult> {
    const descriptor = await readControlDescriptor(this.descriptorPath);
    const request = {
      protocolVersion: HARNESS_CONTROL_PROTOCOL_VERSION,
      bridgeGeneration: descriptor.bridgeGeneration,
      contextToken: descriptor.contextToken,
      requestId,
      operation,
    };
    const response = await send(
      descriptor.endpoint.port,
      `${JSON.stringify(request)}\n`,
    );
    if (!response.ok)
      throw new HarnessControlError(
        response.error.code,
        response.error.message,
      );
    return response.result;
  }
}

async function send(
  port: number,
  payload: string,
): Promise<HarnessControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let input = "";
    const fail = () => {
      socket.destroy();
      reject(
        new HarnessControlError(
          "bridge_unavailable",
          "Quest Engineering harness control bridge is unavailable.",
        ),
      );
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, fail);
    socket.once("error", fail);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(input.slice(0, newline)) as HarnessControlResponse);
      } catch {
        reject(
          new HarnessControlError(
            "invalid_request",
            "Harness control response is invalid.",
          ),
        );
      }
    });
  });
}
