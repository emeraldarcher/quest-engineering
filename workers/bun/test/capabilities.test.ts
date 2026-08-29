import { expect, test } from "bun:test";
import { assertExecutionSupported } from "../src/capabilities.ts";
import type { WorkerCapabilities } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const capabilities: WorkerCapabilities = {
  os: "test",
  arch: "test",
  max_concurrency: 1,
  tags: [],
  executors: [
    {
      adapter: "not-pi",
      models: [{ provider: "fake", model: "test" }],
      reasoning: ["medium"],
      tools: ["workspace.filesystem"],
    },
  ],
  workspace_bindings: [
    {
      binding_id: "00000000-0000-4000-8000-000000000003",
      workspace_id: "00000000-0000-4000-8000-000000000001",
      authorized_root_key: "test",
      source_repository_root: process.cwd(),
      max_access: "read_write",
      allow_unconfined_shell: true,
    },
  ],
};

test("compatibility is executor-generic and exact across resolved dimensions", () => {
  expect(() => assertExecutionSupported(action(), capabilities)).not.toThrow();

  const unsupported = action();
  unsupported.execution.configuration.tools = ["custom.unsupported"];
  expect(() => assertExecutionSupported(unsupported, capabilities)).toThrow(
    "not supported",
  );

  const wrongModel = action();
  wrongModel.execution.configuration.model = {
    provider: "other",
    model: "test",
  };
  expect(() => assertExecutionSupported(wrongModel, capabilities)).toThrow(
    "not supported",
  );
});
