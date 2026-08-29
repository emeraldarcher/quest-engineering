import { describe, expect, test } from "bun:test";
import {
  decodeExecuteAction,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import { action } from "./support.ts";

describe("Worker Protocol v3 ResolvedExecution codec", () => {
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
