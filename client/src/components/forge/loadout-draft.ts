import type { LoadoutInput } from "../../api/client";
import type {
  ExecutionOption,
  Loadout,
  Reasoning,
  ToolPolicy,
  WorkspaceAccess,
} from "../../api/contracts";
import { isKnownCapability } from "./loadout-presentation";

export interface LoadoutDraft {
  name: string;
  description: string;
  harness: string;
  provider: string;
  model: string;
  reasoning: Reasoning | null | undefined;
  toolPolicy: ToolPolicy;
  workspaceAccess: WorkspaceAccess;
}

export function emptyLoadoutDraft(): LoadoutDraft {
  return {
    name: "",
    description: "",
    harness: "",
    provider: "",
    model: "",
    reasoning: undefined,
    toolPolicy: { kind: "exact", tools: [] },
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
    toolPolicy:
      loadout.tool_policy.kind === "exact"
        ? { kind: "exact", tools: [...loadout.tool_policy.tools] }
        : { kind: "native_permissions" },
    workspaceAccess: loadout.workspace_access,
  };
}

export function loadoutInputFromDraft(
  draft: LoadoutDraft,
): Omit<Required<LoadoutInput>, "key"> {
  if (draft.reasoning === undefined)
    throw new Error("Reasoning capability has not been resolved.");
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    harness: draft.harness.trim(),
    model: { provider: draft.provider.trim(), model: draft.model.trim() },
    reasoning: draft.reasoning,
    tool_policy:
      draft.toolPolicy.kind === "exact"
        ? { kind: "exact", tools: [...draft.toolPolicy.tools] }
        : { kind: "native_permissions" },
    workspace_access: draft.workspaceAccess,
  };
}

export function applyExecutionOption(
  draft: LoadoutDraft,
  option: ExecutionOption,
): LoadoutDraft {
  const customCapabilities = customCapabilitiesForPolicy(draft.toolPolicy);
  return {
    ...draft,
    harness: option.harness,
    provider: option.model.provider,
    model: option.model.model,
    reasoning: preferredReasoning(option),
    toolPolicy:
      option.tool_policy.kind === "exact"
        ? {
            kind: "exact",
            tools: unique([
              ...option.current_tool_profile.tools,
              ...customCapabilities,
            ]),
          }
        : { kind: "native_permissions" },
    workspaceAccess: preferredAccess(option),
  };
}

export function replaceCustomCapabilities(
  draft: LoadoutDraft,
  customCapabilities: string[],
): LoadoutDraft {
  if (draft.toolPolicy.kind !== "exact") return draft;
  return {
    ...draft,
    toolPolicy: {
      kind: "exact",
      tools: unique([
        ...draft.toolPolicy.tools.filter((capability) =>
          isKnownCapability(capability),
        ),
        ...customCapabilities,
      ]),
    },
  };
}

export function customCapabilities(draft: LoadoutDraft): string[] {
  return customCapabilitiesForPolicy(draft.toolPolicy);
}

export function toggleKnownCapability(
  draft: LoadoutDraft,
  capability: string,
  enabled: boolean,
): LoadoutDraft {
  if (draft.toolPolicy.kind !== "exact") return draft;
  const tools = enabled
    ? unique([...draft.toolPolicy.tools, capability])
    : draft.toolPolicy.tools.filter((value) => value !== capability);
  return { ...draft, toolPolicy: { kind: "exact", tools } };
}

function customCapabilitiesForPolicy(policy: ToolPolicy): string[] {
  return policy.kind === "exact"
    ? policy.tools.filter((capability) => !isKnownCapability(capability))
    : [];
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
