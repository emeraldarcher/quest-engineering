import {
  type ArtifactInstance,
  type CancelDispatch,
  type CancelHarnessSetupCommand,
  type ExecuteAction,
  type HumanAttentionResponseCommand,
  isJsonValue,
  type PrepareHarnessSetupCommand,
  type ResolvedExecution,
  type RespondHarnessSetupCommand,
  WORKER_PROTOCOL_VERSION,
  type WorkspaceAccess,
} from "./types.ts";

export class ProtocolDecodeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

export function decodeCancelDispatch(
  value: unknown,
  expectedWorkerId: string,
  expectedGeneration: number,
): CancelDispatch {
  const payload = record(value, "message");
  exact(payload.type, "cancel_dispatch", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  exact(
    payload.connection_generation,
    expectedGeneration,
    "connection_generation",
  );
  const cancellation = record(payload.cancellation, "cancellation");
  exact(cancellation.origin, "product_operator", "cancellation.origin");

  return {
    type: "cancel_dispatch",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    connection_generation: expectedGeneration,
    action_id: string(payload.action_id, "action_id"),
    run_id: string(payload.run_id, "run_id"),
    occurrence_id: string(payload.occurrence_id, "occurrence_id"),
    attempt_id: string(payload.attempt_id, "attempt_id"),
    cancellation: {
      request_id: string(cancellation.request_id, "cancellation.request_id"),
      origin: "product_operator",
      reason: nullableString(cancellation.reason, "cancellation.reason"),
      requested_at: string(
        cancellation.requested_at,
        "cancellation.requested_at",
      ),
    },
  };
}

export function decodeHumanAttentionResponse(
  value: unknown,
  expectedWorkerId: string,
  expectedGeneration: number,
): HumanAttentionResponseCommand {
  const payload = record(value, "message");
  exact(payload.type, "respond_human_attention", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  exact(
    payload.connection_generation,
    expectedGeneration,
    "connection_generation",
  );
  const response = record(payload.response, "response");
  if (typeof response.approved !== "boolean")
    throw new ProtocolDecodeError("response.approved", "must be a boolean");
  if (!isJsonValue(response.value))
    throw new ProtocolDecodeError("response.value", "must be JSON");
  const respondedAt = string(response.responded_at, "response.responded_at");
  if (!Number.isFinite(Date.parse(respondedAt)))
    throw new ProtocolDecodeError(
      "response.responded_at",
      "must be an ISO-8601 timestamp",
    );
  return {
    type: "respond_human_attention",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    connection_generation: expectedGeneration,
    action_id: string(payload.action_id, "action_id"),
    run_id: string(payload.run_id, "run_id"),
    occurrence_id: string(payload.occurrence_id, "occurrence_id"),
    attempt_id: string(payload.attempt_id, "attempt_id"),
    response: {
      request_id: string(response.request_id, "response.request_id"),
      attention_id: string(response.attention_id, "response.attention_id"),
      approved: response.approved,
      value: response.value,
      responded_at: respondedAt,
    },
  };
}

export function decodePrepareHarnessSetup(
  value: unknown,
  expectedWorkerId: string,
  expectedGeneration: number,
): PrepareHarnessSetupCommand {
  const payload = record(value, "message");
  exact(payload.type, "prepare_harness_setup", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  exact(
    payload.connection_generation,
    expectedGeneration,
    "connection_generation",
  );
  const setup = record(payload.setup, "setup");
  exact(
    setup.authorization_kind,
    "human_harness_setup",
    "setup.authorization_kind",
  );
  const authorizedAt = timestamp(setup.authorized_at, "setup.authorized_at");
  const profile = record(setup.profile, "setup.profile");
  const configuration = record(setup.configuration, "setup.configuration");
  const model = record(configuration.model, "setup.configuration.model");
  const reasoning = nullableString(
    configuration.reasoning,
    "setup.configuration.reasoning",
  );
  const reasoningCapability = decodeReasoningCapability(
    configuration.reasoning_capability,
    "setup.configuration.reasoning_capability",
  );
  if (
    (reasoningCapability.kind === "unsupported") !== (reasoning === null) ||
    (reasoningCapability.kind === "enumerated" &&
      (reasoning === null || !reasoningCapability.values.includes(reasoning)))
  )
    throw new ProtocolDecodeError(
      "setup.configuration.reasoning",
      "must exactly match the resolved reasoning capability",
    );
  const toolPolicy = decodeToolPolicy(
    configuration.tool_policy,
    "setup.configuration.tool_policy",
  );
  const toolEnforcement = oneOf(
    configuration.tool_enforcement,
    ["exact", "native_permissions"] as const,
    "setup.configuration.tool_enforcement",
  );
  const resolved = record(
    configuration.resolved_tool_profile,
    "setup.configuration.resolved_tool_profile",
  );
  const resolvedTools = uniqueStrings(
    resolved.tools,
    "setup.configuration.resolved_tool_profile.tools",
  );
  if (
    toolPolicy.kind !== "exact" ||
    toolEnforcement !== "exact" ||
    !sameStringSet(toolPolicy.tools, resolvedTools)
  )
    throw new ProtocolDecodeError(
      "setup.configuration.tool_policy",
      "setup requires one exact tool policy",
    );
  return {
    type: "prepare_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    connection_generation: expectedGeneration,
    setup: {
      setup_id: string(setup.setup_id, "setup.setup_id"),
      setup_generation: positiveInteger(
        setup.setup_generation,
        "setup.setup_generation",
      ),
      authorization_id: string(
        setup.authorization_id,
        "setup.authorization_id",
      ),
      authorization_kind: "human_harness_setup",
      authorized_at: authorizedAt,
      action_id: string(setup.action_id, "setup.action_id"),
      run_id: string(setup.run_id, "setup.run_id"),
      occurrence_id: string(setup.occurrence_id, "setup.occurrence_id"),
      member_key: string(setup.member_key, "setup.member_key"),
      harness_kind: string(setup.harness_kind, "setup.harness_kind"),
      physical_lineage_id: string(
        setup.physical_lineage_id,
        "setup.physical_lineage_id",
      ),
      logical_lineage_id: string(
        setup.logical_lineage_id,
        "setup.logical_lineage_id",
      ),
      workspace_id: string(setup.workspace_id, "setup.workspace_id"),
      worktree_id: string(setup.worktree_id, "setup.worktree_id"),
      workspace_binding_id: string(
        setup.workspace_binding_id,
        "setup.workspace_binding_id",
      ),
      canonical_root: string(setup.canonical_root, "setup.canonical_root"),
      workspace_access: oneOf(
        setup.workspace_access,
        ["none", "read_only", "read_write"] as const,
        "setup.workspace_access",
      ),
      profile: {
        id: string(profile.id, "setup.profile.id"),
        digest: string(profile.digest, "setup.profile.digest"),
      },
      configuration: {
        model: {
          provider: string(
            model.provider,
            "setup.configuration.model.provider",
          ),
          model: string(model.model, "setup.configuration.model.model"),
        },
        reasoning,
        reasoning_capability: reasoningCapability,
        tool_policy: toolPolicy,
        tool_enforcement: toolEnforcement,
        resolved_tool_profile: { tools: resolvedTools },
      },
    },
  };
}

export function decodeCancelHarnessSetup(
  value: unknown,
  expectedWorkerId: string,
  expectedGeneration: number,
): CancelHarnessSetupCommand {
  const payload = record(value, "message");
  exact(payload.type, "cancel_harness_setup", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  exact(
    payload.connection_generation,
    expectedGeneration,
    "connection_generation",
  );
  return {
    type: "cancel_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    connection_generation: expectedGeneration,
    setup_id: string(payload.setup_id, "setup_id"),
    setup_generation: positiveInteger(
      payload.setup_generation,
      "setup_generation",
    ),
    request_id: string(payload.request_id, "request_id"),
  };
}

export function decodeRespondHarnessSetup(
  value: unknown,
  expectedWorkerId: string,
  expectedGeneration: number,
): RespondHarnessSetupCommand {
  const payload = record(value, "message");
  exact(payload.type, "respond_harness_setup", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  exact(
    payload.connection_generation,
    expectedGeneration,
    "connection_generation",
  );
  return {
    type: "respond_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    connection_generation: expectedGeneration,
    setup_id: string(payload.setup_id, "setup_id"),
    setup_generation: positiveInteger(
      payload.setup_generation,
      "setup_generation",
    ),
    attention_id: string(payload.attention_id, "attention_id"),
    request_id: string(payload.request_id, "request_id"),
    value: boundedText(payload.value, "value", 8_192),
  };
}

export function decodeExecuteAction(
  value: unknown,
  expectedWorkerId: string,
): ExecuteAction {
  const payload = record(value, "message");
  exact(payload.type, "execute_action", "type");
  exact(payload.protocol_version, WORKER_PROTOCOL_VERSION, "protocol_version");
  exact(payload.worker_id, expectedWorkerId, "worker_id");
  const execution = decodeExecution(payload.execution);
  const identity = execution.identity;
  const work = execution.work;
  return {
    type: "execute_action",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    execution,
    action_id: identity.action_id,
    run_id: identity.run_id,
    occurrence_id: identity.occurrence_id,
    attempt_id: identity.attempt_id,
    semantic_step_key: identity.semantic_step_key,
    instruction: work.step_instruction,
    inputs: work.inputs,
    declared_outputs: work.declared_outputs.map((output) => output.name),
    context_requirement: { selector: execution.context.mode, value: null },
    context_lineage_occurrence_id: execution.context.source_occurrence_id,
    ...(payload.operational_recovery === undefined
      ? {}
      : {
          operational_recovery: decodeOperationalRecovery(
            payload.operational_recovery,
          ),
        }),
    ...(payload.harness_setup === undefined
      ? {}
      : { harness_setup: decodeHarnessSetupBinding(payload.harness_setup) }),
  };
}

function decodeExecution(value: unknown): ResolvedExecution {
  const execution = record(value, "execution");
  const identity = record(execution.identity, "execution.identity");
  const performer = record(execution.performer, "execution.performer");
  const work = record(execution.work, "execution.work");
  const configuration = record(
    execution.configuration,
    "execution.configuration",
  );
  const model = record(configuration.model, "execution.configuration.model");
  const logicalWorkspace = record(
    execution.logical_workspace,
    "execution.logical_workspace",
  );
  const executionWorkspace = record(
    execution.execution_workspace,
    "execution.execution_workspace",
  );
  const context = record(execution.context, "execution.context");
  const inputs = record(work.inputs, "execution.work.inputs");
  const decodedInputs = Object.fromEntries(
    Object.entries(inputs).map(([key, artifact]) => [
      key,
      decodeArtifact(artifact, `execution.work.inputs.${key}`),
    ]),
  );
  const declaredOutputs = decodeOutputDeclarations(
    work.declared_outputs,
    "execution.work.declared_outputs",
  );
  const reasoning = nullableString(
    configuration.reasoning,
    "execution.configuration.reasoning",
  );
  const reasoningCapability = decodeReasoningCapability(
    configuration.reasoning_capability,
    "execution.configuration.reasoning_capability",
  );
  if (
    (reasoningCapability.kind === "unsupported") !== (reasoning === null) ||
    (reasoningCapability.kind === "enumerated" &&
      (reasoning === null || !reasoningCapability.values.includes(reasoning)))
  )
    throw new ProtocolDecodeError(
      "execution.configuration.reasoning",
      "must exactly match the resolved reasoning capability",
    );
  const toolPolicy = decodeToolPolicy(
    configuration.tool_policy,
    "execution.configuration.tool_policy",
  );
  const resolvedToolProfile = record(
    configuration.resolved_tool_profile,
    "execution.configuration.resolved_tool_profile",
  );
  const resolvedTools = uniqueStrings(
    resolvedToolProfile.tools,
    "execution.configuration.resolved_tool_profile.tools",
  );
  const toolEnforcement = oneOf(
    configuration.tool_enforcement,
    ["exact", "native_permissions"] as const,
    "execution.configuration.tool_enforcement",
  );
  if (
    (toolPolicy.kind === "exact" &&
      (toolEnforcement !== "exact" ||
        !sameStringSet(toolPolicy.tools, resolvedTools))) ||
    (toolPolicy.kind === "native_permissions" &&
      toolEnforcement !== "native_permissions")
  )
    throw new ProtocolDecodeError(
      "execution.configuration.tool_policy",
      "does not match resolved enforcement/profile",
    );
  const access = oneOf(
    executionWorkspace.access,
    ["none", "read_only", "read_write"] as const,
    "execution.execution_workspace.access",
  );
  const mode = oneOf(
    context.mode,
    ["fresh", "continue_from"] as const,
    "execution.context.mode",
  );
  const source = nullableString(
    context.source_occurrence_id,
    "execution.context.source_occurrence_id",
  );
  if ((mode === "fresh") !== (source === null))
    throw new ProtocolDecodeError(
      "execution.context",
      "fresh requires no source and continuation requires a source",
    );

  return {
    identity: {
      launch_id: string(identity.launch_id, "execution.identity.launch_id"),
      action_id: string(identity.action_id, "execution.identity.action_id"),
      run_id: string(identity.run_id, "execution.identity.run_id"),
      occurrence_id: string(
        identity.occurrence_id,
        "execution.identity.occurrence_id",
      ),
      attempt_id: string(identity.attempt_id, "execution.identity.attempt_id"),
      semantic_step_key: string(
        identity.semantic_step_key,
        "execution.identity.semantic_step_key",
      ),
    },
    performer: {
      member_key: string(
        performer.member_key,
        "execution.performer.member_key",
      ),
      member_name: string(
        performer.member_name,
        "execution.performer.member_name",
      ),
      class_key: string(performer.class_key, "execution.performer.class_key"),
      class_name: string(
        performer.class_name,
        "execution.performer.class_name",
      ),
    },
    work: {
      quest_objective: string(
        work.quest_objective,
        "execution.work.quest_objective",
      ),
      class_instructions: string(
        work.class_instructions,
        "execution.work.class_instructions",
      ),
      step_instruction: string(
        work.step_instruction,
        "execution.work.step_instruction",
      ),
      inputs: decodedInputs,
      declared_outputs: declaredOutputs,
      acceptance_contract: decodeAcceptanceContract(
        work.acceptance_contract,
        declaredOutputs,
      ),
    },
    configuration: {
      harness_kind: string(
        configuration.harness_kind,
        "execution.configuration.harness_kind",
      ),
      model: {
        provider: string(
          model.provider,
          "execution.configuration.model.provider",
        ),
        model: string(model.model, "execution.configuration.model.model"),
      },
      reasoning,
      reasoning_capability: reasoningCapability,
      tool_policy: toolPolicy,
      tool_enforcement: toolEnforcement,
      resolved_tool_profile: { tools: resolvedTools },
    },
    logical_workspace: {
      workspace_id: string(
        logicalWorkspace.workspace_id,
        "execution.logical_workspace.workspace_id",
      ),
      workspace_key: string(
        logicalWorkspace.workspace_key,
        "execution.logical_workspace.workspace_key",
      ),
    },
    execution_workspace: {
      worktree_id: string(
        executionWorkspace.worktree_id,
        "execution.execution_workspace.worktree_id",
      ),
      workspace_binding_id: string(
        executionWorkspace.workspace_binding_id,
        "execution.execution_workspace.workspace_binding_id",
      ),
      canonical_root: string(
        executionWorkspace.canonical_root,
        "execution.execution_workspace.canonical_root",
      ),
      access: access as WorkspaceAccess,
    },
    context: {
      mode,
      source_occurrence_id: source,
      logical_lineage_id: string(
        context.logical_lineage_id,
        "execution.context.logical_lineage_id",
      ),
    },
  };
}

function decodeAcceptanceContract(
  value: unknown,
  declaredOutputs: ResolvedExecution["work"]["declared_outputs"],
): NonNullable<ResolvedExecution["work"]["acceptance_contract"]> | null {
  if (value == null) return null;
  const contract = record(value, "execution.work.acceptance_contract");
  const output = string(
    contract.output,
    "execution.work.acceptance_contract.output",
  );
  if (!declaredOutputs.some((declaration) => declaration.name === output))
    throw new ProtocolDecodeError(
      "execution.work.acceptance_contract.output",
      "must name a declared output slot",
    );
  return {
    output,
    gate_key: string(
      contract.gate_key,
      "execution.work.acceptance_contract.gate_key",
    ),
    subject_kind: string(
      contract.subject_kind,
      "execution.work.acceptance_contract.subject_kind",
    ),
    subject_artifact_id: string(
      contract.subject_artifact_id,
      "execution.work.acceptance_contract.subject_artifact_id",
    ),
  };
}

function decodeOperationalRecovery(
  value: unknown,
): NonNullable<ExecuteAction["operational_recovery"]> {
  const recovery = record(value, "operational_recovery");
  return {
    epoch_number: nonNegativeInteger(
      recovery.epoch_number,
      "operational_recovery.epoch_number",
    ),
    attempt_in_epoch: positiveInteger(
      recovery.attempt_in_epoch,
      "operational_recovery.attempt_in_epoch",
    ),
    attempt_allowance:
      recovery.attempt_allowance === null
        ? null
        : positiveInteger(
            recovery.attempt_allowance,
            "operational_recovery.attempt_allowance",
          ),
    authorization_kind: oneOf(
      recovery.authorization_kind,
      ["initial", "human"] as const,
      "operational_recovery.authorization_kind",
    ),
    continuation_mode: oneOf(
      recovery.continuation_mode,
      ["fresh", "retained"] as const,
      "operational_recovery.continuation_mode",
    ),
    retained_lineage_id: nullableString(
      recovery.retained_lineage_id,
      "operational_recovery.retained_lineage_id",
    ),
    source_attempt_id: nullableString(
      recovery.source_attempt_id,
      "operational_recovery.source_attempt_id",
    ),
    request_id: nullableString(
      recovery.request_id,
      "operational_recovery.request_id",
    ),
  };
}

function decodeHarnessSetupBinding(
  value: unknown,
): NonNullable<ExecuteAction["harness_setup"]> {
  const setup = record(value, "harness_setup");
  const environment = record(setup.environment, "harness_setup.environment");
  const profile = record(
    environment.profile,
    "harness_setup.environment.profile",
  );
  return {
    setup_id: string(setup.setup_id, "harness_setup.setup_id"),
    setup_generation: positiveInteger(
      setup.setup_generation,
      "harness_setup.setup_generation",
    ),
    physical_lineage_id: string(
      setup.physical_lineage_id,
      "harness_setup.physical_lineage_id",
    ),
    environment: {
      environment_id: string(
        environment.environment_id,
        "harness_setup.environment.environment_id",
      ),
      incarnation: string(
        environment.incarnation,
        "harness_setup.environment.incarnation",
      ),
      profile: {
        id: string(profile.id, "harness_setup.environment.profile.id"),
        digest: string(
          profile.digest,
          "harness_setup.environment.profile.digest",
        ),
      },
    },
    config_identity: string(
      setup.config_identity,
      "harness_setup.config_identity",
    ),
  };
}

function decodeArtifact(value: unknown, field: string): ArtifactInstance {
  const artifact = record(value, field);
  if (!isJsonValue(artifact.value))
    throw new ProtocolDecodeError(`${field}.value`, "must be JSON-compatible");
  return {
    id: string(artifact.id, `${field}.id`),
    kind: string(artifact.kind, `${field}.kind`),
    output_name: string(artifact.output_name, `${field}.output_name`),
    producer_occurrence_id: string(
      artifact.producer_occurrence_id,
      `${field}.producer_occurrence_id`,
    ),
    value: artifact.value,
    version:
      artifact.version == null
        ? null
        : positiveInteger(artifact.version, `${field}.version`),
    supersedes_artifact_id: optionalNullableString(
      artifact.supersedes_artifact_id,
      `${field}.supersedes_artifact_id`,
    ),
    content_hash: optionalNullableString(
      artifact.content_hash,
      `${field}.content_hash`,
    ),
    media_type: optionalNullableString(
      artifact.media_type,
      `${field}.media_type`,
    ),
    filename: optionalNullableString(artifact.filename, `${field}.filename`),
    title: optionalNullableString(artifact.title, `${field}.title`),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolDecodeError(field, "must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ProtocolDecodeError(field, "must be a non-empty string");
  return value;
}
function boundedText(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw new ProtocolDecodeError(
      field,
      `must be a string no larger than ${maximumBytes} bytes`,
    );
  return value;
}
function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result)))
    throw new ProtocolDecodeError(field, "must be an ISO-8601 timestamp");
  return result;
}
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}
function optionalNullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  return string(value, field);
}
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0)
    throw new ProtocolDecodeError(field, "must be a positive integer");
  return Number(value);
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new ProtocolDecodeError(field, "must be a non-negative integer");
  return Number(value);
}
function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function decodeReasoningCapability(value: unknown, field: string) {
  const capability = record(value, field);
  if (capability.kind === "unsupported")
    return { kind: "unsupported" as const };
  if (capability.kind === "enumerated") {
    const values = uniqueStrings(capability.values, `${field}.values`);
    if (values.length > 0) return { kind: "enumerated" as const, values };
  }
  throw new ProtocolDecodeError(field, "invalid reasoning capability");
}

