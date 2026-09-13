import type { LoadoutInput } from "../../api/client";
import type {
  ExecutionOption,
  Loadout,
  Reasoning,
  ToolEnforcement,
  WorkspaceAccess,
} from "../../api/contracts";
import { isKnownCapability } from "./loadout-presentation";

export interface LoadoutDraft {
  name: string;
  description: string;
  harness: string;
  provider: string;
  model: string;
  reasoning: Reasoning | null;
  tools: string[];
  toolEnforcement: ToolEnforcement;
  workspaceAccess: WorkspaceAccess;
}

export function emptyLoadoutDraft(): LoadoutDraft {
  return {
    name: "",
    description: "",
    harness: "",
    provider: "",
    model: "",
    reasoning: "medium",
    tools: [],
    toolEnforcement: "exact",
    workspaceAccess: "read_write",
  };
}

export function draftFromLoadout(loadout: Loadout): LoadoutDraft {
  return {
    name: loadout.name,
    description: loadout.description,
    harness: loadout.harness,
    provider: loadout.model.provider,
    model: loadout.model.model,
    reasoning: loadout.reasoning,
    tools: [...loadout.tools],
    toolEnforcement: loadout.tool_enforcement,
    workspaceAccess: loadout.workspace_access,
  };
}

export function loadoutInputFromDraft(
  draft: LoadoutDraft,
): Omit<Required<LoadoutInput>, "key"> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    harness: draft.harness.trim(),
    model: { provider: draft.provider.trim(), model: draft.model.trim() },
    reasoning: draft.reasoning,
    tools: [...draft.tools],
    tool_enforcement: draft.toolEnforcement,
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
    harness: option.harness,
    provider: option.model.provider,
    model: option.model.model,
    reasoning: preferredReasoning(option),
    tools:
      option.tool_enforcement === "exact"
        ? unique([...option.tools, ...customCapabilities])
        : [...option.tools],
    toolEnforcement: option.tool_enforcement,
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

function preferredReasoning(option: ExecutionOption): Reasoning | null {
  if (option.reasoning_capability.kind === "unsupported") return null;
  const values = option.reasoning_capability.values;
  if (values.includes("medium")) return "medium";
  return values[0] as Reasoning;
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
