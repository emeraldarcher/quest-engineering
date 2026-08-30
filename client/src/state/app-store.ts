import { derived, get, writable } from "svelte/store";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  type ClassDefinition,
  type ExecutionOption,
  type Loadout,
  type Quest,
  type RunProjection,
  type RunSummary,
  type Squad,
  type Tactic,
  type Workspace,
  type WorkspaceSource,
} from "../api/contracts";
import { RealtimeClient, type RealtimeStatus } from "../realtime/client";
import { projectRunWorld } from "../world/projector";

export type BuildingId =
  | "gatehouse"
  | "guild"
  | "blacksmith"
  | "tavern"
  | "quest-board"
  | "work-area";
export interface ProductState {
  classes: ClassDefinition[];
  loadouts: Loadout[];
  squads: Squad[];
  tactics: Tactic[];
  quests: Quest[];
  workspaces: Workspace[];
  workspaceSources: WorkspaceSource[];
  executionOptions: ExecutionOption[];
  runs: RunSummary[];
}
const emptyProduct: ProductState = {
  classes: [],
  loadouts: [],
  squads: [],
  tactics: [],
  quests: [],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [],
  runs: [],
};

export function createAppStore(api: ApiClient, socketUrl: string) {
  const product = writable<ProductState>(emptyProduct);
  const selectedBuilding = writable<BuildingId | null>(null);
  const selectedRun = writable<RunProjection | null>(null);
  const loading = writable(true);
  const error = writable<ApiError | null>(null);
  const realtimeStatus = writable<RealtimeStatus>("disconnected");
  const bootstrapRunning = writable(false);
  const world = derived(selectedRun, (run) => run && projectRunWorld(run));
  let runRequest = 0;
  let refetching = false;
  let refetchNeeded = false;
  let productRefetching = false;
  let productRefetchNeeded = false;

  const realtime = new RealtimeClient(socketUrl, {
    onStatus: (status) => realtimeStatus.set(status),
    onJoined: (run) => selectedRun.set(run),
    onInvalidated: (runId) => {
      if (get(selectedRun)?.id === runId) void invalidateRun(runId);
    },
    onProductInvalidated: () => void invalidateProduct(),
    onUnavailable: (runId) => {
      if (get(selectedRun)?.id !== runId) return;
      selectedRun.set(null);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      void loadProduct();
    },
  });

  async function loadProduct(quiet = false) {
    realtime.start();
    if (!quiet) loading.set(true);
    error.set(null);
    try {
      const [
        classes,
        loadouts,
        squads,
        tactics,
        quests,
        workspaces,
        workspaceSources,
        executionOptions,
        runs,
      ] = await Promise.all([
        api.listClasses(),
        api.listLoadouts(),
        api.listSquads(),
        api.listTactics(),
        api.listQuests(),
        api.listWorkspaces(),
        api.listWorkspaceSources(),
        api.listExecutionOptions(),
        api.listRuns(),
      ]);
      product.set({
        classes,
        loadouts,
        squads,
        tactics,
        quests,
        workspaces,
        workspaceSources,
        executionOptions,
        runs,
      });
    } catch (cause) {
      error.set(toApiError(cause));
    } finally {
      if (!quiet) loading.set(false);
    }
  }

  async function invalidateProduct() {
    if (productRefetching) {
      productRefetchNeeded = true;
      return;
    }
    productRefetching = true;
    try {
      do {
        productRefetchNeeded = false;
        await loadProduct(true);
      } while (productRefetchNeeded);
    } finally {
      productRefetching = false;
    }
  }

  async function refreshProduct() {
    await loadProduct();
  }

  async function selectRun(runId: string) {
    const request = ++runRequest;
    error.set(null);
    try {
      const run = await api.getRun(runId);
      if (request !== runRequest) return;
      selectedRun.set(run);
      realtime.selectRun(runId);
      history.replaceState(null, "", `#/run/${encodeURIComponent(runId)}`);
    } catch (cause) {
      if (request !== runRequest) return;
      if (cause instanceof ApiError && cause.status === 404) {
        selectedRun.set(null);
        history.replaceState(
          null,
          "",
          `${location.pathname}${location.search}`,
        );
        await loadProduct();
      } else {
        error.set(toApiError(cause));
      }
    }
  }

  async function invalidateRun(runId: string) {
    if (refetching) {
      refetchNeeded = true;
      return;
    }
    refetching = true;
    try {
      do {
        refetchNeeded = false;
        const request = ++runRequest;
        const run = await api.getRun(runId);
        if (request === runRequest && get(selectedRun)?.id === runId) {
          selectedRun.set(run);
          error.set(null);
        }
      } while (refetchNeeded);
    } catch (cause) {
      error.set(toApiError(cause));
    } finally {
      refetching = false;
    }
  }

  function reportError(cause: unknown) {
    const failure = toApiError(cause);
    error.set(failure);
    if (import.meta.env.DEV) console.error(failure.code, failure.meta);
  }

  async function command<T>(operation: () => Promise<T>): Promise<T | null> {
    error.set(null);
    try {
      return await operation();
    } catch (cause) {
      reportError(cause);
      return null;
    }
  }

  async function retryPublishing(runId: string) {
    const result = await command(() => api.retryDelivery(runId));
    if (result) await invalidateRun(runId);
  }

  async function cleanupWorktree(runId: string, acknowledgeUnmerged = false) {
    const result = await command(() =>
      api.cleanupWorktree(runId, acknowledgeUnmerged),
    );
    if (result) await invalidateRun(runId);
  }

  function selectBuildingId(id: BuildingId | null) {
    selectedBuilding.set(id);
  }
  function isEmptyFirstRun() {
    const value = get(product);
    return (
      value.classes.length === 0 &&
      value.loadouts.length === 0 &&
      value.squads.length === 0 &&
      value.tactics.length === 0
    );
  }
  function dispose() {
    realtime.disconnect();
  }

  return {
    api,
    product,
    selectedBuilding,
    selectedRun,
    world,
    loading,
    error,
    realtimeStatus,
    bootstrapRunning,
    loadProduct,
    refreshProduct,
    command,
    reportError,
    retryPublishing,
    cleanupWorktree,
    selectRun,
    selectBuildingId,
    isEmptyFirstRun,
    dispose,
  };
}
function toApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(
        "client_error",
        "The client could not complete that request.",
      );
}
export type AppStore = ReturnType<typeof createAppStore>;
