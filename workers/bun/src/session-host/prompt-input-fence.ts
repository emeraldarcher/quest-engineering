import { createHash } from "node:crypto";
import { HERDR_METADATA_TOKEN_VALUE_BYTES } from "./herdr/compatibility.ts";
import { paneProcessIdentityDigest } from "./pane-process-identity.ts";
import type {
  HostedAgent,
  HostedPaneProcessInfo,
  PromptInputAuthority,
  SessionBackendReadiness,
} from "./types.ts";

export type PromptInputFenceClassification =
  | "immutable_physical_identity"
  | "generation_fenced_authority"
  | "expected_dynamic_state"
  | "derived_identity";

/** Secret-safe result: values are deliberately never retained or returned. */
export interface PromptInputFenceCheck {
  field: string;
  classification: PromptInputFenceClassification;
  expectedPresent: boolean;
  currentPresent: boolean;
  equal: boolean;
  expectedProvenance: string;
  currentProvenance: string;
}

export interface PromptInputFenceResult {
  ok: boolean;
  checks: PromptInputFenceCheck[];
  mismatches: PromptInputFenceCheck[];
  mismatchFields: string[];
}

export interface PromptInputFenceObservation {
  sessionName: string;
  sessionIncarnation: string | null;
  readiness: SessionBackendReadiness;
  /** The exact deterministic managed-agent name used as the lookup target. */
  agentLookupTarget: string;
  agent: HostedAgent;
  process: HostedPaneProcessInfo;
}

const PHYSICAL = "immutable_physical_identity" as const;
const GENERATION = "generation_fenced_authority" as const;
const DYNAMIC = "expected_dynamic_state" as const;
const DERIVED = "derived_identity" as const;

/**
 * Canonical environment identity. NUL framing prevents concatenation
 * ambiguity while retaining neither environment component in diagnostics.
 */
export function environmentIdentityDigest(
  environmentId: string,
  environmentIncarnation: string,
): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(environmentIncarnation)
    .digest("hex");
}

/** Validate authority syntax before any backend lookup or pane side effect. */
export function validatePromptInputAuthority(
  authority: PromptInputAuthority,
): PromptInputFenceResult {
  const checks: PromptInputFenceCheck[] = [];
  const required: Array<{
    field: keyof PromptInputAuthority;
    classification: PromptInputFenceClassification;
  }> = [
    { field: "workerId", classification: GENERATION },
    { field: "questLaunchId", classification: GENERATION },
    { field: "runId", classification: GENERATION },
    { field: "actionId", classification: GENERATION },
    { field: "occurrenceId", classification: GENERATION },
    { field: "attemptId", classification: GENERATION },
    { field: "physicalLineageId", classification: PHYSICAL },
    { field: "environmentId", classification: PHYSICAL },
    { field: "environmentIncarnation", classification: PHYSICAL },
    { field: "herdrServerGeneration", classification: GENERATION },
    { field: "sessionName", classification: PHYSICAL },
    { field: "sessionIncarnation", classification: PHYSICAL },
    { field: "workspaceId", classification: PHYSICAL },
    { field: "tabId", classification: PHYSICAL },
    { field: "paneId", classification: PHYSICAL },
    { field: "terminalId", classification: PHYSICAL },
    { field: "agentName", classification: PHYSICAL },
    { field: "agentIntegrationKind", classification: PHYSICAL },
    { field: "paneProcessIdentityDigest", classification: DERIVED },
    { field: "ownershipToken", classification: GENERATION },
    { field: "resultNonce", classification: GENERATION },
    { field: "promptAuthorizedAt", classification: GENERATION },
    { field: "promptIntentAt", classification: GENERATION },
  ];
  for (const item of required) {
    const value = authority[item.field];
    add(checks, {
      field: authorityField(item.field),
      classification: item.classification,
      expected: "non-empty",
      current: value,
      equal: typeof value === "string" && value.length > 0,
      expectedProvenance: "prompt authority contract",
      currentProvenance: "Worker prompt authority",
    });
  }
  add(checks, {
    field: "agent_integration_contract",
    classification: PHYSICAL,
    expected: "agy",
    current: authority.agentIntegrationKind,
    equal: authority.agentIntegrationKind === "agy",
    expectedProvenance: "Antigravity prompt-input contract",
    currentProvenance: "Worker prompt authority",
  });
  for (const item of [
    {
      field: "herdr_endpoint_generation",
      value: authority.herdrEndpointGeneration,
      classification: GENERATION,
    },
    {
      field: "pane_shell_pid",
      value: authority.paneShellPid,
      classification: PHYSICAL,
    },
    {
      field: "pane_foreground_process_group_id",
      value: authority.paneForegroundProcessGroupId,
      classification: PHYSICAL,
    },
  ] as const)
    add(checks, {
      field: item.field,
      classification: item.classification,
      expected: 1,
      current: item.value,
      equal: Number.isSafeInteger(item.value) && item.value >= 1,
      expectedProvenance: "prompt authority contract",
      currentProvenance: "Worker prompt authority",
    });
  const authorizedAt = Date.parse(authority.promptAuthorizedAt);
  const intentAt = Date.parse(authority.promptIntentAt);
  add(checks, {
    field: "prompt_authorization_timestamp",
    classification: GENERATION,
    expected: "valid timestamp",
    current: authority.promptAuthorizedAt,
    equal: Number.isFinite(authorizedAt),
    expectedProvenance: "Product authorization contract",
    currentProvenance: "Product prompt authorization",
  });
  add(checks, {
    field: "prompt_intent_timestamp",
    classification: GENERATION,
    expected: "valid timestamp",
    current: authority.promptIntentAt,
    equal: Number.isFinite(intentAt),
    expectedProvenance: "Product prompt-intent contract",
    currentProvenance: "durable Product prompt intent",
  });
  add(checks, {
    field: "prompt_intent_after_authorization",
    classification: GENERATION,
    expected: authorizedAt,
    current: intentAt,
    equal:
      Number.isFinite(authorizedAt) &&
      Number.isFinite(intentAt) &&
      intentAt >= authorizedAt,
    expectedProvenance: "Product authorization ordering",
    currentProvenance: "durable Product timestamps",
  });
  return result(checks);
}

