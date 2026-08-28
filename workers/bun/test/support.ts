import type { ExecuteAction } from "../src/protocol/types.ts";

export function action(overrides: Partial<ExecuteAction> = {}): ExecuteAction {
  return {
    type: "execute_action",
    protocol_version: 2,
    worker_id: "worker-test",
    action_id: "action-1",
    run_id: "run-1",
    occurrence_id: "occurrence-1",
    attempt_id: "attempt-1",
    semantic_step_key: "implement",
    instruction: "Implement the supplied plan and produce a change set.",
    performer_requirement: { selector: "class", value: "builder" },
    performer_affinity_occurrence_id: null,
    context_requirement: { selector: "fresh", value: null },
    context_lineage_occurrence_id: null,
    inputs: {},
    declared_outputs: ["change_set"],
    ...overrides,
  };
}
