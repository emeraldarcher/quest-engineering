import { describe, expect, test } from "bun:test";
import {
  decodeExecuteAction,
  ProtocolDecodeError,
} from "../src/protocol/codec.ts";
import { action } from "./support.ts";

describe("Worker Protocol v2 Action codec", () => {
  test("requires and preserves the provider-neutral instruction", () => {
    const input = action({
      instruction: "Inspect inputs.\nProduce the result.",
    });
    expect(decodeExecuteAction(input, "worker-test").instruction).toBe(
      input.instruction,
    );
    expect(() =>
      decodeExecuteAction({ ...input, instruction: "  " }, "worker-test"),
    ).toThrow(ProtocolDecodeError);
  });

  test("rejects protocol v1", () => {
    expect(() =>
      decodeExecuteAction({ ...action(), protocol_version: 1 }, "worker-test"),
    ).toThrow("protocol_version");
  });

  test("validates artifact values and unique declared outputs", () => {
    expect(() =>
      decodeExecuteAction(
        { ...action(), declared_outputs: ["x", "x"] },
        "worker-test",
      ),
    ).toThrow("duplicates");
    expect(() =>
      decodeExecuteAction(
        {
          ...action(),
          inputs: {
            bad: {
              id: "a",
              type: "bad",
              producer_occurrence_id: "o",
              value: Number.NaN,
            },
          },
        },
        "worker-test",
      ),
    ).toThrow("JSON-compatible");
  });
});
