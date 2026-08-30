import type { WorkerConfig } from "./config.ts";
import type {
  ExecuteAction,
  ExecutorCapability,
  WorkerCapabilities,
} from "./protocol/types.ts";

const QE_TOOLS = [
  "workspace.filesystem",
  "workspace.search",
  "terminal.shell",
] as const;

export function executorCapabilities(config: WorkerConfig): ExecutorCapability {
  return {
    adapter: config.provider,
    models:
      config.executorModels ??
      (config.piModel
        ? [splitModel(config.piModel)]
        : [{ provider: config.provider, model: "test" }]),
    reasoning: config.reasoningLevels ?? ["low", "medium", "high"],
    tools: [...QE_TOOLS],
  };
}

export function workerCapabilities(
  config: WorkerConfig,
  os: string,
  arch: string,
): WorkerCapabilities {
  return {
    os,
    arch,
    max_concurrency: config.maxConcurrency,
    tags: config.tags,
    executors: [executorCapabilities(config)],
    features: [
      "run_delivery_v1",
      "run_worktree_retention_v1",
      "run_worktree_cleanup_v1",
      "workspace_binding_status_v1",
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
        executor.models.some(
          (model) =>
            model.provider === requested.model.provider &&
            model.model === requested.model.model,
        ) &&
        executor.reasoning.includes(requested.reasoning) &&
        requested.tools.every((tool) => executor.tools.includes(tool)) &&
        adapterCombinationSupported(executor.adapter, action),
    );
  if (!compatible)
    throw new Error(
      "Resolved execution is not supported by advertised capabilities and binding policy.",
    );
}

function adapterCombinationSupported(
  adapter: string,
  action: ExecuteAction,
): boolean {
  if (adapter !== "pi") return true;
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
