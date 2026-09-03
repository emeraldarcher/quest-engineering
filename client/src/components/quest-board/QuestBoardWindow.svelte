<script context="module" lang="ts">
let rememberedQuestId: string | null = null;
</script>

<script lang="ts">
import { get } from "svelte/store";
import { onMount, tick } from "svelte";
import { type QuestInput } from "../../api/client";
import {
  ApiError,
  type Quest,
  type Squad,
  type Tactic,
  type TacticSource,
  type Workspace,
} from "../../api/contracts";
import { openPullRequest } from "../../platform/open-pull-request";
import SemanticNode from "../tactics/SemanticNode.svelte";
import type { TacticNode } from "../war-room/tactic-model";
import type { AppStore, ProductState } from "../../state/app-store";
import { projectRepositoryIdentity, projectStatus } from "../projects/project-presentation";
import "../management/management-window.css";
import {
  archiveExplanation,
  currentRunSummary,
  humanize,
  memberSummary,
  previewIssue,
  projectForQuest,
  questStatus,
  resolvedTacticFromDefinitionPreview,
  resolvedTacticFromQuestPreview,
  runSummaryLabel,
  semanticSteps,
  squadForQuest,
  squadIssueSummary,
  squadReferenceIssues,
  tacticForQuest,
} from "./quest-presentation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let onOpenWorkYard: (runId: string) => void;
export let onOpenProjects: () => void;
export let onOpenTavern: () => void;
export let onOpenWarRoom: (tacticId: string) => void = () => {};
export let scene: string | null = null;

type Mode = "detail" | "create" | "edit";
type Picker = "project" | "squad" | "tactic" | null;
type PreviewState = "idle" | "loading" | "ready" | "failed";
type Draft = {
  title: string;
  objective: string;
  workspaceId: string;
  squadId: string;
  tacticSource: TacticSource;
};
type DraftErrors = Partial<Record<"title" | "objective" | "project" | "squad" | "tactic", string>>;

const { error: errorStore } = store;
let mode: Mode = "detail";
let selectedId: string | null = null;
let optimisticQuest: Quest | null = null;
let draft: Draft = emptyDraft();
let fieldErrors: DraftErrors = {};
let localIssue = "";
let busy = false;
let busyAction: "launch" | "archive" | null = null;
let initialized = false;
let search = "";
let picker: Picker = null;
let projectCatalog: Workspace[] = product.workspaces;
let squadCatalog: Squad[] = product.squads;
let tacticCatalog: Tactic[] = product.tactics;
let definitionPreview: unknown = null;
let definitionPreviewId: string | null = null;
let previewState: PreviewState = "idle";
let previewFailure: ApiError | null = null;
let resolvedTactic: import("../../api/contracts").JsonValue | null = null;
let previewSignature = "";
let previewRequest = 0;
let windowElement: HTMLElement;
let pickerDialog: HTMLDialogElement;
let pickerTrigger: HTMLButtonElement | null = null;
let pickerCloseButton: HTMLButtonElement;
let archiveDialog: HTMLDialogElement;
let archiveTrigger: HTMLButtonElement;
let archiveCancel: HTMLButtonElement;
let dirtyDialog: HTMLDialogElement;
let dirtyKeepButton: HTMLButtonElement;
let dirtyReturnFocus: HTMLElement | null = null;
let pendingContinuation: (() => void) | null = null;

$: {
  const merged = mergeCatalog(projectCatalog, product.workspaces);
  if (JSON.stringify(merged) !== JSON.stringify(projectCatalog))
    projectCatalog = merged;
}
$: {
  const merged = mergeCatalog(squadCatalog, product.squads);
  if (JSON.stringify(merged) !== JSON.stringify(squadCatalog)) squadCatalog = merged;
}
$: {
  const merged = mergeCatalog(tacticCatalog, product.tactics);
  if (JSON.stringify(merged) !== JSON.stringify(tacticCatalog)) tacticCatalog = merged;
}
$: selectedQuest =
  product.quests.find((quest) => quest.id === selectedId) ??
  (optimisticQuest?.id === selectedId ? optimisticQuest : null);
$: if (optimisticQuest && product.quests.some((quest) => quest.id === optimisticQuest?.id))
  optimisticQuest = null;
$: selectedProject = selectedQuest
  ? projectForQuest(selectedQuest, projectCatalog)
  : null;
$: selectedSquad = selectedQuest ? squadForQuest(selectedQuest, squadCatalog) : null;
$: selectedTactic = selectedQuest ? tacticForQuest(selectedQuest, tacticCatalog) : null;
$: selectedKnownConfigurationIssue = Boolean(
  !selectedProject ||
    selectedProject.archived_at ||
    !selectedSquad ||
    selectedSquad.archived_at ||
    selectedSquadIssues.length ||
    (selectedQuest?.tactic_source.type === "definition" &&
      (!selectedTactic || selectedTactic.archived_at)),
);
$: selectedStatus = selectedQuest
  ? presentedQuestStatus(
      selectedQuest,
      previewFailure,
      selectedKnownConfigurationIssue,
    )
  : null;
$: selectedRun = selectedQuest
  ? currentRunSummary(selectedQuest, product.runs)
  : null;
$: classCatalog = product.classCatalog.length ? product.classCatalog : product.classes;
$: loadoutCatalog = product.loadoutCatalog.length ? product.loadoutCatalog : product.loadouts;
$: selectedSquadIssues = selectedSquad
  ? squadReferenceIssues(selectedSquad, classCatalog, loadoutCatalog)
  : [];
$: selectedConfigurationBlocked = Boolean(
  (selectedQuest && knownConfigurationIssue(selectedQuest)) ||
    previewFailureBlocksLaunch(previewFailure),
);
$: selectedPreviewIssue =
  !selectedProject || selectedProject.archived_at
    ? {
        title: "Project needs configuration",
        description: "Choose an active Project before launching another Run.",
      }
    : !selectedSquad || selectedSquad.archived_at
      ? {
          title: "Squad needs configuration",
          description: "Choose an active Squad before launching another Run.",
        }
      : selectedSquadIssues.length
        ? {
            title: "Squad needs configuration",
            description:
              "One or more Members reference a Class or Loadout that is no longer available.",
          }
        : selectedQuest?.tactic_source.type === "definition" &&
          (!selectedTactic || selectedTactic.archived_at)
        ? {
            title: "Approach needs attention",
            description: "Choose an active reusable Tactic before launching another Run.",
          }
        : previewIssue(previewFailure);
$: selectedSteps = semanticSteps(
  resolvedTactic ??
    (selectedQuest?.tactic_source.type === "inline"
      ? selectedQuest.tactic_source.body
      : selectedTactic?.body ?? null),
);
$: normalizedSearch = search.trim().toLocaleLowerCase();
$: visibleQuests = product.quests.filter((quest) =>
  `${quest.title} ${quest.objective} ${presentedQuestStatus(
    quest,
    quest.id === selectedId ? previewFailure : null,
  ).label}`
    .toLocaleLowerCase()
    .includes(normalizedSearch),
);
$: activeProjects = projectCatalog.filter((item) => !item.archived_at);
$: activeSquads = squadCatalog.filter((item) => !item.archived_at);
$: activeTactics = tacticCatalog.filter((item) => !item.archived_at);
$: draftProject = projectCatalog.find((item) => item.id === draft.workspaceId) ?? null;
$: draftSquad = squadCatalog.find((item) => item.id === draft.squadId) ?? null;
$: draftTacticDefinitionId =
  draft.tacticSource.type === "definition"
    ? draft.tacticSource.tactic_definition_id
    : "";
