import { expect, test } from "bun:test";
import type { ExecutionOption, Loadout } from "../../api/contracts";
import {
  applyExecutionOption,
  draftFromLoadout,
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
  tools: ["workspace.filesystem", "acme.special-tool"],
  tool_enforcement: "exact",
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
  reasoning_capability: {
    kind: "enumerated",
    values: ["low", "medium", "high"],
  },
  tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  tool_enforcement: "exact",
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
    modelRefKey({
      harness: "antigravity",
      provider: "shared",
      model: "same",
    }),
  );
});

test("an undiscovered custom ModelRef and capability round-trip losslessly", () => {
  const input = loadoutInputFromDraft(draftFromLoadout(custom));

  expect(input.model).toEqual(custom.model);
  expect(input.tools).toEqual(custom.tools);
  expect(input.workspace_access).toBe("read_write");
  expect(input).not.toHaveProperty("instructions");
});

test("editing identity only does not normalize or delete custom configuration", () => {
  const draft = { ...draftFromLoadout(custom), name: "Renamed Custom Coding" };
  const input = loadoutInputFromDraft(draft);

  expect(input.name).toBe("Renamed Custom Coding");
  expect(input.model).toEqual(custom.model);
  expect(input.tools).toEqual(["workspace.filesystem", "acme.special-tool"]);
});

test("a known execution option populates ordinary Product fields only", () => {
  const populated = applyExecutionOption(
    { ...draftFromLoadout(custom), name: "Preset Coding" },
    option,
  );
  const input = loadoutInputFromDraft(populated);

  expect(input).toEqual({
    name: "Preset Coding",
    description: custom.description,
    harness: "pi",
    model: { provider: option.model.provider, model: option.model.model },
    reasoning: "medium",
    tools: [
      "workspace.filesystem",
      "workspace.search",
      "terminal.shell",
      "acme.special-tool",
    ],
    tool_enforcement: "exact",
    workspace_access: "read_write",
  });
  expect(input).not.toHaveProperty("preset_id");
  expect(input).not.toHaveProperty("execution_profile_id");
  expect(input).not.toHaveProperty("known_profile");
});

test("unsupported reasoning and native tool profile populate without fake values or subsets", () => {
  const native: ExecutionOption = {
    ...option,
    harness: "antigravity",
    reasoning_capability: { kind: "unsupported" },
    tool_enforcement: "native_permissions",
  };
  const populated = applyExecutionOption(draftFromLoadout(custom), native);
  const input = loadoutInputFromDraft(populated);

  expect(input.reasoning).toBeNull();
  expect(input.tools).toEqual(native.tools);
  expect(input.tool_enforcement).toBe("native_permissions");
  expect(input.tools).not.toContain("acme.special-tool");
});

test("applying a preset preserves custom capability IDs explicitly", () => {
  const populated = applyExecutionOption(draftFromLoadout(custom), option);

  expect({
    harness: populated.harness,
    provider: populated.provider,
    model: populated.model,
  }).toEqual({
    harness: option.harness,
    provider: option.model.provider,
    model: option.model.model,
  });
  expect(populated.tools).toContain("acme.special-tool");
});
