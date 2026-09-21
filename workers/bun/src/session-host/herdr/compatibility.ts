import type {
  HostedSnapshot,
  SessionBackendDiagnostic,
  SessionBackendReadiness,
} from "../types.ts";

/**
 * Protocol 22 is the newest contract exercised by QE's deterministic and local
 * smoke tests. It is diagnostic provenance only, never an acceptance ceiling.
 */
export const HERDR_TESTED_PROTOCOL = 22;

/**
 * Herdr 0.9 introduced endpoint generation 1 as the stable compatibility
 * boundary. Older endpoints require replacement even if their numeric socket
 * protocol once appeared in a QE allowlist.
 */
export const HERDR_MIN_ENDPOINT_GENERATION = 1;

const SHARED_REQUIREMENTS = [
  ["backend.health", ["ping"]],
  ["session.inventory", ["session.snapshot"]],
  ["session.ownership_metadata", ["workspace.report_metadata"]],
  ["terminal.topology", ["workspace.create", "tab.create", "tab.rename"]],
  ["terminal.metadata", ["pane.report_metadata"]],
  ["terminal.shell_readiness", ["pane.process_info"]],
  ["agent.interactive_launch", ["agent.start"]],
  ["agent.prompt", ["agent.prompt"]],
  ["agent.inspect", ["agent.get"]],
  ["agent.send_input", ["agent.send_keys"]],
  ["integration.discovery", ["integration.list"]],
] as const;

const HARNESS_REQUIREMENTS: Record<
  string,
  ReadonlyArray<readonly [string, readonly string[]]>
> = {
  pi: [["agent.state_observation", ["agent.wait"]]],
  antigravity: [],
};

const REQUIRED_OPERATION_PARAMETERS: Record<string, readonly string[]> = {
  "workspace.report_metadata": ["workspace_id", "source", "tokens"],
  "workspace.create": ["cwd", "label", "focus", "env"],
  "tab.create": ["workspace_id", "cwd", "label", "focus", "env"],
  "tab.rename": ["tab_id", "label"],
  "pane.report_metadata": [
    "pane_id",
    "source",
    "title",
    "display_agent",
    "tokens",
  ],
  "pane.process_info": ["pane_id"],
  "agent.start": ["pane_id", "name", "kind", "args", "timeout_ms"],
  "agent.prompt": ["target", "text", "wait"],
  "agent.get": ["target"],
  "agent.send_keys": ["target", "keys"],
  "agent.wait": ["target", "until", "timeout_ms"],
};

const RESPONSE_SHAPE_REQUIREMENTS: ReadonlyArray<
  readonly [string, ReadonlyArray<readonly string[]>]
> = [
  ["session.inventory", [["workspaces", "panes", "agents"]]],
  ["session.ownership_metadata", [["workspace_id", "tokens"]]],
  [
    "terminal.topology",
    [
      ["workspace_id"],
      ["tab_id", "workspace_id"],
      ["pane_id", "tab_id", "workspace_id"],
    ],
  ],
  ["terminal.shell_readiness", [["shell_pid", "foreground_process_group_id"]]],
  [
    "agent.interactive_launch",
    [
      [
        "agent",
        "agent_status",
        "interactive_ready",
        "launch_pending",
        "name",
        "pane_id",
        "workspace_id",
      ],
    ],
  ],
  ["agent.prompt", [["agent", "agent_status", "pane_id", "workspace_id"]]],
  ["agent.inspect", [["agent", "agent_status", "pane_id", "workspace_id"]]],
  ["agent.state_observation", [["agent_status", "pane_id", "workspace_id"]]],
  ["integration.discovery", [["target", "available", "state"]]],
];

const CANONICAL_AGENT_STATES = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
] as const;

export interface HerdrIntegrationEvidence {
  target: string;
  available?: boolean;
  state?: string;
  malformed?: boolean;
}

export interface HerdrCompatibilityEvidence {
  status: Record<string, unknown>;
  schema: Record<string, unknown>;
  ping: {
    version: string;
    protocol: number;
    endpointGeneration: number;
    agentExplicitLaunch?: boolean;
  };
  snapshot: HostedSnapshot;
  integrations: HerdrIntegrationEvidence[];
  serverGeneration?: string;
}