$: draftTactic =
  tacticCatalog.find((item) => item.id === draftTacticDefinitionId) ?? null;
$: draftSteps = semanticSteps(
  definitionPreviewId === draftTactic?.id
    ? resolvedTacticFromDefinitionPreview(definitionPreview) ?? draftTactic?.body ?? null
    : draft.tacticSource.type === "inline"
      ? draft.tacticSource.body
      : draftTactic?.body ?? null,
);
$: if (
  initialized &&
  mode === "detail" &&
  selectedQuest &&
  questPreviewSignature(selectedQuest) !== previewSignature
) {
  previewSignature = questPreviewSignature(selectedQuest);
  void inspectQuest(selectedQuest);
}
$: if (
  initialized &&
  mode === "detail" &&
  selectedId &&
  !product.quests.some((quest) => quest.id === selectedId) &&
  optimisticQuest?.id !== selectedId
) {
  selectDefaultQuest();
}

onMount(async () => {
  if (!store.fixture) {
    void store.loadTavernCatalogs();
    try {
      [projectCatalog, squadCatalog, tacticCatalog] = await Promise.all([
        store.api.listWorkspaces(true),
        store.api.listSquads(true),
        store.api.listTactics(true),
      ]);
    } catch {
      projectCatalog = product.workspaces;
      squadCatalog = product.squads;
      tacticCatalog = product.tactics;
    }
  }

  initialized = true;
  selectDefaultQuest();
  await tick();
  applyScene();
  await tick();
  if (store.fixture && mode === "detail" && selectedQuest) {
    previewSignature = questPreviewSignature(selectedQuest);
    await inspectQuest(selectedQuest);
  }
  windowElement?.querySelector<HTMLElement>(".quest-card.selected, .empty-state button, .detail-pane h2")?.focus();
});

function mergeCatalog<T extends { id: string }>(catalog: T[], active: T[]): T[] {
  const activeIds = new Set(active.map((item) => item.id));
  return [...active, ...catalog.filter((item) => !activeIds.has(item.id))];
}

function presentedQuestStatus(
  quest: Quest,
  failure: ApiError | null = null,
  knownIssue = knownConfigurationIssue(quest),
) {
  if (
    quest.lifecycle.state === "ready" &&
    (knownIssue || previewFailureBlocksLaunch(failure))
  )
    return {
      label: "Setup needs attention",
      description:
        "This Quest is saved, but its current configuration cannot launch a new Run.",
      tone: "danger" as const,
      needsHuman: true,
    };
  return questStatus(quest);
}

function previewFailureBlocksLaunch(failure: ApiError | null): boolean {
  return Boolean(
    failure &&
      !["network_unavailable", "invalid_response", "client_error"].includes(
        failure.code,
      ),
  );
}

function knownConfigurationIssue(quest: Quest): boolean {
  const project = projectForQuest(quest, projectCatalog);
  const squad = squadForQuest(quest, squadCatalog);
  const approach = tacticForQuest(quest, tacticCatalog);
  return Boolean(
    !project ||
      project.archived_at ||
      !squad ||
      squad.archived_at ||
      squadReferenceIssues(squad, classCatalog, loadoutCatalog).length ||
      (quest.tactic_source.type === "definition" &&
        (!approach || approach.archived_at)),
  );
}

function applyScene() {
  if (scene === "new") startCreate();
  if (scene === "edit" && selectedQuest) startEdit(selectedQuest);
  if (scene === "project-picker") {
    startCreate();
    void tick().then(() => openPicker("project"));
  }
  if (scene === "squad-picker") {
    startCreate();
    void tick().then(() => openPicker("squad"));
  }
  if (scene === "tactic-picker") {
    startCreate();
    void tick().then(() => openPicker("tactic"));
  }
  if (scene === "launching") busyAction = "launch";
  if (scene === "archive" && selectedQuest)
    void tick().then(() => openArchive());
  if (scene === "dirty" && selectedQuest) {
    startEdit(selectedQuest);
    draft = { ...draft, objective: `${draft.objective} Unsaved clarification.` };
    window.setTimeout(() => requestLeave(() => undefined), 50);
  }
}

function selectDefaultQuest() {
  const fixturePreferred = store.fixture ? product.quests[0] ?? null : null;
  const preferred = product.quests.find((quest) => quest.id === rememberedQuestId);
  const active = product.quests.find((quest) => quest.lifecycle.state === "needs_attention") ??
    product.quests.find((quest) => quest.lifecycle.state !== "complete") ??
    product.quests[0] ?? null;
  selectedId = (fixturePreferred ?? preferred ?? active)?.id ?? null;
  if (selectedId) rememberedQuestId = selectedId;
}

function selectQuest(quest: Quest) {
  requestTransition(() => {
    selectedId = quest.id;
    rememberedQuestId = quest.id;
    mode = "detail";
    localIssue = "";
    fieldErrors = {};
  });
}

function emptyDraft(): Draft {
  return {
    title: "",
    objective: "",
    workspaceId: "",
    squadId: "",
    tacticSource: { type: "definition", tactic_definition_id: "" },
  };
}

function startCreate() {
  mode = "create";
  selectedId = null;
  const projects = projectCatalog.filter((item) => !item.archived_at);
  const squads = squadCatalog.filter((item) => !item.archived_at);
  const tactics = tacticCatalog.filter((item) => !item.archived_at);
  draft = {
    ...emptyDraft(),
    workspaceId: projects.length === 1 ? projects[0]?.id ?? "" : "",
    squadId: squads.length === 1 ? squads[0]?.id ?? "" : "",
    tacticSource: {
      type: "definition",
      tactic_definition_id: tactics.length === 1 ? tactics[0]?.id ?? "" : "",
    },
  };
  clearIssues();
  void focusField("quest-title");
  if (draft.tacticSource.type === "definition" && draft.tacticSource.tactic_definition_id)
    void loadDefinitionPreview(draft.tacticSource.tactic_definition_id);
}

function beginCreate() {
  requestTransition(startCreate);
}

function startEdit(quest: Quest) {
  selectedId = quest.id;
  rememberedQuestId = quest.id;
  mode = "edit";
  draft = {
    title: quest.title,
    objective: quest.objective,
    workspaceId: quest.workspace_id,
    squadId: quest.squad_id,
    tacticSource:
      quest.tactic_source.type === "definition"
        ? {
            type: "definition",
            tactic_definition_id: quest.tactic_source.tactic_definition_id,
          }
        : { type: "inline", body: quest.tactic_source.body },
  };
  clearIssues();
  if (quest.tactic_source.type === "definition")
    void loadDefinitionPreview(quest.tactic_source.tactic_definition_id);
  void focusField("quest-title");
}

