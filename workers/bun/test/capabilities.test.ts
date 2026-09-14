import { expect, test } from "bun:test";
import {
  assertExecutionSupported,
  discoveredExecutorCapabilities,
} from "../src/capabilities.ts";
import type { WorkerCapabilities } from "../src/protocol/types.ts";
import { action } from "./support.ts";

function capabilities(
  qeCapabilities = ["workspace.filesystem", "workspace.search"],
): WorkerCapabilities {
  return {
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
        supported_tool_policies: ["exact"],
        tool_enforcement: "exact",
        tool_profile: { tools: ["workspace.filesystem"] },
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
        supported_tool_policies: ["native_permissions"],
        tool_enforcement: "native_permissions",
        tool_profile: { tools: qeCapabilities },
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
}

test("capabilities advertise model reasoning and supported tool policies", () => {
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
          model: "same",
          displayName: "Pi",
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
          model: "none",
          displayName: "None",
          reasoningCapability: { kind: "unsupported" },
        },
        {
          provider: "shared",
          model: "bad",
          displayName: "Bad",
          reasoningCapability: { kind: "unknown", detail: "conflict" },
        },
      ],
      capabilities: { structuredResult: true } as never,
    },
  ]);
  expect(executors[0]?.supported_tool_policies).toEqual(["exact"]);
  expect(executors[1]?.supported_tool_policies).toEqual(["native_permissions"]);
  expect(executors[1]?.models).toHaveLength(1);
});

test("Pi exact policy is enforced and cannot resolve as native permissions", () => {
  expect(() =>
    assertExecutionSupported(action(), capabilities()),
  ).not.toThrow();
  const invalid = action();
  invalid.execution.configuration.tool_policy = { kind: "native_permissions" };
  invalid.execution.configuration.tool_enforcement = "native_permissions";
  expect(() => assertExecutionSupported(invalid, capabilities())).toThrow(
    "not supported",
  );
});

test("native policy remains valid across adapter capability-profile changes with frozen provenance", () => {
  const request = action();
  request.execution.configuration = {
    harness_kind: "antigravity",
    model: { provider: "antigravity", model: "no-effort" },
    reasoning: null,
    reasoning_capability: { kind: "unsupported" },
    tool_policy: { kind: "native_permissions" },
    tool_enforcement: "native_permissions",
    resolved_tool_profile: {
      tools: ["workspace.filesystem", "workspace.search"],
    },
  };
  expect(() => assertExecutionSupported(request, capabilities())).not.toThrow();
  const runAProfile = structuredClone(
    request.execution.configuration.resolved_tool_profile,
  );

  const expanded = capabilities([
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ]);
  request.execution.configuration.resolved_tool_profile = {
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  };
  expect(() => assertExecutionSupported(request, expanded)).not.toThrow();
  expect(request.execution.configuration.tool_policy).toEqual({
    kind: "native_permissions",
  });
  expect(runAProfile.tools).toEqual([
    "workspace.filesystem",
    "workspace.search",
  ]);

  const contracted = capabilities(["workspace.filesystem"]);
  request.execution.configuration.resolved_tool_profile = {
    tools: ["workspace.filesystem"],
  };
  expect(() => assertExecutionSupported(request, contracted)).not.toThrow();
  expect(request.execution.configuration.tool_policy).toEqual({
    kind: "native_permissions",
  });
});

test("enumerated catalog changes invalidate only unavailable selected values", () => {
  const changed = capabilities();
  const model = changed.executors[0]?.models[0];
  if (!model) throw new Error("missing fixture model");
  model.reasoning_capability = { kind: "enumerated", values: ["high"] };
  const request = action();
  expect(() => assertExecutionSupported(request, changed)).toThrow(
    "not supported",
  );

  request.execution.configuration.reasoning = "high";
  request.execution.configuration.reasoning_capability = {
    kind: "enumerated",
    values: ["high"],
  };
  expect(() => assertExecutionSupported(request, changed)).not.toThrow();
});

test("resolved reasoning null requires frozen unsupported capability evidence", () => {
  const request = action();
  request.execution.configuration.reasoning = null;
  expect(() => assertExecutionSupported(request, capabilities())).toThrow(
    "not supported",
  );
  request.execution.configuration.reasoning_capability = {
    kind: "unsupported",
  };
  expect(() => assertExecutionSupported(request, capabilities())).toThrow(
    "not supported",
  );
});
