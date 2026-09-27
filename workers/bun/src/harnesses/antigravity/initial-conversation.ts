import { createHash } from "node:crypto";

export interface AntigravityInitialConversationBinding {
  actionId: string;
  attemptId: string;
  lineageId: string;
  resultNonce: string;
  environmentId: string;
  incarnation: string;
}

export type AntigravityInitialConversationLaunchBinding = Pick<
  AntigravityInitialConversationBinding,
  "lineageId" | "environmentId" | "incarnation"
>;

export interface AntigravityInitialConversationRequest
  extends AntigravityInitialConversationBinding {
  schemaVersion: 1;
  kind: "antigravity_initial_conversation";
  nonce: string;
  prompt: string;
  promptHash: string;
  requestedAt: string;
}

export interface AntigravityInitialConversationAcknowledgement
  extends AntigravityInitialConversationBinding {
  schemaVersion: 1;
  kind: "antigravity_initial_conversation_ack";
  nonce: string;
  promptHash: string;
  status: "started" | "failed";
  acknowledgedAt: string;
  message?: string;
}

export function parseInitialConversationBinding(
  encoded: string | undefined,
): AntigravityInitialConversationLaunchBinding {
  let value: unknown;
  try {
    value = JSON.parse(encoded ?? "null");
  } catch {
    throw new Error("initial conversation binding is malformed");
  }
  if (!isRecord(value))
    throw new Error("initial conversation binding is absent");
  const binding = {
    lineageId: text(value.lineageId),
    environmentId: text(value.environmentId),
    incarnation: text(value.incarnation),
  };
  if (Object.values(binding).some((item) => !item))
    throw new Error("initial conversation binding is incomplete");
  return binding;
}

export function parseInitialConversationRequest(
  encoded: string,
  expected: AntigravityInitialConversationLaunchBinding,
): AntigravityInitialConversationRequest {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("initial conversation request is malformed");
  }
  if (!isRecord(value))
    throw new Error("initial conversation request is not an object");
  const request = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    nonce: text(value.nonce),
    actionId: text(value.actionId),
    attemptId: text(value.attemptId),
    lineageId: text(value.lineageId),
    resultNonce: text(value.resultNonce),
    environmentId: text(value.environmentId),
    incarnation: text(value.incarnation),
    prompt: text(value.prompt),
    promptHash: text(value.promptHash),
    requestedAt: text(value.requestedAt),
  };
  if (
    request.schemaVersion !== 1 ||
    request.kind !== "antigravity_initial_conversation" ||
    !request.nonce ||
    !request.actionId ||
    !request.attemptId ||
    !request.lineageId ||
    !request.resultNonce ||
    !request.environmentId ||
    !request.incarnation ||
    !request.prompt ||
    request.prompt.includes("\0") ||
    !Number.isFinite(Date.parse(request.requestedAt)) ||
    request.promptHash !== digest(request.prompt)
  )
    throw new Error("initial conversation request contract is invalid");
  for (const [key, expectedValue] of Object.entries(expected))
    if (request[key as keyof typeof request] !== expectedValue)
      throw new Error(`initial conversation request ${key} is stale`);
  return request as AntigravityInitialConversationRequest;
}

export function initialConversationArgs(
  baseArgs: readonly string[],
  prompt: string,
  logPath: string,
): string[] {
  if (!prompt || prompt.includes("\0"))
    throw new Error("initial conversation prompt must be non-empty text");
  if (!logPath.startsWith("/") || logPath.includes("\0"))
    throw new Error("initial conversation log path must be absolute");
  if (
    baseArgs.includes("--conversation") ||
    baseArgs.includes("--continue") ||
    baseArgs.includes("-c") ||
    baseArgs.includes("--print") ||
    baseArgs.includes("-p") ||
    baseArgs.includes("--prompt-interactive") ||
    baseArgs.includes("-i")
  )
    throw new Error(
      "initial conversation launch requires a fresh conversation-free argv",
    );
  const logFlag = baseArgs.indexOf("--log-file");
  if (
    logFlag < 0 ||
    logFlag !== baseArgs.lastIndexOf("--log-file") ||
    typeof baseArgs[logFlag + 1] !== "string"
  )
    throw new Error("initial conversation launch requires one native log path");
  const args = [...baseArgs];
  args[logFlag + 1] = logPath;
  return [...args, "--prompt-interactive", prompt];
}

export function initialConversationAcknowledgement(
  request: AntigravityInitialConversationRequest,
  status: "started" | "failed",
  acknowledgedAt: string,
  message?: string,
): AntigravityInitialConversationAcknowledgement {
  return {
    schemaVersion: 1,
    kind: "antigravity_initial_conversation_ack",
    nonce: request.nonce,
    actionId: request.actionId,
    attemptId: request.attemptId,
    lineageId: request.lineageId,
    resultNonce: request.resultNonce,
    environmentId: request.environmentId,
    incarnation: request.incarnation,
    promptHash: request.promptHash,
    status,
    acknowledgedAt,
    ...(message ? { message } : {}),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