function cancelEditor() {
  requestTransition(() => {
    mode = "detail";
    if (!selectedId) selectDefaultQuest();
    clearIssues();
    void tick().then(() =>
      windowElement
        ?.querySelector<HTMLElement>(`.quest-card[data-quest-id="${selectedId}"]`)
        ?.focus(),
    );
  });
}

function clearIssues() {
  localIssue = "";
  fieldErrors = {};
}

function draftFromQuest(quest: Quest): Draft {
  return {
    title: quest.title,
    objective: quest.objective,
    workspaceId: quest.workspace_id,
    squadId: quest.squad_id,
    tacticSource: quest.tactic_source,
  };
}

function isDirty(): boolean {
  if (mode === "create")
    return Boolean(
      draft.title ||
        draft.objective ||
        draft.workspaceId ||
        draft.squadId ||
        (draft.tacticSource.type === "definition" &&
          draft.tacticSource.tactic_definition_id),
    );
  if (mode !== "edit" || !selectedQuest) return false;
  return JSON.stringify(draft) !== JSON.stringify(draftFromQuest(selectedQuest));
}

function requestTransition(continuation: () => void) {
  requestLeave(continuation);
}

export function requestLeave(continuation: () => void) {
  if (!isDirty() || !dirtyDialog) {
    continuation();
    return;
  }
  pendingContinuation = continuation;
  dirtyReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!dirtyDialog.open) dirtyDialog.showModal();
  void tick().then(() => dirtyKeepButton?.focus());
}

function keepEditing() {
  pendingContinuation = null;
  dirtyDialog.close();
  void tick().then(() => dirtyReturnFocus?.focus());
}

function discardAndContinue() {
  const continuation = pendingContinuation;
  pendingContinuation = null;
  dirtyDialog.close();
  continuation?.();
}

async function saveAndContinue() {
  const continuation = pendingContinuation;
  pendingContinuation = null;
  dirtyDialog.close();
  if (await saveQuest()) continuation?.();
}

function validateDraft(): boolean {
  const errors: DraftErrors = {};
  if (!draft.title.trim()) errors.title = "Give this Quest a title.";
  if (!draft.objective.trim()) errors.objective = "Describe the outcome you want.";
  if (!draft.workspaceId) errors.project = "Choose a Project.";
  if (!draft.squadId) errors.squad = "Choose a Squad.";
  if (
    draft.tacticSource.type === "definition" &&
    !draft.tacticSource.tactic_definition_id
  )
    errors.tactic = "Choose an Approach.";
  fieldErrors = errors;
  if (Object.keys(errors).length === 0) return true;
  localIssue = "Review the highlighted Quest fields.";
  const id = errors.title
    ? "quest-title"
    : errors.objective
      ? "quest-objective"
      : errors.project
        ? "project-picker-button"
        : errors.squad
          ? "squad-picker-button"
          : "tactic-picker-button";
  void focusField(id);
  return false;
}

async function saveQuest(): Promise<boolean> {
  if (busy || !validateDraft()) return false;
  busy = true;
  clearIssues();
  const input: Required<QuestInput> = {
    title: draft.title.trim(),
    objective: draft.objective.trim(),
    workspace_id: draft.workspaceId,
    squad_id: draft.squadId,
    tactic_source: draft.tacticSource,
  };
  try {
    const saved =
      mode === "edit" && selectedQuest
        ? await store.command(() => store.api.updateQuest(selectedQuest.id, input))
        : await store.command(() => store.api.createQuest(input));
    if (!saved) {
      applyServerErrors(get(errorStore));
      return false;
    }
    optimisticQuest = saved;
    selectedId = saved.id;
    rememberedQuestId = saved.id;
    mode = "detail";
    previewSignature = "";
    await store.refreshProduct();
    await tick();
    windowElement?.querySelector<HTMLElement>(".quest-hero h2")?.focus();
    return true;
  } finally {
    busy = false;
  }
}

function applyServerErrors(failure: ApiError | null) {
  const errors: DraftErrors = {};
  for (const detail of failure?.details ?? []) {
    if (detail.path[0] === "title") errors.title = "Enter a valid Quest title.";
    if (detail.path[0] === "objective") errors.objective = "Enter a valid objective.";
    if (detail.path[0] === "workspace_id") errors.project = "Choose an available Project definition.";
    if (detail.path[0] === "squad_id") errors.squad = "Choose an available Squad definition.";
    if (detail.path[0] === "tactic_source") errors.tactic = "Choose an Approach that can be used here.";
  }
  fieldErrors = errors;
  localIssue = failure?.message ?? "Quest Engineering couldn't save this Quest.";
}

function openPicker(kind: Exclude<Picker, null>, event: MouseEvent | null = null) {
  picker = kind;
  pickerTrigger = (event?.currentTarget as HTMLButtonElement | undefined) ?? null;
  pickerDialog?.showModal();
  void tick().then(() => pickerCloseButton?.focus());
}

function closePicker() {
  pickerDialog.close();
  picker = null;
  pickerTrigger?.focus();
}

function clearFieldError(field: keyof DraftErrors) {
  fieldErrors = Object.fromEntries(
    Object.entries(fieldErrors).filter(([key]) => key !== field),
  ) as DraftErrors;
}

function chooseProject(project: Workspace) {
  draft = { ...draft, workspaceId: project.id };
  clearFieldError("project");
  closePicker();
}

function chooseSquad(squad: Squad) {
  draft = { ...draft, squadId: squad.id };
  clearFieldError("squad");
  closePicker();
}

function chooseTactic(tactic: Tactic) {
  draft = {
    ...draft,
    tacticSource: { type: "definition", tactic_definition_id: tactic.id },
  };
  clearFieldError("tactic");
  void loadDefinitionPreview(tactic.id);
  closePicker();
}

async function loadDefinitionPreview(id: string) {
  definitionPreviewId = id;
  definitionPreview = null;
  if (store.fixture) return;
  try {
    const value = await store.api.previewTacticDefinition(id);
    if (definitionPreviewId === id) definitionPreview = value;
  } catch {
    // The saved Quest preview remains the authoritative contextual check.
  }
}

function questPreviewSignature(quest: Quest): string {
  const definitionId =
    quest.tactic_source.type === "definition"
      ? quest.tactic_source.tactic_definition_id
      : null;
  return JSON.stringify([
    quest.id,
    quest.workspace_id,
    quest.squad_id,
    quest.tactic_source,
    product.squads.find((item) => item.id === quest.squad_id) ?? null,
    definitionId
      ? product.tactics.find((item) => item.id === definitionId) ?? null
      : null,
    product.classes.map((item) => [item.id, item.key, item.archived_at]),
    product.loadouts.map((item) => [item.id, item.key, item.archived_at]),
  ]);
}

