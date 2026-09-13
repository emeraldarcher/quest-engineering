import { expect, test } from "bun:test";
import {
  assertExecutionSupported,
  discoveredExecutorCapabilities,
} from "../src/capabilities.ts";
import type { WorkerCapabilities } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const capabilities: WorkerCapabilities = {
  os: "test",
  arch: "test",
  max_concurrency: 1,
  tags: [],
  executors: [
    {
      harness_kind: "fake",
      models: [
        {
          provider: "fake",
          model: "test",
          display_name: "Fake test",
          reasoning_capability: { kind: "enumerated", values: ["medium"] },
        },
      ],
      tools: ["workspace.filesystem"],
      tool_enforcement: "exact",
    },
    {
      harness_kind: "antigravity",
      models: [
        {
          provider: "antigravity",
          model: "no-effort",
          display_name: "No effort",
          reasoning_capability: { kind: "unsupported" },
        },
      ],
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
      tool_enforcement: "native_permissions",
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

test("live catalogs preserve reasoning capability and harness tool guarantees", () => {
  const executors = discoveredExecutorCapabilities([
    {
      kind: "pi",
      displayName: "Pi",
      strategy: "native_extension",
      integration: {
        status: "ready",
        detail: "ready",
        installed: true,
        authenticated: true,
      },
      models: [
        {
          provider: "shared",
          model: "same-name",
          displayName: "Pi model",
          reasoningCapability: { kind: "enumerated", values: ["xhigh"] },
        },
      ],
      capabilities: { structuredResult: true } as never,
    },
    {
      kind: "antigravity",
      displayName: "Antigravity",
      strategy: "hooks_plus_structured_tool",
      integration: {
        status: "ready",
        detail: "ready",
        installed: true,
        authenticated: true,
      },
      models: [
        {
          provider: "shared",
          model: "no-effort",
          displayName: "Antigravity model",
          reasoningCapability: { kind: "unsupported" },
        },
        {
          provider: "shared",
          model: "ambiguous",
          displayName: "Ambiguous model",
          reasoningCapability: { kind: "unknown", detail: "conflict" },
        },
      ],
      capabilities: { structuredResult: true } as never,
    },
  ]);
  expect(executors[0]?.models[0]?.reasoning_capability).toEqual({
    kind: "enumerated",
    values: ["xhigh"],
  });
  expect(executors[0]?.tool_enforcement).toBe("exact");
  expect(executors[1]?.models).toHaveLength(1);
  expect(executors[1]?.models[0]?.reasoning_capability).toEqual({
    kind: "unsupported",
  });
  expect(executors[1]?.tool_enforcement).toBe("native_permissions");
});

test("Pi exact selection accepts subsets while rejecting unavailable requirements", () => {
  expect(() => assertExecutionSupported(action(), capabilities)).not.toThrow();

  const unsupported = action();
  unsupported.execution.configuration.tools = ["custom.unsupported"];
  expect(() => assertExecutionSupported(unsupported, capabilities)).toThrow(
    "not supported",
  );
});

test("native-permissions profile requires exact profile identity and unsupported reasoning", () => {
  const request = action();
  request.execution.configuration = {
    harness_kind: "antigravity",
    model: { provider: "antigravity", model: "no-effort" },
    reasoning: null,
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    tool_enforcement: "native_permissions",
  };
  expect(() => assertExecutionSupported(request, capabilities)).not.toThrow();

  request.execution.configuration.tools = ["workspace.filesystem"];
  expect(() => assertExecutionSupported(request, capabilities)).toThrow(
    "not supported",
  );
  request.execution.configuration.tools = [
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ];
  request.execution.configuration.reasoning = "high";
  expect(() => assertExecutionSupported(request, capabilities)).toThrow(
    "not supported",
  );
});
