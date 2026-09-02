import { expect, test } from "bun:test";
import type { ExecutionOption, Workspace } from "../api/contracts";
import { starterChoice, supportsStarter } from "./starter-crew";

const workspace: Workspace = {
  id: "workspace-1",
  key: "project",
  name: "Project",
  source_kind: "local_git",
  source_fingerprint: null,
  binding: { state: "ready", message: "Ready." },
  archived_at: null,
};
const option: ExecutionOption = {
  model: { provider: "test", model: "starter" },
  reasoning: ["medium"],
  tools: ["workspace.filesystem"],
  workspaces: [
    {
      workspace_id: workspace.id,
      workspace_access: ["none", "read_only", "read_write"],
    },
  ],
  available: true,
};

test("starter choice pairs a ready Project with one currently usable configuration", () => {
  expect(starterChoice([workspace], [option])).toEqual({ workspace, option });
  expect(
    starterChoice(
      [
        {
          ...workspace,
          binding: { state: "preparing", message: "Preparing." },
        },
      ],
      [option],
    ),
  ).toBeNull();
});

test("starter compatibility requires both writable Builder and read-only Reviewer access", () => {
  expect(supportsStarter(option, workspace.id)).toBe(true);
  expect(
    supportsStarter(
      {
        ...option,
        workspaces: [
          { workspace_id: workspace.id, workspace_access: ["read_only"] },
        ],
      },
      workspace.id,
    ),
  ).toBe(false);
  expect(supportsStarter({ ...option, available: false }, workspace.id)).toBe(
    false,
  );
});
