import { expect, test } from "bun:test";
import type { ExecutionOption, Loadout } from "../../api/contracts";
import {
  applyExecutionOption,
  draftFromLoadout,
  loadoutInputFromDraft,
} from "./loadout-draft";

const custom: Loadout = {
  id: "loadout-custom",
  key: "custom-coding",
  name: "Custom Coding",
  description: "Custom tools.",
  model: { provider: "custom-provider", model: "custom-model-x" },
  reasoning: "high",
  tools: ["workspace.filesystem", "acme.special-tool"],
  workspace_access: "read_write",
  archived_at: null,
};
const option: ExecutionOption = {
  model: { provider: "openai-codex", model: "gpt-5.6-sol" },
  reasoning: ["low", "medium", "high"],
  tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  workspaces: [
    {
      workspace_id: "workspace-1",
      workspace_access: ["none", "read_only", "read_write"],
    },
  ],
  available: true,
};

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
    model: option.model,
    reasoning: "medium",
    tools: [
      "workspace.filesystem",
      "workspace.search",
      "terminal.shell",
      "acme.special-tool",
    ],
    workspace_access: "read_write",
  });
  expect(input).not.toHaveProperty("preset_id");
  expect(input).not.toHaveProperty("execution_profile_id");
  expect(input).not.toHaveProperty("known_profile");
});

test("applying a preset preserves custom capability IDs explicitly", () => {
  const populated = applyExecutionOption(draftFromLoadout(custom), option);

  expect({ provider: populated.provider, model: populated.model }).toEqual(
    option.model,
  );
  expect(populated.tools).toContain("acme.special-tool");
});