/**
 * Pure, side-effect-free validation of the complete managed-agent input fence.
 * It emits only field names, presence, equality, classification, and
 * provenance; capability, ownership, nonce, and credential values never enter
 * the result.
 */
export function validatePromptInputFence(
  authority: PromptInputAuthority,
  observation: PromptInputFenceObservation,
): PromptInputFenceResult {
  const checks = [...validatePromptInputAuthority(authority).checks];
  const readiness = observation.readiness;
  const agent = observation.agent;
  const tokens = agent.tokens ?? {};
  const process = observation.process;

  compare(
    checks,
    "herdr_session_name",
    PHYSICAL,
    authority.sessionName,
    observation.sessionName,
    "managed-agent physical identity",
    "current Herdr backend",
  );
  compare(
    checks,
    "herdr_session_incarnation",
    PHYSICAL,
    authority.sessionIncarnation,
    observation.sessionIncarnation,
    "managed-agent physical identity",
    "current Herdr ownership record",
  );
  add(checks, {
    field: "herdr_backend_ready",
    classification: GENERATION,
    expected: true,
    current: readiness.ready,
    equal: readiness.ready === true,
    expectedProvenance: "prompt-input capability contract",
    currentProvenance: "current Herdr readiness",
  });
  for (const capability of ["terminal.literal_input", "terminal.submit_input"])
    add(checks, {
      field: `herdr_capability_${capability.replaceAll(".", "_")}`,
      classification: GENERATION,
      expected: capability,
      current: readiness.capabilities.includes(capability)
        ? capability
        : undefined,
      equal: readiness.capabilities.includes(capability),
      expectedProvenance: "prompt-input capability contract",
      currentProvenance: "current Herdr readiness",
    });
  compare(
    checks,
    "herdr_endpoint_generation",
    GENERATION,
    authority.herdrEndpointGeneration,
    readiness.provenance.endpointGeneration,
    "prompt authority",
    "current Herdr readiness",
  );
  compare(
    checks,
    "herdr_server_generation",
    GENERATION,
    authority.herdrServerGeneration,
    readiness.provenance.serverGeneration,
    "prompt authority",
    "current Herdr readiness",
  );
  compare(
    checks,
    "herdr_readiness_session_incarnation",
    GENERATION,
    authority.sessionIncarnation,
    readiness.provenance.sessionIncarnation,
    "prompt authority",
    "current Herdr readiness",
  );

  compare(
    checks,
    "managed_agent_lookup_target",
    PHYSICAL,
    authority.agentName,
    observation.agentLookupTarget,
    "managed-agent physical identity",
    "Herdr agent.get target",
  );
  compare(
    checks,
    "agent_integration_kind",
    PHYSICAL,
    "agy",
    agent.agent,
    "managed-agent physical identity",
    "Herdr native agent projection",
  );
  add(checks, {
    field: "agent_reported_name_if_present",
    classification: PHYSICAL,
    expected: authority.agentName,
    current: agent.name,
    equal: agent.name === undefined || agent.name === authority.agentName,
    expectedProvenance: "managed-agent physical identity",
    currentProvenance: "optional Herdr presentation projection",
  });
  add(checks, {
    field: "agent_status_idle",
    classification: DYNAMIC,
    expected: "idle",
    current: agent.status,
    equal: agent.status === "idle",
    expectedProvenance: "pre-input lifecycle",
    currentProvenance: "current Herdr agent state",
  });
  add(checks, {
    field: "agent_interactive_ready",
    classification: DYNAMIC,
    expected: true,
    current: agent.interactiveReady,
    equal: agent.interactiveReady === true,
    expectedProvenance: "materialized launch contract",
    currentProvenance: "current Herdr dynamic projection",
  });
  add(checks, {
    field: "agent_launch_not_pending",
    classification: DYNAMIC,
    expected: false,
    current: agent.launchPending,
    equal: agent.launchPending !== true,
    expectedProvenance: "materialized launch contract",
    currentProvenance: "optional Herdr dynamic projection",
  });
  add(checks, {
    field: "agent_native_materialized",
    classification: DYNAMIC,
    expected: true,
    current: agent.nativeMaterialized,
    equal: agent.nativeMaterialized === true,
    expectedProvenance: "native integration contract",
    currentProvenance: "Herdr native agent projection",
  });
  compare(
    checks,
    "workspace_id",
    PHYSICAL,
    authority.workspaceId,
    agent.workspaceId,
    "managed-agent physical identity",
    "current Herdr agent topology",
  );
  compare(
    checks,
    "tab_id",
    PHYSICAL,
    authority.tabId,
    agent.tabId,
    "managed-agent physical identity",
    "current Herdr agent topology",
  );
  compare(
    checks,
    "pane_id",
    PHYSICAL,
    authority.paneId,
    agent.paneId,
    "managed-agent physical identity",
    "current Herdr agent topology",
  );
  compare(
    checks,
    "terminal_id",
    PHYSICAL,
    authority.terminalId,
    agent.terminalId,
    "managed-agent physical identity",
    "current Herdr agent topology",
  );

  const expectedTokens: Array<{
    field: string;
    key: string;
    expected: string;
    classification: PromptInputFenceClassification;
    expectedProvenance: string;
  }> = [
    {
      field: "owner_marker",
      key: "qe_owner",
      expected: "quest-engineering-worker/v1",
      classification: GENERATION,
      expectedProvenance: "Worker ownership protocol",
    },
    {
      field: "worker_id",
      key: "qe_worker_id",
      expected: authority.workerId,
      classification: GENERATION,
      expectedProvenance: "prompt authority",
    },
    {
      field: "quest_launch_id",
      key: "qe_launch_id",
      expected: authority.questLaunchId,
      classification: GENERATION,
      expectedProvenance: "prompt authority",
    },
    {
      field: "run_id",
      key: "qe_run_id",
      expected: authority.runId,
      classification: GENERATION,
      expectedProvenance: "prompt authority",
    },
    {
      field: "physical_lineage_id",
      key: "qe_lineage_id",
      expected: authority.physicalLineageId,
      classification: PHYSICAL,
      expectedProvenance: "managed-agent physical identity",
    },
    {
      field: "harness_kind",
      key: "qe_harness_kind",
      expected: "antigravity",
      classification: PHYSICAL,
      expectedProvenance: "managed-agent physical identity",
    },
    {
      field: "agent_name_token",
      key: "qe_agent_name",
      expected: authority.agentName,
      classification: PHYSICAL,
      expectedProvenance: "managed-agent physical identity",
    },
    {
      field: "ownership_token",
      key: "qe_ownership_token",
      expected: authority.ownershipToken,
      classification: GENERATION,
      expectedProvenance: "PhysicalLineage ownership authority",
    },
    {
      field: "session_incarnation_token",
      key: "qe_session_incarnation",
      expected: authority.sessionIncarnation,
      classification: PHYSICAL,
      expectedProvenance: "managed-agent physical identity",
    },
    {
      field: "environment_identity_digest",
      key: "qe_environment_hash",
      expected: environmentIdentityDigest(
        authority.environmentId,
        authority.environmentIncarnation,
      ),
      classification: DERIVED,
      expectedProvenance: "canonical environment identity",
    },
    {
      field: "active_state",
      key: "qe_active_state",
      expected: "active",
      classification: GENERATION,
      expectedProvenance: "current dispatch authority",
    },
    {
      field: "active_action_id",
      key: "qe_active_action_id",
      expected: boundedHerdrMetadataToken(authority.actionId),
      classification: GENERATION,
      expectedProvenance:
        "current dispatch authority bounded by the Herdr metadata protocol",
    },
    {
      field: "action_identity_digest",
      key: "qe_action_hash",
      expected: digest(authority.actionId),
      classification: DERIVED,
      expectedProvenance: "current Action identity",
    },
    {
      field: "occurrence_identity_digest",
      key: "qe_occurrence_hash",
      expected: digest(authority.occurrenceId),
      classification: DERIVED,
      expectedProvenance: "current StepOccurrence identity",
    },
    {
      field: "attempt_identity_digest",
      key: "qe_attempt_hash",
      expected: digest(authority.attemptId),
      classification: DERIVED,
      expectedProvenance: "current Attempt identity",
    },
    {
      field: "result_nonce",
      key: "qe_result_nonce",
      expected: authority.resultNonce,
      classification: GENERATION,
      expectedProvenance: "current dispatch result authority",
    },
  ];
  for (const token of expectedTokens)
    compare(
      checks,
      token.field,
      token.classification,
      token.expected,
      tokens[token.key],
      token.expectedProvenance,
      `Herdr managed-agent token ${token.key}`,
    );

  compare(
    checks,
    "pane_process_pane_id",
    PHYSICAL,
    authority.paneId,
    process.paneId,
    "managed-agent physical identity",
    "current Herdr process inspection",
  );
  compare(
    checks,
    "pane_shell_pid",
    PHYSICAL,
    authority.paneShellPid,
    process.shellPid,
    "preauthorization process observation",
    "current Herdr process inspection",
  );
  compare(
    checks,
    "pane_foreground_process_group_id",
    PHYSICAL,
    authority.paneForegroundProcessGroupId,
    process.foregroundProcessGroupId,
    "preauthorization process observation",
    "current Herdr process inspection",
  );
  compare(
    checks,
    "pane_process_identity_digest",
    DERIVED,
    authority.paneProcessIdentityDigest,
    paneProcessIdentityDigest(process),
    "canonical preauthorization process observation",
    "canonical current process observation",
  );
  return result(checks);
}

