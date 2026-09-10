<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import "../management/management-window.css";
import "./war-room.css";
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
import TacticHeader from "./TacticHeader.svelte";
import TacticInterfaceEditor from "./TacticInterfaceEditor.svelte";
import TacticInterfaceSummary from "./TacticInterfaceSummary.svelte";
import TacticTreeToolbar from "./TacticTreeToolbar.svelte";
import {
  appendChild,
  asJson,
  artifactTypeLabel,
  BUILT_IN_ARTIFACT_KINDS,
  displayNodeName,
  draftFromTactic,
  draftSignature,
  emptyDraft,
  entries,
  generatedTacticKey,
  insertAfter,
  artifactContractLabel,
  isPlanRevisionUntil,
  isReviewRemediationUntil,
  localDraftIssues,
  makeStep,
  makeUntil,
  makeUse,
  moveIntoPrevious,
  moveNode,
  moveOut,
  nodeAt,
  pathKey,
  referencedOutputsForRemoval,
  removeNodeWithSelection,
  replaceNode,
  steps,
  subtreeSize,
  type ArtifactInputDraft,
  type ArtifactOutputDraft,
  type ArtifactRefDraft,
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
type InspectorView = "node" | "interface" | "details";

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
let removeDialog: HTMLDialogElement;
let removeCancel: HTMLButtonElement;
let pendingAction: PendingAction = null;
let pendingRemoval: { name: string; count: number; references: string[] } | null = null;
let inspectorView: InspectorView = "node";
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
$: hasTreeSelection = Boolean(
  selectedNode && !(draft.body.type === "sequence" && !draft.body.children.length),
);
$: canMoveUp = Boolean(selectedNode && moveNode(draft.body, selectedPath, -1).body !== draft.body);
$: canMoveDown = Boolean(selectedNode && moveNode(draft.body, selectedPath, 1).body !== draft.body);
$: canMoveInto = Boolean(selectedNode && moveIntoPrevious(draft.body, selectedPath).body !== draft.body);
$: canMoveOut = Boolean(selectedNode && moveOut(draft.body, selectedPath).body !== draft.body);
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
      "use-delivery": firstPath(
        (node) =>
          node.type === "use" &&
          tacticCatalog.find((item) => item.id === node.tactic_definition_id)?.key ===
            "implement-and-review",
      ),
      "nested-use": firstPath((node) => node.type === "use"),
    };
    selectedPath = scenePath[scene] ?? [];
    inspectorView = scene === "interface" ? "interface" : scene === "details" ? "details" : "node";
    inspectorAdvanced = scene === "step-advanced" || scene === "affinity" || scene === "context";
    nestedPreviewOpen = scene === "nested-use";
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
    inspectorView = "details";
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
    inspectorView = "node";
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
  inspectorView = "node";
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
  inspectorView = "node";
  schedulePreview();
  if (kind === "use") void tick().then(autoBindSelectedUse);
}

function selectNode(path: NodePath) {
  selectedPath = path;
  inspectorView = "node";
  nestedPreviewOpen = false;
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
  if (!selectedNode) return;
  const count = subtreeSize(selectedNode);
  const references = referencedOutputsForRemoval(draft, selectedPath);
  const needsWarning = count > 1 || references.length > 0;
  if (!needsWarning) {
    performRemoval();
    return;
  }
  pendingRemoval = {
    name: displayNodeName(selectedNode, tacticCatalog),
    count,
    references,
  };
  removeDialog.showModal();
  void tick().then(() => removeCancel?.focus());
}

function performRemoval() {
  const result = removeNodeWithSelection(draft.body, selectedPath);
  if (!result.removed) {
    localIssue = "That item could not be removed from its current composition.";
    return;
  }
  draft.body = result.body;
  selectedPath = result.path;
  draft = { ...draft };
  inspectorView = "node";
  nestedPreviewOpen = false;
  pendingRemoval = null;
  removeDialog?.close();
  schedulePreview();
}

function closeRemove() {
  pendingRemoval = null;
  removeDialog.close();
}

function addArtifact(direction: "consumes" | "produces") {
  if (selectedNode?.type !== "step") return;
  const artifact = direction === "consumes"
    ? { name: "input", kind: "", source: null, required: true } satisfies ArtifactInputDraft
    : { name: "result", kind: "", review: null } satisfies ArtifactOutputDraft;
  setSelectedNode({ ...selectedNode, [direction]: [...selectedNode[direction], artifact] });
}

