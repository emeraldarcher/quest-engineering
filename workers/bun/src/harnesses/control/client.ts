import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { JsonValue } from "../../protocol/types.ts";
import {
  HARNESS_CONTROL_PATH_ENV,
  readControlDescriptor,
} from "./descriptor.ts";
import {
  type CompletionFailure,
  HARNESS_CONTROL_PROTOCOL_VERSION,
  HarnessCompletionError,
  type HarnessControlDescriptor,
  HarnessControlError,
  type HarnessControlOperation,
  type HarnessControlResponse,
  type HarnessControlResult,
} from "./types.ts";

export const SBX_CONTROL_MAILBOX_ENV = "QE_SBX_CONTROL_MAILBOX";

export class HarnessControlClient {
  constructor(
    private readonly descriptorPath: string,
    private readonly mailboxRoot?: string,
  ) {}

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): HarnessControlClient {
    const path = env[HARNESS_CONTROL_PATH_ENV]?.trim();
    if (!path)
      throw new HarnessControlError(
        "bridge_unavailable",
        `${HARNESS_CONTROL_PATH_ENV} is missing.`,
      );
    return new HarnessControlClient(
      path,
      env[SBX_CONTROL_MAILBOX_ENV]?.trim() || undefined,
    );
  }

  async completeStep(
    outputs: Record<string, JsonValue>,
    requestId: string = crypto.randomUUID(),
  ): Promise<HarnessControlResult> {
    try {
      return await this.call({ type: "complete_step", outputs }, requestId);
    } catch (error) {
      const known =
        error instanceof HarnessControlError
          ? error
          : new HarnessControlError(
              "bridge_unavailable",
              "Quest Engineering completion infrastructure failed.",
            );
      if (known.code === "invalid_step_result")
        throw new HarnessCompletionError(
          "semantic_validation",
          known.code,
          known.message,
        );
      if (completionInfrastructureCode(known.code)) {
        try {
          const status = await this.completionStatus();
          if (status.completed)
            return { accepted: true, completed: true, duplicate: true };
        } catch {
          // The original typed infrastructure failure remains authoritative.
        }
        throw new HarnessCompletionError(
          staleContextCode(known.code) ? "stale_context" : "infrastructure",
          known.code,
          known.message,
        );
      }
      throw known;
    }
  }

  reportCompletionFailure(
    failure: CompletionFailure,
    requestId: string = crypto.randomUUID(),
  ) {
    return this.call({ type: "report_completion_failure", failure }, requestId);
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
    if (this.mailboxRoot)
      return callMailbox(
        this.descriptorPath,
        this.mailboxRoot,
        operation,
        requestId,
      );
    const first = await readControlDescriptor(this.descriptorPath);
    try {
      return await callDescriptor(first, operation, requestId);
    } catch (error) {
      if (!(error instanceof HarnessControlError) || !refreshable(error.code))
        throw error;
      const current = await readControlDescriptor(this.descriptorPath);
      if (sameCredentials(first, current)) throw error;
      return callDescriptor(current, operation, requestId);
    }
  }
}

async function callDescriptor(
  descriptor: HarnessControlDescriptor,
  operation: HarnessControlOperation,
  requestId: string,
): Promise<HarnessControlResult> {
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
    throw new HarnessControlError(response.error.code, response.error.message);
  return response.result;
}

export async function forwardHarnessControlPayload(
  descriptorPath: string,
  payload: string,
): Promise<string> {
  const descriptor = await readControlDescriptor(descriptorPath);
  const response = await send(descriptor.endpoint.port, payload);
  return `${JSON.stringify(response)}\n`;
}

async function callMailbox(
  descriptorPath: string,
  mailboxRoot: string,
  operation: HarnessControlOperation,
  requestId: string,
): Promise<HarnessControlResult> {
  const descriptor = await readControlDescriptor(descriptorPath);
  const request = {
    protocolVersion: HARNESS_CONTROL_PROTOCOL_VERSION,
    bridgeGeneration: descriptor.bridgeGeneration,
    contextToken: descriptor.contextToken,
    requestId,
    operation,
  };
  const key = createHash("sha256").update(requestId).digest("hex");
  const requests = join(mailboxRoot, "requests");
  const responses = join(mailboxRoot, "responses");
  await mkdir(requests, { recursive: true });
  await mkdir(responses, { recursive: true });
  const requestPath = join(requests, `${key}.json`);
  const responsePath = join(responses, `${key}.json`);
  await rm(responsePath, { force: true });
  const temporary = `${requestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, requestPath);
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      try {
        const response = decodeResponse(
          JSON.parse(await readFile(responsePath, "utf8")),
        );
        if (!response.ok)
          throw new HarnessControlError(
            response.error.code,
            response.error.message,
          );
        return response.result;
      } catch (error) {
        if (
          error instanceof HarnessControlError ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new HarnessControlError(
      "bridge_timeout",
      "Quest Engineering sandbox control mailbox timed out.",
    );
  } finally {
    await Promise.all([
      rm(requestPath, { force: true }),
      rm(responsePath, { force: true }),
    ]).catch(() => undefined);
  }
}

async function send(
  port: number,
  payload: string,
): Promise<HarnessControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let input = "";
    let settled = false;
    let connected = false;
    const fail = (
      code: "bridge_unavailable" | "bridge_timeout" | "invalid_bridge_response",
    ) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new HarnessControlError(
          code,
          code === "bridge_timeout"
            ? "Quest Engineering harness control bridge timed out."
            : code === "invalid_bridge_response"
              ? "Quest Engineering harness control response was lost."
              : "Quest Engineering harness control bridge is unavailable.",
        ),
      );
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => fail("bridge_timeout"));
    socket.once("error", () =>
      fail(connected ? "invalid_bridge_response" : "bridge_unavailable"),
    );
    socket.once("connect", () => {
      connected = true;
      socket.write(payload);
    });
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      if (settled) return;
      settled = true;
      socket.destroy();
      try {
        resolve(decodeResponse(JSON.parse(input.slice(0, newline))));
      } catch {
        reject(
          new HarnessControlError(
            "invalid_bridge_response",
            "Harness control response is invalid.",
          ),
        );
      }
    });
    socket.once("end", () => {
      if (!settled)
        fail(connected ? "invalid_bridge_response" : "bridge_unavailable");
    });
  });
}

function decodeResponse(value: unknown): HarnessControlResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid response");
  const response = value as Partial<HarnessControlResponse>;
  if (response.protocolVersion !== HARNESS_CONTROL_PROTOCOL_VERSION)
    throw new Error("invalid response");
  if (response.ok === true && response.result)
    return response as HarnessControlResponse;
  if (
    response.ok === false &&
    response.error &&
    typeof response.error.code === "string" &&
    typeof response.error.message === "string"
  )
    return response as HarnessControlResponse;
  throw new Error("invalid response");
}

function sameCredentials(
  left: HarnessControlDescriptor,
  right: HarnessControlDescriptor,
): boolean {
  return (
    left.endpoint.port === right.endpoint.port &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.contextToken === right.contextToken
  );
}

function refreshable(code: string): boolean {
  return staleContextCode(code) || code === "bridge_unavailable";
}
function staleContextCode(code: string): boolean {
  return [
    "bridge_generation_mismatch",
    "unknown_control_context",
    "stale_control_context",
  ].includes(code);
}
function completionInfrastructureCode(code: string): boolean {
  return (
    staleContextCode(code) ||
    [
      "bridge_unavailable",
      "bridge_timeout",
      "invalid_bridge_response",
    ].includes(code)
  );
}
