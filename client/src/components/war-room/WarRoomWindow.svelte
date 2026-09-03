<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import "../management/management-window.css";
import type { AppStore, ProductState } from "../../state/app-store";
import {
  ApiError,
  type ApiErrorDetail,
  type ClassDefinition,
  type SemanticArtifactBinding,
  type Tactic,
  type TacticPreview,
} from "../../api/contracts";
import SemanticNode from "../tactics/SemanticNode.svelte";
import {
  appendChild,
  asJson,
  cloneDraft,
  displayNodeName,
  draftFromTactic,
  draftSignature,
  emptyDraft,
  entries,
  generatedLocalKey,
  generatedTacticKey,
  insertAfter,
  localDraftIssues,
  makeStep,
  makeUntil,
  makeUse,
  moveIntoPrevious,
  moveNode,
  moveOut,
  nodeAt,
  pathKey,
  removeNode,
  replaceNode,
  steps,
  type NodePath,
  type ParallelNode,
  type SequenceNode,
  type StepNode,
  type TacticDraft,
  type TacticNode,
  type TacticUseNode,
  type UntilNode,
  usageFor,
} from "./tactic-model";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let onOpenQuestBoard: () => void;
export let scene: string | null = null;

type Mode = "detail" | "create" | "edit";
type PreviewState = "idle" | "loading" | "valid" | "context" | "attention" | "unavailable";
type PendingAction = (() => void) | null;

let windowElement: HTMLElement;
let mode: Mode = "detail";
let selectedId: string | null = null;
let tacticCatalog: Tactic[] = [];
let classCatalog: ClassDefinition[] = [];
let draft: TacticDraft = emptyDraft([]);
let baseline = "";
let selectedPath: NodePath = [];
let preview: TacticPreview | null = null;
let previewFailure: ApiError | null = null;
let previewState: PreviewState = "idle";
let busy = false;
let localIssue = "";
let search = "";
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewRequest = 0;
let previewController: AbortController | null = null;
let dirtyDialog: HTMLDialogElement;
let dirtyKeep: HTMLButtonElement;
let archiveDialog: HTMLDialogElement;
let archiveCancel: HTMLButtonElement;
let archiveTrigger: HTMLButtonElement;
let pendingAction: PendingAction = null;
let nestedPreviewOpen = false;
let advancedOpen = false;
let inspectorAdvanced = false;
let rememberedSelection: string | null = null;
let unsubscribeProduct: (() => void) | null = null;

