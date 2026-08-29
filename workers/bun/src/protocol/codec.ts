import {
  type ArtifactInstance,
  type ExecuteAction,
  isJsonValue,
  type Reasoning,
  type ResolvedExecution,
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
    declared_outputs: work.declared_outputs,
    context_requirement: { selector: execution.context.mode, value: null },
    context_lineage_occurrence_id: execution.context.source_occurrence_id,
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
  const declaredOutputs = uniqueStrings(
    work.declared_outputs,
    "execution.work.declared_outputs",
  );
  const tools = uniqueStrings(
    configuration.tools,
    "execution.configuration.tools",
  );
  const reasoning = oneOf(
    configuration.reasoning,
    ["low", "medium", "high"] as const,
    "execution.configuration.reasoning",
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
    },
    configuration: {
      model: {
        provider: string(
          model.provider,
          "execution.configuration.model.provider",
        ),
        model: string(model.model, "execution.configuration.model.model"),
      },
      reasoning: reasoning as Reasoning,
      tools,
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

function decodeArtifact(value: unknown, field: string): ArtifactInstance {
  const artifact = record(value, field);
  if (!isJsonValue(artifact.value))
    throw new ProtocolDecodeError(`${field}.value`, "must be JSON-compatible");
  return {
    id: string(artifact.id, `${field}.id`),
    type: string(artifact.type, `${field}.type`),
    producer_occurrence_id: string(
      artifact.producer_occurrence_id,
      `${field}.producer_occurrence_id`,
    ),
    value: artifact.value,
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
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
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
