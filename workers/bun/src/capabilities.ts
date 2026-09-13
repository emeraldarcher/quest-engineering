import type { WorkerConfig } from "./config.ts";
import type { HarnessDiscovery } from "./harnesses/types.ts";
import type {
  ExecuteAction,
  ExecutorCapability,
  WorkerCapabilities,
} from "./protocol/types.ts";

export const QE_TOOL_CAPABILITIES = [
  "workspace.filesystem",
  "workspace.search",
  "terminal.shell",
] as const;

export function executorCapabilities(config: WorkerConfig): ExecutorCapability {
  const reasoning = config.reasoningLevels ?? ["low", "medium", "high"];
  return {
    harness_kind: config.provider,
    models: (
      config.executorModels ??
      (config.piModel
        ? [splitModel(config.piModel)]
        : [{ provider: config.provider, model: "test" }])
    ).map((model) => ({
      ...model,
      display_name: `${model.provider}/${model.model}`,
      reasoning_capability: { kind: "enumerated", values: reasoning },
    })),
    tools: [...QE_TOOL_CAPABILITIES],
    tool_enforcement: "exact",
  };
}

export function discoveredExecutorCapabilities(
  discoveries: HarnessDiscovery[],
): ExecutorCapability[] {
  return discoveries
    .filter(
      (discovery) =>
        discovery.integration.status === "ready" &&
        discovery.capabilities.structuredResult &&
        discovery.models.length > 0,
    )
    .map((discovery) => ({
      harness_kind: discovery.kind,
      models: discovery.models
        .filter(
          (
            model,
          ): model is typeof model & {
            reasoningCapability: Exclude<
              typeof model.reasoningCapability,
              { kind: "unknown" }
            >;
          } => model.reasoningCapability.kind !== "unknown",
        )
        .map((model) => ({
          provider: model.provider,
          model: model.model,
          display_name: model.displayName,
          reasoning_capability: model.reasoningCapability,
        })),
      tools: [...QE_TOOL_CAPABILITIES],
      tool_enforcement:
        discovery.kind === "antigravity"
          ? ("native_permissions" as const)
          : ("exact" as const),
    }))
    .filter((executor) => executor.models.length > 0);
}

export function workerCapabilities(
  config: WorkerConfig,
  os: string,
  arch: string,
  discoveries?: HarnessDiscovery[],
): WorkerCapabilities {
  return {
    os,
    arch,
    max_concurrency: config.maxConcurrency,
    tags: config.tags,
    executors: discoveries
      ? discoveredExecutorCapabilities(discoveries)
      : [executorCapabilities(config)],
    features: [
      "run_delivery_v1",
      "run_worktree_retention_v1",
      "run_worktree_cleanup_v1",
      "workspace_binding_status_v1",
      "live_execution_sessions_v1",
    ],
    workspace_bindings: config.workspaceBindings.map((binding) => ({
      ...binding,
    })),
  };
}

export function assertExecutionSupported(
  action: ExecuteAction,
  capabilities: WorkerCapabilities,
): void {
  const requested = action.execution.configuration;
  const workspace = action.execution.execution_workspace;
  const binding = capabilities.workspace_bindings.find(
    (item) =>
      item.binding_id === workspace.workspace_binding_id &&
      item.workspace_id === action.execution.logical_workspace.workspace_id,
  );
  const accessRank = { none: 0, read_only: 1, read_write: 2 } as const;
  const compatible =
    binding !== undefined &&
    accessRank[binding.max_access] >= accessRank[workspace.access] &&
    (!requested.tools.includes("terminal.shell") ||
      binding.allow_unconfined_shell) &&
    capabilities.executors.some(
      (executor) =>
        executor.harness_kind === requested.harness_kind &&
        executor.models.some(
          (model) =>
            model.provider === requested.model.provider &&
            model.model === requested.model.model &&
            reasoningSupported(model.reasoning_capability, requested.reasoning),
        ) &&
        toolSelectionSupported(
          executor.tool_enforcement,
          executor.tools,
          requested.tool_enforcement,
          requested.tools,
        ) &&
        harnessCombinationSupported(executor.harness_kind, action),
    );
  if (!compatible)
    throw new Error(
      "Resolved execution is not supported by advertised capabilities and binding policy.",
    );
}

function reasoningSupported(
  capability: ExecutorCapability["models"][number]["reasoning_capability"],
  requested: string | null,
): boolean {
  return capability.kind === "unsupported"
    ? requested === null
    : requested !== null && capability.values.includes(requested);
}

function toolSelectionSupported(
  advertisedEnforcement: ExecutorCapability["tool_enforcement"],
  advertisedTools: string[],
  requestedEnforcement: ExecutorCapability["tool_enforcement"],
  requestedTools: string[],
): boolean {
  if (advertisedEnforcement !== requestedEnforcement) return false;
  const available = new Set(advertisedTools);
  if (!requestedTools.every((tool) => available.has(tool))) return false;
  return (
    advertisedEnforcement === "exact" ||
    (requestedTools.length === available.size &&
      requestedTools.every((tool) => available.has(tool)))
  );
}

function harnessCombinationSupported(
  harnessKind: string,
  action: ExecuteAction,
): boolean {
  if (harnessKind !== "pi") return true;
  const requested = action.execution.configuration;
  const access = action.execution.execution_workspace.access;
  const workspaceTools = [
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ];
  return (
    !(requested.tools.includes("terminal.shell") && access !== "read_write") &&
    !(
      access === "none" &&
      requested.tools.some((tool) => workspaceTools.includes(tool))
    )
  );
}
function splitModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1)
    throw new Error("Pi model must use provider/model syntax.");
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}
