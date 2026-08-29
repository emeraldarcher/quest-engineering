import type { WorkerConfig } from "./config.ts";
import type {
  ExecuteAction,
  ExecutorCapability,
  WorkerCapabilities,
  WorkspaceAccess,
} from "./protocol/types.ts";

const QE_TOOLS = [
  "workspace.filesystem",
  "workspace.search",
  "terminal.shell",
] as const;
const ACCESS: Record<WorkspaceAccess, number> = {
  none: 0,
  read_only: 1,
  read_write: 2,
};

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
    workspaces: [
      {
        ref: config.workspaceRef ?? "workspace:test",
        root: config.workspaceRoot,
        max_access: config.workspaceMaxAccess ?? "read_write",
      },
    ],
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
  };
}

export function assertExecutionSupported(
  action: ExecuteAction,
  capabilities: WorkerCapabilities,
): void {
  const requested = action.execution.configuration;
  const compatible = capabilities.executors.some(
    (executor) =>
      executor.models.some(
        (model) =>
          model.provider === requested.model.provider &&
          model.model === requested.model.model,
      ) &&
      executor.reasoning.includes(requested.reasoning) &&
      requested.tools.every((tool) => executor.tools.includes(tool)) &&
      executor.workspaces.some(
        (workspace) =>
          workspace.ref === requested.workspace.ref &&
          workspace.root === requested.workspace.root &&
          ACCESS[workspace.max_access] >= ACCESS[requested.workspace.access],
      ) &&
      adapterCombinationSupported(executor.adapter, action),
  );
  if (!compatible)
    throw new Error(
      "Resolved execution is not supported by advertised capabilities.",
    );
}

function adapterCombinationSupported(
  adapter: string,
  action: ExecuteAction,
): boolean {
  if (adapter !== "pi") return true;
  const requested = action.execution.configuration;
  const workspaceTools = [
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ];
  return (
    !(
      requested.tools.includes("terminal.shell") &&
      requested.workspace.access !== "read_write"
    ) &&
    !(
      requested.workspace.access === "none" &&
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
