import type { StreamedProcessHandle } from "../../execution-environment/types.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type { HarnessTransportBinding } from "../transport-binding.ts";
import { validateTransportBinding } from "../transport-binding.ts";

export const CLAUDE_TRANSPORT_BINDING_KIND =
  "claude_agent_sdk_stream_v2" as const;

export type ClaudeQueryState =
  | "not_invoked"
  | "requested"
  | "acknowledged"
  | "uncertain";

export type ClaudeSubmissionState =
  | "not_submitted"
  | "submitted"
  | "native_accepted"
  | "settled"
  | "cancelled"
  | "terminal";

export type ClaudeRecoveryDisposition =
  | "replace_without_submission"
  | "submission_uncertain"
  | "reopen_settled_session"
  | "terminal_history";

export function claudeRecoveryDisposition(
  submissionState: ClaudeSubmissionState,
  queryState: ClaudeQueryState,
): ClaudeRecoveryDisposition {
  if (submissionState === "cancelled" || submissionState === "terminal")
    return "terminal_history";
  if (submissionState === "settled") return "reopen_settled_session";
  if (queryState === "not_invoked" && submissionState === "not_submitted")
    return "replace_without_submission";
  return "submission_uncertain";
}

export interface ClaudeTransportState {
  wrapperGeneration: string;
  process: StreamedProcessHandle;
  profileId: string;
  profileDigest: string;
  workspaceIdentity: string;
  configurationIdentity: string;
  wrapperExecutable: string;
  wrapperVersion: string;
  sdkVersion: string;
  claudeCodeVersion: string;
  runtimeSha256: string;
  model: string;
  effort: string;
  toolPolicyDigest: string;
  query: {
    state: ClaudeQueryState;
    requestId: string | null;
    invocationCount: number;
  };
  submission: {
    state: ClaudeSubmissionState;
    requestId: string | null;
    turnId: string | null;
    continuationCount: number;
    eventCursor: number;
  };
}

export function claudeTransportBinding(
  state: ClaudeTransportState,
): HarnessTransportBinding {
  return validateTransportBinding(
    {
      schemaVersion: 1,
      harnessKind: "claude_agent_sdk",
      kind: CLAUDE_TRANSPORT_BINDING_KIND,
      payload: structuredClone(state) as unknown as Record<string, JsonValue>,
    },
    "claude_agent_sdk",
  );
}