async function inspectQuest(quest: Quest) {
  const request = ++previewRequest;
  previewState = "loading";
  previewFailure = null;
  resolvedTactic = null;
  if (store.fixture) {
    const name = store.fixture.name;
    if (name === "quest-board-invalid-squad") {
      previewFailure = new ApiError("validation_failed", "The request is invalid.", [
        { code: "class_not_found", path: ["members", 1, "class_id"], details: {} },
      ]);
      previewState = "failed";
      return;
    }
    if (name === "quest-board-tactic-error") {
      previewFailure = new ApiError("validation_failed", "The request is invalid.", [
        { code: "unsatisfied_performer_class", path: ["execution_plan"], details: {} },
      ]);
      previewState = "failed";
      return;
    }
    resolvedTactic =
      quest.tactic_source.type === "inline"
        ? quest.tactic_source.body
        : tacticForQuest(quest, tacticCatalog)?.body ?? null;
    previewState = "ready";
    return;
  }
  try {
    const value = await store.api.previewQuest(quest.id);
    if (request !== previewRequest || selectedId !== quest.id) return;
    resolvedTactic = resolvedTacticFromQuestPreview(value);
    previewState = "ready";
  } catch (cause) {
    if (request !== previewRequest || selectedId !== quest.id) return;
    previewFailure = cause instanceof ApiError ? cause : new ApiError("client_error", "Quest preview failed.");
    previewState = "failed";
  }
}

function launchFailureCopy(failure: ApiError | null): string {
  const codes = new Set(failure?.details.map((detail) => detail.code) ?? []);
  if (codes.has("missing_or_archived_definition")) return "The Squad needs configuration before a new Run can begin.";
  if (codes.has("run_active")) return "This Quest already has an active Run.";
  if (codes.has("delivery_active") || codes.has("delivery_pending")) return "The latest Run is still moving through Delivery.";
  if (codes.has("retry_publishing_required")) return "Publishing must be retried from the Work Yard before another Run can begin.";
  if (codes.has("quest_completed")) return "This Quest is already complete.";
  return failure?.message ?? "Quest Engineering couldn't launch this Quest.";
}

async function launchQuest(runAgain = false) {
  if (!selectedQuest || busyAction || isDirty()) return;
  busyAction = "launch";
  localIssue = "";
  try {
    const launch = await store.command(() => store.api.launchQuest(selectedQuest.id));
    if (!launch) {
      localIssue = launchFailureCopy(get(errorStore));
      return;
    }
    await store.refreshProduct();
    await store.selectRun(launch.runId);
  } finally {
    busyAction = null;
  }
}

async function openReview() {
  const review = selectedQuest?.lifecycle.delivery?.review;
  if (!review || store.fixture) return;
  await store.command(() => openPullRequest(review.url, review.number));
}

function openArchive() {
  if (!selectedQuest) return;
  archiveTrigger = document.activeElement as HTMLButtonElement;
  archiveDialog?.showModal();
  void tick().then(() => archiveCancel?.focus());
}

function closeArchive() {
  archiveDialog.close();
  archiveTrigger?.focus();
}

async function confirmArchive() {
  if (!selectedQuest || busyAction) return;
  busyAction = "archive";
  const archivedId = selectedQuest.id;
  try {
    const archived = await store.command(() => store.api.archiveQuest(archivedId));
    if (!archived) {
      localIssue = get(errorStore)?.message ?? "Quest Engineering couldn't archive this Quest.";
      return;
    }
    archiveDialog.close();
    if (selectedId === archivedId) selectedId = null;
    rememberedQuestId = null;
    await store.refreshProduct();
    selectDefaultQuest();
    await tick();
    windowElement?.querySelector<HTMLElement>(".quest-card.selected, .empty-state button")?.focus();
  } finally {
    busyAction = null;
  }
}

function projectAvailabilityCopy(project: Workspace): string {
  if (project.archived_at)
    return "This saved Project has been archived. Choose an active Project before launching another Run.";
  if (project.binding.state === "offline")
    return "This Project isn't currently available for execution. You can still launch the Quest; work will wait until the Project becomes available.";
  if (project.binding.state === "preparing")
    return "You can launch now. Work will begin when the Project is available for execution.";
  if (project.binding.state === "attention_required")
    return "This Project needs connection attention. Launch remains server-authoritative; a new Run may wait for an available host.";
  if (project.binding.state === "unbound")
    return "This Project is not connected yet. A launched Run will wait for an available host.";
  return projectStatus(project.binding.state).description;
}

function openProjectManager() {
  requestTransition(onOpenProjects);
}

function openTacticInWarRoom() {
  if (selectedTactic) onOpenWarRoom(selectedTactic.id);
}

function openTavern() {
  requestTransition(onOpenTavern);
}

function focusField(id: string) {
  return tick().then(() => document.getElementById(id)?.focus());
}
</script>