$: activeTactics = tacticCatalog.filter((tactic) => !tactic.archived_at);
$: visibleTactics = activeTactics.filter((tactic) =>
  `${tactic.name} ${tactic.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
);
$: selectedTactic = tacticCatalog.find((tactic) => tactic.id === selectedId) ?? null;
$: selectedNode = nodeAt(draft.body, selectedPath);
$: selectedNodePath = pathKey(selectedPath);
$: dirty = (mode === "create" || mode === "edit") && draftSignature(draft) !== baseline;
$: usage = selectedTactic
  ? usageFor(selectedTactic.id, product.tactics, product.quests)
  : { quests: 0, tactics: 0 };
$: localIssues = mode === "create" || mode === "edit" ? localDraftIssues(draft) : [];
$: previewBindings = preview?.artifact_bindings ?? [];
$: contextualDetails = contextualArtifacts(previewFailure);
onMount(async () => {
  rememberedSelection = store.fixture
    ? null
    : sessionStorage.getItem("qe-war-room-selection");
  tacticCatalog = product.tactics;
  classCatalog = product.classCatalog.length ? product.classCatalog : product.classes;
  if (!store.fixture) {
    try {
      [tacticCatalog, classCatalog] = await Promise.all([
        store.api.listTactics(true),
        store.api.listClasses(true),
      ]);
    } catch (cause) {
      localIssue = failureMessage(cause, "The Tactic catalog could not be loaded.");
    }
  }
  let firstProductEmission = true;
  unsubscribeProduct = store.product.subscribe((latest) => {
    if (firstProductEmission) {
      firstProductEmission = false;
      return;
    }
    const archivedTactics = tacticCatalog.filter((item) => item.archived_at);
    const archivedClasses = classCatalog.filter((item) => item.archived_at);
    tacticCatalog = [
      ...latest.tactics,
      ...archivedTactics.filter(
        (item) => !latest.tactics.some((active) => active.id === item.id),
      ),
    ];
    classCatalog = [
      ...latest.classes,
      ...archivedClasses.filter(
        (item) => !latest.classes.some((active) => active.id === item.id),
      ),
    ];
    if (
      mode === "detail" &&
      selectedId &&
      !latest.tactics.some((item) => item.id === selectedId)
    ) {
      const next = selectInitialTactic();
      void previewPersisted(next);
    }
  });
  const initialTactic = selectInitialTactic();
  await tick();
  await previewPersisted(initialTactic);
  applyScene();
  await tick();
  windowElement?.querySelector<HTMLElement>(".tactic-card.selected, .empty-state button")?.focus();
});

onDestroy(() => {
  if (previewTimer) clearTimeout(previewTimer);
  previewController?.abort();
  unsubscribeProduct?.();
});

export function requestLeave(continuation: () => void) {
  requestTransition(continuation);
}

function selectInitialTactic(): Tactic | null {
  const available = tacticCatalog.filter((tactic) => !tactic.archived_at);
  const preferred = available.find((tactic) => tactic.id === rememberedSelection);
  const selected = preferred ?? available[0] ?? null;
  selectedId = selected?.id ?? null;
  if (selectedId) sessionStorage.setItem("qe-war-room-selection", selectedId);
  if (store.fixture && selected) {
    preview = store.fixture.tacticPreviews?.[selected.id] ?? {
      resolved_tactic: selected.body,
      artifact_bindings: [],
      provenance: null,
      step_origins: [],
    };
    previewState = "valid";
  }
  return selected;
}

function applyScene() {
  if (!scene) return;
  if (scene === "new") startCreate();
  else if (scene === "archive" && selectedTactic) openArchive();
  else if (scene !== "detail" && selectedTactic) {
    startEdit(selectedTactic);
    const allEntries = entries(draft.body);
    const firstPath = (predicate: (node: TacticNode) => boolean): NodePath =>
      allEntries.find((entry) => predicate(entry.node))?.path ?? [];
    const scenePath: Record<string, NodePath> = {
      step: firstPath((node) => node.type === "step"),
      "step-advanced": firstPath((node) => node.type === "step"),
      sequence: firstPath((node) => node.type === "sequence"),
      parallel: firstPath((node) => node.type === "parallel"),
      until: firstPath((node) => node.type === "until"),
      affinity: firstPath((node) => node.type === "step" && node.key === "repair"),
      context: firstPath((node) => node.type === "step" && node.key === "repair"),
      artifacts: firstPath((node) => node.type === "step" && node.key === "review"),
      ambiguous: firstPath((node) => node.type === "step" && node.key === "review"),
      use: firstPath((node) => node.type === "use"),
    };
    selectedPath = scenePath[scene] ?? [];
    inspectorAdvanced = scene === "step-advanced" || scene === "affinity" || scene === "context";
    if (scene === "dirty") {
      draft = { ...draft, description: `${draft.description} Updated plan.` };
      void tick().then(() => requestTransition(() => {}));
    }
  }
}

function selectTactic(id: string) {
  if (id === selectedId && mode === "detail") return;
  requestTransition(() => {
    mode = "detail";
    selectedId = id;
    rememberedSelection = id;
    sessionStorage.setItem("qe-war-room-selection", id);
    clearEditorState();
    void previewPersisted(tacticCatalog.find((tactic) => tactic.id === id) ?? null);
  });
}

function startCreate() {
  requestTransition(() => {
    mode = "create";
    selectedId = null;
    draft = emptyDraft(activeTactics.map((tactic) => tactic.key));
    baseline = draftSignature(draft);
    selectedPath = [];
    preview = null;
    previewFailure = null;
    previewState = "idle";
    localIssue = "";
    void tick().then(() => windowElement?.querySelector<HTMLInputElement>("#tactic-name")?.focus());
  });
}

function startEdit(tactic: Tactic) {
  requestTransition(() => {
    mode = "edit";
    selectedId = tactic.id;
    draft = draftFromTactic(tactic);
    baseline = draftSignature(draft);
    selectedPath = [];
    localIssue = "";
    advancedOpen = false;
    inspectorAdvanced = false;
    void runDraftPreview();
  });
}

function cancelEdit() {
  requestTransition(() => {
    mode = "detail";
    clearEditorState();
    void previewPersisted();
  });
}

function clearEditorState() {
  localIssue = "";
  selectedPath = [];
  nestedPreviewOpen = false;
  previewFailure = null;
  previewState = "idle";
}

function updateDraftName(value: string) {
  draft.name = value;
  if (mode === "create")
    draft.key = generatedTacticKey(value, activeTactics.map((item) => item.key));
}

function setSelectedNode(node: TacticNode) {
  draft.body = replaceNode(draft.body, selectedPath, node);
  draft = { ...draft };
  schedulePreview();
}

function addNode(kind: "step" | "sequence" | "parallel" | "until" | "use") {
  const firstClass = classCatalog.find((item) => !item.archived_at)?.key ?? "";
  let node: TacticNode;
  if (kind === "step") node = makeStep("New Step", draft.body, firstClass);
  else if (kind === "sequence") {
    node = { type: "sequence", children: [makeStep("New Step", draft.body, firstClass)] };
  } else if (kind === "parallel") {
    const first = makeStep("First Branch", draft.body, firstClass);
    const interim: SequenceNode = { type: "sequence", children: [first] };
    const second = makeStep("Second Branch", interim, firstClass);
    node = { type: "parallel", children: [first, second] };
  } else if (kind === "until") node = makeUntil(draft.body, firstClass);
  else {
    const target = activeTactics.find((item) => item.id !== draft.id);
    if (!target) {
      localIssue = "Create another reusable Tactic before adding a reuse step.";
      return;
    }
    node = makeUse(target, draft.body);
  }

  const current = selectedNode;
  if (current && (current.type === "sequence" || current.type === "parallel")) {
    const index = current.children.length;
    draft.body = appendChild(draft.body, selectedPath, node);
    selectedPath = [...selectedPath, index];
  } else if (!entries(draft.body).length || (draft.body.type === "sequence" && !draft.body.children.length)) {
    draft.body = draft.body.type === "sequence" ? { ...draft.body, children: [node] } : node;
    selectedPath = draft.body.type === "sequence" ? [0] : [];
  } else if (selectedPath.length && typeof selectedPath.at(-1) !== "number") {
    draft.body = replaceNode(draft.body, selectedPath, {
      type: "sequence",
      children: [current ?? node, node],
    });
    selectedPath = [...selectedPath, 1];
  } else {
    draft.body = insertAfter(draft.body, selectedPath, node);
    const index = selectedPath.at(-1);
    selectedPath = typeof index === "number"
      ? [...selectedPath.slice(0, -1), index + 1]
      : [1];
  }
  draft = { ...draft };
  schedulePreview();
}

function moveSelected(direction: -1 | 1) {
  const moved = moveNode(draft.body, selectedPath, direction);
  draft.body = moved.body;
  selectedPath = moved.path;
  draft = { ...draft };
  schedulePreview();
}

function nestSelected() {
  const moved = moveIntoPrevious(draft.body, selectedPath);
  draft.body = moved.body;
  selectedPath = moved.path;
  draft = { ...draft };
  schedulePreview();
}

function unnestSelected() {
  const moved = moveOut(draft.body, selectedPath);
  draft.body = moved.body;
  selectedPath = moved.path;
  draft = { ...draft };
  schedulePreview();
}

function removeSelected() {
  const name = selectedNode ? displayNodeName(selectedNode, tacticCatalog) : "this item";
  if (!confirm(`Remove ${name}? References are preserved and preview will show anything that now needs attention.`))
    return;
  draft.body = removeNode(draft.body, selectedPath);
  selectedPath = selectedPath.slice(0, -1);
  draft = { ...draft };
  schedulePreview();
}

function addArtifact(direction: "consumes" | "produces") {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({
    ...selectedNode,
    [direction]: [...selectedNode[direction], { type: "", source: null }],
  });
}

function updateArtifact(
  direction: "consumes" | "produces",
  index: number,
  patch: Partial<{ type: string; source: string | null }>,
) {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({
    ...selectedNode,
    [direction]: selectedNode[direction].map((artifact, artifactIndex) =>
      artifactIndex === index ? { ...artifact, ...patch } : artifact,
    ),
  });
}

function removeArtifact(direction: "consumes" | "produces", index: number) {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({
    ...selectedNode,
    [direction]: selectedNode[direction].filter((_, artifactIndex) => artifactIndex !== index),
  });
}

function artifactSourceCandidates(type: string): string[] {
  const projected = previewFailure?.details.find(
    (detail) => detail.code === "ambiguous_artifact" && detailRecord(detail).artifact_type === type,
  );
  const candidateSteps = projected ? detailRecord(projected).candidate_steps : null;
  if (Array.isArray(candidateSteps))
    return candidateSteps
      .map((candidate) =>
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>).local_key
          : null,
      )
      .filter((value): value is string => typeof value === "string");
  return steps(draft.body)
    .filter((step) => step.key !== (selectedNode?.type === "step" ? selectedNode.key : ""))
    .filter((step) => step.produces.some((artifact) => artifact.type === type))
    .map((step) => step.key);
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void runDraftPreview(), 320);
}

async function runDraftPreview() {
  if (mode !== "create" && mode !== "edit") return;
  const request = ++previewRequest;
  previewController?.abort();
  previewController = new AbortController();
  previewState = "loading";
  previewFailure = null;
  if (store.fixture) {
    preview =
      (draft.id ? store.fixture.tacticPreviews?.[draft.id] : null) ?? {
        resolved_tactic: asJson(draft.body),
        artifact_bindings: [],
        provenance: null,
        step_origins: [],
      };
    previewState = ["cycle", "ambiguous", "generic-error"].includes(scene ?? "")
      ? "attention"
      : scene === "contextual"
        ? "context"
        : "valid";
    if (scene === "contextual")
      previewFailure = new ApiError("preview_failed", "", [
        { code: "missing_artifact", path: [], details: { artifact_type: "plan", consumer_step: { local_key: "implement", instance_path: [] } } },
      ]);
    if (scene === "cycle")
      previewFailure = new ApiError("preview_failed", "", [
        { code: "cyclic_tactic_reference", path: [], details: {}, definition_path: ["implement-and-review", "backend-flow", "implement-and-review"] },
      ]);
    if (scene === "ambiguous")
      previewFailure = new ApiError("preview_failed", "", [
        {
          code: "ambiguous_artifact",
          path: [],
          details: {
            artifact_type: "change_set",
            consumer_step: { local_key: "review", instance_path: [] },
            candidate_steps: [
              { local_key: "backend", instance_path: [] },
              { local_key: "frontend", instance_path: [] },
            ],
          },
        },
      ]);
    if (scene === "generic-error")
      previewFailure = new ApiError("preview_failed", "", [
        { code: "invalid_structure", path: [], details: {} },
      ]);
    return;
  }
  try {
    const result = draft.id
      ? await store.api.previewTacticDefinition(draft.id, asJson(draft.body), previewController.signal)
      : await store.api.previewTacticDraft(asJson(draft.body), previewController.signal);
    if (request !== previewRequest) return;
    preview = result;
    previewFailure = null;
    previewState = "valid";
  } catch (cause) {
    if (request !== previewRequest || previewController.signal.aborted) return;
    const failure = asApiError(cause);
    preview = null;
    previewFailure = failure;
    previewState = failure.details.length && failure.details.every((detail) => detail.code === "missing_artifact")
      ? "context"
      : ["network_unavailable", "invalid_response"].includes(failure.code)
        ? "unavailable"
        : "attention";
  }
}

async function previewPersisted(tactic: Tactic | null = selectedTactic) {
  if (!tactic) return;
  const request = ++previewRequest;
  previewState = "loading";
  previewFailure = null;
  if (store.fixture) {
    preview = store.fixture.tacticPreviews?.[tactic.id] ?? {
      resolved_tactic: tactic.body,
      artifact_bindings: [],
      provenance: null,
      step_origins: [],
    };
    previewState = "valid";
    return;
  }
  try {
    const result = await store.api.previewTacticDefinition(tactic.id);
    if (request !== previewRequest) return;
    preview = result;
    previewState = "valid";
  } catch (cause) {
    if (request !== previewRequest) return;
    previewFailure = asApiError(cause);
    previewState = previewFailure.details.length && previewFailure.details.every((detail) => detail.code === "missing_artifact")
      ? "context"
      : "attention";
  }
}

async function saveTactic(): Promise<boolean> {
  if (busy) return false;
  const issues = localDraftIssues(draft);
  if (issues.length) {
    localIssue = issues[0] ?? "Complete this Tactic before saving.";
    return false;
  }
  busy = true;
  localIssue = "";
  try {
    const saved = draft.id
      ? await store.api.updateTactic(draft.id, {
          name: draft.name.trim(),
          description: draft.description,
          body: asJson(draft.body),
        })
      : await store.api.createTactic({
          key: draft.key,
          name: draft.name.trim(),
          description: draft.description,
          body: asJson(draft.body),
        });
    selectedId = saved.id;
    rememberedSelection = saved.id;
    sessionStorage.setItem("qe-war-room-selection", saved.id);
    mode = "detail";
    baseline = "";
    await refreshCatalogs();
    await store.refreshProduct();
    await previewPersisted();
    await tick();
    windowElement?.querySelector<HTMLElement>(".tactic-detail h2")?.focus();
    return true;
  } catch (cause) {
    const failure = asApiError(cause);
    previewFailure = failure;
    previewState = failure.details.every((detail) => detail.code === "missing_artifact")
      ? "context"
      : "attention";
    localIssue = saveFailureMessage(failure);
    return false;
  } finally {
    busy = false;
  }
}

async function refreshCatalogs() {
  if (store.fixture) {
    if (draft.id) {
      tacticCatalog = tacticCatalog.map((item) =>
        item.id === draft.id ? { ...item, name: draft.name, description: draft.description, body: asJson(draft.body) } : item,
      );
    }
    return;
  }
  tacticCatalog = await store.api.listTactics(true);
}

function requestTransition(action: () => void) {
  if (!dirty) {
    action();
    return;
  }
  pendingAction = action;
  dirtyDialog.showModal();
  void tick().then(() => dirtyKeep?.focus());
}
function keepEditing() {
  pendingAction = null;
  dirtyDialog.close();
}
function discardAndContinue() {
  const action = pendingAction;
  pendingAction = null;
  dirtyDialog.close();
  action?.();
}
async function saveAndContinue() {
  if (!(await saveTactic())) return;
  const action = pendingAction;
  pendingAction = null;
  dirtyDialog.close();
  action?.();
}

function openReferenced(use: TacticUseNode) {
  const target = tacticCatalog.find((item) => item.id === use.tactic_definition_id);
  if (!target) return;
  selectTactic(target.id);
}

function openArchive() {
  if (!selectedTactic) return;
  archiveDialog.showModal();
  void tick().then(() => archiveCancel?.focus());
}
function closeArchive() {
  archiveDialog.close();
  archiveTrigger?.focus();
}
async function confirmArchive() {
  if (!selectedTactic || busy) return;
  busy = true;
  try {
    await store.api.archiveTactic(selectedTactic.id);
    archiveDialog.close();
    await refreshCatalogs();
    await store.refreshProduct();
    selectedId = activeTactics[0]?.id ?? null;
    if (selectedId) await previewPersisted();
  } catch (cause) {
    localIssue = failureMessage(cause, "This Tactic could not be archived.");
    archiveDialog.close();
  } finally {
    busy = false;
  }
}

function validationLabel(): { label: string; description: string; tone: string } {
  if (previewState === "loading") return { label: "Checking…", description: "Checking this semantic flow.", tone: "active" };
  if (previewState === "valid") return { label: "Valid", description: "This semantic flow resolves successfully.", tone: "success" };
  if (previewState === "context") return { label: "Requires context", description: "This reusable Tactic expects artifacts from the flow that uses it. It can still be saved and reused.", tone: "warning" };
  if (previewState === "unavailable") return { label: "Preview unavailable", description: "The draft is preserved. Try the semantic check again.", tone: "neutral" };
  if (previewState === "attention") return { label: "Needs attention", description: friendlyPreviewIssue(previewFailure), tone: "danger" };
  return { label: "Draft", description: "Build the semantic flow, then check it before saving.", tone: "neutral" };
}

function contextualArtifacts(failure: ApiError | null): Array<{ artifact: string; step: string | null }> {
  if (!failure) return [];
  return failure.details
    .filter((detail) => detail.code === "missing_artifact")
    .map((detail) => {
      const data = detailRecord(detail);
      const consumer = data.consumer_step;
      return {
        artifact: typeof data.artifact_type === "string" ? data.artifact_type : "required input",
        step:
          consumer && typeof consumer === "object" && !Array.isArray(consumer) &&
          typeof (consumer as Record<string, unknown>).local_key === "string"
            ? ((consumer as Record<string, unknown>).local_key as string)
            : null,
      };
    });
}

function detailRecord(detail: ApiErrorDetail): Record<string, unknown> {
  return detail.details && typeof detail.details === "object" && !Array.isArray(detail.details)
    ? (detail.details as Record<string, unknown>)
    : {};
}
function friendlyPreviewIssue(failure: ApiError | null): string {
  if (!failure) return "This flow needs attention.";
  const cycle = failure.details.find((detail) => detail.code === "cyclic_tactic_reference");
  if (cycle)
    return `Circular tactic reference${cycle.definition_path?.length ? `: ${cycle.definition_path.join(" → ")}` : ". Choose a different reusable Tactic."}`;
  const ambiguous = failure.details.find((detail) => detail.code === "ambiguous_artifact");
  if (ambiguous) {
    const artifact = detailRecord(ambiguous).artifact_type;
    return `${typeof artifact === "string" ? artifact : "An input"} has more than one possible producer. Choose a source explicitly.`;
  }
  const invalid = failure.details.find((detail) => detail.code === "invalid_artifact_source");
  if (invalid) return "An explicit artifact source is not a valid upstream producer here.";
  return "Quest Engineering could not resolve this semantic flow. Review the highlighted structure.";
}
function saveFailureMessage(failure: ApiError): string {
  if (failure.details.some((detail) => detail.code === "cyclic_tactic_reference"))
    return friendlyPreviewIssue(failure);
  if (failure.code === "validation_failed") return "Some Tactic fields or references are not valid. Your complete draft is still here.";
  return failureMessage(failure, "The Tactic could not be saved. Your complete draft is still here.");
}
function failureMessage(cause: unknown, fallback: string): string {
  const failure = asApiError(cause);
  return ["network_unavailable", "invalid_response"].includes(failure.code) ? `${fallback} Quest Engineering is unavailable.` : fallback;
}
function asApiError(cause: unknown): ApiError {
  return cause instanceof ApiError ? cause : new ApiError("client_error", "The request could not be completed.");
}
function conditionValueType(value: string | number | boolean | null): string {
  if (value === null) return "null";
  return typeof value;
}
function conditionValueForType(type: string): string | number | boolean | null {
  if (type === "number") return 0;
  if (type === "boolean") return true;
  if (type === "null") return null;
  return "accepted";
}

function nodeLabel(node: TacticNode): string {
  return displayNodeName(node, tacticCatalog);
}
function referencedTactic(node: TacticUseNode): Tactic | null {
  return tacticCatalog.find((item) => item.id === node.tactic_definition_id) ?? null;
}
function classForKey(key: string): ClassDefinition | null {
  return classCatalog.find((item) => item.key === key) ?? null;
}
function humanizeKey(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
</script>

<aside class="management-window management-window-shell war-room-window" bind:this={windowElement} aria-label="War Room Tactic authoring">
  <header class="window-header">
    <div><span class="eyebrow">Plan how the crew works</span><h1>War Room</h1></div>
    <div class="header-actions">{#if mode === "detail"}<button class="primary" type="button" on:click={startCreate}>+ New Tactic</button>{/if}<button class="icon-button" type="button" aria-label="Close War Room" on:click={() => requestTransition(onClose)}>×</button></div>
  </header>

  <div class:editing={mode !== "detail"} class="war-layout">
    <section class="tactic-browser" aria-labelledby="tactic-browser-title">
      <div class="browser-heading"><div><span class="eyebrow">Reusable Product</span><h2 id="tactic-browser-title">Tactics</h2></div><span class="count-seal">{activeTactics.length}</span></div>
      {#if activeTactics.length > 5}<label class="search-field"><span class="sr-only">Search Tactics</span><input bind:value={search} placeholder="Search Tactics" /></label>{/if}
      <div class="tactic-list">
        {#each visibleTactics as tactic}
          <button class:selected={tactic.id === selectedId} class="tactic-card" data-tactic-id={tactic.id} type="button" on:click={() => selectTactic(tactic.id)}><strong>{tactic.name}</strong><small>{tactic.description || "Reusable semantic flow"}</small></button>
        {:else}{#if activeTactics.length}<p>No Tactics match this search.</p>{/if}{/each}
      </div>
    </section>

    {#if mode === "detail"}
      <section class="tactic-detail" aria-live="polite">
        {#if !selectedTactic}
          <div class="empty-state"><div class="empty-seal" aria-hidden="true">✦</div><h2>No Tactics yet</h2><p>Tactics describe how your crew approaches work. Build flows from Steps, sequences, parallel work, remediation loops, and reusable Tactics.</p><button class="primary" type="button" on:click={startCreate}>Create Tactic</button></div>
        {:else}
          <article>
            <header class="detail-hero"><div><span class="eyebrow">Reusable Tactic</span><h2 tabindex="-1">{selectedTactic.name}</h2><p>{selectedTactic.description || "A reusable semantic approach for future Runs."}</p></div><span class="status-chip tone-{validationLabel().tone}">{validationLabel().label}</span></header>
            {#if localIssue}<div class="friendly-error" role="alert">{localIssue}</div>{/if}
            <section class="validation-banner tone-{validationLabel().tone}" aria-live="polite"><strong>{validationLabel().label}</strong><span>{validationLabel().description}</span></section>
            {#if previewState === "context"}<section class="context-warning"><strong>Requires surrounding context</strong><p>This Tactic can still be saved and reused. The flow that uses it must provide:</p><ul>{#each contextualDetails as item}<li><code>{item.artifact}</code>{item.step ? ` · expected by ${humanizeKey(item.step)}` : ""}</li>{/each}</ul></section>{/if}
            <section class="read-flow" aria-labelledby="semantic-flow-title"><div class="section-heading"><div><span class="eyebrow">Semantic flow</span><h3 id="semantic-flow-title">What the crew will do</h3></div></div><SemanticNode node={(preview?.resolved_tactic ?? selectedTactic.body) as unknown as TacticNode} bindings={previewBindings} tactics={tacticCatalog} /></section>
            <section class="usage-panel"><div><span class="eyebrow">Usage</span><h3>{usage.quests ? `Used by ${usage.quests} active ${usage.quests === 1 ? "Quest" : "Quests"}` : "Not used by an active Quest"}</h3>{#if usage.tactics}<p>Reused by {usage.tactics} active {usage.tactics === 1 ? "Tactic" : "Tactics"}.</p>{/if}</div><button class="text-action" type="button" on:click={onOpenQuestBoard}>Open Quest Board</button></section>
            <details class="advanced-read" bind:open={advancedOpen}><summary>Advanced</summary><dl><dt>Tactic key</dt><dd><code>{selectedTactic.key}</code></dd></dl></details>
            <footer class="detail-actions"><button class="primary" type="button" on:click={() => startEdit(selectedTactic)}>Edit Tactic</button><button class="archive-action" bind:this={archiveTrigger} type="button" on:click={openArchive}>Archive</button></footer>
          </article>
        {/if}
      </section>
    {:else}
      <section class="flow-editor" aria-label="Tactic flow editor">
        <header class="editor-heading"><div><span class="eyebrow">{mode === "create" ? "New Tactic" : "Edit Tactic"}</span><h2>{draft.name || "Untitled Tactic"}</h2></div><div class="preview-state tone-{validationLabel().tone}" role="status"><strong>{validationLabel().label}</strong><small>{previewState === "loading" ? "Server preview" : "Semantic check"}</small></div></header>
        {#if localIssue}<div class="friendly-error" role="alert">{localIssue}</div>{/if}
        {#if usage.quests && mode === "edit"}<p class="future-run-note">Changes affect future Runs used by {usage.quests} active {usage.quests === 1 ? "Quest" : "Quests"}. Existing Runs keep the Tactic captured when they launched.</p>{/if}
        <fieldset class="metadata-fields"><legend>Tactic</legend><label for="tactic-name">Name</label><input id="tactic-name" value={draft.name} on:input={(event) => updateDraftName(event.currentTarget.value)} placeholder="Implement & Review" /><label for="tactic-description">Description</label><textarea id="tactic-description" value={draft.description} on:input={(event) => (draft = { ...draft, description: event.currentTarget.value })} placeholder="Describe when this approach is useful."></textarea></fieldset>
        <div class="canvas-toolbar"><div><button type="button" on:click={() => addNode("step")}>+ Step</button><button type="button" on:click={() => addNode("sequence")}>+ Sequence</button><button type="button" on:click={() => addNode("parallel")}>+ Parallel</button><button type="button" on:click={() => addNode("until")}>+ Repeat until…</button><button type="button" on:click={() => addNode("use")}>+ Reuse tactic</button></div>{#if selectedNode}<div><button aria-label="Move selected item up" type="button" on:click={() => moveSelected(-1)}>↑ Move up</button><button aria-label="Move selected item down" type="button" on:click={() => moveSelected(1)}>↓ Move down</button><button aria-label="Move selected item into previous group" type="button" on:click={nestSelected}>→ Move into</button><button aria-label="Move selected item out of group" type="button" on:click={unnestSelected}>← Move out</button><button class="remove-node" type="button" on:click={removeSelected}>Remove</button></div>{/if}</div>
        <div class="flow-canvas"><SemanticNode node={draft.body} bindings={previewBindings} tactics={tacticCatalog} interactive selectedPath={selectedNodePath} onSelect={(path) => (selectedPath = path)} /></div>
        {#if previewState === "context"}<section class="context-warning compact-warning"><strong>Requires surrounding context</strong><ul>{#each contextualDetails as item}<li><code>{item.artifact}</code>{item.step ? ` · ${humanizeKey(item.step)}` : ""}</li>{/each}</ul><small>This does not block saving a reusable Tactic.</small></section>{/if}
        {#if previewState === "attention"}<section class="validation-issues" role="alert"><strong>{friendlyPreviewIssue(previewFailure)}</strong>{#each previewFailure?.details ?? [] as issue}<small><code>{issue.code}</code></small>{/each}</section>{/if}
        <footer class="editor-actions"><button class="secondary" type="button" on:click={cancelEdit}>Cancel</button><button class="primary" type="button" disabled={busy || localIssues.length > 0} on:click={saveTactic}>{busy ? "Saving…" : mode === "create" ? "Create Tactic" : "Save Changes"}</button></footer>
      </section>

      <aside class="node-inspector" aria-label="Selected semantic item inspector">
        {#if !selectedNode}<div class="inspector-empty"><h2>Select an item</h2><p>Choose a Step or composition on the plan to edit it.</p></div>
        {:else if selectedNode.type === "step"}
          {@const step = selectedNode as StepNode}
          <header><span class="eyebrow">Step details</span><h2>{step.name || "New Step"}</h2><p>What happens, who performs it, what it needs, and what it produces.</p></header>
          <label for="step-name">Step name</label><input id="step-name" value={step.name} on:input={(event) => setSelectedNode({ ...step, name: event.currentTarget.value })} />
          <label for="step-class">Performed by</label>
          {#if step.performer.selector === "class"}<select id="step-class" value={step.performer.value} on:change={(event) => setSelectedNode({ ...step, performer: { selector: "class", value: event.currentTarget.value } })}>{#each classCatalog.filter((item) => !item.archived_at || item.key === step.performer.value) as role}<option value={role.key}>{role.name}{role.archived_at ? " · Archived" : ""}</option>{/each}</select>{#if classForKey(step.performer.value)}<p class="field-help"><strong>{classForKey(step.performer.value)?.name}</strong> · {classForKey(step.performer.value)?.description}</p>{/if}{#if classForKey(step.performer.value)?.archived_at}<p class="archived-warning">This Tactic preserves an archived Class reference. Choose an active Class for future use.</p>{/if}{:else}<div class="reference-summary">Same Member as {humanizeKey(step.performer.value)}</div>{/if}
          <label for="step-instruction">Instruction</label><textarea id="step-instruction" value={step.instruction} on:input={(event) => setSelectedNode({ ...step, instruction: event.currentTarget.value })} placeholder="Implement the Quest objective."></textarea>
          <section class="artifact-editor"><div class="inspector-section-title"><h3>Uses</h3><button type="button" on:click={() => addArtifact("consumes")}>+ Input</button></div>{#each step.consumes as artifact, index}<div class="artifact-row"><input aria-label={`Input artifact ${index + 1}`} value={artifact.type} on:input={(event) => updateArtifact("consumes", index, { type: event.currentTarget.value })} placeholder="change_set" /><select aria-label={`Source for ${artifact.type || `input ${index + 1}`}`} value={artifact.source ?? ""} on:change={(event) => updateArtifact("consumes", index, { source: event.currentTarget.value || null })}><option value="">Automatic</option>{#each artifactSourceCandidates(artifact.type) as key}<option value={key}>{humanizeKey(key)}</option>{/each}</select><button aria-label={`Remove input ${artifact.type || index + 1}`} type="button" on:click={() => removeArtifact("consumes", index)}>×</button></div>{@const resolvedBinding = previewBindings.find((binding) => binding.consumer.local_key === step.key && binding.artifact_type === artifact.type)}{#if resolvedBinding}<small class="resolved-binding">Resolved: {resolvedBinding.source.kind === "step" ? resolvedBinding.source.step.name ?? humanizeKey(resolvedBinding.source.step.local_key) : "current remediation value"} · {resolvedBinding.selection}</small>{/if}{/each}</section>
          <section class="artifact-editor"><div class="inspector-section-title"><h3>Produces</h3><button type="button" on:click={() => addArtifact("produces")}>+ Output</button></div>{#each step.produces as artifact, index}<div class="artifact-row output"><input aria-label={`Output artifact ${index + 1}`} value={artifact.type} on:input={(event) => updateArtifact("produces", index, { type: event.currentTarget.value })} placeholder="verdict" /><button aria-label={`Remove output ${artifact.type || index + 1}`} type="button" on:click={() => removeArtifact("produces", index)}>×</button></div>{/each}</section>
          <details class="inspector-advanced" bind:open={inspectorAdvanced}><summary>Advanced</summary><fieldset><legend>Performer</legend><label><input type="radio" checked={step.performer.selector === "class"} on:change={() => setSelectedNode({ ...step, performer: { selector: "class", value: classCatalog.find((item) => !item.archived_at)?.key ?? "" } })} /> Any Member with this Class</label><label><input type="radio" checked={step.performer.selector === "same_as"} on:change={() => setSelectedNode({ ...step, performer: { selector: "same_as", value: steps(draft.body).find((item) => item.key !== step.key)?.key ?? "" } })} /> Same Member as</label>{#if step.performer.selector === "same_as"}<select aria-label="Same performer Step" value={step.performer.value} on:change={(event) => setSelectedNode({ ...step, performer: { selector: "same_as", value: event.currentTarget.value } })}>{#each steps(draft.body).filter((item) => item.key !== step.key) as candidate}<option value={candidate.key}>{candidate.name}</option>{/each}</select>{/if}</fieldset><fieldset><legend>Working context</legend><label><input type="radio" checked={step.context.selector === "fresh"} on:change={() => setSelectedNode({ ...step, context: { selector: "fresh", value: null } })} /> Fresh context</label><label><input type="radio" checked={step.context.selector === "continue_from"} on:change={() => setSelectedNode({ ...step, context: { selector: "continue_from", value: steps(draft.body).find((item) => item.key !== step.key)?.key ?? "" } })} /> Continue context from</label>{#if step.context.selector === "continue_from"}<select aria-label="Context source Step" value={step.context.value} on:change={(event) => setSelectedNode({ ...step, context: { selector: "continue_from", value: event.currentTarget.value } })}>{#each steps(draft.body).filter((item) => item.key !== step.key) as candidate}<option value={candidate.key}>{candidate.name}</option>{/each}</select>{/if}</fieldset><label for="step-key">Stable Step key</label><input id="step-key" value={step.key} readonly /></details>
        {:else if selectedNode.type === "until"}
          {@const until = selectedNode as UntilNode}
          <header><span class="eyebrow">Bounded remediation</span><h2>Repeat until accepted</h2><p>The check runs first. If it is not accepted, remediation runs before checking again.</p></header>
          <label for="condition-artifact">Check artifact</label><input id="condition-artifact" value={until.condition.artifact.type} on:input={(event) => setSelectedNode({ ...until, condition: { ...until.condition, artifact: { ...until.condition.artifact, type: event.currentTarget.value } } })} />
          <label for="condition-source">Produced by</label><select id="condition-source" value={until.condition.artifact.source ?? ""} on:change={(event) => setSelectedNode({ ...until, condition: { ...until.condition, artifact: { ...until.condition.artifact, source: event.currentTarget.value || null } } })}><option value="">Automatic</option>{#each steps(until.check) as candidate}<option value={candidate.key}>{candidate.name}</option>{/each}</select>
          <label for="condition-field">Field</label><input id="condition-field" value={until.condition.field} on:input={(event) => setSelectedNode({ ...until, condition: { ...until.condition, field: event.currentTarget.value } })} />
          <label for="condition-value-type">Value type</label><select id="condition-value-type" value={conditionValueType(until.condition.value)} on:change={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: conditionValueForType(event.currentTarget.value) } })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">True / false</option><option value="null">No value</option></select>
          <label for="condition-value">Accepted value</label>{#if typeof until.condition.value === "boolean"}<select id="condition-value" value={String(until.condition.value)} on:change={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: event.currentTarget.value === "true" } })}><option value="true">True</option><option value="false">False</option></select>{:else if until.condition.value === null}<input id="condition-value" value="No value" readonly />{:else}<input id="condition-value" type={typeof until.condition.value === "number" ? "number" : "text"} value={until.condition.value} on:input={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: typeof until.condition.value === "number" ? Number(event.currentTarget.value) : event.currentTarget.value } })} />{/if}
          <label for="max-remediations">Maximum remediations</label><input id="max-remediations" type="number" min="1" value={until.max_remediations} on:input={(event) => setSelectedNode({ ...until, max_remediations: Number(event.currentTarget.value) })} /><p class="field-help">{until.max_remediations} {until.max_remediations === 1 ? "repair" : "repairs"} means the check can run up to {until.max_remediations + 1} times.</p>
        {:else if selectedNode.type === "use"}
          {@const use = selectedNode as TacticUseNode}
          {@const target = referencedTactic(use)}
          <header><span class="eyebrow">Reusable composition</span><h2>{target?.name ?? "Tactic unavailable"}</h2><p>Use another reusable semantic flow here.</p></header>
          <label for="reuse-tactic">Tactic</label><select id="reuse-tactic" value={use.tactic_definition_id} on:change={(event) => setSelectedNode({ ...use, tactic_definition_id: event.currentTarget.value })}>{#each activeTactics.filter((item) => item.id !== draft.id) as tactic}<option value={tactic.id}>{tactic.name}</option>{/each}{#if target?.archived_at}<option value={target.id}>{target.name} · Archived</option>{/if}</select>
          {#if target?.archived_at}<p class="archived-warning">This reference is archived and will not resolve for a future Run.</p>{/if}
          <div class="use-actions"><button type="button" on:click={() => (nestedPreviewOpen = !nestedPreviewOpen)}>{nestedPreviewOpen ? "Hide Preview" : "Preview ▸"}</button><button type="button" disabled={!target} on:click={() => openReferenced(use)}>Open Tactic</button></div>
          {#if nestedPreviewOpen && target}<div class="nested-preview"><SemanticNode node={target.body as unknown as TacticNode} bindings={[]} tactics={tacticCatalog} compact /></div>{/if}
          <details><summary>Advanced</summary><label for="instance-key">Stable instance key</label><input id="instance-key" value={use.instance_key} readonly /></details>
        {:else}
          {@const container = selectedNode as SequenceNode | ParallelNode}
          <header><span class="eyebrow">Composition</span><h2>{container.type === "parallel" ? "At the same time" : "Then, in sequence"}</h2><p>{container.type === "parallel" ? "Every branch starts from the same preceding flow. Continue after all branches complete." : "Each item completes before the next begins."}</p></header>
          <div class="container-summary"><strong>{container.children.length}</strong><span>{container.type === "parallel" ? "branches" : "ordered items"}</span></div>
          <button class="primary inspector-add" type="button" on:click={() => addNode("step")}>{container.type === "parallel" ? "+ Add branch" : "+ Add Step"}</button>
        {/if}
      </aside>
    {/if}
  </div>

  {#if selectedTactic}<dialog bind:this={archiveDialog} on:cancel|preventDefault={closeArchive} aria-labelledby="archive-tactic-title"><div class="dialog-card"><span class="dialog-icon" aria-hidden="true">!</span><h2 id="archive-tactic-title">Archive {selectedTactic.name}?</h2><p>Existing Run history is unaffected.</p><p>{usage.quests || usage.tactics ? `This definition is still referenced by ${usage.quests} active ${usage.quests === 1 ? "Quest" : "Quests"} and ${usage.tactics} active ${usage.tactics === 1 ? "Tactic" : "Tactics"}. Those references may need to be updated before future Runs can launch.` : "It will no longer be available for new reusable selections."}</p><div class="action-row"><button class="secondary" bind:this={archiveCancel} type="button" on:click={closeArchive}>Cancel</button><button class="destructive" type="button" disabled={busy} on:click={confirmArchive}>{busy ? "Archiving…" : "Archive Tactic"}</button></div></div></dialog>{/if}
  <dialog bind:this={dirtyDialog} on:cancel|preventDefault={keepEditing} aria-labelledby="dirty-tactic-title"><div class="dialog-card"><span class="dialog-icon amber" aria-hidden="true">✎</span><h2 id="dirty-tactic-title">Save your Tactic changes?</h2><p>You have unsaved semantic-flow changes. Save them before leaving, keep editing, or discard this complete draft.</p><div class="dirty-actions"><button class="secondary" bind:this={dirtyKeep} type="button" on:click={keepEditing}>Keep Editing</button><button class="secondary" type="button" on:click={discardAndContinue}>Discard</button><button class="primary" type="button" disabled={busy} on:click={saveAndContinue}>{busy ? "Saving…" : mode === "create" ? "Create Tactic" : "Save Changes"}</button></div></div></dialog>
</aside>

<style>
.war-room-window{width:min(86rem,calc(100vw - 1.5rem));height:min(50rem,calc(100vh - 4.5rem))}.war-layout{display:grid;grid-template-columns:minmax(15rem,27%) minmax(0,1fr);height:calc(100% - 5rem);min-height:0}.war-layout.editing{grid-template-columns:minmax(13rem,20%) minmax(25rem,1fr) minmax(18rem,24%)}.tactic-browser{min-width:0;padding:1rem;overflow:hidden;background:linear-gradient(155deg,#e8d0a0,#d4ae73);border-right:2px solid #a87a4e}.browser-heading,.section-heading,.detail-actions,.editor-actions,.inspector-section-title,.header-actions,.editor-heading,.detail-hero,.usage-panel{display:flex;align-items:center;gap:.75rem}.browser-heading h2,.section-heading h3{margin:.05rem 0 0;color:var(--app-ink);font:700 1.2rem Georgia,serif}.count-seal{display:grid;place-items:center;width:2rem;height:2rem;margin-left:auto;color:#fff8e9;background:var(--app-teal);border:2px solid #f7e2b7;border-radius:50%;font-weight:800}.search-field{display:block;margin:.7rem 0}.tactic-list{display:grid;align-content:start;gap:.55rem;max-height:calc(100% - 3.5rem);padding:.2rem;overflow:auto}.tactic-card{display:grid;gap:.25rem;width:100%;min-height:4.2rem;padding:.7rem .8rem;color:var(--app-ink);text-align:left;background:#fff1cc;border:1px solid #af8757;box-shadow:0 2px 5px #72503522}.tactic-card small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tactic-card.selected{background:#fffaf0;border-color:#3f746d;box-shadow:0 0 0 2px #4c817966,0 4px 10px #72503533}.tactic-detail,.flow-editor,.node-inspector{min-width:0;min-height:0;overflow:auto;color:var(--app-ink);background:linear-gradient(145deg,#fff3d2,#f2dba8)}.tactic-detail{padding:1.25rem 1.4rem}.detail-hero{align-items:flex-start;padding-bottom:1rem;border-bottom:1px solid #c59a68}.detail-hero>div{min-width:0;flex:1}.detail-hero h2,.editor-heading h2,.node-inspector h2{margin:.12rem 0;color:#293b39;font:700 2rem Georgia,serif}.detail-hero p{margin:.25rem 0;color:#65726e}.status-chip{padding:.35rem .65rem;border-radius:999px;font-size:.75rem;font-weight:800}.tone-success{background:#d7ebd1;color:#2f6543}.tone-warning{background:#f3dfaa;color:#74541f}.tone-danger{background:#f5cec3;color:#8a443d}.tone-active{background:#cde4df;color:#315f5c}.tone-neutral{background:#e7e2d2;color:#576864}.validation-banner{display:flex;gap:.6rem;align-items:baseline;margin:1rem 0;padding:.7rem .85rem;border-left:5px solid currentColor;border-radius:7px}.validation-banner span{color:#606c68}.read-flow{display:grid;gap:.65rem;margin:1rem 0;padding:1rem;background:#f5e6bf;border:1px solid #c69b67;border-radius:10px}.usage-panel{justify-content:space-between;margin:1rem 0;padding:.9rem 1rem;background:#fff9e9;border:1px solid #c8a171;border-radius:8px}.usage-panel h3{margin:.15rem 0;font:700 1.05rem Georgia,serif}.usage-panel p{margin:.2rem 0}.advanced-read{margin:1rem 0;padding:.65rem;border-top:1px solid #c59a68}.advanced-read dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem}.detail-actions{justify-content:space-between;padding-top:1rem;border-top:1px solid #c59a68}.flow-editor{display:grid;grid-template-rows:auto auto auto minmax(15rem,1fr) auto auto;gap:.65rem;padding:.85rem 1rem}.editor-heading{justify-content:space-between}.editor-heading h2{font-size:1.45rem}.preview-state{display:grid;padding:.4rem .55rem;border-radius:7px;text-align:right}.preview-state small{color:inherit}.future-run-note{margin:0;padding:.55rem .7rem;background:#e1eddc;border-left:4px solid #568467;font-size:.78rem}.metadata-fields{display:grid;grid-template-columns:auto minmax(10rem,1fr);gap:.35rem .6rem;padding:.55rem .7rem;border:1px solid #c49b6d;border-radius:8px}.metadata-fields legend{font-weight:800}.metadata-fields textarea{min-height:3.2rem}.canvas-toolbar{display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap}.canvas-toolbar>div{display:flex;gap:.35rem;flex-wrap:wrap}.canvas-toolbar button{padding:.35rem .5rem;color:#365e59;background:#fff8e8;border:1px solid #9e8060;box-shadow:none;font-size:.74rem}.canvas-toolbar .remove-node{color:#934a43}.flow-canvas{min-height:0;padding:.8rem;overflow:auto;background:linear-gradient(#d8bd87 1px,transparent 1px),linear-gradient(90deg,#d8bd87 1px,transparent 1px),#efd8aa;background-size:24px 24px;border:2px solid #9d7149;border-radius:10px;box-shadow:inset 0 0 18px #6e492c25}.editor-actions{justify-content:flex-end;padding-top:.5rem;border-top:1px solid #bd9463}.node-inspector{padding:1rem;border-left:2px solid #a87a4e;background:#fff8e7}.node-inspector header{padding-bottom:.7rem;border-bottom:1px solid #d0ae80}.node-inspector h2{font-size:1.35rem}.node-inspector header p{color:#68736d;font-size:.78rem}.node-inspector>label,.node-inspector details>label{display:block;margin:.7rem 0 .25rem;font-size:.76rem;font-weight:800}.node-inspector textarea{min-height:6rem}.artifact-editor{margin-top:.9rem;padding-top:.7rem;border-top:1px solid #d4b487}.inspector-section-title{justify-content:space-between}.inspector-section-title h3{margin:0;font:700 1rem Georgia,serif}.inspector-section-title button,.artifact-row button{padding:.2rem .4rem;color:#446b65;background:#fff;border:1px solid #aa8b67;box-shadow:none}.artifact-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(6rem,.8fr) auto;gap:.3rem;margin-top:.4rem}.artifact-row.output{grid-template-columns:minmax(0,1fr) auto}.resolved-binding{display:block;margin:.2rem;color:#3d6e66}.inspector-advanced{margin-top:1rem;padding-top:.7rem;border-top:1px solid #d4b487}.inspector-advanced fieldset{display:grid;gap:.35rem;margin:.7rem 0;padding:.55rem;border:1px solid #d1b184}.inspector-advanced label{font-size:.76rem}.reference-summary,.field-help,.archived-warning{padding:.45rem .55rem;background:#f3e7c8;font-size:.75rem}.archived-warning{color:#8d453f;background:#f5d4ca}.container-summary{display:flex;align-items:baseline;gap:.4rem;margin:1rem 0;padding:1rem;background:#f5e7c6;border:1px solid #c7a475}.container-summary strong{font:700 2rem Georgia,serif}.inspector-add{width:100%}.use-actions{display:flex;gap:.4rem;margin:.8rem 0}.nested-preview{max-height:16rem;padding:.5rem;overflow:auto;background:#f0ddb5;border:1px solid #b88d5b}.context-warning,.validation-issues{margin:.7rem 0;padding:.75rem .85rem;background:#fff0c9;border-left:5px solid #c28a35;border-radius:7px}.context-warning p{margin:.25rem 0}.context-warning li{margin:.25rem 0}.context-warning code{color:#5b5547}.compact-warning{margin:0}.validation-issues{display:grid;gap:.25rem;background:#f8d8cf;border-color:#c45f55}.friendly-error{padding:.65rem .75rem;color:#873f3b;background:#f7d4ca;border-left:5px solid #bd5e56}.empty-state{display:grid;place-items:center;align-content:center;height:100%;text-align:center}.empty-state p{max-width:35rem}.empty-seal{font-size:2rem}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:1050px){.war-layout.editing{grid-template-columns:9.5rem minmax(0,1fr) 15rem}.war-room-window{width:calc(100vw - 1rem)}.tactic-card small{display:none}.canvas-toolbar{flex-wrap:nowrap;overflow-x:auto;padding-bottom:.2rem}.canvas-toolbar>div{flex-wrap:nowrap}.canvas-toolbar button{white-space:nowrap}}@media(max-width:760px){.war-room-window{inset:.4rem;width:calc(100vw - .8rem);height:calc(100vh - .8rem)}.war-layout,.war-layout.editing{grid-template-columns:1fr;grid-template-rows:auto minmax(18rem,1fr) auto}.tactic-browser{max-height:8rem;padding:.55rem;border-right:0;border-bottom:2px solid #a87a4e}.browser-heading{display:none}.tactic-list{display:flex;max-height:7rem;overflow:auto}.tactic-card{min-width:12rem}.node-inspector{max-height:42vh;border-left:0;border-top:2px solid #a87a4e}.metadata-fields{grid-template-columns:1fr}.flow-editor{padding:.65rem}.canvas-toolbar>div:last-child{display:none}}
</style>