function compare(
  checks: PromptInputFenceCheck[],
  field: string,
  classification: PromptInputFenceClassification,
  expected: unknown,
  current: unknown,
  expectedProvenance: string,
  currentProvenance: string,
): void {
  add(checks, {
    field,
    classification,
    expected,
    current,
    equal: expected === current,
    expectedProvenance,
    currentProvenance,
  });
}

function add(
  checks: PromptInputFenceCheck[],
  input: {
    field: string;
    classification: PromptInputFenceClassification;
    expected: unknown;
    current: unknown;
    equal: boolean;
    expectedProvenance: string;
    currentProvenance: string;
  },
): void {
  checks.push({
    field: input.field,
    classification: input.classification,
    expectedPresent: present(input.expected),
    currentPresent: present(input.current),
    equal: input.equal,
    expectedProvenance: input.expectedProvenance,
    currentProvenance: input.currentProvenance,
  });
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function result(checks: PromptInputFenceCheck[]): PromptInputFenceResult {
  const mismatches = checks.filter((check) => !check.equal);
  return {
    ok: mismatches.length === 0,
    checks,
    mismatches,
    mismatchFields: [...new Set(mismatches.map((check) => check.field))],
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedHerdrMetadataToken(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= HERDR_METADATA_TOKEN_VALUE_BYTES) return value;
  return bytes.subarray(0, HERDR_METADATA_TOKEN_VALUE_BYTES).toString("utf8");
}

function authorityField(field: keyof PromptInputAuthority): string {
  return field.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}
