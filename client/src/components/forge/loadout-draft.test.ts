import { expect, test } from "bun:test";
import type { ExecutionOption, Loadout } from "../../api/contracts";
import {
  applyExecutionOption,
  draftFromLoadout,
  emptyLoadoutDraft,
  loadoutInputFromDraft,
} from "./loadout-draft";
import { modelRefKey } from "./loadout-presentation";

const custom: Loadout = {
  id: "loadout-custom",
  key: "custom-coding",
  name: "Custom Coding",
  description: "Custom tools.",
  harness: "pi",
  model: { provider: "custom-provider", model: "custom-model-x" },
  reasoning: "high",
  tool_policy: {
    kind: "exact",
    tools: ["workspace.filesystem", "acme.special-tool"],
  },
  workspace_access: "read_write",
  archived_at: null,
};
const option: ExecutionOption = {
  harness: "pi",
  model: {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    display_name: "GPT 5.6 Sol",
  },
  account_availability: "verified_available",
  reasoning_capability: {
    kind: "enumerated",
    values: ["low", "medium", "high"],
  },
  tool_policy: { kind: "exact" },
  tool_enforcement: "exact",
  current_tool_profile: {
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  },
  workspaces: [
    {
      workspace_id: "workspace-1",
      workspace_access: ["none", "read_only", "read_write"],
    },
  ],
  available: true,
};

test("identical provider/model names remain distinct across harnesses", () => {
  expect(
    modelRefKey({ harness: "pi", provider: "shared", model: "same" }),
  ).not.toBe(
    modelRefKey({ harness: "antigravity", provider: "shared", model: "same" }),
  );
});

test("an undiscovered exact policy round-trips losslessly", () => {
  const input = loadoutInputFromDraft(draftFromLoadout(custom));
  expect(input.model).toEqual(custom.model);
  expect(input.tool_policy).toEqual(custom.tool_policy);
  expect(input).not.toHaveProperty("tool_enforcement");
});

test("a known exact option populates an authored exact policy", () => {
  const input = loadoutInputFromDraft(
    applyExecutionOption(
      { ...draftFromLoadout(custom), name: "Preset Coding" },
      option,
    ),
  );
  expect(input.reasoning).toBe("medium");
  expect(input.tool_policy).toEqual({
    kind: "exact",
    tools: [...option.current_tool_profile.tools, "acme.special-tool"],
  });
});

test("native policy stores no discovered catalog as authored intent", () => {
  const native: ExecutionOption = {
    ...option,
    harness: "antigravity",
    reasoning_capability: { kind: "unsupported" },
    tool_policy: { kind: "native_permissions" },
    tool_enforcement: "native_permissions",
    current_tool_profile: { tools: ["a", "b", "c"] },
  };
  const input = loadoutInputFromDraft(
    applyExecutionOption(draftFromLoadout(custom), native),
  );
  expect(input.reasoning).toBeNull();
  expect(input.tool_policy).toEqual({ kind: "native_permissions" });
  expect(input).not.toHaveProperty("tools");
  expect(input).not.toHaveProperty("tool_enforcement");
});

test("switching from native policy to Pi creates a valid exact draft", () => {
  const nativeLoadout: Loadout = {
    ...custom,
    harness: "antigravity",
    reasoning: null,
    tool_policy: { kind: "native_permissions" },
  };
  const populated = applyExecutionOption(
    draftFromLoadout(nativeLoadout),
    option,
  );
  expect(populated.toolPolicy).toEqual({
    kind: "exact",
    tools: option.current_tool_profile.tools,
  });
});

test("an unresolved draft cannot serialize as unsupported", () => {
  expect(emptyLoadoutDraft().reasoning).toBeUndefined();
  expect(() => loadoutInputFromDraft(emptyLoadoutDraft())).toThrow(
    "has not been resolved",
  );
});
