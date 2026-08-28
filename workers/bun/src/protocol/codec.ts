import {
  type ArtifactInstance,
  type ExecuteAction,
  isJsonValue,
  type Requirement,
  WORKER_PROTOCOL_VERSION,
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

  const instruction = string(payload.instruction, "instruction");
  if (!instruction.trim())
    throw new ProtocolDecodeError("instruction", "must not be blank");

  const inputs = record(payload.inputs, "inputs");
  const decodedInputs = Object.fromEntries(
    Object.entries(inputs).map(([key, artifact]) => [
      key,
      decodeArtifact(artifact, `inputs.${key}`),
    ]),
  );
  const declaredOutputs = stringArray(
    payload.declared_outputs,
    "declared_outputs",
  );
  if (new Set(declaredOutputs).size !== declaredOutputs.length) {
    throw new ProtocolDecodeError(
      "declared_outputs",
      "must not contain duplicates",
    );
  }

  return {
    type: "execute_action",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: expectedWorkerId,
    action_id: string(payload.action_id, "action_id"),
    run_id: string(payload.run_id, "run_id"),
    occurrence_id: string(payload.occurrence_id, "occurrence_id"),
    attempt_id: string(payload.attempt_id, "attempt_id"),
    semantic_step_key: string(payload.semantic_step_key, "semantic_step_key"),
    instruction,
    performer_requirement: requirement(
      payload.performer_requirement,
      "performer_requirement",
    ),
    performer_affinity_occurrence_id: nullableString(
      payload.performer_affinity_occurrence_id,
      "performer_affinity_occurrence_id",
    ),
    context_requirement: requirement(
      payload.context_requirement,
      "context_requirement",
    ),
    context_lineage_occurrence_id: nullableString(
      payload.context_lineage_occurrence_id,
      "context_lineage_occurrence_id",
    ),
    inputs: decodedInputs,
    declared_outputs: declaredOutputs,
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

function requirement(value: unknown, field: string): Requirement {
  const item = record(value, field);
  return {
    selector: string(item.selector, `${field}.selector`),
    value: nullableString(item.value, `${field}.value`),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolDecodeError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ProtocolDecodeError(field, "must be a non-empty string");
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw new ProtocolDecodeError(field, "must be an array");
  return value.map((item, index) => string(item, `${field}.${index}`));
}

function exact(value: unknown, expected: unknown, field: string): void {
  if (value !== expected)
    throw new ProtocolDecodeError(
      field,
      `must equal ${JSON.stringify(expected)}`,
    );
}