export function parseClaudeTransportBinding(
  binding: HarnessTransportBinding | null,
): ClaudeTransportState | null {
  if (!binding) return null;
  const valid = validateTransportBinding(binding, "claude_agent_sdk");
  if (valid.kind !== CLAUDE_TRANSPORT_BINDING_KIND)
    throw new Error("Claude transport binding kind is incompatible.");
  const value = valid.payload as Record<string, unknown>;
  exact(value, [
    "wrapperGeneration",
    "process",
    "profileId",
    "profileDigest",
    "workspaceIdentity",
    "configurationIdentity",
    "wrapperExecutable",
    "wrapperVersion",
    "sdkVersion",
    "claudeCodeVersion",
    "runtimeSha256",
    "model",
    "effort",
    "toolPolicyDigest",
    "query",
    "submission",
  ]);
  for (const field of [
    "wrapperGeneration",
    "profileId",
    "profileDigest",
    "workspaceIdentity",
    "configurationIdentity",
    "wrapperExecutable",
    "wrapperVersion",
    "sdkVersion",
    "claudeCodeVersion",
    "runtimeSha256",
    "model",
    "effort",
    "toolPolicyDigest",
  ])
    if (typeof value[field] !== "string" || value[field].length === 0)
      invalid();
  if (!/^[a-f0-9]{64}$/.test(String(value.runtimeSha256))) invalid();
  const process = parseProcess(value.process);
  if (!record(value.query)) invalid();
  exact(value.query, ["state", "requestId", "invocationCount"]);
  if (
    !["not_invoked", "requested", "acknowledged", "uncertain"].includes(
      String(value.query.state),
    ) ||
    !nullableToken(value.query.requestId) ||
    !natural(value.query.invocationCount) ||
    Number(value.query.invocationCount) > 1 ||
    (value.query.state === "not_invoked" &&
      (value.query.requestId !== null || value.query.invocationCount !== 0)) ||
    (value.query.state !== "not_invoked" && value.query.requestId === null) ||
    (value.query.state === "acknowledged" && value.query.invocationCount !== 1)
  )
    invalid();
  if (!record(value.submission)) invalid();
  exact(value.submission, [
    "state",
    "requestId",
    "turnId",
    "continuationCount",
    "eventCursor",
  ]);
  if (
    ![
      "not_submitted",
      "submitted",
      "native_accepted",
      "settled",
      "cancelled",
      "terminal",
    ].includes(String(value.submission.state)) ||
    !nullableToken(value.submission.requestId) ||
    !nullableToken(value.submission.turnId) ||
    !natural(value.submission.continuationCount) ||
    !natural(value.submission.eventCursor) ||
    (value.submission.state === "native_accepted" &&
      value.query.state !== "acknowledged") ||
    (value.submission.state === "submitted" &&
      !["requested", "acknowledged", "uncertain"].includes(
        String(value.query.state),
      ))
  )
    invalid();
  return {
    wrapperGeneration: value.wrapperGeneration as string,
    process,
    profileId: value.profileId as string,
    profileDigest: value.profileDigest as string,
    workspaceIdentity: value.workspaceIdentity as string,
    configurationIdentity: value.configurationIdentity as string,
    wrapperExecutable: value.wrapperExecutable as string,
    wrapperVersion: value.wrapperVersion as string,
    sdkVersion: value.sdkVersion as string,
    claudeCodeVersion: value.claudeCodeVersion as string,
    runtimeSha256: value.runtimeSha256 as string,
    model: value.model as string,
    effort: value.effort as string,
    toolPolicyDigest: value.toolPolicyDigest as string,
    query: {
      state: value.query.state as ClaudeQueryState,
      requestId: value.query.requestId as string | null,
      invocationCount: value.query.invocationCount as number,
    },
    submission: {
      state: value.submission.state as ClaudeSubmissionState,
      requestId: value.submission.requestId as string | null,
      turnId: value.submission.turnId as string | null,
      continuationCount: value.submission.continuationCount as number,
      eventCursor: value.submission.eventCursor as number,
    },
  };
}

function parseProcess(value: unknown): StreamedProcessHandle {
  if (!record(value)) invalid();
  const allowed = new Set([
    "contractVersion",
    "backendKind",
    "environment",
    "backendProcessId",
    "processStartIdentity",
    "processGeneration",
    "executable",
    "observedExecutable",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.contractVersion !== 1 ||
    !token(value.backendKind) ||
    !record(value.environment) ||
    !token(value.backendProcessId) ||
    !token(value.processStartIdentity) ||
    !token(value.processGeneration) ||
    typeof value.executable !== "string" ||
    !value.executable.startsWith("/") ||
    (value.observedExecutable !== undefined &&
      typeof value.observedExecutable !== "string")
  )
    invalid();
  exact(value.environment, [
    "workerId",
    "runId",
    "environmentId",
    "incarnation",
    "backendKind",
    "profile",
  ]);
  if (
    !token(value.environment.workerId) ||
    !token(value.environment.runId) ||
    !token(value.environment.environmentId) ||
    !token(value.environment.incarnation) ||
    !token(value.environment.backendKind) ||
    !record(value.environment.profile)
  )
    invalid();
  exact(value.environment.profile, ["id", "digest"]);
  if (
    !token(value.environment.profile.id) ||
    typeof value.environment.profile.digest !== "string"
  )
    invalid();
  return structuredClone(value) as unknown as StreamedProcessHandle;
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  )
    invalid();
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[a-zA-Z0-9._:@/+\-=]+$/.test(value)
  );
}
function nullableToken(value: unknown): value is string | null {
  return value === null || token(value);
}
function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function invalid(): never {
  throw new Error("Claude transport binding payload is invalid.");
}
