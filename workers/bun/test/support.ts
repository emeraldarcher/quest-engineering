import type { ExecuteAction } from "../src/protocol/types.ts";

export function action(overrides: Partial<ExecuteAction> = {}): ExecuteAction {
  const base: ExecuteAction = {
    type: "execute_action",
    protocol_version: 4,
    worker_id: "worker-test",
    execution: {
      identity: {
        launch_id: "launch-1",
        action_id: "action-1",
        run_id: "run-1",
        occurrence_id: "occurrence-1",
        attempt_id: "attempt-1",
        semantic_step_key: "implement",
      },
      performer: {
        member_key: "alice",
        member_name: "Alice",
        class_key: "builder",
        class_name: "Builder",
      },
      work: {
        quest_objective: "Ship the requested change.",
        class_instructions: "Build carefully.",
        step_instruction:
          "Implement the supplied plan and produce a change set.",
        inputs: {},
        declared_outputs: ["change_set"],
      },
      configuration: {
        model: { provider: "fake", model: "test" },
        reasoning: "medium",
        tools: ["workspace.filesystem"],
      },
      logical_workspace: {
        workspace_id: "00000000-0000-4000-8000-000000000001",
        workspace_key: "test",
      },
      execution_workspace: {
        worktree_id: "00000000-0000-4000-8000-000000000002",
        workspace_binding_id: "00000000-0000-4000-8000-000000000003",
        canonical_root: process.cwd(),
        access: "read_write",
      },
      context: {
        mode: "fresh",
        source_occurrence_id: null,
        logical_lineage_id: "logical-action-1",
      },
    },
    action_id: "action-1",
    run_id: "run-1",
    occurrence_id: "occurrence-1",
    attempt_id: "attempt-1",
    semantic_step_key: "implement",
    instruction: "Implement the supplied plan and produce a change set.",
    inputs: {},
    declared_outputs: ["change_set"],
    context_requirement: { selector: "fresh", value: null },
    context_lineage_occurrence_id: null,
  };
  const merged = { ...base, ...overrides };
  if (!overrides.execution) {
    merged.execution = {
      ...base.execution,
      identity: {
        ...base.execution.identity,
        action_id: overrides.action_id ?? base.action_id,
        run_id: overrides.run_id ?? base.run_id,
        occurrence_id: overrides.occurrence_id ?? base.occurrence_id,
        attempt_id: overrides.attempt_id ?? base.attempt_id,
        semantic_step_key:
          overrides.semantic_step_key ?? base.semantic_step_key,
      },
      work: {
        ...base.execution.work,
        step_instruction: overrides.instruction ?? base.instruction,
        inputs: overrides.inputs ?? base.inputs,
        declared_outputs: overrides.declared_outputs ?? base.declared_outputs,
      },
      context: {
        ...base.execution.context,
        mode:
          overrides.context_requirement?.selector ??
          base.context_requirement.selector,
        source_occurrence_id:
          overrides.context_lineage_occurrence_id ??
          base.context_lineage_occurrence_id,
        logical_lineage_id:
          overrides.context_requirement?.selector === "continue_from"
            ? base.execution.context.logical_lineage_id
            : `logical-${overrides.action_id ?? base.action_id}`,
      },
    };
  }
  if (overrides.execution) {
    merged.action_id = overrides.execution.identity.action_id;
    merged.run_id = overrides.execution.identity.run_id;
    merged.occurrence_id = overrides.execution.identity.occurrence_id;
    merged.attempt_id = overrides.execution.identity.attempt_id;
    merged.semantic_step_key = overrides.execution.identity.semantic_step_key;
    merged.instruction = overrides.execution.work.step_instruction;
    merged.inputs = overrides.execution.work.inputs;
    merged.declared_outputs = overrides.execution.work.declared_outputs;
    merged.context_requirement = {
      selector: overrides.execution.context.mode,
      value: null,
    };
    merged.context_lineage_occurrence_id =
      overrides.execution.context.source_occurrence_id;
  }
  return merged;
}