<aside class="management-window management-window-shell quest-board-window" bind:this={windowElement} aria-labelledby="quest-board-title">
  <header class="window-header">
    <div><span class="window-kicker">Plan the work</span><h1 id="quest-board-title">Quest Board</h1></div>
    {#if mode === "detail"}<button class="primary new-quest" type="button" on:click={beginCreate}>+ New Quest</button>{/if}
    <button class="icon-button" type="button" aria-label="Close Quest Board" on:click={() => requestLeave(onClose)}>×</button>
  </header>

  <div class="quest-layout" class:editor-open={mode !== "detail"}>
    <section class="quest-browser" aria-label="Quest browser">
      <div class="browser-heading"><div><span class="eyebrow">Active Product</span><h2>Quests</h2></div><span class="count-seal">{product.quests.length}</span></div>
      {#if product.quests.length > 4}<label class="quest-search"><span class="sr-only">Search Quests</span><input type="search" bind:value={search} placeholder="Search Quests…" /></label>{/if}
      <div class="quest-list">
        {#each visibleQuests as quest (quest.id)}
          {@const status = presentedQuestStatus(
            quest,
            quest.id === selectedId ? previewFailure : null,
          )}
          <button type="button" class="quest-card tone-{status.tone}" class:selected={quest.id === selectedId && mode === "detail"} aria-pressed={quest.id === selectedId && mode === "detail"} data-quest-id={quest.id} on:click={() => selectQuest(quest)}>
            <span class="pin" aria-hidden="true"></span><strong>{quest.title}</strong><span class="quest-card-status"><span class="status-dot" aria-hidden="true"></span>{status.label}</span>{#if status.needsHuman}<span class="needs-you">Needs you</span>{/if}
          </button>
        {:else}{#if product.quests.length > 0}<p class="no-results">No Quests match that search.</p>{/if}{/each}
      </div>
    </section>

    <section class="detail-pane" aria-live="polite">
      {#if mode === "create" || mode === "edit"}
        <form class="quest-editor" on:submit|preventDefault={saveQuest}>
          <div class="editor-title"><span class="eyebrow">{mode === "create" ? "New Quest" : "Edit Quest"}</span><h2>{mode === "create" ? (product.quests.length ? "Describe the next outcome" : "Give your crew something to work on") : `Refine ${selectedQuest?.title ?? "this Quest"}`}</h2><p>Define what you want accomplished, then choose where, who, and how.</p></div>
          {#if localIssue}<div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>{/if}
          <fieldset class="what-fields"><legend><span>What</span>Quest</legend>
            <label for="quest-title">Title</label><input id="quest-title" bind:value={draft.title} aria-invalid={fieldErrors.title ? "true" : undefined} placeholder="Add login validation" />{#if fieldErrors.title}<small class="field-error">{fieldErrors.title}</small>{/if}
            <label for="quest-objective">Objective</label><textarea id="quest-objective" bind:value={draft.objective} aria-invalid={fieldErrors.objective ? "true" : undefined} placeholder="Describe the outcome you want and what success should mean."></textarea>{#if fieldErrors.objective}<small class="field-error">{fieldErrors.objective}</small>{/if}
          </fieldset>
          <fieldset class="assignment-fields"><legend><span>Assignment</span>Where, who, and how</legend>
            <div class="choice-grid">
              <div class="choice-field"><span class="choice-label">Project</span><button id="project-picker-button" class="choice-button" class:invalid={fieldErrors.project} type="button" aria-haspopup="dialog" on:click={(event) => openPicker("project", event)}>{#if draftProject}<strong>{draftProject.name}</strong><small>{projectRepositoryIdentity(draftProject, product.workspaceSources)} · {projectStatus(draftProject.binding.state).shortLabel}</small>{:else}<strong>Choose a Project</strong><small>Where the work happens</small>{/if}</button>{#if fieldErrors.project}<small class="field-error">{fieldErrors.project}</small>{/if}</div>
              <div class="choice-field"><span class="choice-label">Squad</span><button id="squad-picker-button" class="choice-button" class:invalid={fieldErrors.squad} type="button" aria-haspopup="dialog" on:click={(event) => openPicker("squad", event)}>{#if draftSquad}<strong>{draftSquad.name}</strong><small>{draftSquad.members.length} {draftSquad.members.length === 1 ? "Member" : "Members"}</small>{:else}<strong>Choose a Squad</strong><small>Who is available</small>{/if}</button>{#if fieldErrors.squad}<small class="field-error">{fieldErrors.squad}</small>{/if}</div>
              <div class="choice-field approach-choice"><span class="choice-label">Approach</span>{#if draft.tacticSource.type === "inline"}<div class="choice-button static-choice"><strong>Inline Tactic</strong><small>Preserved with this Quest · authoring is not available here</small></div>{:else}<button id="tactic-picker-button" class="choice-button" class:invalid={fieldErrors.tactic} type="button" aria-haspopup="dialog" on:click={(event) => openPicker("tactic", event)}>{#if draftTactic}<strong>{draftTactic.name}</strong><small>Reusable Tactic</small>{:else}<strong>Choose an Approach</strong><small>How the work proceeds</small>{/if}</button>{/if}{#if fieldErrors.tactic}<small class="field-error">{fieldErrors.tactic}</small>{/if}</div>
            </div>
            {#if draftSteps.length}<div class="mini-tactic" aria-label="Approach semantic preview">{#each draftSteps as step, index}<span>{step.name}</span>{#if index < draftSteps.length - 1}<i aria-hidden="true">→</i>{/if}{/each}</div>{/if}
          </fieldset>
          <div class="editor-actions"><button class="secondary" type="button" on:click={cancelEditor}>Cancel</button><button class="primary" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Create Quest" : "Save Changes"}</button></div>
        </form>
      {:else if !selectedQuest}
        <div class="empty-state quest-empty"><div class="empty-seal" aria-hidden="true">✦</div><h2>No Quests yet</h2><p>Give your crew something to work on. Describe the outcome you want, choose your Project, crew, and approach, then launch the work.</p><button class="primary" type="button" on:click={startCreate}>Create Your First Quest</button></div>
      {:else}
        <article class="quest-detail">
          <header class="quest-hero"><div><span class="eyebrow">What you want accomplished</span><h2 tabindex="-1">{selectedQuest.title}</h2><p>{selectedQuest.objective}</p></div>{#if selectedStatus}<span class="status-chip tone-{selectedStatus.tone}">{selectedStatus.label}</span>{/if}</header>
          {#if localIssue}<div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>{/if}
          {#if selectedStatus}<section class="lifecycle-banner tone-{selectedStatus.tone}" aria-label="Quest lifecycle"><div class="lifecycle-mark" aria-hidden="true">{selectedStatus.tone === "success" ? "✓" : selectedStatus.tone === "danger" ? "!" : "◆"}</div><div class="lifecycle-copy"><span class="eyebrow">Quest lifecycle</span><h3>{selectedStatus.label}</h3><p>{selectedStatus.description}</p></div><div class="lifecycle-banner-actions">{#if selectedQuest.lifecycle.primary_action === "launch"}<button class="primary lifecycle-primary" type="button" disabled={busyAction === "launch" || previewState === "loading" || selectedConfigurationBlocked} on:click={() => launchQuest(false)}>{busyAction === "launch" ? "Launching…" : "Launch Quest"}</button>{:else if selectedQuest.lifecycle.primary_action === "run_again"}<button class="primary lifecycle-primary" type="button" disabled={busyAction === "launch"} on:click={() => launchQuest(true)}>{busyAction === "launch" ? "Launching…" : "Run Again"}</button>{/if}{#if selectedQuest.lifecycle.primary_action === "open_pull_request" && selectedQuest.lifecycle.delivery?.review}<button class="primary lifecycle-primary" type="button" on:click={openReview}>Open Pull Request #{selectedQuest.lifecycle.delivery.review.number}</button>{/if}</div></section>{/if}

          <section class="assignment-section" aria-labelledby="assignment-title"><div class="section-heading"><div><span class="eyebrow">Launch configuration</span><h3 id="assignment-title">Assignment</h3></div></div>
            <div class="assignment-grid">
              <article class="assignment-card project-card"><span class="card-kicker">Where · Project</span>{#if selectedProject}<div class="assignment-name"><div><h4>{selectedProject.name}</h4><p>{projectRepositoryIdentity(selectedProject, product.workspaceSources)}</p></div><span class="mini-status tone-{selectedProject.archived_at ? "attention" : projectStatus(selectedProject.binding.state).tone}">{selectedProject.archived_at ? "Archived" : projectStatus(selectedProject.binding.state).shortLabel}</span></div><p class="availability-copy">{projectAvailabilityCopy(selectedProject)}</p><button class="text-action" type="button" on:click={openProjectManager}>Open Projects</button>{:else}<h4>Project unavailable</h4><p>This Quest keeps its Project association, but that Product definition isn't currently available.</p><button class="text-action" type="button" on:click={openProjectManager}>Open Projects</button>{/if}</article>
              <article class="assignment-card squad-card"><span class="card-kicker">Who · Squad</span>{#if selectedSquad}<div class="assignment-name"><div><h4>{selectedSquad.name}</h4><p>{selectedSquad.members.length} {selectedSquad.members.length === 1 ? "Member" : "Members"}</p></div>{#if selectedSquad.archived_at}<span class="mini-status tone-attention">Archived</span>{:else if selectedSquadIssues.length}<span class="mini-status tone-attention">Needs configuration</span>{/if}</div><ul class="member-lines">{#each memberSummary(selectedSquad, classCatalog, loadoutCatalog).slice(0, 4) as member}<li><strong>{member.name}</strong><span>{member.className} · {member.loadoutName}</span></li>{/each}</ul>{#if selectedSquadIssues.length}<p class="configuration-warning">{squadIssueSummary(selectedSquadIssues)}</p>{/if}<button class="text-action" type="button" on:click={openTavern}>Open Tavern</button>{:else}<h4>Squad unavailable</h4><p>The saved Squad association is no longer available for a new Run.</p><button class="text-action" type="button" on:click={openTavern}>Open Tavern</button>{/if}</article>
              <article class="assignment-card tactic-card"><span class="card-kicker">How · Approach</span>{#if selectedQuest.tactic_source.type === "inline"}<h4>Inline Tactic</h4><p>Quest-local semantics are preserved. Editing this Tactic belongs in a future authoring experience.</p>{:else if selectedTactic}<div class="assignment-name"><div><h4>{selectedTactic.name}</h4><p>Reusable Tactic</p></div>{#if selectedTactic.archived_at}<span class="mini-status tone-attention">Archived</span>{/if}</div><p>{selectedTactic.description}</p>{:else}<h4>Approach unavailable</h4><p>The reusable Tactic selected by this Quest isn't currently available.</p>{/if}{#if selectedTactic && !selectedTactic.archived_at}<button class="text-action" type="button" on:click={openTacticInWarRoom}>Open in War Room</button>{/if}{#if selectedSteps.length}<div class="semantic-flow shared-preview" aria-label="Resolved Approach"><SemanticNode node={(resolvedTactic ?? (selectedQuest.tactic_source.type === "inline" ? selectedQuest.tactic_source.body : selectedTactic?.body)) as unknown as TacticNode} bindings={[]} tactics={tacticCatalog} compact /></div>{/if}</article>
            </div>
          </section>

          {#if previewState === "loading" && selectedQuest.lifecycle.state === "ready"}<p class="readiness-note" role="status">Checking the saved launch configuration…</p>{/if}
          {#if selectedPreviewIssue}<section class="setup-issue" aria-label="Quest setup issue"><span aria-hidden="true">!</span><div><h3>{selectedPreviewIssue.title}</h3><p>{selectedPreviewIssue.description}</p></div></section>{/if}

          {#if selectedRun}<section class="run-summary" aria-labelledby="run-summary-title"><div><span class="eyebrow">{selectedQuest.lifecycle.state === "working" ? "Current Run" : "Latest Run"}</span><h3 id="run-summary-title">{runSummaryLabel(selectedQuest, selectedRun)}</h3><p>{selectedQuest.lifecycle.state === "preparing_review" ? "Execution and Delivery remain separate. Quest Engineering is preparing review." : selectedQuest.lifecycle.state === "complete" ? "This Run's merged Delivery proves Quest completion." : `${Object.values(selectedRun.step_counts).reduce((sum, value) => sum + value, 0)} semantic steps in this Run.`}</p></div><button class="secondary" type="button" on:click={() => onOpenWorkYard(selectedRun.id)}>{selectedQuest.lifecycle.state === "complete" ? "View Run" : "Open Work Yard"}</button></section>{/if}

          <footer class="quest-actions"><div class="management-actions"><button class="secondary" type="button" on:click={() => startEdit(selectedQuest)}>Edit</button><button class="archive-action" bind:this={archiveTrigger} type="button" on:click={openArchive}>Archive</button></div></footer>
        </article>
      {/if}
    </section>
  </div>

  <dialog class="picker-dialog" bind:this={pickerDialog} on:cancel|preventDefault={closePicker} aria-labelledby="picker-title"><div class="picker-shell"><header><div><span class="eyebrow">Choose for this Quest</span><h2 id="picker-title">{picker === "project" ? "Choose a Project" : picker === "squad" ? "Choose a Squad" : "Choose an Approach"}</h2></div><button class="dialog-close" bind:this={pickerCloseButton} type="button" aria-label="Close picker" on:click={closePicker}>×</button></header><div class="picker-options">{#if picker === "project"}{#each activeProjects as project}<button type="button" class:selected={project.id === draft.workspaceId} on:click={() => chooseProject(project)}><div><strong>{project.name}</strong><span>{projectRepositoryIdentity(project, product.workspaceSources)}</span></div><small class="mini-status tone-{projectStatus(project.binding.state).tone}">{projectStatus(project.binding.state).shortLabel}</small></button>{/each}{:else if picker === "squad"}{#each activeSquads as squad}<button type="button" class:selected={squad.id === draft.squadId} on:click={() => chooseSquad(squad)}><div><strong>{squad.name}</strong><span>{#each memberSummary(squad, classCatalog, loadoutCatalog).slice(0, 3) as member}{member.name} · {member.className} · {member.loadoutName}<br />{/each}</span></div>{#if squadReferenceIssues(squad, classCatalog, loadoutCatalog).length}<small class="mini-status tone-attention">Needs configuration</small>{:else}<small>{squad.members.length} Members</small>{/if}</button>{/each}{:else if picker === "tactic"}{#each activeTactics as tactic}<button type="button" class:selected={tactic.id === (draft.tacticSource.type === "definition" ? draft.tacticSource.tactic_definition_id : "")} on:click={() => chooseTactic(tactic)}><div><strong>{tactic.name}</strong><span>{tactic.description}</span>{#if semanticSteps(tactic.body).length}<em>{semanticSteps(tactic.body).map((step) => step.name).join(" → ")}</em>{/if}</div><small>Reusable Tactic</small></button>{/each}{/if}</div>{#if (picker === "project" && !activeProjects.length) || (picker === "squad" && !activeSquads.length) || (picker === "tactic" && !activeTactics.length)}<p class="picker-empty">No active choices are available yet.</p>{/if}</div></dialog>

  {#if selectedQuest}<dialog bind:this={archiveDialog} on:cancel|preventDefault={closeArchive} aria-labelledby="archive-title"><div class="dialog-card"><span class="dialog-icon" aria-hidden="true">!</span><h2 id="archive-title">Archive {selectedQuest.title}?</h2><p>This Quest will be removed from the active Quest Board.</p><p>{archiveExplanation(selectedQuest.lifecycle.state)}</p><div class="action-row"><button class="secondary" bind:this={archiveCancel} type="button" on:click={closeArchive}>Cancel</button><button class="destructive" type="button" disabled={busyAction === "archive"} on:click={confirmArchive}>{busyAction === "archive" ? "Archiving…" : "Archive Quest"}</button></div></div></dialog>{/if}

  <dialog bind:this={dirtyDialog} on:cancel|preventDefault={keepEditing} aria-labelledby="dirty-title"><div class="dialog-card"><span class="dialog-icon amber" aria-hidden="true">✎</span><h2 id="dirty-title">Save your Quest changes?</h2><p>You have unsaved changes. Save them before leaving, keep editing, or discard this draft.</p><div class="dirty-actions"><button class="secondary" bind:this={dirtyKeepButton} type="button" on:click={keepEditing}>Keep Editing</button><button class="secondary" type="button" on:click={discardAndContinue}>Discard</button><button class="primary" type="button" disabled={busy} on:click={saveAndContinue}>{busy ? "Saving…" : mode === "create" ? "Create Quest" : "Save Changes"}</button></div></div></dialog>
</aside>

<style>
.quest-board-window { width: min(72rem, calc(100vw - 2rem)); height: min(49rem, calc(100vh - 5.4rem)); }
.window-header { gap: .65rem; }
.new-quest { white-space: nowrap; }
.quest-layout { display: grid; grid-template-columns: minmax(17rem, 31%) minmax(0, 1fr); height: calc(100% - 5rem); min-height: 0; }
.quest-browser { min-width: 0; padding: 1rem; overflow: hidden; background: linear-gradient(160deg,#ead2a4,#d8b77f); border-right: 2px solid #a87a4e; }
.browser-heading,.section-heading,.assignment-name,.run-summary,.quest-actions,.editor-actions,.picker-shell header { display:flex; align-items:center; gap:.8rem; }
.browser-heading h2,.section-heading h3 { margin:.05rem 0 0; color:var(--app-ink); font:700 1.2rem Georgia,serif; }
.count-seal { display:grid; place-items:center; width:2rem; height:2rem; margin-left:auto; color:#fff8e9; background:var(--app-teal); border:2px solid #f7e2b7; border-radius:50%; font-weight:800; }
.quest-search { margin:.75rem 0; }
.quest-search input { padding:.55rem .7rem; color:var(--app-ink); background:#fff8e7; border:1px solid #ad8b60; border-radius:8px; }
.quest-list { display:grid; align-content:start; gap:.55rem; max-height:calc(100% - 3.5rem); padding:.2rem; overflow:auto; }
.quest-card { position:relative; display:grid; grid-template-columns:1fr auto; gap:.3rem .5rem; width:100%; min-height:4.55rem; padding:.75rem .8rem .7rem 1rem; color:var(--app-ink); text-align:left; background:#fff2cf; border:1px solid #b58d5d; box-shadow:0 2px 5px #72503522; }
.quest-card::after { content:""; position:absolute; inset:0 auto 0 0; width:5px; background:#87968a; border-radius:8px 0 0 8px; }
.quest-card.tone-active::after { background:var(--app-teal); }.quest-card.tone-warning::after { background:var(--app-amber); }.quest-card.tone-danger::after { background:var(--app-coral); }.quest-card.tone-success::after { background:var(--app-green); }
.quest-card.selected { background:#fffaf0; border-color:#3f746d; box-shadow:0 0 0 2px #4c817966,0 4px 10px #72503533; }
.quest-card strong { align-self:end; font-size:.94rem; }
.quest-card-status { display:flex; align-items:center; gap:.35rem; grid-column:1; color:#52645e; font-size:.76rem; font-weight:700; }
.status-dot { width:.48rem; height:.48rem; background:currentColor; border-radius:50%; }
.needs-you { grid-column:2; grid-row:1/3; align-self:center; padding:.18rem .38rem; color:#873f39; background:#f6d6c9; border-radius:99px; font-size:.65rem; font-weight:800; text-transform:uppercase; }
.pin { position:absolute; top:-.27rem; left:50%; width:.55rem; height:.55rem; background:#bd6d43; border:1px solid #7b432e; border-radius:50%; box-shadow:0 1px 2px #4b352e66; }
.detail-pane { min-width:0; overflow:auto; background:linear-gradient(145deg,#fff5db,#f4e1ba); }
.quest-detail,.quest-editor { padding:1.2rem 1.35rem 1rem; }
.quest-hero { display:flex; align-items:flex-start; gap:1rem; padding-bottom:1rem; border-bottom:1px solid #d2b486; }
.quest-hero>div { flex:1; min-width:0; }.quest-hero h2,.editor-title h2 { margin:.18rem 0 .35rem; color:#263b3c; font:700 clamp(1.55rem,2.5vw,2.15rem) Georgia,serif; line-height:1.08; }.quest-hero p,.editor-title p { max-width:45rem; margin:0; color:#586962; font-size:1rem; line-height:1.55; }
.status-chip,.mini-status { white-space:nowrap; border-radius:99px; font-weight:800; }.status-chip { padding:.42rem .7rem; font-size:.78rem; }.status-chip.tone-neutral { color:#52645e;background:#e1ded0; }.status-chip.tone-active { color:#275e59;background:#cfe5dc; }.status-chip.tone-warning { color:#7b551f;background:#f3dfad; }.status-chip.tone-danger { color:#873f39;background:#f5d0c8; }.status-chip.tone-success { color:#315f3e;background:#d2e7ce; }
.lifecycle-banner { display:flex; gap:.8rem; margin:1rem 0; padding:.85rem 1rem; background:#fffaf0; border-left:5px solid #87968a; border-radius:7px; }.lifecycle-banner.tone-active { border-color:var(--app-teal); }.lifecycle-banner.tone-warning { border-color:var(--app-amber); }.lifecycle-banner.tone-danger { border-color:var(--app-coral); }.lifecycle-banner.tone-success { border-color:var(--app-green); }.lifecycle-mark { display:grid; place-items:center; flex:0 0 2.1rem; height:2.1rem; color:white; background:var(--app-teal); border-radius:50%; font-weight:900; }.lifecycle-copy { flex:1; min-width:0; }.lifecycle-banner-actions { display:flex; align-items:center; margin-left:auto; }.lifecycle-banner h3,.run-summary h3,.setup-issue h3 { margin:.05rem 0 .18rem; color:var(--app-ink); font:700 1.13rem Georgia,serif; }.lifecycle-banner p,.run-summary p,.setup-issue p { margin:0; color:var(--app-muted); line-height:1.42; }
.assignment-section { margin-top:1.1rem; }.assignment-grid { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; margin-top:.65rem; }.assignment-card { min-width:0; padding:.8rem; background:#fffaf0; border:1px solid #d1b488; border-radius:9px; }.assignment-card.tactic-card { grid-column:1/-1; display:grid; grid-template-columns:minmax(10rem,.8fr) minmax(15rem,1.2fr); gap:.25rem 1rem; }.card-kicker { color:#8a6b4e; font-size:.67rem; font-weight:850; letter-spacing:.09em; text-transform:uppercase; }.assignment-card h4 { margin:.22rem 0 .12rem; color:#314647; font:700 1.05rem Georgia,serif; }.assignment-card p { margin:.15rem 0; color:#68756e; font-size:.82rem; line-height:1.4; }.assignment-name>div { flex:1; min-width:0; }.mini-status { padding:.22rem .42rem; font-size:.67rem; }.mini-status.tone-ready,.mini-status.tone-success { color:#315f3e;background:#d8ead4; }.mini-status.tone-preparing,.mini-status.tone-active { color:#275e59;background:#d4e8e2; }.mini-status.tone-offline,.mini-status.tone-warning { color:#74551f;background:#f1dfb4; }.mini-status.tone-attention,.mini-status.tone-danger { color:#873f39;background:#f4d2c9; }.mini-status.tone-unbound { color:#5e665f;background:#e5e0d4; }
.availability-copy { min-height:2.25rem; }.text-action { min-height:auto!important; padding:.25rem 0!important; color:var(--app-teal-dark)!important; background:transparent!important; border:0!important; box-shadow:none!important; font-size:.78rem!important; font-weight:800; text-decoration:underline; }.member-lines { display:grid; gap:.22rem; margin:.45rem 0 .25rem; padding:0; list-style:none; }.member-lines li { display:flex; gap:.4rem; margin:0; font-size:.74rem; }.member-lines strong { color:#405454; }.member-lines span { color:#78827b; }.configuration-warning { color:#934842!important; }.semantic-flow { grid-column:2; grid-row:1/5; display:block; min-width:0; padding:.45rem; background:#f4e6c8; border-radius:7px; }
.readiness-note { padding:.6rem; color:#536962; text-align:center; }.setup-issue { display:flex; gap:.7rem; margin:1rem 0; padding:.8rem; background:#f8ded5; border-left:4px solid var(--app-coral); border-radius:7px; }.setup-issue>span { font-weight:900; color:var(--app-coral); }
.run-summary { margin:1rem 0; padding:.8rem 1rem; background:#dce9df; border:1px solid #a9c1ae; border-radius:8px; }.run-summary>div { flex:1; }.quest-actions { justify-content:space-between; margin-top:1.15rem; padding-top:.9rem; border-top:1px solid #d1b488; }.management-actions { display:flex; gap:.55rem; }.archive-action { min-height:2.45rem!important; padding:.45rem .65rem!important; color:#9a4e48!important; background:transparent!important; border:1px solid transparent!important; box-shadow:none!important; }.lifecycle-primary { min-width:10rem; }
.quest-empty { min-height:100%; align-content:center; }.empty-seal { display:grid; place-items:center; width:4rem; height:4rem; color:#fff6db; background:linear-gradient(#5d8f74,#45725e); border:4px double #f1d69e; border-radius:50%; font-size:1.6rem; }
.quest-editor { max-width:52rem; margin:auto; }.editor-title { margin-bottom:.9rem; }.quest-editor fieldset { margin:0 0 .85rem; padding:.8rem 1rem; background:#fffaf0; border:1px solid #d0b487; border-radius:9px; }.quest-editor legend { padding:0 .4rem; color:#314647; font:700 1rem Georgia,serif; }.quest-editor legend span { margin-right:.45rem; color:#917054; font:800 .65rem system-ui,sans-serif; letter-spacing:.1em; text-transform:uppercase; }.quest-editor label,.choice-label { display:block; margin:.35rem 0 .22rem; color:#5d655f; font-size:.78rem; font-weight:800; }.quest-editor input,.quest-editor textarea { width:100%; padding:.55rem .65rem; color:var(--app-ink); background:#fffdf5; border:1px solid #ad8d67; border-radius:7px; }.quest-editor textarea { min-height:5.2rem; }.choice-grid { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; }.approach-choice { grid-column:1/-1; }.choice-button { display:grid; width:100%; min-height:3.8rem!important; padding:.58rem .7rem!important; color:var(--app-ink)!important; text-align:left; background:#fffdf5!important; border:1px solid #ad8d67!important; box-shadow:none!important; }.choice-button.invalid { border-color:var(--app-coral)!important; box-shadow:0 0 0 1px #bd5d5555!important; }.choice-button strong { color:#30494a; }.choice-button small { color:#778079; }.static-choice { border-style:dashed!important; }.field-error { display:block; margin-top:.2rem; color:#a34842; font-weight:750; }.mini-tactic { display:flex; align-items:center; gap:.35rem; margin-top:.65rem; padding:.55rem; color:#315b55; background:#edf0dc; border-radius:6px; font-size:.76rem; font-weight:800; }.mini-tactic i { color:#a7753a; font-style:normal; }.editor-actions { justify-content:flex-end; }
.picker-dialog { width:min(43rem,calc(100vw - 2rem))!important; max-height:min(38rem,calc(100vh - 2rem)); }.picker-shell header { padding:1rem 1.1rem; color:#fff6de; background:linear-gradient(135deg,var(--app-wood),var(--app-wood-dark)); }.picker-shell header>div { flex:1; }.picker-shell h2 { margin:.1rem 0 0; color:#fff6de; font:700 1.45rem Georgia,serif; }.picker-shell header .eyebrow { color:#ead8b6; }.dialog-close { width:2.5rem; padding:0; color:#fff6de; background:#5b4035; border:1px solid #d7b67c; }.picker-options { display:grid; gap:.55rem; max-height:29rem; padding:1rem; overflow:auto; }.picker-options>button { display:flex; align-items:center; gap:.8rem; width:100%; padding:.75rem; color:var(--app-ink); text-align:left; background:#fff8e8; border:1px solid #c7a77a; box-shadow:none; }.picker-options>button.selected { border-color:var(--app-teal); box-shadow:0 0 0 2px #4c817955; }.picker-options>button>div { display:grid; flex:1; gap:.15rem; }.picker-options strong { color:#304849; }.picker-options span { color:#6d7770; font-size:.78rem; line-height:1.35; }.picker-options em { color:#4d776e; font-size:.72rem; font-style:normal; font-weight:800; }.picker-options small { color:#806d58; }.picker-empty { padding:2rem; text-align:center; }.dialog-card p+p { margin-top:.55rem; }.dialog-icon.amber { background:var(--app-amber); }.dirty-actions { display:flex; flex-wrap:wrap; justify-content:center; gap:.55rem; margin-top:1.2rem; }
.no-results { color:#695d50; text-align:center; }
@media (max-width:1000px) { .quest-board-window { width:calc(100vw - 1rem)!important; }.quest-layout { grid-template-columns:minmax(14rem,32%) minmax(0,1fr); }.quest-browser { padding:.75rem; }.quest-detail,.quest-editor { padding:1rem; }.assignment-card.tactic-card { grid-template-columns:1fr; }.semantic-flow { grid-column:1; grid-row:auto; justify-content:flex-start; overflow:auto; }.quest-hero { flex-direction:column; }.status-chip { align-self:flex-start; } }
@media (max-width:720px) { .quest-board-window { height:calc(100vh - 5.3rem); }.window-header { min-height:4.4rem!important; }.window-header h1 { font-size:1.45rem; }.new-quest { order:3; min-height:2.35rem!important; padding:.35rem .5rem!important; }.quest-layout { grid-template-columns:1fr; grid-template-rows:minmax(9rem,34%) minmax(0,1fr); height:calc(100% - 4.4rem); }.quest-browser { border-right:0; border-bottom:2px solid #a87a4e; }.browser-heading { display:none; }.quest-list { display:flex; max-height:100%; overflow:auto; }.quest-card { flex:0 0 13.5rem; min-height:4rem; }.assignment-grid,.choice-grid { grid-template-columns:1fr; }.approach-choice,.assignment-card.tactic-card { grid-column:1; }.quest-actions,.run-summary,.lifecycle-banner { align-items:stretch; flex-direction:column; }.management-actions { justify-content:stretch; }.lifecycle-banner-actions { margin-left:0; }.lifecycle-banner-actions button { width:100%; }.quest-hero h2,.editor-title h2 { font-size:1.45rem; } }
</style>
