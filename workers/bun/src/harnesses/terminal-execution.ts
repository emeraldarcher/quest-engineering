import type { HarnessLineage } from "../dispatch/registry.ts";
import type { JsonValue } from "../protocol/types.ts";
import type { HostedAgent, HostedExecutionRef } from "../session-host/types.ts";
import {
  sameNativeSession,
  validateNativeSessionRef,
} from "./native-session.ts";
import {
  type HarnessTransportBinding,
  validateTransportBinding,
} from "./transport-binding.ts";
import type {
  HarnessCapabilities,
  HarnessExecutionHandle,
  HarnessInspection,
  HarnessPreparedExecution,
  InteractiveHarnessSession,
} from "./types.ts";

export const TERMINAL_TRANSPORT_BINDING_KIND = "terminal";

export interface TerminalTransportBinding {
  backendKind: string;
  ref: HostedExecutionRef;
  agent: HostedAgent;
}

/** Adapter-private convenience shape; generic AgentHarness callers see only the handle. */
export interface TerminalHarnessPreparedExecution
  extends HarnessPreparedExecution {
  ref: HostedExecutionRef;
  agent: HostedAgent;
}

export function terminalPreparedExecution(
  lineage: HarnessLineage,
  backendKind: string,
  ref: HostedExecutionRef,
  agent: HostedAgent,
  capabilities: HarnessCapabilities,
): TerminalHarnessPreparedExecution {
  const handle = terminalExecutionHandle(
    lineage.harnessKind,
    lineage.lineageId,
    backendKind,
    ref,
    agent,
  );
  const interactive = terminalInteractiveSession(capabilities);
  return {
    lineage: {
      ...lineage,
      executionHandle: handle,
      transportBinding: handle.transportBinding ?? null,
      interactive,
    },
    ref,
    agent,
    handle,
    interactive,
  };
}

export function terminalExecutionHandle(
  harnessKind: string,
  executionId: string,
  backendKind: string,
  ref: HostedExecutionRef,
  agent: HostedAgent,
): HarnessExecutionHandle {
  return {
    schemaVersion: 1,
    harnessKind,
    executionId,
    ...((agent.nativeSession ?? ref.nativeSession)
      ? { nativeSession: agent.nativeSession ?? ref.nativeSession }
      : {}),
    transportBinding: terminalTransportBinding(
      harnessKind,
      backendKind,
      ref,
      agent,
    ),
  };
}

export function terminalTransportBinding(
  harnessKind: string,
  backendKind: string,
  ref: HostedExecutionRef,
  agent: HostedAgent,
): HarnessTransportBinding {
  const binding = validateTransportBinding(
    {
      schemaVersion: 1,
      harnessKind,
      kind: TERMINAL_TRANSPORT_BINDING_KIND,
      payload: {
        backendKind,
        ref: ref as unknown as Record<string, JsonValue>,
        agent: agent as unknown as Record<string, JsonValue>,
      },
    },
    harnessKind,
  );
  terminalBinding(binding, harnessKind);
  return binding;
}

export function terminalBinding(
  binding: HarnessTransportBinding | null | undefined,
  expectedHarnessKind: string,
): TerminalTransportBinding {
  const valid = validateTransportBinding(binding, expectedHarnessKind);
  if (valid.kind !== TERMINAL_TRANSPORT_BINDING_KIND)
    throw new Error(
      "Harness execution does not have a terminal transport binding.",
    );
  const payload = valid.payload;
  if (!hasExactKeys(payload, ["backendKind", "ref", "agent"]))
    throw new Error(
      "Terminal transport binding has unexpected payload fields.",
    );
  if (
    typeof payload.backendKind !== "string" ||
    !payload.backendKind ||
    payload.backendKind.length > 128
  )
    throw new Error("Terminal transport binding has no backend identity.");
  const ref = hostedExecutionRef(payload.ref, expectedHarnessKind);
  const agent = hostedAgent(payload.agent, expectedHarnessKind);
  if (
    agent.paneId !== ref.paneId ||
    agent.workspaceId !== ref.workspaceId ||
    (agent.name !== undefined && agent.name !== ref.agentName) ||
    (agent.terminalId !== undefined &&
      ref.terminalId !== undefined &&
      agent.terminalId !== ref.terminalId) ||
    (agent.nativeSession !== undefined &&
      ref.nativeSession !== undefined &&
      !sameNativeSession(agent.nativeSession, ref.nativeSession))
  )
    throw new Error(
      "Terminal transport binding topology is internally inconsistent.",
    );
  return { backendKind: payload.backendKind, ref, agent };
}

export function terminalExecution(
  execution: HarnessPreparedExecution,
  expectedHarnessKind: string,
): TerminalTransportBinding {
  if (
    execution.handle.harnessKind !== expectedHarnessKind ||
    execution.lineage.harnessKind !== expectedHarnessKind ||
    execution.handle.executionId !== execution.lineage.lineageId
  )
    throw new Error("Harness execution handle ownership is invalid.");
  return terminalBinding(
    execution.handle.transportBinding,
    expectedHarnessKind,
  );
}

export function terminalLineage(
  lineage: HarnessLineage,
  expectedHarnessKind: string,
): TerminalTransportBinding {
  return terminalBinding(lineage.transportBinding, expectedHarnessKind);
}

export function terminalInteractiveSession(
  capabilities: HarnessCapabilities,
): InteractiveHarnessSession {
  return {
    kind: "terminal",
    attachment: capabilities.canAttachTerminal
      ? {
          available: true,
          supportsObservation: true,
          supportsTakeover: capabilities.conversationalTakeover,
        }
      : null,
    literalInput: capabilities.canSendInput,
    processIdentity: "verified",
  };
}

