import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerConfig, WorkspaceBindingConfig } from "../config.ts";
import type { WorkerCapabilities } from "../protocol/types.ts";

export type BindingReconciliationStatus =
  | "accepted"
  | "stale_workspace"
  | "conflict"
  | "rejected";

export interface BindingReconciliationOutcome {
  binding_id: string;
  workspace_id: string;
  status: BindingReconciliationStatus;
  code?: string;
}

export interface BindingReconciliationSummary {
  active: number;
  retired: number;
  fencedConfigured: number;
}

export function applyBindingReconciliation(
  config: WorkerConfig,
  capabilities: WorkerCapabilities,
  value: unknown,
): BindingReconciliationSummary {
  const outcomes = decodeOutcomes(value);
  const configuredIds = new Set(config.configuredWorkspaceBindingIds ?? []);
  const retire = new Map<string, BindingReconciliationOutcome>();

  for (const outcome of outcomes) {
    if (outcome.status !== "accepted") retire.set(outcome.binding_id, outcome);
  }

  const retiring = config.workspaceBindings.filter((binding) => {
    const outcome = retire.get(binding.binding_id);
    return outcome?.workspace_id === binding.workspace_id;
  });
  const retiringIds = new Set(retiring.map((binding) => binding.binding_id));
  const nextActive = config.workspaceBindings.filter(
    (binding) => !retiringIds.has(binding.binding_id),
  );
  const nextRetired = [...(config.retiredWorkspaceBindings ?? [])];
  for (const binding of retiring) {
    if (!nextRetired.some((item) => item.binding_id === binding.binding_id))
      nextRetired.push(binding);
  }

  if (retiring.some((binding) => !configuredIds.has(binding.binding_id)))
    persistWorkspaceBindings(config, nextActive, nextRetired);

  config.workspaceBindings.splice(
    0,
    config.workspaceBindings.length,
    ...nextActive,
  );
  config.retiredWorkspaceBindings ??= [];
  config.retiredWorkspaceBindings.splice(
    0,
    config.retiredWorkspaceBindings.length,
    ...nextRetired,
  );
  capabilities.workspace_bindings.splice(
    0,
    capabilities.workspace_bindings.length,
    ...capabilities.workspace_bindings.filter(
      (binding) => !retiringIds.has(binding.binding_id),
    ),
  );

  for (const binding of retiring) {
    const outcome = retire.get(binding.binding_id);
    const shortWorkspace = `${binding.workspace_id.slice(0, 8)}…`;
    if (outcome?.status === "stale_workspace") {
      if (configuredIds.has(binding.binding_id))
        console.warn(
          `Workspace binding ${shortWorkspace} references a Workspace that no longer exists; fencing the environment-configured binding for this Worker process. Update QE_WORKSPACE_BINDINGS_JSON before restart.`,
        );
      else
        console.warn(
          `Workspace binding ${shortWorkspace} references a Workspace that no longer exists; retiring the local binding.`,
        );
    } else {
      console.warn(
        `Workspace binding ${shortWorkspace} was rejected (${outcome?.code ?? outcome?.status ?? "unknown"}); fencing the binding.`,
      );
    }
  }

  const fencedConfigured = retiring.filter((binding) =>
    configuredIds.has(binding.binding_id),
  ).length;
  console.info(
    `Worker registered with ${capabilities.workspace_bindings.length} active bindings; ${retiring.length - fencedConfigured} stale bindings retired; ${fencedConfigured} configured bindings fenced.`,
  );

  return {
    active: capabilities.workspace_bindings.length,
    retired: retiring.length - fencedConfigured,
    fencedConfigured,
  };
}

export function persistWorkspaceBindings(
  config: WorkerConfig,
  active: WorkspaceBindingConfig[] = config.workspaceBindings,
  retired: WorkspaceBindingConfig[] = config.retiredWorkspaceBindings ?? [],
): void {
  const configuredIds = new Set(config.configuredWorkspaceBindingIds ?? []);
  const state = {
    version: 2,
    active: active.filter((binding) => !configuredIds.has(binding.binding_id)),
    retired: retired.filter(
      (binding) => !configuredIds.has(binding.binding_id),
    ),
  };
  const path =
    config.workspaceBindingsPath ??
    join(config.dataRoot, "workspace-bindings.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function decodeOutcomes(value: unknown): BindingReconciliationOutcome[] {
  if (!Array.isArray(value))
    throw new Error(
      "Worker registration omitted binding reconciliation outcomes.",
    );
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid Workspace binding reconciliation outcome.");
    const outcome = item as Record<string, unknown>;
    const status = outcome.status;
    if (
      typeof outcome.binding_id !== "string" ||
      typeof outcome.workspace_id !== "string" ||
      !["accepted", "stale_workspace", "conflict", "rejected"].includes(
        String(status),
      )
    )
      throw new Error("Invalid Workspace binding reconciliation outcome.");
    return {
      binding_id: outcome.binding_id,
      workspace_id: outcome.workspace_id,
      status: status as BindingReconciliationStatus,
      ...(typeof outcome.code === "string" ? { code: outcome.code } : {}),
    };
  });
}