function updateInput(index: number, patch: Partial<ArtifactInputDraft>) {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({ ...selectedNode, consumes: selectedNode.consumes.map((artifact, i) => i === index ? { ...artifact, ...patch } : artifact) });
}
function selectInputSource(index: number, artifact: ArtifactInputDraft, value: string) {
  const source = parseRef(value);
  const port = source?.producer === "$inputs" ? draft.interface.inputs.find((input) => input.key === source.output) : null;
  updateInput(index, { source, required: port ? port.required : artifact.required });
}
function updateOutput(index: number, patch: Partial<ArtifactOutputDraft>) {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({ ...selectedNode, produces: selectedNode.produces.map((artifact, i) => i === index ? { ...artifact, ...patch } : artifact) });
}

function removeArtifact(direction: "consumes" | "produces", index: number) {
  if (selectedNode?.type !== "step") return;
  setSelectedNode({
    ...selectedNode,
    [direction]: selectedNode[direction].filter((_, artifactIndex) => artifactIndex !== index),
  });
}

function refValue(source: ArtifactRefDraft | null): string {
  return source ? `${source.producer}::${source.output}` : "";
}
function parseRef(value: string): ArtifactRefDraft | null {
  const split = value.lastIndexOf("::");
  return split > 0 ? { producer: value.slice(0, split), output: value.slice(split + 2) } : null;
}
function artifactSourceCandidates(kind: string): Array<{ ref: ArtifactRefDraft; label: string }> {
  const all = entries(draft.body);
  const selectedIndex = all.findIndex((entry) => entry.node === selectedNode);
  const upstream = selectedIndex < 0 ? all : all.slice(0, selectedIndex);
  const stepOutputs = upstream.flatMap(({ node }) => node.type === "step"
    ? node.produces.filter((output) => output.kind === kind).map((output) => ({ ref: { producer: node.key, output: output.name }, label: `${node.name} → ${artifactContractLabel(node, output, "produces")}` }))
    : []);
  const useOutputs = upstream.flatMap(({ node }) => {
    if (node.type !== "use") return [];
    const tactic = tacticCatalog.find((item) => item.id === node.tactic_definition_id);
    return (tactic?.interface.outputs ?? []).filter((output) => output.kind === kind).map((output) => ({ ref: { producer: node.instance_key, output: output.key }, label: `${tactic?.name ?? "Reusable Tactic"} → ${output.label}` }));
  });
  const parentInputs = draft.interface.inputs.filter((input) => input.kind === kind).map((input) => ({ ref: { producer: "$inputs", output: input.key }, label: `Tactic Input → ${input.label}` }));
  return [...parentInputs, ...stepOutputs, ...useOutputs];
}

function interfaceOutputCandidates(kind: string): Array<{ ref: ArtifactRefDraft; label: string }> {
  return entries(draft.body).flatMap(({node}) => {
    if (node.type === "step") return node.produces.filter((output) => output.kind === kind).map((output) => ({ref:{producer:node.key,output:output.name},label:`${node.name} → ${artifactContractLabel(node, output, "produces")}`}));
    if (node.type === "use") {
      const tactic = tacticCatalog.find((item) => item.id === node.tactic_definition_id);
      return (tactic?.interface.outputs ?? []).filter((output) => output.kind === kind).map((output) => ({ref:{producer:node.instance_key,output:output.key},label:`${tactic?.name ?? "Reusable Tactic"} → ${output.label}`}));
    }
    return [];
  });
}

function conditionCandidates(until: UntilNode): Array<{ ref: ArtifactRefDraft; label: string; output: ArtifactOutputDraft }> {
  return steps(until.check).flatMap((step) => step.produces.map((output) => ({ ref: { producer: step.key, output: output.name }, label: `${step.name} → ${humanizeKey(output.name)}`, output })));
}

function isBuiltInKind(kind: string): boolean {
  return (BUILT_IN_ARTIFACT_KINDS as readonly string[]).includes(kind);
}
function commonOutputName(kind: string): string {
  if (kind === "quest_plan") return "plan";
  if (kind === "review_verdict") return "verdict";
  if (kind === "change_set") return "change_set";
  return "result";
}

