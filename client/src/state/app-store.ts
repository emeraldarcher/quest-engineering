import { get, writable } from "svelte/store";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  type ArtifactDetail,
  type ClassDefinition,
  type ExecutionOption,
  type HarnessSessionProjection,
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
import {
  type AttentionTarget,
  initializeAttentionNotifications,
  notifyHumanAttention,
} from "../platform/attention-notification";
import {
  canOpenLocalLiveSession,
  openLocalLiveSession,
  type SessionOpenMode,
} from "../platform/live-session";
import { RealtimeClient, type RealtimeStatus } from "../realtime/client";
import { projectActiveCrewActivities } from "../world/crew/active-crew";
import { ActiveRunTracker } from "./active-run-tracker";
import { recordAttentionOnce } from "./attention-dedupe";
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
  const realtimeStatus = writable<RealtimeStatus>(
    fixture?.realtimeStatus ?? "disconnected",
  );
  const serverReachable = writable<boolean | null>(
    fixture ? fixture.realtimeStatus !== "disconnected" : null,
  );
  const bootstrapRunning = writable(false);
  const starterStatus = writable<StarterCrewStatus | null>(
    fixture?.starterStatus ?? null,
  );
  const liveAttentions = writable<AttentionTarget[]>([]);
  const attentionNotifications = writable<AttentionTarget[]>([]);
  const sessionFocus = writable<{
    runId: string;
    occurrenceId: string;
    attemptId: string;
    sessionId: string;
  } | null>(null);
  const seenAttentionIds = new Set<string>(readSeenAttentionIds());
  const activeCrew = writable(
    fixture
      ? projectActiveCrewActivities(
          Object.values(fixture.runs).filter(
            (run) => run.status !== "completed" && run.status !== "failed",
          ),
        )
      : [],
  );
  let activeRunTracker: ActiveRunTracker | null = null;
  let runRequest = 0;
  let refetching = false;
  let refetchNeeded = false;
  let productRefetching = false;
  let productRefetchNeeded = false;

  const realtime = new RealtimeClient(socketUrl, {
    onStatus: (status) => {
      realtimeStatus.set(status);
      if (status === "connected") {
        serverReachable.set(true);
        activeRunTracker?.reconnect();
      } else if (status === "reconnecting" || status === "disconnected") {
        activeRunTracker?.suspend();
        liveAttentions.set([]);
      }
    },
    onJoined: (run) => {
      selectedRun.set(run);
      activeRunTracker?.seed(run);
      observeAttention(run);
    },
    onInvalidated: (runId) => {
      if (activeRunTracker?.isTracking(runId))
        activeRunTracker.invalidate(runId);
      else if (get(selectedRun)?.id === runId) void invalidateRun(runId);
    },
    onProductInvalidated: () => void invalidateProduct(),
    onUnavailable: (runId) => {
      if (get(selectedRun)?.id !== runId) return;
      selectedRun.set(null);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      void loadProduct();
    },
  });
  if (!fixture) {
    void initializeAttentionNotifications((target) => {
      void focusAttention(target, true);
    });
    activeRunTracker = new ActiveRunTracker({
      getRun: (runId) => api.getRun(runId),
      watchRun: (runId) => realtime.watchRun(runId),
      onActivities: (activities) => activeCrew.set(activities),
      onProjection: (projection) => {
        if (get(selectedRun)?.id === projection.id) selectedRun.set(projection);
        observeAttention(projection);
      },
      onError: (runId, cause) => {
        if (get(selectedRun)?.id === runId) reportError(cause);
        else if (import.meta.env.DEV)
          console.warn("Active crew projection could not refresh.", cause);
      },
    });
  }

  function observeAttention(run: RunProjection) {
    const activeTargets: AttentionTarget[] = [];
    for (const step of run.steps) {
      const session = step.session;
      const attention = session?.attention;
      const attempt = step.attempt;
      if (!session || !attention || !attempt || !step.member) continue;
      const target: AttentionTarget = {
        attentionId: attention.attention_id,
        runId: run.id,
        occurrenceId: step.occurrence_id,
        attemptId: attempt.id,
        sessionId: session.id,
        questTitle: run.quest.title,
        memberName: step.member.name,
        stepName: step.name ?? step.semantic_step_key,
        harnessName: session.harness.display_name,
        message: attention.message,
      };
      activeTargets.push(target);
      if (recordAttentionOnce(seenAttentionIds, target.attentionId)) {
        attentionNotifications.update((items) => [...items, target]);
        persistSeenAttentionIds(seenAttentionIds);
        void notifyHumanAttention(target);
      }
    }
    liveAttentions.update((items) => [
      ...items.filter((item) => item.runId !== run.id),
      ...activeTargets,
    ]);
    attentionNotifications.update((items) =>
      items.filter(
        (item) =>
          item.runId !== run.id ||
          activeTargets.some(
            (active) => active.attentionId === item.attentionId,
          ),
      ),
    );
  }

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
      serverReachable.set(true);
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
      activeRunTracker?.updateSummaries(runs);
    } catch (cause) {
      serverReachable.set(false);
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
      const run =
        activeRunTracker?.projection(runId) ?? (await api.getRun(runId));
      if (request !== runRequest) return;
      selectedRun.set(run);
      activeRunTracker?.seed(run);
      observeAttention(run);
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
          activeRunTracker?.seed(run);
          observeAttention(run);
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

  async function openLiveSession(
    runId: string,
    attemptId: string,
    session: HarnessSessionProjection,
    mode: SessionOpenMode,
  ) {
    if (!canOpenLocalLiveSession()) {
      reportError(
        new ApiError(
          "local_session_attachment_unavailable",
          `Live session available on ${session.worker.display_name}, but browser attachment is unavailable.`,
        ),
      );
      return false;
    }
    const attachment = await command(() =>
      api.getSessionAttachment(runId, attemptId, session.id),
    );
    if (!attachment) return false;
    const opened = await command(async () => {
      await openLocalLiveSession(attachment, mode);
      // Native Tauri validation and Terminal launch succeeded; descriptor
      // issuance alone is never recorded as a human attachment.
      return api.recordSessionOpened(attachment.descriptor_token, mode);
    });
    return Boolean(opened);
  }

  async function focusAttention(target: AttentionTarget, open = false) {
    await selectRun(target.runId);
    sessionFocus.set({
      runId: target.runId,
      occurrenceId: target.occurrenceId,
      attemptId: target.attemptId,
      sessionId: target.sessionId,
    });
    selectBuildingId("work-area");
    if (!open) return;
    const projection = get(selectedRun);
    const step = projection?.steps.find(
      (item) => item.occurrence_id === target.occurrenceId,
    );
    if (projection && step?.attempt?.id === target.attemptId && step.session)
      await openLiveSession(
        projection.id,
        target.attemptId,
        step.session,
        "takeover",
      );
  }

  function dismissAttention(attentionId: string) {
    attentionNotifications.update((items) =>
      items.filter((item) => item.attentionId !== attentionId),
    );
  }

  async function retryExecution(runId: string, occurrenceId: string) {
    const result = await command(() => api.retryExecution(runId, occurrenceId));
    if (result) await invalidateRun(runId);
  }

  async function recoverExecutionFresh(runId: string, occurrenceId: string) {
    const result = await command(() =>
      api.recoverExecutionFresh(runId, occurrenceId, crypto.randomUUID()),
    );
    if (result) await invalidateRun(runId);
  }

  async function markExecutionFailed(runId: string, occurrenceId: string) {
    const result = await command(() =>
      api.markExecutionFailed(runId, occurrenceId),
    );
    if (result) await invalidateRun(runId);
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
    if (!fixture) {
      activeRunTracker?.dispose();
      realtime.disconnect();
    }
  }

  return {
    api,
    fixture,
    product,
    selectedBuilding,
    selectedRun,
    activeCrew,
    liveAttentions,
    attentionNotifications,
    sessionFocus,
    loading,
    error,
    realtimeStatus,
    serverReachable,
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
    openLiveSession,
    focusAttention,
    dismissAttention,
    retryExecution,
    recoverExecutionFresh,
    markExecutionFailed,
    retryPublishing,
    cleanupWorktree,
    selectRun,
    selectBuildingId,
    isEmptyFirstRun,
    dispose,
  };
}
function readSeenAttentionIds(): string[] {
  try {
    const value = JSON.parse(
      sessionStorage.getItem("qe-seen-attention") ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
function persistSeenAttentionIds(values: Set<string>): void {
  try {
    sessionStorage.setItem(
      "qe-seen-attention",
      JSON.stringify([...values].slice(-200)),
    );
  } catch {
    // Storage can be unavailable in hardened webviews; in-memory dedupe remains.
  }
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
