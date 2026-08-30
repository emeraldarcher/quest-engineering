<script lang="ts">
import { onDestroy, onMount, tick, type Component } from "svelte";
import type {
  ArtifactDetail,
  ClassDefinition,
  JsonValue,
  Loadout,
  Quest,
  Reasoning,
  Squad,
  Workspace,
  WorkspaceAccess,
} from "./api/contracts";
import TownCanvas from "./components/TownCanvas.svelte";
import ValidationSummary from "./components/ValidationSummary.svelte";
import { openPullRequest } from "./platform/open-pull-request";
import { createStarterCrew } from "./domain/starter-crew";
import type { AppStore, BuildingId } from "./state/app-store";

export let store: AppStore;
const {
  product: productStore,
  selectedBuilding: selectedBuildingStore,
  selectedRun: selectedRunStore,
  world: worldStore,
  loading: loadingStore,
  error: errorStore,
  realtimeStatus: realtimeStatusStore,
  bootstrapRunning: bootstrapRunningStore,
} = store;
let workspaceDraft: { key: string; name: string; source_kind: "git_remote" | "local_git"; source_fingerprint: string } = {
  key: "",
  name: "",
  source_kind: "local_git",
  source_fingerprint: "",
};
let classDraft = { key: "", name: "", description: "", instructions: "" };
let loadoutDraft: {
  key: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoning: Reasoning;
  tools: string;
  workspace_access: WorkspaceAccess;
} = {
  key: "",
  name: "",
  description: "",
  provider: "",
  model: "",
  reasoning: "medium",
  tools: "workspace.filesystem",
  workspace_access: "read_write",
};
let squadDraft: {
  id?: string;
  key: string;
  name: string;
  description: string;
  members: Array<{
    member_key: string;
    name: string;
    class_id: string;
    loadout_id: string;
  }>;
} = { key: "", name: "", description: "", members: [] };
let questDraft: {
  id?: string;
  title: string;
  objective: string;
  workspace_id: string;
  squad_id: string;
  tactic_definition_id: string;
} = {
  title: "",
  objective: "",
  workspace_id: "",
  squad_id: "",
  tactic_definition_id: "",
};
let selectedWorkspace: Workspace | null = null;
let selectedWorkspaceSource = "";
let selectedClass: ClassDefinition | null = null;
let selectedLoadout: Loadout | null = null;
let selectedSquad: Squad | null = null;
let selectedQuest: Quest | null = null;
let preview: unknown = null;
let selectedMemberKey: string | null = null;
let artifact: ArtifactDetail | null = null;
let starterOption = "";
let starterWorkspace = "";
let previousFocus: HTMLElement | null = null;
let journalOpen = new URLSearchParams(location.search).get("journal") === "1";
let FixtureChooserComponent: Component | null = null;

onMount(async () => {
  if (import.meta.env.DEV)
    FixtureChooserComponent = (await import("./components/FixtureChooser.svelte")).default;
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  const params = new URLSearchParams(location.search);
  const fixtureBuilding = (params.get("window") ?? params.get("building")) as BuildingId | null;
  if (buildings.some((item) => item.id === fixtureBuilding)) selectBuilding(fixtureBuilding as BuildingId);
  if (store.fixture?.name === "member-inspector") selectedMemberKey = "member-1";
  await store.loadProduct();
  if (store.fixture && fixtureBuilding === "gatehouse" && product.workspaces[0]) editWorkspace(product.workspaces[0]);
  if (store.fixture && fixtureBuilding === "guild" && product.classes[0]) editClass(product.classes[0]);
  if (store.fixture && fixtureBuilding === "blacksmith" && product.loadouts[0]) editLoadout(product.loadouts[0]);
  if (store.fixture && fixtureBuilding === "tavern" && product.squads[0]) editSquad(product.squads[0]);
  if (store.fixture && fixtureBuilding === "quest-board" && product.quests[0]) editQuest(product.quests[0]);
  const match = location.hash.match(/^#\/run\/(.+)$/);
  if (match?.[1]) await store.selectRun(decodeURIComponent(match[1]));
});
onDestroy(() => {
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  store.dispose();
});

const buildings: Array<{ id: BuildingId; label: string; hotkey: string }> = [
  { id: "gatehouse", label: "Wayfinder", hotkey: "1" },
  { id: "guild", label: "Guild Hall", hotkey: "2" },
  { id: "blacksmith", label: "Forge", hotkey: "3" },
  { id: "tavern", label: "Tavern", hotkey: "4" },
  { id: "quest-board", label: "Quest Board", hotkey: "5" },
  { id: "work-area", label: "Work Yard", hotkey: "6" },
];
$: product = $productStore;
$: {
  const freshQuest = selectedQuest && product.quests.find((item) => item.id === selectedQuest?.id);
  if (freshQuest && freshQuest !== selectedQuest) selectedQuest = freshQuest;
  const freshProject = selectedWorkspace && product.workspaces.find((item) => item.id === selectedWorkspace?.id);
  if (freshProject && freshProject !== selectedWorkspace) selectedWorkspace = freshProject;
}
$: run = $selectedRunStore;
$: world = $worldStore;
$: townStatus = {
  preparingReview: product.quests.filter((quest) => quest.lifecycle.state === "preparing_review").length,
  awaitingReview: product.quests.filter((quest) => quest.lifecycle.state === "awaiting_review").length,
  attention: product.quests.filter((quest) => quest.lifecycle.state === "needs_attention").length,
  complete: product.quests.filter((quest) => quest.lifecycle.state === "complete").length,
};
$: selectedOption =
  product.executionOptions.find(
    (option) => optionKey(option) === starterOption,
  ) ?? null;
$: member =
  run?.squad.members.find((item) => item.member_key === selectedMemberKey) ??
  null;
$: memberSteps =
  run?.steps.filter((step) => step.member?.member_key === selectedMemberKey) ?? [];
$: memberStep =
  memberSteps.find((step) =>
    ["scheduled", "running", "failed", "uncertain"].includes(step.state),
  ) ?? memberSteps.at(-1) ?? null;
$: memberIsActive =
  memberStep !== null && ["scheduled", "running", "uncertain"].includes(memberStep.state);

function handleUnhandledRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
  store.reportError(event.reason);
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if ($selectedBuildingStore) requestCloseWindow();
    else journalOpen = false;
    return;
  }
  if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
  const building = buildings.find((item) => item.hotkey === event.key);
  if (building) selectBuilding(building.id);
}

