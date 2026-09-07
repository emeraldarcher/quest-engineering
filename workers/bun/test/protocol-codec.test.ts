import { describe, expect, test } from "bun:test";
import {
  decodeExecuteAction,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import { action } from "./support.ts";

describe("Worker Protocol v5 ResolvedExecution codec", () => {
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
              declared_outputs: ["x", "x"],
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("duplicates");
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
                  type: "bad",
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
