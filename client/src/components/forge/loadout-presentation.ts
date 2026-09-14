import type {
  ExecutionOption,
  Loadout,
  Reasoning,
  WorkspaceAccess,
} from "../../api/contracts";

export interface CapabilityPresentation {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export const knownCapabilities: CapabilityPresentation[] = [
  {
    id: "workspace.filesystem",
    name: "Project files",
    description: "Work with files in the Project.",
    icon: "▤",
  },
  {
    id: "workspace.search",
    name: "Project search",
    description: "Search files and content in the Project.",
    icon: "⌕",
  },
  {
    id: "terminal.shell",
    name: "Shell",
    description: "Run development commands.",
    icon: ">_",
  },
];

const capabilityById = new Map(
  knownCapabilities.map((capability) => [capability.id, capability]),
);

export function knownCapability(id: string): CapabilityPresentation | null {
  return capabilityById.get(id) ?? null;
}

export function isKnownCapability(id: string): boolean {
  return capabilityById.has(id);
}

export function reasoningLabel(reasoning: Reasoning | null): string {
  if (reasoning === null) return "Not configurable";
  return `${reasoning.charAt(0).toLocaleUpperCase()}${reasoning.slice(1)}`;
}

export function accessLabel(access: WorkspaceAccess): string {
  switch (access) {
    case "none":
      return "No access";
    case "read_only":
      return "Read only";
    case "read_write":
      return "Read & write";
  }
}

export function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    "openai-codex": "OpenAI Codex",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    fixture: "Fixture",
  };
  return known[provider] ?? titleIdentifier(provider);
}

export function modelLabel(model: string): string {
  return model
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ")
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bClaude\b/g, "Claude");
}

export function canonicalModel(loadout: Loadout): string {
  return `${loadout.harness} / ${loadout.model.provider} / ${loadout.model.model}`;
}

export function modelRefKey(model: {
  harness: string;
  provider: string;
  model: string;
}): string {
  return JSON.stringify([model.harness, model.provider, model.model]);
}

export function optionKey(option: ExecutionOption): string {
  return JSON.stringify({
    model: option.model,
    reasoning_capability: option.reasoning_capability,
    tool_policy: option.tool_policy,
    tool_enforcement: option.tool_enforcement,
    current_tool_profile: option.current_tool_profile,
    workspaces: option.workspaces,
    available: option.available,
  });
}

export function uniqueModelOptions(options: ExecutionOption[]): Array<{
  harness: string;
  provider: string;
  model: string;
  display_name: string;
}> {
  return Array.from(
    new Map(
      options.map((option) => {
        const value = { harness: option.harness, ...option.model };
        return [modelRefKey(value), value];
      }),
    ).values(),
  );
}

export function modelIsDiscovered(
  model: { harness: string; provider: string; model: string },
  options: ExecutionOption[],
): boolean {
  const key = modelRefKey(model);
  return options.some(
    (option) =>
      modelRefKey({ harness: option.harness, ...option.model }) === key,
  );
}

export function presetLabel(option: ExecutionOption): string {
  const reasoning =
    option.reasoning_capability.kind === "unsupported"
      ? "Effort not configurable"
      : option.reasoning_capability.values.map(reasoningLabel).join(" / ");
  const tools =
    option.tool_policy.kind === "exact"
      ? `${option.current_tool_profile.tools.length} ${option.current_tool_profile.tools.length === 1 ? "capability" : "capabilities"}`
      : "Native tool permissions";
  return `${option.harness} · ${option.model.display_name} · ${reasoning} · ${tools}`;
}

function titleIdentifier(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}