function selectBuilding(id: BuildingId) {
  if ($selectedBuildingStore && $selectedBuildingStore !== id && isWindowDirty() &&
      !confirm("Discard unsaved changes and open another management window?")) return;
  if (!$selectedBuildingStore)
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  store.selectBuildingId(id);
  preview = null;
  artifact = null;
  void tick().then(() => document.querySelector<HTMLElement>(".panel input:not([disabled]), .panel select, .panel button")?.focus());
}
function isWindowDirty() {
  if ($selectedBuildingStore === "gatehouse") {
    if (!selectedWorkspace) return !!(workspaceDraft.key || workspaceDraft.name || workspaceDraft.source_fingerprint);
    return JSON.stringify(workspaceDraft) !== JSON.stringify({
      key: selectedWorkspace.key, name: selectedWorkspace.name,
      source_kind: selectedWorkspace.source_kind,
      source_fingerprint: selectedWorkspace.source_fingerprint ?? "",
    });
  }
  if ($selectedBuildingStore === "guild") {
    if (!selectedClass) return Object.values(classDraft).some(Boolean);
    return JSON.stringify(classDraft) !== JSON.stringify({
      key: selectedClass.key, name: selectedClass.name,
      description: selectedClass.description, instructions: selectedClass.instructions,
    });
  }
  if ($selectedBuildingStore === "blacksmith") {
    if (!selectedLoadout) return !!(loadoutDraft.key || loadoutDraft.name || loadoutDraft.description || loadoutDraft.provider || loadoutDraft.model);
    return JSON.stringify(loadoutDraft) !== JSON.stringify({
      key: selectedLoadout.key, name: selectedLoadout.name,
      description: selectedLoadout.description,
      provider: selectedLoadout.model.provider, model: selectedLoadout.model.model,
      reasoning: selectedLoadout.reasoning,
      tools: selectedLoadout.tools.join(", "),
      workspace_access: selectedLoadout.workspace_access,
    });
  }
  if ($selectedBuildingStore === "tavern") {
    if (!selectedSquad) return !!(squadDraft.key || squadDraft.name || squadDraft.description || squadDraft.members.length);
    return JSON.stringify(squadDraft) !== JSON.stringify({
      id: selectedSquad.id, key: selectedSquad.key, name: selectedSquad.name,
      description: selectedSquad.description,
      members: selectedSquad.members.map((item) => ({ ...item })),
    });
  }
  if ($selectedBuildingStore === "quest-board") {
    if (!selectedQuest) return !!(questDraft.title || questDraft.objective);
    if (selectedQuest.tactic_source.type === "inline") return false;
    return JSON.stringify(questDraft) !== JSON.stringify({
      id: selectedQuest.id, title: selectedQuest.title,
      objective: selectedQuest.objective,
      workspace_id: selectedQuest.workspace_id,
      squad_id: selectedQuest.squad_id,
      tactic_definition_id: selectedQuest.tactic_source.tactic_definition_id,
    });
  }
  return false;
}
function requestCloseWindow() {
  if (isWindowDirty() && !confirm("Discard unsaved changes and close this window?")) return;
  store.selectBuildingId(null);
  void tick().then(() => previousFocus?.focus());
}
function selectMember(key: string) {
  selectedMemberKey = key;
  selectBuilding("work-area");
}
async function openJournalRun(id: string) {
  await store.selectRun(id);
  journalOpen = false;
  selectBuilding("work-area");
}
function newWorkspace() {
  selectedWorkspace = null;
  selectedWorkspaceSource = "";
  workspaceDraft = { key: "", name: "", source_kind: "local_git", source_fingerprint: "" };
}
function chooseWorkspaceSource(candidateId: string) {
  selectedWorkspaceSource = candidateId;
  if (selectedWorkspace) return;
  const source = product.workspaceSources.find((item) => item.candidate_id === candidateId);
  if (!source) return;
  workspaceDraft = {
    ...workspaceDraft,
    key: workspaceDraft.key || source.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: workspaceDraft.name || source.name,
    source_kind: source.source_kind,
    source_fingerprint: source.source_fingerprint ?? "",
  };
}
function editWorkspace(value: Workspace) {
  selectedWorkspace = value;
  workspaceDraft = {
    key: value.key,
    name: value.name,
    source_kind: value.source_kind,
    source_fingerprint: value.source_fingerprint ?? "",
  };
}
async function saveWorkspace() {
  const input = {
    key: workspaceDraft.key,
    name: workspaceDraft.name,
    source_kind: workspaceDraft.source_kind,
    source_fingerprint: workspaceDraft.source_fingerprint || null,
  };
  if (selectedWorkspace) {
    await store.api.updateWorkspace(selectedWorkspace.id, input);
  } else {
    const workspace = await store.api.createWorkspace(input);
    if (selectedWorkspaceSource)
      await store.api.bindWorkspaceSource(workspace.id, selectedWorkspaceSource);
  }
  await store.refreshProduct();
  newWorkspace();
}
async function bindWorkspaceSource() {
  if (!selectedWorkspace || !selectedWorkspaceSource) return;
  await store.api.bindWorkspaceSource(selectedWorkspace.id, selectedWorkspaceSource);
  selectedWorkspaceSource = "";
  await store.refreshProduct();
}
async function archiveWorkspace() {
  if (selectedWorkspace && confirm(`Archive ${selectedWorkspace.name}?`)) {
    await store.api.archiveWorkspace(selectedWorkspace.id);
    await store.refreshProduct();
    newWorkspace();
  }
}

