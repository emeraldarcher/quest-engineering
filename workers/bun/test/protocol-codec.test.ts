import { describe, expect, test } from "bun:test";
import {
  decodeExecuteAction,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import { action } from "./support.ts";

describe("Worker Protocol v6 ResolvedExecution codec", () => {
  test("requires and preserves separated semantic instructions", () => {
    const input = action({
      instruction: "Inspect inputs.\nProduce the result.",
    });
    expect(decodeExecuteAction(input, "worker-test").instruction).toBe(
      input.execution.work.step_instruction,
    );
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: { ...input.execution.work, step_instruction: "" },
          },
        },
        "worker-test",
      ),
    ).toThrow(ProtocolDecodeError);
  });

  test("decodes normalized operational retry attribution without changing semantic context", () => {
    const input = action();
    const decoded = decodeExecuteAction(
      {
        ...input,
        operational_recovery: {
          epoch_number: 1,
          attempt_in_epoch: 1,
          attempt_allowance: 2,
          authorization_kind: "human",
          continuation_mode: "retained",
          retained_lineage_id: "lineage-retained",
          source_attempt_id: "attempt-1",
          request_id: "request-1",
        },
      },
      input.worker_id,
    );
    expect(decoded.operational_recovery).toMatchObject({
      epoch_number: 1,
      attempt_in_epoch: 1,
      continuation_mode: "retained",
    });
    expect(decoded.execution.context).toEqual(input.execution.context);
  });

  test("preserves document provenance and exact acceptance contract", () => {
    const input = action();
    const decoded = decodeExecuteAction(
      {
        ...input,
        execution: {
          ...input.execution,
          work: {
            ...input.execution.work,
            inputs: {
              quest_plan: {
                id: "plan-v2",
                kind: "quest_plan",
                output_name: "input",
                producer_occurrence_id: "revise-plan-1",
                value: { kind: "document", content: "# Plan" },
                version: 2,
                supersedes_artifact_id: "plan-v1",
                content_hash: "sha256:abc",
                media_type: "text/markdown",
                filename: "quest-plan.md",
                title: "Quest Plan",
              },
            },
            declared_outputs: [{ name: "verdict", kind: "review_verdict" }],
            acceptance_contract: {
              output: "verdict",
              gate_key: "plan_acceptance",
              subject_kind: "quest_plan",
              subject_artifact_id: "plan-v2",
            },
          },
        },
      },
      input.worker_id,
    );

    expect(decoded.execution.work.inputs.quest_plan?.version).toBe(2);
    expect(decoded.execution.work.acceptance_contract).toEqual({
      output: "verdict",
      gate_key: "plan_acceptance",
      subject_kind: "quest_plan",
      subject_artifact_id: "plan-v2",
    });
  });

  test("rejects protocol v2", () => {
    expect(() =>
      decodeExecuteAction({ ...action(), protocol_version: 2 }, "worker-test"),
    ).toThrow("protocol_version");
  });

  test("validates artifact values and unique declared outputs", () => {
    const input = action();
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: {
              ...input.execution.work,
              declared_outputs: [
                { name: "x", kind: "result" },
                { name: "x", kind: "result" },
              ],
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("unique output names");
    expect(() =>
      decodeExecuteAction(
        {
          ...input,
          execution: {
            ...input.execution,
            work: {
              ...input.execution.work,
              inputs: {
                bad: {
                  id: "a",
                  kind: "bad",
                  output_name: "input",
                  producer_occurrence_id: "o",
                  value: Number.NaN,
                },
              },
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("JSON-compatible");
  });
});
