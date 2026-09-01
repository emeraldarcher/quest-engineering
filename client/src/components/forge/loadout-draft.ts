import type { LoadoutInput } from "../../api/client";
import type {
  ExecutionOption,
  Loadout,
  Reasoning,
  WorkspaceAccess,
} from "../../api/contracts";
import { isKnownCapability } from "./loadout-presentation";

export interface LoadoutDraft {
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoning: Reasoning;
  tools: string[];
  workspaceAccess: WorkspaceAccess;
}

export function emptyLoadoutDraft(): LoadoutDraft {
  return {
    name: "",
    description: "",
    provider: "",
    model: "",
    reasoning: "medium",
    tools: [],
    workspaceAccess: "read_write",
  };
}

export function draftFromLoadout(loadout: Loadout): LoadoutDraft {
  return {
    name: loadout.name,
    description: loadout.description,
    provider: loadout.model.provider,
    model: loadout.model.model,
    reasoning: loadout.reasoning,
    tools: [...loadout.tools],
    workspaceAccess: loadout.workspace_access,
  };
}

export function loadoutInputFromDraft(
  draft: LoadoutDraft,
): Omit<Required<LoadoutInput>, "key"> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    model: { provider: draft.provider.trim(), model: draft.model.trim() },
    reasoning: draft.reasoning,
    tools: [...draft.tools],
    workspace_access: draft.workspaceAccess,
  };
}

export function applyExecutionOption(
  draft: LoadoutDraft,
  option: ExecutionOption,
): LoadoutDraft {
  const customCapabilities = draft.tools.filter(
    (capability) => !isKnownCapability(capability),
  );
  return {
    ...draft,
    provider: option.model.provider,
    model: option.model.model,
    reasoning: preferredReasoning(option.reasoning),
    tools: unique([...option.tools, ...customCapabilities]),
    workspaceAccess: preferredAccess(option),
  };
}

export function replaceCustomCapabilities(
  draft: LoadoutDraft,
  customCapabilities: string[],
): LoadoutDraft {
  return {
    ...draft,
    tools: unique([
      ...draft.tools.filter((capability) => isKnownCapability(capability)),
      ...customCapabilities,
    ]),
  };
}

export function customCapabilities(draft: LoadoutDraft): string[] {
  return draft.tools.filter((capability) => !isKnownCapability(capability));
}

export function toggleKnownCapability(
  draft: LoadoutDraft,
  capability: string,
  enabled: boolean,
): LoadoutDraft {
  if (enabled) return { ...draft, tools: unique([...draft.tools, capability]) };
  return {
    ...draft,
    tools: draft.tools.filter((value) => value !== capability),
  };
}

function preferredReasoning(values: Reasoning[]): Reasoning {
  if (values.includes("medium")) return "medium";
  return values[0] ?? "medium";
}

function preferredAccess(option: ExecutionOption): WorkspaceAccess {
  const values = option.workspaces.flatMap(
    (workspace) => workspace.workspace_access,
  );
  if (values.includes("read_write")) return "read_write";
  if (values.includes("read_only")) return "read_only";
  return "none";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