export function evaluateHerdrCompatibility(
  harnessKind: string,
  evidence: HerdrCompatibilityEvidence,
): SessionBackendReadiness {
  const diagnostics: SessionBackendDiagnostic[] = [];
  const capabilities = new Set<string>();
  const missing = new Set<string>();
  const statusProtocol = integer(evidence.status.protocol);
  const statusVersion = optionalString(evidence.status.version);
  const statusCapabilities = record(evidence.status.capabilities);
  const statusGeneration = integer(
    statusCapabilities?.endpoint_protocol_generation,
  );
  const schemaProtocol = integer(evidence.schema.protocol);
  const schemaVersion = integer(evidence.schema.schema_version);

  if (
    schemaProtocol === undefined ||
    schemaVersion === undefined ||
    schemaVersion < 1
  ) {
    missing.add("backend.api_metadata");
    diagnostics.push({
      code: "malformed_contract",
      capability: "backend.api_metadata",
      message:
        "Herdr API schema metadata omitted a valid protocol or schema version.",
    });
  } else capabilities.add("backend.api_metadata");

  if (evidence.status.compatible !== true) {
    missing.add("backend.wire_compatibility");
    diagnostics.push({
      code: "wire_incompatible",
      capability: "backend.wire_compatibility",
      message: "Herdr did not report compatible client/server wire behavior.",
    });
  } else capabilities.add("backend.wire_compatibility");

  if (evidence.status.endpoint_compatible !== true) {
    missing.add("backend.endpoint_compatibility");
    diagnostics.push({
      code: "wire_incompatible",
      capability: "backend.endpoint_compatibility",
      message: "Herdr did not report a compatible endpoint API.",
    });
  } else capabilities.add("backend.endpoint_compatibility");

  if (
    statusGeneration === undefined ||
    statusGeneration < HERDR_MIN_ENDPOINT_GENERATION ||
    evidence.ping.endpointGeneration < HERDR_MIN_ENDPOINT_GENERATION
  ) {
    missing.add("backend.endpoint_generation_1");
    diagnostics.push({
      code: "endpoint_generation_unsupported",
      capability: "backend.endpoint_generation_1",
      message: `Herdr endpoint generation ${String(statusGeneration ?? "unknown")} does not meet QE's generation ${HERDR_MIN_ENDPOINT_GENERATION} compatibility floor.`,
    });
  } else {
    capabilities.add("backend.endpoint_generation_1");
  }

  if (
    statusProtocol === undefined ||
    evidence.ping.protocol !== statusProtocol ||
    (statusVersion !== undefined && evidence.ping.version !== statusVersion)
  ) {
    missing.add("backend.server_identity");
    diagnostics.push({
      code: "malformed_contract",
      capability: "backend.server_identity",
      message:
        "Herdr status and live ping did not identify the same server contract.",
    });
  } else {
    capabilities.add("backend.server_identity");
  }

  const schemaOperations = operationContracts(evidence.schema);
  for (const [capability, operations] of [
    ...SHARED_REQUIREMENTS,
    ...(HARNESS_REQUIREMENTS[harnessKind] ?? []),
  ]) {
    const absent = operations.filter(
      (operation) => !schemaOperations.has(operation),
    );
    const malformed = operations.flatMap((operation) => {
      const parameters = schemaOperations.get(operation);
      return (REQUIRED_OPERATION_PARAMETERS[operation] ?? [])
        .filter((parameter) => !parameters?.has(parameter))
        .map((parameter) => `${operation}.${parameter}`);
    });
    if (absent.length === 0 && malformed.length === 0)
      capabilities.add(capability);
    else {
      missing.add(capability);
      diagnostics.push({
        code: "missing_capability",
        capability,
        message: `Herdr cannot prove QE capability '${capability}'; API metadata omits ${[...absent, ...malformed].join(", ")}.`,
      });
    }
  }

  if (harnessKind === "pi") {
    const explicitLaunchSchema =
      schemaOperations.get("agent.start")?.has("command") === true;
    const explicitLaunchAdvertised = evidence.ping.agentExplicitLaunch === true;
    if (explicitLaunchSchema && explicitLaunchAdvertised)
      capabilities.add("agent.explicit_launch");
    else {
      missing.add("agent.explicit_launch");
      diagnostics.push({
        code: "missing_capability",
        capability: "agent.explicit_launch",
        message:
          "Herdr cannot prove generic exact managed launch support in both live capabilities and agent.start schema metadata.",
      });
    }
  }

  for (const [capability, shapes] of RESPONSE_SHAPE_REQUIREMENTS) {
    if (capability === "agent.state_observation" && harnessKind !== "pi")
      continue;
    const missingShapes = shapes.filter(
      (properties) => !supportsResponseShape(evidence.schema, properties),
    );
    if (missingShapes.length === 0) continue;
    capabilities.delete(capability);
    missing.add(capability);
    diagnostics.push({
      code: "missing_capability",
      capability,
      message: `Herdr cannot prove QE capability '${capability}'; response metadata omits ${missingShapes.map((shape) => shape.join("+")).join(", ")}.`,
    });
  }

  if (supportsCanonicalAgentLifecycle(evidence.schema))
    capabilities.add("lifecycle.canonical_states");
  else {
    missing.add("lifecycle.canonical_states");
    diagnostics.push({
      code: "missing_capability",
      capability: "lifecycle.canonical_states",
      message:
        "Herdr API metadata does not expose the canonical idle/working/blocked/done/unknown lifecycle contract.",
    });
  }

  if (snapshotContractValid(evidence.snapshot))
    capabilities.add("session.snapshot_decoding");
  else {
    missing.add("session.snapshot_decoding");
    diagnostics.push({
      code: "malformed_contract",
      capability: "session.snapshot_decoding",
      message:
        "Herdr's live session snapshot did not satisfy QE's decoded shape.",
    });
  }

  const integrationCapability = integrationCapabilityFor(harnessKind);
  if (integrationCapability) {
    const expectedTarget = harnessKind === "pi" ? "pi" : "antigravity_cli";
    const integration = evidence.integrations.find(
      (item) => item.target === expectedTarget,
    );
    if (
      integration &&
      !integration.malformed &&
      integration.available === true &&
      integration.state === "current"
    ) {
      capabilities.add(integrationCapability);
    } else {
      missing.add(integrationCapability);
      diagnostics.push({
        code: integration?.malformed
          ? "malformed_contract"
          : "missing_capability",
        capability: integrationCapability,
        message: integration?.malformed
          ? `Herdr returned malformed integration metadata for '${expectedTarget}'.`
          : `Herdr integration '${expectedTarget}' is not available and current.`,
      });
    }
  }

  if (
    statusProtocol !== undefined &&
    statusProtocol > HERDR_TESTED_PROTOCOL &&
    diagnostics.every(
      (diagnostic) => diagnostic.code === "newer_than_tested_but_compatible",
    )
  )
    diagnostics.push({
      code: "newer_than_tested_but_compatible",
      message: `Herdr protocol ${statusProtocol} is newer than QE's tested protocol ${HERDR_TESTED_PROTOCOL}; the required capability contract passed.`,
    });

  const blocking = diagnostics.filter(
    (diagnostic) => diagnostic.code !== "newer_than_tested_but_compatible",
  );
  return {
    backendKind: "herdr",
    harnessKind,
    status: blocking.length === 0 ? "ready" : "incompatible",
    ready: blocking.length === 0,
    capabilities: [...capabilities].sort(),
    missingCapabilities: [...missing].sort(),
    diagnostics,
    provenance: {
      ...(statusVersion ? { version: statusVersion } : {}),
      ...(statusProtocol !== undefined ? { protocol: statusProtocol } : {}),
      testedProtocol: HERDR_TESTED_PROTOCOL,
      ...(statusGeneration !== undefined
        ? { endpointGeneration: statusGeneration }
        : {}),
      ...(evidence.serverGeneration
        ? { serverGeneration: evidence.serverGeneration }
        : {}),
    },
  };
}