function newClass() {
  selectedClass = null;
  classDraft = { key: "", name: "", description: "", instructions: "" };
}
function editClass(value: ClassDefinition) {
  selectedClass = value;
  classDraft = {
    key: value.key,
    name: value.name,
    description: value.description,
    instructions: value.instructions,
  };
}
async function saveClass() {
  if (selectedClass) await store.api.updateClass(selectedClass.id, classDraft);
  else await store.api.createClass(classDraft);
  await store.refreshProduct();
  newClass();
}
async function archiveClass() {
  if (selectedClass && confirm(`Archive ${selectedClass.name}?`)) {
    await store.api.archiveClass(selectedClass.id);
    await store.refreshProduct();
    newClass();
  }
}

function applyExecutionOption(key: string) {
  const option = product.executionOptions.find(
    (item) => optionKey(item) === key,
  );
  if (!option) return;
  const access = option.workspaces.some((workspace) =>
    workspace.workspace_access.includes("read_write"),
  )
    ? "read_write"
    : option.workspaces.some((workspace) =>
          workspace.workspace_access.includes("read_only"),
        )
      ? "read_only"
      : "none";
  loadoutDraft = {
    ...loadoutDraft,
    provider: option.model.provider,
    model: option.model.model,
    reasoning: option.reasoning.includes("medium")
      ? "medium"
      : (option.reasoning[0] ?? "low"),
    tools: option.tools.join(", "),
    workspace_access: access,
  };
}
function newLoadout() {
  selectedLoadout = null;
  loadoutDraft = {
    key: "",
    name: "",
    description: "",
    provider: selectedOption?.model.provider ?? "",
    model: selectedOption?.model.model ?? "",
    reasoning: "medium",
    tools: "workspace.filesystem",
    workspace_access: "read_write",
  };
}
function editLoadout(value: Loadout) {
  selectedLoadout = value;
  loadoutDraft = {
    key: value.key,
    name: value.name,
    description: value.description,
    provider: value.model.provider,
    model: value.model.model,
    reasoning: value.reasoning,
    tools: value.tools.join(", "),
    workspace_access: value.workspace_access,
  };
}
async function saveLoadout() {
  const input = {
    key: loadoutDraft.key,
    name: loadoutDraft.name,
    description: loadoutDraft.description,
    model: { provider: loadoutDraft.provider, model: loadoutDraft.model },
    reasoning: loadoutDraft.reasoning,
    tools: loadoutDraft.tools
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    workspace_access: loadoutDraft.workspace_access,
  };
  if (selectedLoadout) await store.api.updateLoadout(selectedLoadout.id, input);
  else await store.api.createLoadout(input);
  await store.refreshProduct();
  newLoadout();
}
async function archiveLoadout() {
  if (selectedLoadout && confirm(`Archive ${selectedLoadout.name}?`)) {
    await store.api.archiveLoadout(selectedLoadout.id);
    await store.refreshProduct();
    newLoadout();
  }
}

function newSquad() {
  selectedSquad = null;
  squadDraft = { key: "", name: "", description: "", members: [] };
}
function editSquad(value: Squad) {
  selectedSquad = value;
  squadDraft = {
    id: value.id,
    key: value.key,
    name: value.name,
    description: value.description,
    members: value.members.map((item) => ({ ...item })),
  };
}
function addMember() {
  const classId = product.classes[0]?.id ?? "";
  const loadoutId = product.loadouts[0]?.id ?? "";
  squadDraft.members = [
    ...squadDraft.members,
    {
      member_key: `member-${squadDraft.members.length + 1}`,
      name: "New Member",
      class_id: classId,
      loadout_id: loadoutId,
    },
  ];
}
function moveMember(index: number, direction: number) {
  const next = index + direction;
  if (next < 0 || next >= squadDraft.members.length) return;
  const members = [...squadDraft.members];
  const current = members[index];
  const other = members[next];
  if (!current || !other) return;
  members[index] = other;
  members[next] = current;
  squadDraft.members = members;
}
async function saveSquad() {
  const input = {
    key: squadDraft.key,
    name: squadDraft.name,
    description: squadDraft.description,
    members: squadDraft.members,
  };
  if (selectedSquad) await store.api.updateSquad(selectedSquad.id, input);
  else await store.api.createSquad(input);
  await store.refreshProduct();
  newSquad();
}
async function archiveSquad() {
  if (selectedSquad && confirm(`Archive ${selectedSquad.name}?`)) {
    await store.api.archiveSquad(selectedSquad.id);
    await store.refreshProduct();
    newSquad();
  }
}