function decodeToolPolicy(value: unknown, field: string) {
  const policy = record(value, field);
  if (policy.kind === "native_permissions")
    return { kind: "native_permissions" as const };
  if (policy.kind === "exact")
    return {
      kind: "exact" as const,
      tools: uniqueStrings(policy.tools, `${field}.tools`),
    };
  throw new ProtocolDecodeError(field, "invalid tool policy");
}

function decodeOutputDeclarations(
  value: unknown,
  field: string,
): ResolvedExecution["work"]["declared_outputs"] {
  if (!Array.isArray(value))
    throw new ProtocolDecodeError(field, "must be an array");
  const outputs = value.map((item, index) => {
    const output = record(item, `${field}.${index}`);
    return {
      name: string(output.name, `${field}.${index}.name`),
      kind: string(output.kind, `${field}.${index}.kind`),
    };
  });
  if (new Set(outputs.map((output) => output.name)).size !== outputs.length)
    throw new ProtocolDecodeError(field, "must contain unique output names");
  return outputs;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw new ProtocolDecodeError(field, "must be an array");
  const values = value.map((item, index) => string(item, `${field}.${index}`));
  if (new Set(values).size !== values.length)
    throw new ProtocolDecodeError(field, "must not contain duplicates");
  return values;
}
function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new ProtocolDecodeError(field, `must be one of ${values.join(",")}`);
  return value as T[number];
}
function exact(value: unknown, expected: unknown, field: string): void {
  if (value !== expected)
    throw new ProtocolDecodeError(
      field,
      `must equal ${JSON.stringify(expected)}`,
    );
}