export function unavailableHerdrReadiness(
  harnessKind: string,
  message: string,
): SessionBackendReadiness {
  return {
    backendKind: "herdr",
    harnessKind,
    status: "unavailable",
    ready: false,
    capabilities: [],
    missingCapabilities: ["backend.connection"],
    diagnostics: [
      {
        code: "backend_unavailable",
        capability: "backend.connection",
        message,
      },
    ],
    provenance: { testedProtocol: HERDR_TESTED_PROTOCOL },
  };
}

export function incompatibleHerdrReadiness(
  harnessKind: string,
  capability: string,
  message: string,
  provenance: SessionBackendReadiness["provenance"] = {
    testedProtocol: HERDR_TESTED_PROTOCOL,
  },
  code: Extract<
    SessionBackendDiagnostic["code"],
    | "wire_incompatible"
    | "endpoint_generation_unsupported"
    | "malformed_contract"
    | "ownership_conflict"
  > = "malformed_contract",
): SessionBackendReadiness {
  return {
    backendKind: "herdr",
    harnessKind,
    status: "incompatible",
    ready: false,
    capabilities: [],
    missingCapabilities: [capability],
    diagnostics: [{ code, capability, message }],
    provenance: {
      testedProtocol: HERDR_TESTED_PROTOCOL,
      ...provenance,
    },
  };
}