function newQuest() {
  selectedQuest = null;
  questDraft = {
    title: "",
    objective: "",
    workspace_id: product.workspaces[0]?.id ?? "",
    squad_id: product.squads[0]?.id ?? "",
    tactic_definition_id: product.tactics[0]?.id ?? "",
  };
  preview = null;
}
function editQuest(value: Quest) {
  selectedQuest = value;
  if (value.tactic_source.type !== "definition") return;
  questDraft = {
    id: value.id,
    title: value.title,
    objective: value.objective,
    workspace_id: value.workspace_id,
    squad_id: value.squad_id,
    tactic_definition_id: value.tactic_source.tactic_definition_id,
  };
  preview = null;
}
async function saveQuest() {
  const input = {
    title: questDraft.title,
    objective: questDraft.objective,
    workspace_id: questDraft.workspace_id,
    squad_id: questDraft.squad_id,
    tactic_source: {
      type: "definition" as const,
      tactic_definition_id: questDraft.tactic_definition_id,
    },
  };
  if (selectedQuest) await store.api.updateQuest(selectedQuest.id, input);
  else {
    const created = await store.api.createQuest(input);
    selectedQuest = created;
    questDraft.id = created.id;
  }
  await store.refreshProduct();
}
async function previewQuest() {
  if (selectedQuest) preview = await store.api.previewQuest(selectedQuest.id);
}
async function launchQuest() {
  if (!selectedQuest) return;
  const launch = await store.api.launchQuest(selectedQuest.id);
  await store.selectRun(launch.runId);
  store.selectBuildingId("work-area");
  preview = null;
}
async function openSelectedQuestReview() {
  if (store.fixture) return;
  const review = selectedQuest?.lifecycle.delivery?.review;
  if (review) await store.command(() => openPullRequest(review.url, review.number));
}
async function retrySelectedQuestPublishing() {
  const runId = selectedQuest?.lifecycle.current_run_id;
  if (runId) await store.retryPublishing(runId);
}
async function retryPublishing() {
  if (run) await store.retryPublishing(run.id);
}
async function cleanupWorktree() {
  if (!run) return;
  const acknowledge = run.delivery?.state === "closed_unmerged";
  if (acknowledge && !confirm("This Pull Request closed without merge. Remove only the clean local worktree?")) return;
  await store.cleanupWorktree(run.id, acknowledge);
}
async function reviewOnGitHub() {
  if (store.fixture) return;
  const review = run?.delivery?.review;
  if (review) await store.command(() => openPullRequest(review.url, review.number));
}
async function archiveQuest() {
  if (selectedQuest && confirm(`Archive ${selectedQuest.title}?`)) {
    await store.api.archiveQuest(selectedQuest.id);
    await store.refreshProduct();
    newQuest();
  }
}

async function bootstrap() {
  if (!store.isEmptyFirstRun() || !selectedOption || !starterWorkspace) return;
  store.bootstrapRunning.set(true);
  try {
    await createStarterCrew(store.api, {
      option: selectedOption,
      workspace: product.workspaces.find(
        (item) => item.id === starterWorkspace,
      )!,
    });
    await store.refreshProduct();
    selectBuilding("quest-board");
    newQuest();
  } catch (cause) {
    store.reportError(cause);
  } finally {
    store.bootstrapRunning.set(false);
  }
}
async function openArtifact(id: string) {
  if (run) artifact = await store.api.getArtifact(run.id, id);
}
function artifactPreview(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return JSON.stringify(value);
  if (value.kind === "scalar") return JSON.stringify(value.value);
  return typeof value.summary === "string" ? value.summary : "value";
}

function optionKey(option: {
  model: { provider: string; model: string };
  reasoning: string[];
  tools: string[];
  workspaces: Array<{ workspace_id: string }>;
}) {
  return `${option.model.provider}/${option.model.model}/${option.reasoning.join(",")}/${option.tools.join(",")}/${option.workspaces.map((workspace) => workspace.workspace_id).join(",")}`;
}
</script>

