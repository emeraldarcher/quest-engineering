import { describe, expect, test } from "bun:test";
import {
  decodeCancelDispatch,
  decodeExecuteAction,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import type { CancelDispatch } from "../src/protocol/types.ts";
import { action } from "./support.ts";

describe("Worker Protocol v9 ResolvedExecution codec", () => {
  test("decodes only an exact Worker-generation cancellation command", () => {
    const command = {
      type: "cancel_dispatch",
      protocol_version: 9,
      worker_id: "worker-test",
      connection_generation: 7,
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      cancellation: {
        request_id: "cancel-1",
        origin: "product_operator",
        reason: null,
        requested_at: "2026-09-17T12:00:00Z",
      },
    } satisfies CancelDispatch;

    expect(decodeCancelDispatch(command, "worker-test", 7)).toEqual(command);
    expect(() =>
      decodeCancelDispatch(
        { ...command, connection_generation: 6 },
        "worker-test",
        7,
      ),
    ).toThrow(ProtocolDecodeError);
    expect(() =>
      decodeCancelDispatch({ ...command, attempt_id: "" }, "worker-test", 7),
    ).toThrow(ProtocolDecodeError);
  });

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

  test("preserves unsupported reasoning and explicit tool enforcement", () => {
    const input = action();
    input.execution.configuration.reasoning = null;
    input.execution.configuration.reasoning_capability = {
      kind: "unsupported",
    };
    input.execution.configuration.tool_policy = { kind: "native_permissions" };
    input.execution.configuration.tool_enforcement = "native_permissions";
    const decoded = decodeExecuteAction(input, input.worker_id);

    expect(decoded.execution.configuration.reasoning).toBeNull();
    expect(decoded.execution.configuration.tool_enforcement).toBe(
      "native_permissions",
    );
  });

  test("rejects null without unsupported evidence and malformed capability evidence", () => {
    const enumeratedNull = action();
    enumeratedNull.execution.configuration.reasoning = null;
    expect(() =>
      decodeExecuteAction(enumeratedNull, enumeratedNull.worker_id),
    ).toThrow("must exactly match");

    const unsupportedValue = action();
    unsupportedValue.execution.configuration.reasoning_capability = {
      kind: "unsupported",
    };
    expect(() =>
      decodeExecuteAction(unsupportedValue, unsupportedValue.worker_id),
    ).toThrow("must exactly match");

    const unknown = action() as unknown as Record<string, unknown>;
    const execution = unknown.execution as Record<string, unknown>;
    const configuration = execution.configuration as Record<string, unknown>;
    configuration.reasoning = null;
    configuration.reasoning_capability = { kind: "unknown" };
    expect(() => decodeExecuteAction(unknown, "worker-test")).toThrow(
      "invalid reasoning capability",
    );
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