export function readinessDetail(value: SessionBackendReadiness): string {
  return (
    value.diagnostics.map((item) => item.message).join(" ") ||
    `Herdr ${value.provenance.version ?? "unknown"} protocol ${String(value.provenance.protocol ?? "unknown")} readiness verified.`
  );
}

function integrationCapabilityFor(harnessKind: string): string | null {
  if (harnessKind === "pi") return "integration.pi.current";
  if (harnessKind === "antigravity") return "integration.antigravity.current";
  return null;
}

function operationContracts(
  schema: Record<string, unknown>,
): Map<string, Set<string>> {
  const request = record(record(schema.schemas)?.request);
  const operations = new Map<string, Set<string>>();
  visit(request, (value) => {
    const properties = record(value.properties);
    const method = record(properties?.method);
    if (typeof method?.const !== "string") return;
    const params = resolveLocalRef(record(properties?.params), schema);
    const paramProperties = record(params?.properties);
    operations.set(
      method.const,
      new Set(paramProperties ? Object.keys(paramProperties) : []),
    );
  });
  return operations;
}

function resolveLocalRef(
  value: Record<string, unknown> | null,
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!value || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("#/")) return null;
  let current: unknown = schema;
  for (const segment of value.$ref
    .slice(2)
    .split("/")
    .map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    current = record(current)?.[segment];
  }
  return record(current);
}

function supportsResponseShape(
  schema: Record<string, unknown>,
  requiredProperties: readonly string[],
): boolean {
  const success = record(record(schema.schemas)?.success_response);
  let found = false;
  visit(success, (value) => {
    if (found) return;
    const properties = record(value.properties);
    if (
      properties &&
      requiredProperties.every((property) => property in properties)
    )
      found = true;
  });
  return found;
}

function supportsCanonicalAgentLifecycle(
  schema: Record<string, unknown>,
): boolean {
  const success = record(record(schema.schemas)?.success_response);
  let found = false;
  visit(success, (value) => {
    if (found || !Array.isArray(value.enum)) return;
    const values = value.enum.filter(
      (item): item is string => typeof item === "string",
    );
    if (CANONICAL_AGENT_STATES.every((status) => values.includes(status)))
      found = true;
  });
  return found;
}

function snapshotContractValid(snapshot: HostedSnapshot): boolean {
  return (
    Array.isArray(snapshot.workspaces) &&
    Array.isArray(snapshot.panes) &&
    Array.isArray(snapshot.agents) &&
    snapshot.workspaces.every(
      (item) => typeof item.workspaceId === "string" && item.workspaceId,
    ) &&
    snapshot.panes.every(
      (item) =>
        Boolean(item.paneId) &&
        Boolean(item.workspaceId) &&
        Boolean(item.tabId),
    ) &&
    snapshot.agents.every(
      (item) =>
        Boolean(item.agent) &&
        Boolean(item.paneId) &&
        Boolean(item.workspaceId) &&
        CANONICAL_AGENT_STATES.includes(item.status),
    )
  );
}

function visit(
  value: unknown,
  observer: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, observer);
    return;
  }
  const item = record(value);
  if (!item) return;
  observer(item);
  for (const nested of Object.values(item)) visit(nested, observer);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
