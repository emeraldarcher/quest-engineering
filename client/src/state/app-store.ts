import { derived, get, writable } from "svelte/store";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  type ArtifactDetail,
  type ClassDefinition,
  type ExecutionOption,
  type Loadout,
  type Quest,
  type RunProjection,
  type RunSummary,
  type Squad,
  type StarterCrewResult,
  type StarterCrewStatus,
  type Tactic,
  type Workspace,
  type WorkspaceSource,
} from "../api/contracts";
import type { ClientFixture } from "../fixtures/fixtures";
import { RealtimeClient, type RealtimeStatus } from "../realtime/client";
import { projectRunWorld } from "../world/projector";
import { executeStarterCrewCommand } from "./starter-crew-command";

export type BuildingId =
  | "gatehouse"
  | "guild"
  | "blacksmith"
  | "tavern"
  | "quest-board"
  | "war-room"
  | "work-area";
export interface ProductState {
  classes: ClassDefinition[];
  classCatalog: ClassDefinition[];
  loadouts: Loadout[];
  loadoutCatalog: Loadout[];
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
  classCatalog: [],
  loadouts: [],
  loadoutCatalog: [],
  squads: [],
  tactics: [],
  quests: [],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [],
  runs: [],
};

export function createAppStore(
  api: ApiClient,
  socketUrl: string,
  fixture: ClientFixture | null = null,
) {
  const product = writable<ProductState>(fixture?.product ?? emptyProduct);
  const selectedBuilding = writable<BuildingId | null>(null);
  const selectedRun = writable<RunProjection | null>(
    fixture?.selectedRunId
      ? (fixture.runs[fixture.selectedRunId] ?? null)
      : null,
  );
  const loading = writable(true);
  const error = writable<ApiError | null>(null);
  const realtimeStatus = writable<RealtimeStatus>("disconnected");
  const bootstrapRunning = writable(false);
  const starterStatus = writable<StarterCrewStatus | null>(
    fixture?.starterStatus ?? null,
  );
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
    if (fixture) {
      loading.set(false);
      return;
    }
    realtime.start();
    if (!quiet) loading.set(true);
    error.set(null);
    try {
      const includeArchivedDefinitions = get(selectedBuilding) === "tavern";
      const [
        classCatalog,
        loadoutCatalog,
        squads,
        tactics,
        quests,
        workspaces,
        workspaceSources,
        executionOptions,
        runs,
        loadedStarterStatus,
      ] = await Promise.all([
        api.listClasses(includeArchivedDefinitions),
        api.listLoadouts(includeArchivedDefinitions),
        api.listSquads(),
        api.listTactics(),
        api.listQuests(),
        api.listWorkspaces(),
        api.listWorkspaceSources(),
        api.listExecutionOptions(),
        api.listRuns(),
        api.getStarterCrewStatus(),
      ]);
      product.set({
        classes: classCatalog.filter((item) => item.archived_at === null),
        classCatalog,
        loadouts: loadoutCatalog.filter((item) => item.archived_at === null),
        loadoutCatalog,
        squads,
        tactics,
        quests,
        workspaces,
        workspaceSources,
        executionOptions,
        runs,
      });
      starterStatus.set(loadedStarterStatus);
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

  async function loadTavernCatalogs() {
    if (fixture) return;
    error.set(null);
    try {
      const [classCatalog, loadoutCatalog] = await Promise.all([
        api.listClasses(true),
        api.listLoadouts(true),
      ]);
      product.update((value) => ({ ...value, classCatalog, loadoutCatalog }));
    } catch (cause) {
      reportError(cause);
    }
  }

  async function refreshStarterStatus() {
    if (fixture) return get(starterStatus);
    try {
      const value = await api.getStarterCrewStatus();
      starterStatus.set(value);
      return value;
    } catch (cause) {
      reportError(cause);
      return null;
    }
  }

  async function createStarterCrew(
    workspaceId: string,
  ): Promise<StarterCrewResult | { status: "ready"; recovered: true } | null> {
    if (fixture) return null;
    error.set(null);
    const outcome = await executeStarterCrewCommand(api, workspaceId);
    if (outcome.state === "ready") {
      await loadProduct(true);
      return outcome.result ?? { status: "ready", recovered: true };
    }
    if (outcome.status) starterStatus.set(outcome.status);
    const failure = toApiError(outcome.cause);
    error.set(
      outcome.status
        ? new ApiError(
            failure.code,
            failure.message,
            failure.details,
            { ...failure.meta, starter_status_refetched: true },
            failure.status,
          )
        : failure,
    );
    return null;
  }

  async function refreshWorkspaceSources() {
    if (fixture) return get(product).workspaceSources;
    error.set(null);
    try {
      const workspaceSources = await api.listWorkspaceSources();
      product.update((value) => ({ ...value, workspaceSources }));
      return workspaceSources;
    } catch (cause) {
      reportError(cause);
      return [];
    }
  }

  async function selectRun(runId: string) {
    if (fixture) {
      selectedRun.set(fixture.runs[runId] ?? null);
      return;
    }
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

  async function loadArtifact(
    runId: string,
    artifactId: string,
  ): Promise<ArtifactDetail | null> {
    if (fixture) return fixture.artifactDetails?.[runId]?.[artifactId] ?? null;
    return command(() => api.getArtifact(runId, artifactId));
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
    if (!fixture) realtime.disconnect();
  }

  return {
    api,
    fixture,
    product,
    selectedBuilding,
    selectedRun,
    world,
    loading,
    error,
    realtimeStatus,
    bootstrapRunning,
    starterStatus,
    loadProduct,
    refreshProduct,
    loadTavernCatalogs,
    refreshStarterStatus,
    createStarterCrew,
    refreshWorkspaceSources,
    command,
    reportError,
    loadArtifact,
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
