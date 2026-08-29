<script lang="ts">
import { onDestroy, onMount } from "svelte";
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

onMount(async () => {
  window.addEventListener("keydown", handleKeydown);
  const fixtureBuilding = new URLSearchParams(location.search).get("building") as BuildingId | null;
  if (buildings.some((item) => item.id === fixtureBuilding)) selectBuilding(fixtureBuilding as BuildingId);
  await store.loadProduct();
  const match = location.hash.match(/^#\/run\/(.+)$/);
  if (match?.[1]) await store.selectRun(decodeURIComponent(match[1]));
});
onDestroy(() => {
  window.removeEventListener("keydown", handleKeydown);
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
$: run = $selectedRunStore;
$: world = $worldStore;
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

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    store.selectBuildingId(null);
    return;
  }
  if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
  const building = buildings.find((item) => item.hotkey === event.key);
  if (building) selectBuilding(building.id);
}

function selectBuilding(id: BuildingId) {
  store.selectBuildingId(id);
  preview = null;
  artifact = null;
}
function selectMember(key: string) {
  selectedMemberKey = key;
  store.selectBuildingId("work-area");
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
    alert(
      cause instanceof Error
        ? cause.message
        : "Starter crew could not be created.",
    );
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
  <TownCanvas model={world} selectedBuilding={$selectedBuildingStore} onBuilding={selectBuilding} onMember={selectMember} />
  <header class="topbar"><strong>QUEST ENGINEERING</strong><span class="version">v0.12 · RUNEFALL</span><span class:bad={$realtimeStatusStore !== "connected"}>◆ control plane {$realtimeStatusStore}</span><span class:bad={!product.workspaceSources.length}>◇ {product.workspaceSources.length ? "Worker source online" : "No Worker source"}</span><nav aria-label="Town menu">{#each buildings as building}<button title={`${building.hotkey} · ${building.label}`} on:click={() => selectBuilding(building.id)}><kbd>{building.hotkey}</kbd> {building.label}</button>{/each}</nav></header>
  {#if $loadingStore}<div class="notice">Loading Product data…</div>{/if}
  {#if $errorStore}<div class="error" role="alert"><strong>{$errorStore.code}</strong> — {$errorStore.message}</div>{/if}

  {#if store.isEmptyFirstRun()}
    <section class="first-run" aria-label="First-run starter crew">
      <h1>Raise a starter crew</h1><p>Create ordinary Product rows for a Builder, Reviewer, Loadouts, Squad, and reusable Tactic.</p>
      {#if product.executionOptions.filter((item) => item.available).length && product.workspaces.length}
        <label>Known model <select bind:value={starterOption}><option value="">Choose a connected execution profile</option>{#each product.executionOptions.filter((item) => item.available) as option}<option value={optionKey(option)}>{option.model.provider} / {option.model.model}</option>{/each}</select></label>
        <label>Workspace <select bind:value={starterWorkspace}><option value="">Choose workspace</option>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label>
        <button disabled={!selectedOption || !starterWorkspace || $bootstrapRunningStore} on:click={bootstrap}>{$bootstrapRunningStore ? "Creating…" : "Create starter crew"}</button>
      {:else}<p class="error">Connect a compatible Worker and configure a workspace, then refresh the town. Manual editors remain available.</p>{/if}
    </section>
  {/if}

  {#if run}<aside class="run-status"><strong>{run.quest.title}</strong><span class="pill">{run.status}</span><span class:bad={run.execution_environment.state === "attention_required"}>⌂ {run.execution_environment.message}</span><button on:click={() => selectBuilding("work-area")}>Inspect run</button><div>{#each Object.entries(run.step_counts) as [state, count]}<span>{state}: {count}</span>{/each}</div>{#each run.squad.members as item}<button class="member-status" on:click={() => selectMember(item.member_key)}>{item.name} — {world?.members.find((member) => member.member.member_key === item.member_key)?.activeStepName ?? "idle"}</button>{/each}</aside>{/if}

  {#if $selectedBuildingStore === "gatehouse"}<aside class="panel game-window"><header><span>✦</span><h2>Wayfinder Lodge</h2><button class="close" aria-label="Close" on:click={() => store.selectBuildingId(null)}>×</button></header><p class="subtitle">Logical Workspaces · paths stay with Workers</p><div class="split"><ul class="ledger">{#each product.workspaces as item}<li><button on:click={() => editWorkspace(item)}><strong>{item.name}</strong><small>{item.key} · {item.source_kind}</small></button></li>{/each}</ul><form on:submit|preventDefault={saveWorkspace}><h3>{selectedWorkspace ? "Edit charter" : "Register charter"}</h3><label>Immutable key <input disabled={!!selectedWorkspace} bind:value={workspaceDraft.key} required /></label><label>Display name <input bind:value={workspaceDraft.name} required /></label><label>Source identity <select bind:value={workspaceDraft.source_kind} disabled={!!selectedWorkspace}><option value="local_git">Local Git</option><option value="git_remote">Git remote</option></select></label><label>Remote fingerprint <input bind:value={workspaceDraft.source_fingerprint} placeholder="Optional for local Git" /></label><fieldset><legend>Worker source binding</legend><label>Discovered authorized repository <select value={selectedWorkspaceSource} on:change={(event) => chooseWorkspaceSource(event.currentTarget.value)}><option value="">Choose a source</option>{#each product.workspaceSources.filter((source) => !selectedWorkspace || source.source_kind === selectedWorkspace.source_kind && source.source_fingerprint === selectedWorkspace.source_fingerprint) as source}<option value={source.candidate_id}>{source.name} · {source.source_kind} · {source.max_access}{source.shell_available ? " · shell" : ""}</option>{/each}</select></label><button type="button" disabled={!selectedWorkspace || !selectedWorkspaceSource} on:click={bindWorkspaceSource}>Bind selected source</button></fieldset><p class="hint">Discovery is mediated by the control plane; local paths never enter Product data.</p><ValidationSummary details={$errorStore?.details ?? []} /><footer><button>Save Workspace</button><button type="button" on:click={newWorkspace}>New</button>{#if selectedWorkspace}<button type="button" class="danger" on:click={archiveWorkspace}>Archive</button>{/if}</footer></form></div></aside>{/if}

  {#if $selectedBuildingStore === "guild"}<aside class="panel"><h2>Guild Hall — Classes</h2><div class="split"><ul>{#each product.classes as item}<li><button on:click={() => editClass(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveClass}><h3>{selectedClass ? "Edit" : "Create"} Class</h3><label>Key <input disabled={!!selectedClass} bind:value={classDraft.key} required /></label><label>Name <input bind:value={classDraft.name} required /></label><label>Description <textarea bind:value={classDraft.description}></textarea></label><label>Instructions <textarea bind:value={classDraft.instructions} required></textarea></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Class</button><button type="button" on:click={newClass}>New</button>{#if selectedClass}<button type="button" class="danger" on:click={archiveClass}>Archive</button>{/if}</form></div></aside>{/if}

  {#if $selectedBuildingStore === "blacksmith"}<aside class="panel"><h2>Blacksmith — Loadouts</h2><div class="split"><ul>{#each product.loadouts as item}<li><button on:click={() => editLoadout(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveLoadout}><h3>{selectedLoadout ? "Edit" : "Create"} Loadout</h3><label>Key <input disabled={!!selectedLoadout} bind:value={loadoutDraft.key} required /></label><label>Name <input bind:value={loadoutDraft.name} required /></label><label>Description <textarea bind:value={loadoutDraft.description}></textarea></label><label>Known execution profile <select on:change={(event) => applyExecutionOption(event.currentTarget.value)}><option value="">Choose a discovered profile</option>{#each product.executionOptions as option}<option value={optionKey(option)}>{option.model.provider} / {option.model.model} — {option.available ? "available" : "offline"}</option>{/each}</select></label><label>Provider <input bind:value={loadoutDraft.provider} required /></label><label>Model <input bind:value={loadoutDraft.model} required /></label><label>Reasoning <select bind:value={loadoutDraft.reasoning}><option>low</option><option>medium</option><option>high</option></select></label><label>QE capabilities <input bind:value={loadoutDraft.tools} /></label><label>Workspace access <select bind:value={loadoutDraft.workspace_access}><option>none</option><option>read_only</option><option>read_write</option></select></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Loadout</button><button type="button" on:click={newLoadout}>New</button>{#if selectedLoadout}<button type="button" class="danger" on:click={archiveLoadout}>Archive</button>{/if}</form></div><p class="hint">Known execution profiles are a convenience; custom Product capability values remain valid.</p></aside>{/if}

  {#if $selectedBuildingStore === "tavern"}<aside class="panel"><h2>Tavern — Squads</h2><div class="split"><ul>{#each product.squads as item}<li><button on:click={() => editSquad(item)}>{item.name}</button></li>{/each}</ul><form on:submit|preventDefault={saveSquad}><h3>{selectedSquad ? "Edit" : "Create"} Squad</h3><label>Key <input disabled={!!selectedSquad} bind:value={squadDraft.key} required /></label><label>Name <input bind:value={squadDraft.name} required /></label><label>Description <textarea bind:value={squadDraft.description}></textarea></label><h3>Roster</h3>{#each squadDraft.members as item, index}<fieldset><input aria-label="Member key" bind:value={item.member_key} /><input aria-label="Display name" bind:value={item.name} /><select bind:value={item.class_id}>{#each product.classes as value}<option value={value.id}>{value.name}</option>{/each}</select><select bind:value={item.loadout_id}>{#each product.loadouts as value}<option value={value.id}>{value.name}</option>{/each}</select><button type="button" on:click={() => moveMember(index, -1)}>↑</button><button type="button" on:click={() => moveMember(index, 1)}>↓</button><button type="button" on:click={() => squadDraft.members = squadDraft.members.filter((_, i) => i !== index)}>Remove</button></fieldset>{/each}<ValidationSummary details={$errorStore?.details ?? []} /><button type="button" on:click={addMember}>Add Member</button><button>Save Squad</button><button type="button" on:click={newSquad}>New</button>{#if selectedSquad}<button type="button" class="danger" on:click={archiveSquad}>Archive</button>{/if}</form></div></aside>{/if}

  {#if $selectedBuildingStore === "quest-board"}<aside class="panel"><h2>Quest Board</h2><div class="split"><ul>{#each product.quests as item}<li><button on:click={() => item.tactic_source.type === "definition" ? editQuest(item) : selectedQuest = item}>{item.title}</button>{#if item.tactic_source.type === "inline"}<small> inline tactic — read only</small>{/if}</li>{/each}</ul><form on:submit|preventDefault={saveQuest}><h3>{selectedQuest ? "Edit" : "Create"} Quest</h3>{#if selectedQuest?.tactic_source.type === "inline"}<p>This Quest uses an inline Tactic. v0.12 preserves it read-only.</p>{:else}<label>Title <input bind:value={questDraft.title} required /></label><label>Objective <textarea bind:value={questDraft.objective} required></textarea></label><label>Workspace <select bind:value={questDraft.workspace_id}>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label><label>Squad <select bind:value={questDraft.squad_id}>{#each product.squads as squad}<option value={squad.id}>{squad.name}</option>{/each}</select></label><label>Tactic <select bind:value={questDraft.tactic_definition_id}>{#each product.tactics as tactic}<option value={tactic.id}>{tactic.name} — {tactic.description}</option>{/each}</select></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Quest</button>{#if selectedQuest}<button type="button" on:click={previewQuest}>Preview</button><button type="button" class="launch" on:click={launchQuest}>Launch Quest</button><button type="button" class="danger" on:click={archiveQuest}>Archive</button>{/if}<button type="button" on:click={newQuest}>New</button>{/if}</form></div>{#if preview}<pre>{JSON.stringify(preview, null, 2)}</pre>{/if}<h3>Reusable Tactics</h3>{#each product.tactics as tactic}<article><strong>{tactic.name}</strong><p>{tactic.description}</p></article>{/each}</aside>{/if}

  {#if $selectedBuildingStore === "work-area"}<aside class="panel"><h2>Work Yard — Selected Run</h2><label>Recent runs <select on:change={(event) => store.selectRun(event.currentTarget.value)} value={run?.id ?? ""}><option value="">Choose a run</option>{#each product.runs as summary}<option value={summary.id}>{summary.quest_title} — {summary.status}</option>{/each}</select></label>{#if run}<h3>{run.quest.title} <span class="pill">{run.status}</span></h3><section class="environment"><strong>{run.execution_environment.workspace.name}</strong><span>{run.execution_environment.message}</span>{#if run.execution_environment.branch}<code>{run.execution_environment.branch}</code>{/if}{#if run.execution_environment.source_dirty_changes_excluded}<small>Dirty source changes were excluded from the Run base.</small>{/if}{#if run.execution_environment.state === "retained"}<small>Changes remain in the isolated retained Run worktree; the source checkout was not modified.</small>{/if}</section>{#if world?.orderMarkers.length}<p>Orders: {world.orderMarkers.map((item) => `${item.name} (${item.state})`).join(", ")}</p>{/if}{#if world?.diagnostics.length}<p class="error">{world.diagnostics.join(" ")}</p>{/if}<h3>Member inspector</h3>{#if member}<p><strong>{member.name}</strong> · {member.class.name} · {member.loadout.name}</p>{#if memberStep}<p>{memberIsActive ? "Active assignment" : "Last assignment"}: <strong>{memberStep.name}</strong> — {memberStep.state}</p><p>{memberStep.instruction}</p><small>Occurrence ID: {memberStep.occurrence_id}</small>{#if memberStep.inputs.length || memberStep.outputs.length}<h4>Assignment artifacts</h4>{#each [...memberStep.inputs, ...memberStep.outputs] as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{:else}<p>No assignment history for this Member.</p>{/if}{/if}<h3>Run artifacts</h3>{#if run.artifacts.length}{#each run.artifacts as item}<button on:click={() => openArtifact(item.id)}>{item.type} — {artifactPreview(item.preview)}</button>{/each}{:else}<p>No artifacts were produced.</p>{/if}{#if artifact}<h4>{artifact.type}</h4><pre>{JSON.stringify(artifact.value, null, 2)}</pre>{/if}<h3>Occurrence history</h3>{#each run.steps as step}<details><summary>{step.name ?? step.semantic_step_key} — {step.state}</summary><p>{step.instruction}</p>{#if step.member}<p>Member: {step.member.name}</p>{/if}<small>{step.occurrence_id}</small>{#if step.inputs.length}<h4>Inputs</h4>{#each step.inputs as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{#if step.outputs.length}<h4>Outputs</h4>{#each step.outputs as ref}<button on:click={() => openArtifact(ref.artifact_id)}>{ref.type}</button>{/each}{/if}{#if step.issue}<p class="error">{step.issue.code}: {step.issue.message}</p>{/if}</details>{/each}{/if}</aside>{/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; overflow: hidden; background: #111b24; color: #f4e7c5; font-family: Georgia, "Times New Roman", serif; }
  main { min-height: 100vh; position: relative; }
  button, input, select, textarea { font: inherit; }
  button { background: #253b42; border: 2px solid #9d7747; box-shadow: inset 0 0 0 1px #151e22; color: #f4e7c5; cursor: pointer; padding: .4rem .65rem; }
  button:hover, button:focus-visible { background: #3d5a54; outline: 2px solid #ebc66d; outline-offset: 1px; }
  kbd { color: #ebc66d; font: 700 .7rem ui-monospace, monospace; }
  .topbar { position: relative; z-index: 5; display: flex; gap: .8rem; align-items: center; min-height: 3.2rem; padding: .45rem .8rem; background: linear-gradient(#283b43ee,#15252dee); border-bottom: 3px double #b38b51; box-shadow: 0 5px 18px #071014aa; }
  .topbar strong { color: #ffe7a1; letter-spacing: .13em; text-shadow: 2px 2px #111; }
  .version { color: #a9c8b5; font-size: .72rem; }
  nav { display: flex; gap: .3rem; flex-wrap: wrap; margin-left: auto; }
  nav button { border-width: 1px; font-size: .8rem; }
  .bad { color: #ffd174; }
  .notice, .error { position: relative; z-index: 7; margin: .7rem; padding: .6rem; background: #27394aee; }
  .error { color: #ffd174; border: 2px solid #a05b58; }
  .first-run, .panel, .run-status { background: linear-gradient(145deg,#20343bea,#14252dea); border: 4px double #b38b51; box-shadow: 0 10px 28px #071014cc, inset 0 0 22px #0a131899; }
  .first-run { position: absolute; z-index: 6; top: 5rem; left: 1rem; max-width: 31rem; padding: 1rem; }
  label { display: grid; gap: .25rem; margin: .45rem 0; color: #ddcda6; font-size: .9rem; }
  input, select, textarea { width: 100%; background: #0d1a20; color: #fff1c9; border: 2px solid #6e654b; padding: .45rem; }
  textarea { min-height: 4rem; resize: vertical; }
  .panel { position: absolute; z-index: 6; top: 4.3rem; right: 1rem; max-height: calc(100vh - 5.3rem); overflow: auto; width: min(52rem, calc(100vw - 2rem)); padding: 1rem; }
  .game-window > header { display: flex; align-items: center; gap: .5rem; margin: -1rem -1rem .6rem; padding: .45rem .65rem; background: #3b4f48; border-bottom: 2px solid #b38b51; }
  .game-window > header h2 { margin: 0; flex: 1; }
  .close { padding: .1rem .5rem; font-size: 1.2rem; }
  h2, h3, h4 { color: #f3d783; text-shadow: 1px 2px #111; }
  .subtitle, .hint, small { color: #a9c8b5; }
  .split { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(18rem, 2fr); gap: 1rem; }
  ul { padding: 0; list-style: none; }
  li { margin: .35rem 0; }
  .ledger button { display: grid; width: 100%; text-align: left; }
  .ledger small { display: block; }
  form { display: grid; align-content: start; gap: .3rem; }
  form footer { display: flex; gap: .4rem; flex-wrap: wrap; }
  fieldset { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto auto auto; gap: .25rem; border-color: #806f4b; }
  .run-status { position: absolute; z-index: 4; left: 1rem; bottom: 1rem; width: 20rem; padding: .75rem; display: grid; gap: .4rem; }
  .run-status div { display: flex; gap: .4rem; flex-wrap: wrap; font-size: .75rem; }
  .member-status { text-align: left; }
  .pill { color: #13242a; background: #d6c684; padding: .12rem .38rem; border: 1px solid #fff0ad; }
  .danger { border-color: #c46a62; color: #ffc0a9; }
  .launch { background: #4f7447; }
  .environment { display: grid; gap: .3rem; padding: .6rem; background: #101d22; border-left: 4px solid #80a46e; }
  code { color: #b6d6ca; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0a151a; border: 1px solid #695d43; padding: .7rem; }
  article { border-left: 3px solid #d9c28f; padding-left: .5rem; }
  @media (max-width: 760px) { .panel { left: .5rem; right: .5rem; width: auto; } .split { grid-template-columns: 1fr; } fieldset { grid-template-columns: 1fr 1fr; } .topbar { align-items: flex-start; flex-wrap: wrap; } nav { margin-left: 0; } .version { display: none; } }
</style>