export function terminalInspection(input: {
  lineage: HarnessLineage;
  agent: HostedAgent;
  state: HarnessInspection["state"];
  attention: HarnessInspection["attention"];
  intervention: HarnessInspection["intervention"];
  lastActivityAt: string;
  capabilities: HarnessCapabilities;
  transportBinding?: HarnessTransportBinding;
}): HarnessInspection {
  return {
    state: input.state,
    activity: {
      state:
        input.agent.status === "working"
          ? "active"
          : input.agent.status === "blocked"
            ? "blocked"
            : input.agent.status === "done"
              ? "completed"
              : input.agent.status === "idle"
                ? "idle"
                : "unknown",
      ...(input.agent.message
        ? { detail: input.agent.message.slice(0, 240) }
        : {}),
    },
    nativeSession: input.agent.nativeSession ?? input.lineage.nativeSession,
    health: input.state === "unavailable" ? "unavailable" : "healthy",
    attention: input.attention,
    intervention: input.intervention,
    lastActivityAt: input.lastActivityAt,
    interactive: {
      ...terminalInteractiveSession(input.capabilities),
      ...(input.transportBinding
        ? { transportBinding: input.transportBinding }
        : input.lineage.transportBinding
          ? { transportBinding: input.lineage.transportBinding }
          : {}),
    },
  };
}

function hostedExecutionRef(
  value: JsonValue | undefined,
  expectedHarnessKind: string,
): HostedExecutionRef {
  const record = object(value, "terminal execution reference");
  if (
    !hasOnlyKeys(record, [
      "sessionName",
      "sessionIncarnation",
      "workspaceId",
      "paneId",
      "tabId",
      "terminalId",
      "agentName",
      "nativeSession",
    ])
  )
    throw new Error("Terminal execution reference has unexpected fields.");
  const sessionIncarnation = optionalString(record.sessionIncarnation);
  const tabId = optionalString(record.tabId);
  const terminalId = optionalString(record.terminalId);
  const session = nativeSession(record.nativeSession, expectedHarnessKind);
  const ref: HostedExecutionRef = {
    sessionName: string(record.sessionName, "terminal session name"),
    workspaceId: string(record.workspaceId, "terminal workspace"),
    paneId: string(record.paneId, "terminal pane"),
    agentName: string(record.agentName, "terminal agent name"),
    ...(sessionIncarnation ? { sessionIncarnation } : {}),
    ...(tabId ? { tabId } : {}),
    ...(terminalId ? { terminalId } : {}),
    ...(session ? { nativeSession: session } : {}),
  };
  return ref;
}

function hostedAgent(
  value: JsonValue | undefined,
  expectedHarnessKind: string,
): HostedAgent {
  const record = object(value, "terminal agent snapshot");
  if (
    !hasOnlyKeys(record, [
      "agent",
      "name",
      "status",
      "paneId",
      "workspaceId",
      "terminalId",
      "tabId",
      "cwd",
      "foregroundCwd",
      "statusSource",
      "message",
      "interactiveReady",
      "launchPending",
      "nativeMaterialized",
      "nativeSession",
      "tokens",
    ])
  )
    throw new Error("Terminal agent snapshot has unexpected fields.");
  const status = string(record.status, "terminal agent status");
  if (!["idle", "working", "blocked", "done", "unknown"].includes(status))
    throw new Error("Terminal transport binding has invalid agent status.");
  const agent: HostedAgent = {
    agent: string(record.agent, "terminal agent kind"),
    status: status as HostedAgent["status"],
    paneId: string(record.paneId, "terminal agent pane"),
    workspaceId: string(record.workspaceId, "terminal agent workspace"),
  };
  for (const field of [
    "name",
    "terminalId",
    "tabId",
    "cwd",
    "foregroundCwd",
    "statusSource",
    "message",
  ] as const) {
    const item = optionalString(record[field]);
    if (item) agent[field] = item;
  }
  for (const field of [
    "interactiveReady",
    "launchPending",
    "nativeMaterialized",
  ] as const) {
    const item = record[field];
    if (typeof item === "boolean") agent[field] = item;
    else if (item !== undefined)
      throw new Error(`Terminal transport binding has invalid ${field}.`);
  }
  const session = nativeSession(record.nativeSession, expectedHarnessKind);
  if (session) agent.nativeSession = session;
  if (record.tokens !== undefined) {
    const tokens = object(record.tokens, "terminal agent tokens");
    agent.tokens = Object.fromEntries(
      Object.entries(tokens).map(([key, item]) => [
        key,
        string(item, `terminal token ${key}`),
      ]),
    );
  }
  return agent;
}

function nativeSession(
  value: JsonValue | undefined,
  expectedHarnessKind: string,
) {
  if (value === undefined) return undefined;
  return validateNativeSessionRef(value, expectedHarnessKind);
}

function hasExactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
): boolean {
  return (
    hasOnlyKeys(value, expected) &&
    Object.keys(value).length === expected.length
  );
}

function hasOnlyKeys(
  value: Record<string, JsonValue>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function object(
  value: JsonValue | undefined,
  field: string,
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Terminal transport binding has invalid ${field}.`);
  return value;
}

function string(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Terminal transport binding has invalid ${field}.`);
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value)
    throw new Error(
      "Terminal transport binding has an invalid optional string.",
    );
  return value;
}