<main>
  <TownCanvas model={world} status={townStatus} selectedBuilding={$selectedBuildingStore} selectedMember={selectedMemberKey} onBuilding={selectBuilding} onMember={selectMember} />
  <header class="topbar"><strong>QUEST ENGINEERING</strong><span class="version">v0.14a · LIVING TOWN</span><span class:bad={$realtimeStatusStore !== "connected"}>◆ control plane {$realtimeStatusStore}</span><span class:bad={!product.workspaceSources.length}>◇ {product.workspaceSources.length ? "Worker source online" : "No Worker source"}</span><nav aria-label="Town menu">{#each buildings as building}<button title={`${building.hotkey} · ${building.label}`} on:click={() => selectBuilding(building.id)}><kbd>{building.hotkey}</kbd> {building.label}</button>{/each}<button aria-expanded={journalOpen} on:click={() => journalOpen = !journalOpen}>Journal</button></nav></header>
  {#if $loadingStore}<div class="notice">Loading Product data…</div>{/if}
  {#if $errorStore}<div class="error" role="alert"><strong>{$errorStore.code}</strong> — {$errorStore.message}</div>{/if}

  {#if journalOpen}<aside class="journal-drawer" aria-label="Recent Quest and Run journal"><header><h2>Quest Journal</h2><button aria-label="Close journal" on:click={() => journalOpen = false}>×</button></header>{#each product.runs as summary}<button class="journal-entry" on:click={() => openJournalRun(summary.id)}><strong>{summary.quest_title}</strong><small>{summary.status}{summary.delivery ? ` · ${summary.delivery.state.replaceAll("_", " ")}` : ""}</small></button>{:else}<p>No recent Runs.</p>{/each}<details class="art-credits"><summary>Art credits</summary><p><strong>Mini Medieval by VEXED</strong></p><ul><li>Mini Medieval 2.4.1</li><li>Mini Medieval Kingdom Interior 1.2</li><li>Mini Medieval User Interface 1.1</li></ul><p>Licensed CC BY 4.0. Base palette: fruitpunch24 by Polyphrog.</p><code>creativecommons.org/licenses/by/4.0/</code><p class="hint">Artwork is framed, combined, animated, and integer-scaled for Quest Engineering.</p></details></aside>{/if}

  {#if store.isEmptyFirstRun()}
    <section class="first-run" aria-label="First-run starter crew">
      <h1>Raise a starter crew</h1><p>Create ordinary Product rows for a Builder, Reviewer, Loadouts, Squad, and reusable Tactic.</p>
      {#if product.executionOptions.filter((item) => item.available).length && product.workspaces.length}
        <label>Known model <select bind:value={starterOption}><option value="">Choose a connected execution profile</option>{#each product.executionOptions.filter((item) => item.available) as option}<option value={optionKey(option)}>{option.model.provider} / {option.model.model}</option>{/each}</select></label>
        <label>Project <select bind:value={starterWorkspace}><option value="">Choose workspace</option>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label>
        <button disabled={!selectedOption || !starterWorkspace || $bootstrapRunningStore} on:click={bootstrap}>{$bootstrapRunningStore ? "Creating…" : "Create starter crew"}</button>
      {:else}<p class="error">Connect a compatible Worker and configure a workspace, then refresh the town. Manual editors remain available.</p>{/if}
    </section>
  {/if}

  {#if run}<aside class="run-status" class:window-open={$selectedBuildingStore !== null}><strong>{run.quest.title}</strong><span class="pill">{run.status}</span><span class:bad={run.execution_environment.state === "attention_required"}>⌂ {run.execution_environment.message}</span><button on:click={() => selectBuilding("work-area")}>Inspect run</button><div>{#each Object.entries(run.step_counts) as [state, count]}<span>{state}: {count}</span>{/each}</div>{#each run.squad.members.slice(0, 4) as item}<button class="member-status" on:click={() => selectMember(item.member_key)}>{item.name} — {world?.members.find((member) => member.member.member_key === item.member_key)?.activeStepName ?? "idle"}</button>{/each}{#if run.squad.members.length > 4}<small>+{run.squad.members.length - 4} more Members visible in town</small>{/if}</aside>{/if}

  {#if $selectedBuildingStore}<button class="window-close" aria-label="Close management window" on:click={requestCloseWindow}>×</button>{/if}

  {#if $selectedBuildingStore === "gatehouse"}<aside class="panel game-window"><header><span>✦</span><h2>Projects</h2></header><p class="subtitle">Projects available to your Quests</p><div class="split"><ul class="ledger">{#each product.workspaces as item}<li><button on:click={() => editWorkspace(item)}><strong>{item.name}</strong><small>{item.key} · {item.source_kind}</small></button></li>{/each}</ul><form on:submit|preventDefault={saveWorkspace}><h3>{selectedWorkspace ? "Edit Project" : "Add Project"}</h3><label>Immutable key <input disabled={!!selectedWorkspace} bind:value={workspaceDraft.key} required /></label><label>Repository <select value={selectedWorkspaceSource} on:change={(event) => chooseWorkspaceSource(event.currentTarget.value)}><option value="">Choose a discovered repository</option>{#each product.workspaceSources as source}<option value={source.candidate_id}>{source.name}</option>{/each}</select></label><label>Display name <input bind:value={workspaceDraft.name} required /></label><details class="advanced"><summary>Advanced Git identity and Worker binding</summary><label>Source identity <select bind:value={workspaceDraft.source_kind} disabled={!!selectedWorkspace}><option value="local_git">Local Git</option><option value="git_remote">Git remote</option></select></label><label>Remote fingerprint <input bind:value={workspaceDraft.source_fingerprint} placeholder="Optional for local Git" /></label><fieldset><legend>Worker source binding</legend><label>Discovered authorized repository <select value={selectedWorkspaceSource} on:change={(event) => chooseWorkspaceSource(event.currentTarget.value)}><option value="">Choose a source</option>{#each product.workspaceSources.filter((source) => !selectedWorkspace || source.source_kind === selectedWorkspace.source_kind && source.source_fingerprint === selectedWorkspace.source_fingerprint) as source}<option value={source.candidate_id}>{source.name} · {source.source_kind} · {source.max_access}{source.shell_available ? " · shell" : ""}</option>{/each}</select></label><button type="button" disabled={!selectedWorkspace || !selectedWorkspaceSource} on:click={bindWorkspaceSource}>Bind selected source</button></fieldset><p class="hint">Discovery is mediated by the control plane; local paths never enter Product data.</p></details><ValidationSummary details={$errorStore?.details ?? []} /><footer><button>Save Project</button><button type="button" on:click={newWorkspace}>New</button>{#if selectedWorkspace}<button type="button" class="danger" on:click={archiveWorkspace}>Archive</button>{/if}</footer></form></div></aside>{/if}

  {#if $selectedBuildingStore === "guild"}<aside class="panel game-window"><h2>Guild Hall — Classes</h2><div class="split"><ul>{#each product.classes as item}<li><button on:click={() => editClass(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveClass}><h3>{selectedClass ? "Edit" : "Create"} Class</h3><label>Key <input disabled={!!selectedClass} bind:value={classDraft.key} required /></label><label>Name <input bind:value={classDraft.name} required /></label><label>Description <textarea bind:value={classDraft.description}></textarea></label><label>Instructions <textarea bind:value={classDraft.instructions} required></textarea></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Class</button><button type="button" on:click={newClass}>New</button>{#if selectedClass}<button type="button" class="danger" on:click={archiveClass}>Archive</button>{/if}</form></div></aside>{/if}

  {#if $selectedBuildingStore === "blacksmith"}<aside class="panel game-window"><h2>Forge — Loadouts</h2><div class="split"><ul>{#each product.loadouts as item}<li><button on:click={() => editLoadout(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveLoadout}><h3>{selectedLoadout ? "Edit" : "Create"} Loadout</h3><label>Key <input disabled={!!selectedLoadout} bind:value={loadoutDraft.key} required /></label><label>Name <input bind:value={loadoutDraft.name} required /></label><label>Description <textarea bind:value={loadoutDraft.description}></textarea></label><label>Known execution profile <select on:change={(event) => applyExecutionOption(event.currentTarget.value)}><option value="">Choose a discovered profile</option>{#each product.executionOptions as option}<option value={optionKey(option)}>{option.model.provider} / {option.model.model} — {option.available ? "available" : "offline"}</option>{/each}</select></label><label>Provider <input bind:value={loadoutDraft.provider} required /></label><label>Model <input bind:value={loadoutDraft.model} required /></label><label>Reasoning <select bind:value={loadoutDraft.reasoning}><option>low</option><option>medium</option><option>high</option></select></label><label>QE capabilities <input bind:value={loadoutDraft.tools} /></label><label>Workspace access <select bind:value={loadoutDraft.workspace_access}><option>none</option><option>read_only</option><option>read_write</option></select></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Loadout</button><button type="button" on:click={newLoadout}>New</button>{#if selectedLoadout}<button type="button" class="danger" on:click={archiveLoadout}>Archive</button>{/if}</form></div><p class="hint">Known execution profiles are a convenience; custom Product capability values remain valid.</p></aside>{/if}

  {#if $selectedBuildingStore === "tavern"}<aside class="panel game-window"><h2>Tavern — Squads</h2><div class="split"><ul>{#each product.squads as item}<li><button on:click={() => editSquad(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveSquad}><h3>{selectedSquad ? "Edit" : "Create"} Squad</h3><label>Key <input disabled={!!selectedSquad} bind:value={squadDraft.key} required /></label><label>Name <input bind:value={squadDraft.name} required /></label><label>Description <textarea bind:value={squadDraft.description}></textarea></label><h3>Roster</h3>{#each squadDraft.members as item, index}<fieldset><input aria-label="Member key" bind:value={item.member_key} /><input aria-label="Display name" bind:value={item.name} /><select bind:value={item.class_id}>{#each product.classes as value}<option value={value.id}>{value.name}</option>{/each}</select><select bind:value={item.loadout_id}>{#each product.loadouts as value}<option value={value.id}>{value.name}</option>{/each}</select><button type="button" on:click={() => moveMember(index, -1)}>↑</button><button type="button" on:click={() => moveMember(index, 1)}>↓</button><button type="button" on:click={() => squadDraft.members = squadDraft.members.filter((_, i) => i !== index)}>Remove</button></fieldset>{/each}<ValidationSummary details={$errorStore?.details ?? []} /><button type="button" on:click={addMember}>Add Member</button><button>Save Squad</button><button type="button" on:click={newSquad}>New</button>{#if selectedSquad}<button type="button" class="danger" on:click={archiveSquad}>Archive</button>{/if}</form></div></aside>{/if}

  {#if $selectedBuildingStore === "quest-board"}<aside class="panel game-window"><h2>Quest Board</h2>{#if selectedQuest}<section class="quest-lifecycle"><strong>{selectedQuest.lifecycle.label}</strong>{#if selectedQuest.lifecycle.primary_action === "open_pull_request"}<button type="button" class="launch" on:click={openSelectedQuestReview}>Open Pull Request</button>{:else if selectedQuest.lifecycle.primary_action === "retry_publishing"}<button type="button" on:click={retrySelectedQuestPublishing}>Retry Publishing</button>{/if}</section>{/if}<div class="split"><ul>{#each product.quests as item}<li><button on:click={() => item.tactic_source.type === "definition" ? editQuest(item) : selectedQuest = item}>{item.title}</button>{#if item.tactic_source.type === "inline"}<small> inline tactic — read only</small>{/if}</li>{/each}</ul><form on:submit|preventDefault={saveQuest}><h3>{selectedQuest ? "Edit" : "Create"} Quest</h3>{#if selectedQuest?.tactic_source.type === "inline"}<p>This Quest uses an inline Tactic and remains read-only.</p>{:else}<label>Title <input bind:value={questDraft.title} required /></label><label>Objective <textarea bind:value={questDraft.objective} required></textarea></label><label>Project <select bind:value={questDraft.workspace_id}>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label><label>Squad <select bind:value={questDraft.squad_id}>{#each product.squads as squad}<option value={squad.id}>{squad.name}</option>{/each}</select></label><label>Tactic <select bind:value={questDraft.tactic_definition_id}>{#each product.tactics as tactic}<option value={tactic.id}>{tactic.name} — {tactic.description}</option>{/each}</select></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Quest</button>{#if selectedQuest}<button type="button" on:click={previewQuest}>Preview</button>{#if selectedQuest.lifecycle.primary_action === "launch"}<button type="button" class="launch" on:click={launchQuest}>Launch Quest</button>{:else if selectedQuest.lifecycle.primary_action === "run_again"}<button type="button" class="launch" on:click={launchQuest}>Run Again</button>{/if}<button type="button" class="danger" on:click={archiveQuest}>Archive</button>{/if}<button type="button" on:click={newQuest}>New</button>{/if}</form></div>{#if preview}<pre>{JSON.stringify(preview, null, 2)}</pre>{/if}<h3>Reusable Tactics</h3>{#each product.tactics as tactic}<article><strong>{tactic.name}</strong><p>{tactic.description}</p></article>{/each}</aside>{/if}

  {#if $selectedBuildingStore === "work-area"}<aside class="panel game-window"><h2>Work Yard — Selected Run</h2><label>Recent runs <select on:change={(event) => store.selectRun(event.currentTarget.value)} value={run?.id ?? ""}><option value="">Choose a run</option>{#each product.runs as summary}<option value={summary.id}>{summary.quest_title} — {summary.status}</option>{/each}</select></label>{#if run}<h3>{run.quest.title} <span class="pill">{run.status}</span></h3><section class="environment"><strong>{run.execution_environment.workspace.name}</strong><span>{run.execution_environment.message}</span>{#if run.execution_environment.branch}<code>{run.execution_environment.branch}</code>{/if}{#if run.execution_environment.source_dirty_changes_excluded}<small>Dirty source changes were excluded from the Run base.</small>{/if}{#if run.execution_environment.state === "retained"}<small>Changes remain in the isolated retained Run worktree; the source checkout was not modified.</small>{/if}</section>{#if run.delivery}<section class="delivery"><h3>Delivery · {run.delivery.state.replaceAll("_", " ")}</h3>{#if run.delivery.changes}<span>{run.delivery.changes.files_changed} files · +{run.delivery.changes.additions} / -{run.delivery.changes.deletions}</span>{/if}{#if run.delivery.review?.state === "open"}<button class="launch" on:click={reviewOnGitHub}>Open Pull Request</button>{/if}{#if run.delivery.can_retry}<button on:click={retryPublishing}>Retry Publishing</button>{/if}{#if run.delivery.issue}<p class="error">{run.delivery.issue.code}: {run.delivery.issue.message}</p>{/if}</section>{/if}{#if run.execution_environment.state === "retained" && ["awaiting_review", "merged", "closed_unmerged", "no_changes"].includes(run.delivery?.state ?? "")}<button on:click={cleanupWorktree}>Clean Up Worktree</button>{/if}{#if world?.orderMarkers.length}<p>Orders: {world.orderMarkers.map((item) => `${item.name} (${item.state})`).join(", ")}</p>{/if}{#if world?.diagnostics.length}<p class="error">{world.diagnostics.join(" ")}</p>{/if}<h3>Member inspector</h3>{#if member}<p><strong>{member.name}</strong> · {member.class.name} · {member.loadout.name}</p>{#if memberStep}<p>{memberIsActive ? "Active assignment" : "Last assignment"}: <strong>{memberStep.name}</strong> — {memberStep.state}</p><p>{memberStep.instruction}</p><small>Occurrence ID: {memberStep.occurrence_id}</small>{#if memberStep.inputs.length || memberStep.outputs.length}<h4>Assignment artifacts</h4>{#each [...memberStep.inputs, ...memberStep.outputs] as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{:else}<p>No assignment history for this Member.</p>{/if}{/if}<h3>Run artifacts</h3>{#if run.artifacts.length}{#each run.artifacts as item}<button on:click={() => openArtifact(item.id)}>{item.type} — {artifactPreview(item.preview)}</button>{/each}{:else}<p>No artifacts were produced.</p>{/if}{#if artifact}<h4>{artifact.type}</h4><pre>{JSON.stringify(artifact.value, null, 2)}</pre>{/if}<h3>Occurrence history</h3>{#each run.steps as step}<details><summary>{step.name ?? step.semantic_step_key} — {step.state}</summary><p>{step.instruction}</p>{#if step.member}<p>Member: {step.member.name}</p>{/if}<small>{step.occurrence_id}</small>{#if step.inputs.length}<h4>Inputs</h4>{#each step.inputs as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{#if step.outputs.length}<h4>Outputs</h4>{#each step.outputs as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{#if step.issue}<p class="error">{step.issue.code}: {step.issue.message}</p>{/if}</details>{/each}{/if}</aside>{/if}
  {#if FixtureChooserComponent}<FixtureChooserComponent />{/if}
</main>

<style>
  :global(:root) { --world-background: #120e23; --panel-background: #2a2942; --panel-border: #aea47e; --text-primary: #fff1a9; --text-secondary: #dacea4; --highlight: #ebb85b; --selection: #6dba79; --success: #6dba79; --warning: #ebb85b; --failure: #e67a84; --uncertain: #dacea4; --review-needed: #c9c03d; }
  :global(*) { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  :global(body) { margin: 0; overflow: hidden; background: var(--world-background); color: var(--text-primary); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :global(html[data-capture="dom"]), :global(html[data-capture="dom"] body), :global(html[data-capture="dom"] #app), :global(html[data-capture="dom"] main) { background: transparent !important; }
  main { min-height: 100vh; position: relative; }
  button, input, select, textarea { font: inherit; }
  button { background: #2a2942; border: 2px solid #aea47e; box-shadow: inset 0 0 0 1px #120e23; color: #fff1a9; cursor: pointer; padding: .4rem .65rem; }
  button:hover, button:focus-visible { background: #24505f; outline: 2px solid #6dba79; outline-offset: 1px; }
  kbd { color: #ebc66d; font: 700 .7rem ui-monospace, monospace; }
  .topbar { position: relative; z-index: 5; display: flex; gap: .7rem; align-items: center; min-height: 3.2rem; padding: .42rem .7rem; background: linear-gradient(#2a2942f2,#120e23f2); border-bottom: 3px double #aea47e; box-shadow: 0 5px 18px #120e23aa; }
  .topbar strong { color: #fff1a9; font-family: Georgia, ui-serif, serif; letter-spacing: .11em; text-shadow: 2px 2px #120e23; }
  .version { color: #dacea4; font-size: .72rem; }
  nav { display: flex; gap: .3rem; flex-wrap: wrap; margin-left: auto; }
  nav button { border-width: 1px; font-size: .8rem; }
  .bad { color: #ffd174; }
  .notice, .error { position: relative; z-index: 7; margin: .7rem; padding: .6rem; background: #27394aee; }
  .error { color: #ffd174; border: 2px solid #a05b58; }
  .first-run, .panel, .run-status, .journal-drawer { background: linear-gradient(145deg,#2a2942f2,#120e23f2); border: 4px double #aea47e; box-shadow: 0 10px 28px #120e23cc, inset 0 0 22px #120e2399; }
  .first-run { position: absolute; z-index: 6; top: 5rem; left: 1rem; max-width: 31rem; padding: 1rem; }
  .journal-drawer { position: absolute; z-index: 8; top: 4.15rem; left: .75rem; width: min(22rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow: auto; padding: .7rem; }
  .journal-drawer header { display: flex; align-items: center; gap: .5rem; }
  .journal-drawer header h2 { flex: 1; margin: 0; }
  .art-credits { margin-top: .7rem; padding: .5rem; border: 1px solid #aea47e; }
  .art-credits code { display: block; overflow-wrap: anywhere; color: #dacea4; }
  .journal-entry { display: grid; gap: .15rem; width: 100%; margin-top: .45rem; text-align: left; }
  label { display: grid; gap: .25rem; margin: .45rem 0; color: #ddcda6; font-size: .9rem; }
  input, select, textarea { width: 100%; background: #0d1a20; color: #fff1c9; border: 2px solid #6e654b; padding: .45rem; }
  textarea { min-height: 4rem; resize: vertical; }
  .panel { position: absolute; z-index: 6; top: 4.15rem; right: .75rem; max-height: calc(100vh - 5rem); overflow: auto; overscroll-behavior: contain; width: min(31rem, calc(100vw - 1.5rem)); padding: .85rem; }
  .window-close { position: absolute; z-index: 9; top: 4.55rem; right: 1.3rem; padding: .1rem .5rem; font-size: 1.2rem; }
  .game-window::before { content: ""; position: absolute; z-index: 1; top: 0; left: 0; width: 24px; height: 24px; pointer-events: none; image-rendering: pixelated; background: url("./assets/mini-medieval/ui-1.1/Frames.png") -8px -8px no-repeat; }
  .game-window > h2 { margin: -.85rem -.85rem .8rem; padding: .55rem 2.8rem .55rem .9rem; background: #24505f; border-bottom: 2px solid #aea47e; }
  .game-window > header { display: flex; align-items: center; gap: .5rem; margin: -.85rem -.85rem .6rem; padding: .45rem .9rem; background: #24505f; border-bottom: 2px solid #aea47e; }
  .game-window > header h2 { margin: 0; flex: 1; }
  h2, h3, h4 { color: #f3d783; text-shadow: 1px 2px #111; }
  .subtitle, .hint, small { color: #a9c8b5; }
  .advanced { margin: .5rem 0; padding: .45rem; border: 1px solid #806f4b; }
  .delivery { display: grid; gap: .4rem; margin: .6rem 0; padding: .6rem; border-left: 4px solid #d6c684; background: #101d22; }
  .quest-lifecycle { position: sticky; z-index: 3; top: -.85rem; display: flex; align-items: center; gap: .6rem; margin: -.1rem -.1rem .6rem; padding: .45rem .55rem; background: #120e23f2; border-left: 4px solid #c9c03d; }
  .quest-lifecycle strong { flex: 1; color: #c9c03d; }
  .quest-lifecycle button { padding-block: .3rem; }
  .split { display: grid; grid-template-columns: minmax(8rem, .7fr) minmax(16rem, 1.3fr); gap: .7rem; }
  ul { padding: 0; list-style: none; }
  li { margin: .35rem 0; }
  .ledger button { display: grid; width: 100%; text-align: left; }
  .ledger small { display: block; }
  form { display: grid; align-content: start; gap: .3rem; }
  form footer { display: flex; gap: .4rem; flex-wrap: wrap; }
  fieldset { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .3rem; border-color: #806f4b; }
  fieldset button { min-width: 0; }
  .run-status { position: absolute; z-index: 4; left: .75rem; bottom: .75rem; width: min(19rem, calc(100vw - 1.5rem)); max-height: 42vh; overflow: auto; padding: .65rem; display: grid; gap: .35rem; }
  .run-status div { display: flex; gap: .4rem; flex-wrap: wrap; font-size: .75rem; }
  .member-status { text-align: left; }
  .pill { color: #13242a; background: #d6c684; padding: .12rem .38rem; border: 1px solid #fff0ad; }
  .danger { border-color: #c46a62; color: #ffc0a9; }
  .launch { background: #4f7447; }
  .environment { display: grid; gap: .3rem; padding: .6rem; background: #101d22; border-left: 4px solid #80a46e; }
  code { color: #b6d6ca; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0a151a; border: 1px solid #695d43; padding: .7rem; }
  article { border-left: 3px solid #d9c28f; padding-left: .5rem; }
  @media (max-width: 1000px) { .panel { width: min(27rem, 48vw); min-width: 24rem; } .split { grid-template-columns: 1fr; } .run-status.window-open { width: 15rem; max-height: 13rem; } .run-status.window-open .member-status { display: none; } .topbar { align-items: flex-start; flex-wrap: wrap; } nav { margin-left: 0; } .version { display: none; } }
  @media (max-width: 760px) { .panel { left: .5rem; right: .5rem; width: auto; min-width: 0; } .run-status { max-height: 35vh; } }
</style>
