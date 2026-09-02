import type { ExecutionOption, Workspace } from "../api/contracts";

export interface StarterChoice {
  option: ExecutionOption;
  workspace: Workspace;
}

export function starterChoice(
  workspaces: Workspace[],
  options: ExecutionOption[],
): StarterChoice | null {
  for (const workspace of workspaces) {
    if (workspace.binding.state !== "ready") continue;
    const option = options.find((value) =>
      supportsStarter(value, workspace.id),
    );
    if (option) return { option, workspace };
  }
  return null;
}

export function supportsStarter(
  option: ExecutionOption,
  workspaceId: string,
): boolean {
  const workspace = option.workspaces.find(
    (value) => value.workspace_id === workspaceId,
  );
  return Boolean(
    option.available &&
      option.reasoning.length > 0 &&
      workspace?.workspace_access.includes("read_write") &&
      workspace.workspace_access.includes("read_only"),
  );
}
