import type { WorkerConfig } from "./config.ts";
import { SBX_CODING_EXECUTION_PROFILE_V1 } from "./execution-environment/sbx-profile.ts";
import type { HarnessDiscovery } from "./harnesses/types.ts";
import type {
  ExecuteAction,
  ExecutorCapability,
  ExecutorExecutionEnvironment,
  WorkerCapabilities,
} from "./protocol/types.ts";

// Harness-neutral QE semantic capability IDs advertised by each adapter. This
// is not a forensic inventory of every tool internal to a native harness.
export const QE_TOOL_CAPABILITIES = [
  "workspace.filesystem",
  "workspace.search",
  "terminal.shell",
] as const;

export const SBX_EXECUTOR_EXECUTION_ENVIRONMENT: ExecutorExecutionEnvironment =
  {
    backend_kind: "sbx",
    profile: { ...SBX_CODING_EXECUTION_PROFILE_V1 },
    capabilities: [
      { kind: "filesystem_namespace", mode: "isolated" },
      { kind: "host_filesystem", mode: "unexposed" },
      { kind: "environment_exec", mode: "available" },
      { kind: "pty_launcher", mode: "available" },
    ],
  };

export function executorCapabilities(
  config: WorkerConfig,
  executionEnvironment?: ExecutorExecutionEnvironment,
): ExecutorCapability {
  const reasoning = config.reasoningLevels ?? ["low", "medium", "high"];
  return {
    harness_kind: config.provider,
    ...(executionEnvironment
      ? {
          execution_environment:
            cloneExecutionEnvironment(executionEnvironment),
        }
      : {}),
    models: (
      config.executorModels ??
      (config.piModel
        ? [splitModel(config.piModel)]
        : config.provider === "fake"
          ? [{ provider: "fake", model: "test" }]
          : [])
    ).map((model) => ({
      ...model,
      display_name: `${model.provider}/${model.model}`,
      account_availability: "verified_available" as const,
      reasoning_capability: { kind: "enumerated", values: reasoning },
    })),
    supported_tool_policies: ["exact"],
    tool_enforcement: "exact",
    tool_profile: { tools: [...QE_TOOL_CAPABILITIES] },
  };
}

export function discoveredExecutorCapabilities(
  discoveries: HarnessDiscovery[],
  executionEnvironment?: ExecutorExecutionEnvironment,
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
      ...(executionEnvironment
        ? {
            execution_environment:
              cloneExecutionEnvironment(executionEnvironment),
          }
        : {}),
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
          account_availability: model.accountAvailability,
          reasoning_capability: model.reasoningCapability,
        })),
      supported_tool_policies:
        discovery.kind === "antigravity"
          ? ["native_permissions" as const]
          : ["exact" as const],
      tool_enforcement:
        discovery.kind === "antigravity"
          ? ("native_permissions" as const)
          : ("exact" as const),
      tool_profile: { tools: [...QE_TOOL_CAPABILITIES] },
    }))
    .filter((executor) => executor.models.length > 0);
}

export function workerCapabilities(
  config: WorkerConfig,
  os: string,
  arch: string,
  discoveries?: HarnessDiscovery[],
): WorkerCapabilities {
  const executionEnvironment =
    config.provider === "fake" ? undefined : SBX_EXECUTOR_EXECUTION_ENVIRONMENT;
  return {
    os,
    arch,
    max_concurrency: config.maxConcurrency,
    dispatch_availability: config.dispatchAvailability ?? "active",
    tags: config.tags,
    executors: discoveries
      ? discoveredExecutorCapabilities(discoveries, executionEnvironment)
      : [executorCapabilities(config, executionEnvironment)],
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
    capabilities.executors.some(
      (executor) =>
        executor.harness_kind === requested.harness_kind &&
        (!requested.resolved_tool_profile.tools.includes("terminal.shell") ||
          terminalShellAuthorized(executor, binding)) &&
        executor.models.some(
          (model) =>
            model.provider === requested.model.provider &&
            model.model === requested.model.model &&
            model.account_availability !== "verified_unavailable" &&
            reasoningSupported(
              model.reasoning_capability,
              requested.reasoning,
            ) &&
            reasoningCapabilityEqual(
              model.reasoning_capability,
              requested.reasoning_capability,
            ),
        ) &&
        toolSelectionSupported(executor, requested) &&
        harnessCombinationSupported(executor.harness_kind, action),
    );
  if (!compatible)
    throw new Error(
      "Resolved execution is not supported by advertised capabilities and binding policy.",
    );
}

export function terminalShellAuthorized(
  executor: ExecutorCapability,
  binding: WorkerCapabilities["workspace_bindings"][number],
): boolean {
  const environment = executor.execution_environment;
  // Protocol-v8 Workers did not advertise an execution environment. Preserve
  // their explicit host-root grant while new Workers publish scoped authority.
  if (!environment) return binding.allow_unconfined_shell;
  if (environment.backend_kind === "host_native")
    return binding.allow_unconfined_shell;
  if (environment.backend_kind !== "sbx") return false;
  return [
    ["filesystem_namespace", "isolated"],
    ["host_filesystem", "unexposed"],
    ["environment_exec", "available"],
    ["pty_launcher", "available"],
  ].every(([kind, mode]) =>
    environment.capabilities.some(
      (capability) => capability.kind === kind && capability.mode === mode,
    ),
  );
}

function cloneExecutionEnvironment(
  environment: ExecutorExecutionEnvironment,
): ExecutorExecutionEnvironment {
  return {
    backend_kind: environment.backend_kind,
    profile: { ...environment.profile },
    capabilities: environment.capabilities.map((capability) => ({
      ...capability,
    })),
  };
}

function reasoningSupported(
  capability: ExecutorCapability["models"][number]["reasoning_capability"],
  requested: string | null,
): boolean {
  return capability.kind === "unsupported"
    ? requested === null
    : requested !== null && capability.values.includes(requested);
}

function reasoningCapabilityEqual(
  left: ExecutorCapability["models"][number]["reasoning_capability"],
  right: ExecutorCapability["models"][number]["reasoning_capability"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toolSelectionSupported(
  executor: ExecutorCapability,
  requested: ExecuteAction["execution"]["configuration"],
): boolean {
  if (
    !executor.supported_tool_policies.includes(requested.tool_policy.kind) ||
    executor.tool_enforcement !== requested.tool_enforcement
  )
    return false;
  const available = executor.tool_profile.tools;
  if (requested.tool_policy.kind === "exact")
    return (
      requested.tool_enforcement === "exact" &&
      requested.tool_policy.tools.every((tool) => available.includes(tool)) &&
      sameStringSet(
        requested.resolved_tool_profile.tools,
        requested.tool_policy.tools,
      )
    );
  return (
    requested.tool_enforcement === "native_permissions" &&
    sameStringSet(requested.resolved_tool_profile.tools, available)
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function harnessCombinationSupported(
  harnessKind: string,
  action: ExecuteAction,
): boolean {
  if (harnessKind !== "pi") return true;
  const requested = action.execution.configuration;
  const access = action.execution.execution_workspace.access;
  const tools =
    requested.tool_policy.kind === "exact" ? requested.tool_policy.tools : [];
  const workspaceTools = [
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ];
  return (
    !(tools.includes("terminal.shell") && access !== "read_write") &&
    !(access === "none" && tools.some((tool) => workspaceTools.includes(tool)))
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