function updateInterface(value: Tactic["interface"]) {
  draft = { ...draft, interface: value };
  schedulePreview();
}

function interfaceInputUses(key: string): string[] {
  return entries(draft.body).flatMap(({ node }) =>
    node.type === "step"
      ? node.consumes.flatMap((input) =>
          input.source?.producer === "$inputs" && input.source.output === key
            ? [`${node.name} → ${humanizeKey(input.name)}`]
            : [],
        )
      : [],
  );
}

function acceptedSubjectCandidates(kind: string): Array<{ gateKey: string; label: string }> {
  const candidates = entries(draft.body).flatMap(({ node }) => {
    if (node.type !== "step") return [];
    return node.produces.flatMap((output) => {
      if (!output.review) return [];
      const subject = node.consumes.find(
        (input) => input.name === output.review?.subject_input,
      );
      return subject?.kind === kind
        ? [{ gateKey: output.review.gate_key, label: gateLabel(output.review.gate_key) }]
        : [];
    });
  });
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((item) => item.gateKey === candidate.gateKey) === index,
  );
}

function gateLabel(gateKey: string): string {
  if (gateKey === "plan_acceptance") return "Plan Acceptance";
  if (gateKey === "implementation_acceptance") return "Implementation Acceptance";
  return humanizeKey(gateKey);
}
function updateUseBinding(use: TacticUseNode, input: string, value: string) {
  const source = parseRef(value);
  const others = use.input_bindings.filter((binding) => binding.input !== input);
  setSelectedNode({ ...use, input_bindings: source ? [...others, { input, source }] : others });
}
function updateUseTarget(use: TacticUseNode, tacticDefinitionId: string) {
  setSelectedNode({ ...use, tactic_definition_id: tacticDefinitionId, input_bindings: [] });
  void tick().then(autoBindSelectedUse);
}
function autoBindSelectedUse() {
  if (selectedNode?.type !== "use") return;
  const target = referencedTactic(selectedNode);
  if (!target) return;
  const suggested = target.interface.inputs.flatMap((port) => {
    const candidates = artifactSourceCandidates(port.kind);
    return candidates.length === 1
      ? [{ input: port.key, source: candidates[0]!.ref }]
      : [];
  });
  if (!suggested.length) return;
  const existingInputs = new Set(selectedNode.input_bindings.map((binding) => binding.input));
  const additions = suggested.filter((binding) => !existingInputs.has(binding.input));
  if (additions.length)
    setSelectedNode({
      ...selectedNode,
      input_bindings: [...selectedNode.input_bindings, ...additions],
    });
}
function useBinding(use: TacticUseNode, input: string): string {
  return refValue(use.input_bindings.find((binding) => binding.input === input)?.source ?? null);
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
      ? await store.api.previewTacticDefinition(draft.id, asJson(draft.body), previewController.signal, draft.interface)
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
          interface: draft.interface,
        })
      : await store.api.createTactic({
          key: draft.key,
          name: draft.name.trim(),
          description: draft.description,
          body: asJson(draft.body),
          interface: draft.interface,
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
        item.id === draft.id ? { ...item, name: draft.name, description: draft.description, body: asJson(draft.body), interface: draft.interface } : item,
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
  const condition = failure.details.find((detail) => detail.code === "invalid_condition_artifact");
  if (condition) return "This condition needs a specific output produced by its Check, such as Review Plan → Verdict.";
  const required = failure.details.find((detail) => detail.code === "missing_required_tactic_input");
  if (required) return "A required reusable Tactic input has not been connected to an earlier artifact.";
  const mismatch = failure.details.find((detail) => detail.code === "incompatible_tactic_input_kind");
  if (mismatch) return "The selected artifact has the wrong type for this Tactic input.";
  const invalid = failure.details.find((detail) => detail.code === "invalid_artifact_source");
  if (invalid) return "This field expects an artifact produced by an earlier Step or reusable Tactic.";
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
            <TacticInterfaceSummary value={selectedTactic.interface} />
            <section class="read-flow" aria-labelledby="semantic-flow-title"><div class="section-heading"><div><span class="eyebrow">Semantic flow</span><h3 id="semantic-flow-title">What the crew will do</h3></div></div><SemanticNode node={(preview?.resolved_tactic ?? selectedTactic.body) as unknown as TacticNode} bindings={previewBindings} tactics={tacticCatalog} /></section>
            <section class="usage-panel"><div><span class="eyebrow">Usage</span><h3>{usage.quests ? `Used by ${usage.quests} active ${usage.quests === 1 ? "Quest" : "Quests"}` : "Not used by an active Quest"}</h3>{#if usage.tactics}<p>Reused by {usage.tactics} active {usage.tactics === 1 ? "Tactic" : "Tactics"}.</p>{/if}</div><button class="text-action" type="button" on:click={onOpenQuestBoard}>Open Quest Board</button></section>
            <details class="advanced-read" bind:open={advancedOpen}><summary>Advanced</summary><dl><dt>Tactic key</dt><dd><code>{selectedTactic.key}</code></dd></dl></details>
            <footer class="detail-actions"><button class="primary" type="button" on:click={() => startEdit(selectedTactic)}>Edit Tactic</button><button class="archive-action" bind:this={archiveTrigger} type="button" on:click={openArchive}>Archive</button></footer>
          </article>
        {/if}
      </section>
    {:else}
      <section class="flow-editor" aria-label="Tactic flow editor">
        <div class="editor-top">
        <TacticHeader name={draft.name} description={draft.description} {mode} status={validationLabel()} onEditDetails={() => (inspectorView = "details")} onEditInterface={() => (inspectorView = "interface")} />
        <TacticInterfaceSummary value={draft.interface} onEdit={() => (inspectorView = "interface")} />
        {#if localIssue}<div class="friendly-error" role="alert">{localIssue}</div>{/if}
        {#if usage.quests && mode === "edit"}<p class="future-run-note">Changes affect future Runs used by {usage.quests} active {usage.quests === 1 ? "Quest" : "Quests"}. Existing Runs keep the Tactic captured when they launched.</p>{/if}
        </div>
        <TacticTreeToolbar hasSelection={hasTreeSelection} {canMoveUp} {canMoveDown} {canMoveInto} {canMoveOut} onAdd={addNode} onMove={moveSelected} onMoveInto={nestSelected} onMoveOut={unnestSelected} onRemove={removeSelected} />
        <div class="flow-canvas">
          {#if draft.body.type === "sequence" && !draft.body.children.length}
            <div class="canvas-empty"><div class="empty-seal" aria-hidden="true">✦</div><h3>No steps yet</h3><p>Build the crew's approach to this Quest.</p><button class="primary" type="button" on:click={() => addNode("step")}>+ Add first Step</button></div>
          {:else}
            <SemanticNode node={draft.body} bindings={previewBindings} tactics={tacticCatalog} interactive selectedPath={selectedNodePath} onSelect={selectNode} />
          {/if}
        </div>
        <div class="editor-bottom">
        {#if previewState === "context"}<section class="context-warning compact-warning"><strong>Requires surrounding context</strong><ul>{#each contextualDetails as item}<li><code>{item.artifact}</code>{item.step ? ` · ${humanizeKey(item.step)}` : ""}</li>{/each}</ul><small>This does not block saving a reusable Tactic.</small></section>{/if}
        {#if previewState === "attention"}<section class="validation-issues" role="alert"><strong>{friendlyPreviewIssue(previewFailure)}</strong>{#each previewFailure?.details ?? [] as issue}<small><code>{issue.code}</code></small>{/each}</section>{/if}
        <footer class="editor-actions"><button class="secondary" type="button" on:click={cancelEdit}>Cancel</button><button class="primary" type="button" disabled={busy || localIssues.length > 0} on:click={saveTactic}>{busy ? "Saving…" : mode === "create" ? "Create Tactic" : "Save Changes"}</button></footer>
        </div>
      </section>

      <aside class="node-inspector" aria-label="Tactic inspector">
        {#if inspectorView === "details"}
          <header><span class="eyebrow">Tactic</span><h2>Details</h2><p>Name this reusable approach. You can return to the tree at any time.</p></header>
          <div class="inspector-fields">
            <label for="tactic-name">Name</label><input id="tactic-name" value={draft.name} on:input={(event) => updateDraftName(event.currentTarget.value)} placeholder="Plan & Review" />
            <label for="tactic-description">Description</label><textarea id="tactic-description" value={draft.description} on:input={(event) => (draft = { ...draft, description: event.currentTarget.value })} placeholder="Describe when this approach is useful."></textarea>
          </div>
          <details class="inspector-advanced"><summary>Advanced</summary><label for="tactic-key">Stable Tactic key</label><input id="tactic-key" value={draft.key} readonly /></details>
          {#if selectedNode}<button class="inspector-return" type="button" on:click={() => (inspectorView = "node")}>Return to selected item</button>{/if}
        {:else if inspectorView === "interface"}
          <TacticInterfaceEditor value={draft.interface} outputCandidates={interfaceOutputCandidates} acceptedCandidates={acceptedSubjectCandidates} inputUses={interfaceInputUses} onChange={updateInterface} />
          {#if selectedNode}<button class="inspector-return" type="button" on:click={() => (inspectorView = "node")}>Return to selected item</button>{/if}
        {:else if !selectedNode}<div class="inspector-empty"><h2>Select an item</h2><p>Choose a Step or composition on the plan to edit it.</p><button type="button" on:click={() => (inspectorView = "interface")}>Edit Tactic Interface</button></div>
        {:else if selectedNode.type === "step"}
          {@const step = selectedNode as StepNode}
          <header><span class="eyebrow">Step details</span><h2>{step.name || "New Step"}</h2><p>What happens, who performs it, what it needs, and what it produces.</p></header>
          <div class="inspector-fields">
          <label for="step-name">Step name</label><input id="step-name" value={step.name} on:input={(event) => setSelectedNode({ ...step, name: event.currentTarget.value })} />
          <label for="step-class">Performed by</label>
          {#if step.performer.selector === "class"}<select id="step-class" value={step.performer.value} on:change={(event) => setSelectedNode({ ...step, performer: { selector: "class", value: event.currentTarget.value } })}>{#each classCatalog.filter((item) => !item.archived_at || item.key === step.performer.value) as role}<option value={role.key}>{role.name}{role.archived_at ? " · Archived" : ""}</option>{/each}</select>{#if classForKey(step.performer.value)}<p class="field-help"><strong>{classForKey(step.performer.value)?.name}</strong> · {classForKey(step.performer.value)?.description}</p>{/if}{#if classForKey(step.performer.value)?.archived_at}<p class="archived-warning">This Tactic preserves an archived Class reference. Choose an active Class for future use.</p>{/if}{:else}<div class="reference-summary">Same Member as {humanizeKey(step.performer.value)}</div>{/if}
          <label for="step-instruction">Instruction</label><textarea id="step-instruction" value={step.instruction} on:input={(event) => setSelectedNode({ ...step, instruction: event.currentTarget.value })} placeholder="Implement the Quest objective."></textarea>
          </div>
          <section class="artifact-editor"><div class="inspector-section-title"><h3>Uses</h3><button type="button" on:click={() => addArtifact("consumes")}>+ Input</button></div>{#each step.consumes as artifact, index}<div class="artifact-contract-label">{artifactContractLabel(step, artifact, "consumes")}</div><div class="artifact-row"><select aria-label={`Input type ${index + 1}`} value={artifact.kind} on:change={(event) => updateInput(index, { kind: event.currentTarget.value })}><option value="">Choose type…</option>{#each BUILT_IN_ARTIFACT_KINDS as kind}<option value={kind}>{artifactTypeLabel(kind)}</option>{/each}{#if artifact.kind && !isBuiltInKind(artifact.kind)}<option value={artifact.kind}>{artifactTypeLabel(artifact.kind)}</option>{/if}</select><select aria-label={`Source for ${artifact.name || `input ${index + 1}`}`} value={refValue(artifact.source)} on:change={(event) => selectInputSource(index, artifact, event.currentTarget.value)}><option value="">Automatic · only compatible value</option>{#each artifactSourceCandidates(artifact.kind) as candidate}<option value={refValue(candidate.ref)}>{candidate.label}</option>{/each}</select><button aria-label={`Remove input ${artifact.name || index + 1}`} type="button" on:click={() => removeArtifact("consumes", index)}>×</button></div><details><summary>Advanced</summary><span class="field-label">Input slot</span><input value={artifact.name} on:input={(event) => updateInput(index, {name:event.currentTarget.value})} /><span class="field-label">Custom artifact kind</span><input aria-label={`Custom input kind ${index + 1}`} value={artifact.kind} on:input={(event) => updateInput(index, {kind:event.currentTarget.value})} /><label><input type="checkbox" checked={!artifact.required} on:change={(event) => updateInput(index, {required:!event.currentTarget.checked})} /> Omit when unavailable</label></details>{@const resolvedBinding = previewBindings.find((binding) => binding.consumer.local_key === step.key && binding.input_name === artifact.name)}{#if resolvedBinding}<small class="resolved-binding">Resolved: {resolvedBinding.source.kind === "step" ? resolvedBinding.source.step.name ?? humanizeKey(resolvedBinding.source.step.local_key) : "current loop-carried value"}</small>{/if}{/each}</section>
          <section class="artifact-editor"><div class="inspector-section-title"><h3>Produces</h3><button type="button" on:click={() => addArtifact("produces")}>+ Output</button></div>{#each step.produces as artifact, index}<div class="artifact-contract-label">{humanizeKey(artifact.name)} · {artifactContractLabel(step, artifact, "produces")}</div><div class="artifact-row output"><select aria-label={`Output type ${index + 1}`} value={artifact.kind} on:change={(event) => updateOutput(index, { kind: event.currentTarget.value, name: artifact.name === "result" ? commonOutputName(event.currentTarget.value) : artifact.name, review: event.currentTarget.value === "review_verdict" ? (artifact.review ?? {gate_key:"implementation_acceptance",subject_input:step.consumes[0]?.name ?? "subject"}) : null })}><option value="">Choose type…</option>{#each BUILT_IN_ARTIFACT_KINDS as kind}<option value={kind}>{artifactTypeLabel(kind)}</option>{/each}{#if artifact.kind && !isBuiltInKind(artifact.kind)}<option value={artifact.kind}>{artifactTypeLabel(artifact.kind)}</option>{/if}</select><button aria-label={`Remove output ${artifact.name || index + 1}`} type="button" on:click={() => removeArtifact("produces", index)}>×</button></div><details><summary>Advanced</summary><span class="field-label">Output slot</span><input value={artifact.name} on:input={(event) => updateOutput(index, {name:event.currentTarget.value})} /><span class="field-label">Custom artifact kind</span><input aria-label={`Custom output kind ${index + 1}`} value={artifact.kind} on:input={(event) => updateOutput(index, {kind:event.currentTarget.value})} />{#if artifact.review}<span class="field-label">Acceptance gate</span><select value={artifact.review.gate_key} on:change={(event) => updateOutput(index, {review:{...artifact.review!,gate_key:event.currentTarget.value}})}><option value="plan_acceptance">Plan Acceptance</option><option value="implementation_acceptance">Implementation Acceptance</option></select><span class="field-label">Reviewed input</span><select value={artifact.review.subject_input} on:change={(event) => updateOutput(index, {review:{...artifact.review!,subject_input:event.currentTarget.value}})}>{#each step.consumes as input}<option value={input.name}>{humanizeKey(input.name)}</option>{/each}</select>{/if}</details>{/each}</section>
          <details class="inspector-advanced" bind:open={inspectorAdvanced}><summary>Advanced</summary><fieldset><legend>Performer</legend><label><input type="radio" checked={step.performer.selector === "class"} on:change={() => setSelectedNode({ ...step, performer: { selector: "class", value: classCatalog.find((item) => !item.archived_at)?.key ?? "" } })} /> Any Member with this Class</label><label><input type="radio" checked={step.performer.selector === "same_as"} on:change={() => setSelectedNode({ ...step, performer: { selector: "same_as", value: steps(draft.body).find((item) => item.key !== step.key)?.key ?? "" } })} /> Same Member as</label>{#if step.performer.selector === "same_as"}<select aria-label="Same performer Step" value={step.performer.value} on:change={(event) => setSelectedNode({ ...step, performer: { selector: "same_as", value: event.currentTarget.value } })}>{#each steps(draft.body).filter((item) => item.key !== step.key) as candidate}<option value={candidate.key}>{candidate.name}</option>{/each}</select>{/if}</fieldset><fieldset><legend>Working context</legend><label><input type="radio" checked={step.context.selector === "fresh"} on:change={() => setSelectedNode({ ...step, context: { selector: "fresh", value: null } })} /> Fresh context</label><label><input type="radio" checked={step.context.selector === "continue_from"} on:change={() => setSelectedNode({ ...step, context: { selector: "continue_from", value: steps(draft.body).find((item) => item.key !== step.key)?.key ?? "" } })} /> Continue context from</label>{#if step.context.selector === "continue_from"}<select aria-label="Context source Step" value={step.context.value} on:change={(event) => setSelectedNode({ ...step, context: { selector: "continue_from", value: event.currentTarget.value } })}>{#each steps(draft.body).filter((item) => item.key !== step.key) as candidate}<option value={candidate.key}>{candidate.name}</option>{/each}</select>{/if}</fieldset><label for="step-key">Stable Step key</label><input id="step-key" value={step.key} readonly /></details>
        {:else if selectedNode.type === "until"}
          {@const until = selectedNode as UntilNode}
          <header><span class="eyebrow">Bounded remediation</span><h2>Repeat until accepted</h2><p>The check runs first. If it is not accepted, remediation runs before checking again.</p></header>
          <div class="until-summary"><div><span>Review step</span><strong>{nodeLabel(until.check)}</strong></div><div><span>Otherwise</span><strong>{nodeLabel(until.otherwise)}</strong></div></div>
          <label for="condition-source">Condition</label><select id="condition-source" value={refValue(until.condition.source)} on:change={(event) => { const source = parseRef(event.currentTarget.value); if (source) setSelectedNode({ ...until, condition: { ...until.condition, source } }); }}><option value="">Choose a produced output…</option>{#each conditionCandidates(until) as candidate}<option value={refValue(candidate.ref)}>{candidate.label}</option>{/each}</select>
          {@const semanticCondition = conditionCandidates(until).find((candidate) => refValue(candidate.ref) === refValue(until.condition.source))?.output.review}
          {#if semanticCondition}<p class="field-help"><strong>{semanticCondition.gate_key === "plan_acceptance" ? "Until Quest Plan is accepted" : "Until Implementation is accepted"}</strong><br />The Review Verdict is scoped to the exact reviewed artifact and {semanticCondition.gate_key === "plan_acceptance" ? "Plan Acceptance" : "Implementation Acceptance"}.</p>{/if}
          <details class="inspector-advanced"><summary>Advanced condition</summary>
          <label for="condition-field">Field</label><input id="condition-field" value={until.condition.field} on:input={(event) => setSelectedNode({ ...until, condition: { ...until.condition, field: event.currentTarget.value } })} />
          <label for="condition-value-type">Value type</label><select id="condition-value-type" value={conditionValueType(until.condition.value)} on:change={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: conditionValueForType(event.currentTarget.value) } })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">True / false</option><option value="null">No value</option></select>
          <label for="condition-value">Accepted value</label>{#if typeof until.condition.value === "boolean"}<select id="condition-value" value={String(until.condition.value)} on:change={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: event.currentTarget.value === "true" } })}><option value="true">True</option><option value="false">False</option></select>{:else if until.condition.value === null}<input id="condition-value" value="No value" readonly />{:else}<input id="condition-value" type={typeof until.condition.value === "number" ? "number" : "text"} value={until.condition.value} on:input={(event) => setSelectedNode({ ...until, condition: { ...until.condition, value: typeof until.condition.value === "number" ? Number(event.currentTarget.value) : event.currentTarget.value } })} />{/if}</details>
          {@const reviewRemediation = isReviewRemediationUntil(until)}
          {@const planRevision = isPlanRevisionUntil(until)}
          <label for="max-remediations">{planRevision ? "Maximum plan revisions" : reviewRemediation ? "Maximum repairs" : "Maximum iterations"}</label><input id="max-remediations" type="number" min="1" step="1" required value={until.max_remediations} on:input={(event) => setSelectedNode({ ...until, max_remediations: Number(event.currentTarget.value) })} /><p class="field-help">{until.max_remediations} {planRevision ? until.max_remediations === 1 ? "plan revision" : "plan revisions" : reviewRemediation ? until.max_remediations === 1 ? "repair" : "repairs" : until.max_remediations === 1 ? "remediation iteration" : "remediation iterations"} means the initial check may be followed by exactly that many remediation opportunities and up to {until.max_remediations + 1} total checks. Operational retries do not consume this limit.</p>
        {:else if selectedNode.type === "use"}
          {@const use = selectedNode as TacticUseNode}
          {@const target = referencedTactic(use)}
          <header><span class="eyebrow">Reusable composition</span><h2>{target?.name ?? "Tactic unavailable"}</h2><p>Use another reusable semantic flow here.</p></header>
          <label for="reuse-tactic">Tactic</label><select id="reuse-tactic" value={use.tactic_definition_id} on:change={(event) => updateUseTarget(use, event.currentTarget.value)}>{#each activeTactics.filter((item) => item.id !== draft.id) as tactic}<option value={tactic.id}>{tactic.name}</option>{/each}{#if target?.archived_at}<option value={target.id}>{target.name} · Archived</option>{/if}</select>
          {#if target?.archived_at}<p class="archived-warning">This reference is archived and will not resolve for a future Run.</p>{/if}
          {#if target}<section class="artifact-editor use-contract"><div class="inspector-section-title"><h3>Inputs</h3></div>{#each target.interface.inputs as port}<div class="use-port"><div><strong>{port.label}</strong><small>{artifactTypeLabel(port.kind)} · {port.required ? "Required" : "Optional"}</small></div><label>Source<select aria-label={`Binding for ${port.label}`} value={useBinding(use, port.key)} on:change={(event) => updateUseBinding(use, port.key, event.currentTarget.value)}><option value="">{port.required ? "Choose an upstream artifact…" : "Not connected · Optional"}</option>{#each artifactSourceCandidates(port.kind) as candidate}<option value={refValue(candidate.ref)}>{candidate.label}</option>{/each}</select></label>{#if !artifactSourceCandidates(port.kind).length}<p>Create a compatible upstream output before connecting this input.</p>{/if}</div>{:else}<p class="contract-empty">Inputs · None</p>{/each}<div class="inspector-section-title output-title"><h3>Outputs</h3></div>{#each target.interface.outputs as port}<div class="use-output"><strong>{port.label}</strong><span>{artifactTypeLabel(port.kind)}</span></div>{:else}<p class="contract-empty">Outputs · None</p>{/each}</section>{/if}
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
  <dialog bind:this={removeDialog} on:cancel|preventDefault={closeRemove} aria-labelledby="remove-node-title"><div class="dialog-card"><span class="dialog-icon" aria-hidden="true">!</span><h2 id="remove-node-title">Remove {pendingRemoval?.name ?? "item"}?</h2>{#if (pendingRemoval?.count ?? 0) > 1}<p>This also removes {pendingRemoval!.count - 1} nested {(pendingRemoval!.count - 1) === 1 ? "item" : "items"}.</p>{/if}{#if pendingRemoval?.references.length}<p>The removal will leave {pendingRemoval.references.length === 1 ? "this reference" : "these references"} incomplete: {pendingRemoval.references.join(", ")}.</p>{/if}<p>The draft will remain open so validation can guide repairs.</p><div class="action-row"><button class="secondary" bind:this={removeCancel} type="button" on:click={closeRemove}>Keep item</button><button class="destructive" type="button" on:click={performRemoval}>Remove subtree</button></div></div></dialog>
  <dialog bind:this={dirtyDialog} on:cancel|preventDefault={keepEditing} aria-labelledby="dirty-tactic-title"><div class="dialog-card"><span class="dialog-icon amber" aria-hidden="true">✎</span><h2 id="dirty-tactic-title">Save your Tactic changes?</h2><p>You have unsaved semantic-flow changes. Save them before leaving, keep editing, or discard this complete draft.</p><div class="dirty-actions"><button class="secondary" bind:this={dirtyKeep} type="button" on:click={keepEditing}>Keep Editing</button><button class="secondary" type="button" on:click={discardAndContinue}>Discard</button><button class="primary" type="button" disabled={busy} on:click={saveAndContinue}>{busy ? "Saving…" : mode === "create" ? "Create Tactic" : "Save Changes"}</button></div></div></dialog>
</aside>
