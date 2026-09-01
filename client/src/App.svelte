<script lang="ts">
import { onDestroy, onMount, tick, type Component } from "svelte";
import type { Quest } from "./api/contracts";
import TownCanvas from "./components/TownCanvas.svelte";
import ValidationSummary from "./components/ValidationSummary.svelte";
import ProjectsWindow from "./components/projects/ProjectsWindow.svelte";
import GuildHallWindow from "./components/guild/GuildHallWindow.svelte";
import ForgeWindow from "./components/forge/ForgeWindow.svelte";
import TavernWindow from "./components/tavern/TavernWindow.svelte";
import WorkYardWindow from "./components/work-yard/WorkYardWindow.svelte";
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
let selectedQuest: Quest | null = null;
let preview: unknown = null;
let selectedMemberKey: string | null = null;
let starterOption = "";
let starterWorkspace = "";
let previousFocus: HTMLElement | null = null;
let journalOpen = new URLSearchParams(location.search).get("journal") === "1";
let FixtureChooserComponent: Component | null = null;
let guildWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let forgeWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let tavernWindow: { requestLeave: (continuation: () => void) => void } | null = null;

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
  { id: "gatehouse", label: "Projects", hotkey: "1" },
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
}
$: isEmptyFirstRun =
  product.classes.length === 0 &&
  product.loadouts.length === 0 &&
  product.squads.length === 0 &&
  product.tactics.length === 0;
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
function handleUnhandledRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
  store.reportError(event.reason);
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (document.querySelector("dialog[open]")) return;
    if ($selectedBuildingStore) requestCloseWindow();
    else journalOpen = false;
    return;
  }
  if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
  const building = buildings.find((item) => item.hotkey === event.key);
  if (building) selectBuilding(building.id);
}

function selectBuilding(id: BuildingId) {
  if ($selectedBuildingStore === "guild" && id !== "guild" && guildWindow) {
    guildWindow.requestLeave(() => commitBuildingSelection(id));
    return;
  }
  if ($selectedBuildingStore === "blacksmith" && id !== "blacksmith" && forgeWindow) {
    forgeWindow.requestLeave(() => commitBuildingSelection(id));
    return;
  }
  if ($selectedBuildingStore === "tavern" && id !== "tavern" && tavernWindow) {
    tavernWindow.requestLeave(() => commitBuildingSelection(id));
    return;
  }
  if ($selectedBuildingStore && $selectedBuildingStore !== id && isWindowDirty() &&
      !confirm("Discard unsaved changes and open another management window?")) return;
  commitBuildingSelection(id);
}
function commitBuildingSelection(id: BuildingId) {
  if (!$selectedBuildingStore)
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  store.selectBuildingId(id);
  preview = null;
  void tick().then(() => document.querySelector<HTMLElement>(".panel input:not([disabled]), .panel select, .panel button")?.focus());
}
function isWindowDirty() {
  if ($selectedBuildingStore === "gatehouse") return false;
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
  if ($selectedBuildingStore === "guild" && guildWindow) {
    guildWindow.requestLeave(closeWindow);
    return;
  }
  if ($selectedBuildingStore === "blacksmith" && forgeWindow) {
    forgeWindow.requestLeave(closeWindow);
    return;
  }
  if ($selectedBuildingStore === "tavern" && tavernWindow) {
    tavernWindow.requestLeave(closeWindow);
    return;
  }
  if (isWindowDirty() && !confirm("Discard unsaved changes and close this window?")) return;
  closeWindow();
}
function closeWindow() {
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
async function archiveQuest() {
  if (selectedQuest && confirm(`Archive ${selectedQuest.title}?`)) {
    await store.api.archiveQuest(selectedQuest.id);
    await store.refreshProduct();
    newQuest();
  }
}

async function bootstrap() {
  if (!isEmptyFirstRun || !selectedOption || !starterWorkspace) return;
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
  <header class="topbar"><strong>QUEST ENGINEERING</strong><span class="version">v0.14b · AUTHORED TOWN</span><span class:bad={$realtimeStatusStore !== "connected"}>◆ control plane {$realtimeStatusStore}</span><span class:bad={!product.workspaceSources.length}>◇ {product.workspaceSources.length ? "Repositories available" : "No repositories available"}</span><nav aria-label="Town menu">{#each buildings as building}<button title={`${building.hotkey} · ${building.label}`} on:click={() => selectBuilding(building.id)}><kbd>{building.hotkey}</kbd> {building.label}</button>{/each}<button aria-expanded={journalOpen} on:click={() => journalOpen = !journalOpen}>Journal</button></nav></header>
  {#if $loadingStore}<div class="notice">Loading Product data…</div>{/if}
  {#if $errorStore}<div class="error" role="alert"><strong>{$errorStore.code}</strong> — {$errorStore.message}</div>{/if}

  {#if journalOpen}<aside class="journal-drawer" aria-label="Recent Quest and Run journal"><header><h2>Quest Journal</h2><button aria-label="Close journal" on:click={() => journalOpen = false}>×</button></header>{#each product.runs as summary}<button class="journal-entry" on:click={() => openJournalRun(summary.id)}><strong>{summary.quest_title}</strong><small>{summary.status}{summary.delivery ? ` · ${summary.delivery.state.replaceAll("_", " ")}` : ""}</small></button>{:else}<p>No recent Runs.</p>{/each}<details class="art-credits"><summary>Art credits</summary><p><strong>Mini Medieval by VEXED</strong></p><ul><li>Mini Medieval 2.4.1</li><li>Mini Medieval Kingdom Interior 1.2</li><li>Mini Medieval User Interface 1.1</li></ul><p>Licensed CC BY 4.0. Base palette: fruitpunch24 by Polyphrog.</p><code>creativecommons.org/licenses/by/4.0/</code><p class="hint">Artwork is framed, combined, animated, and integer-scaled for Quest Engineering.</p></details></aside>{/if}

  {#if isEmptyFirstRun}
    <section class="first-run" aria-label="First-run starter crew">
      <h1>Raise a starter crew</h1><p>Create ordinary Product rows for a Builder, Reviewer, Loadouts, Squad, and reusable Tactic.</p>
      {#if product.executionOptions.filter((item) => item.available).length && product.workspaces.length}
        <label>Known model <select bind:value={starterOption}><option value="">Choose a connected execution profile</option>{#each product.executionOptions.filter((item) => item.available) as option}<option value={optionKey(option)}>{option.model.provider} / {option.model.model}</option>{/each}</select></label>
        <label>Project <select bind:value={starterWorkspace}><option value="">Choose Project</option>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label>
        <button disabled={!selectedOption || !starterWorkspace || $bootstrapRunningStore} on:click={bootstrap}>{$bootstrapRunningStore ? "Creating…" : "Create starter crew"}</button>
      {:else if !product.workspaces.length}
        <p>Add a Project before raising your starter crew.</p>
        <button on:click={() => selectBuilding("gatehouse")}>Add your first Project</button>
      {:else}<p class="error">Connect a compatible Worker, then refresh the town. Manual editors remain available.</p>{/if}
    </section>
  {/if}

  {#if run && $selectedBuildingStore !== "work-area"}<aside class="run-status" class:window-open={$selectedBuildingStore !== null}><strong>{run.quest.title}</strong><span class="pill">{run.status}</span><span class:bad={run.execution_environment.state === "attention_required"}>⌂ {run.execution_environment.message}</span><button on:click={() => selectBuilding("work-area")}>Inspect run</button><div>{#each Object.entries(run.step_counts) as [state, count]}<span>{state}: {count}</span>{/each}</div>{#each run.squad.members.slice(0, 4) as item}<button class="member-status" on:click={() => selectMember(item.member_key)}>{item.name} — {world?.members.find((member) => member.member.member_key === item.member_key)?.activeStepName ?? "idle"}</button>{/each}{#if run.squad.members.length > 4}<small>+{run.squad.members.length - 4} more Members visible in town</small>{/if}</aside>{/if}

  {#if $selectedBuildingStore && !["gatehouse", "guild", "blacksmith", "tavern", "work-area"].includes($selectedBuildingStore)}<button class="window-close" aria-label="Close management window" on:click={requestCloseWindow}>×</button>{/if}

  {#if $selectedBuildingStore === "gatehouse"}<ProjectsWindow {store} {product} onClose={requestCloseWindow} scene={store.fixture ? new URLSearchParams(location.search).get("projects") : null} />{/if}

  {#if $selectedBuildingStore === "guild"}<GuildHallWindow bind:this={guildWindow} {store} {product} onClose={requestCloseWindow} scene={store.fixture ? new URLSearchParams(location.search).get("guild") : null} />{/if}

  {#if $selectedBuildingStore === "blacksmith"}<ForgeWindow bind:this={forgeWindow} {store} {product} onClose={requestCloseWindow} scene={store.fixture ? new URLSearchParams(location.search).get("forge") : null} />{/if}

  {#if $selectedBuildingStore === "tavern"}<TavernWindow bind:this={tavernWindow} {store} {product} scene={store.fixture ? new URLSearchParams(location.search).get("tavern") : null} onClose={closeWindow} />{/if}

  {#if $selectedBuildingStore === "quest-board"}<aside class="panel game-window"><h2>Quest Board</h2>{#if selectedQuest}<section class="quest-lifecycle"><strong>{selectedQuest.lifecycle.label}</strong>{#if selectedQuest.lifecycle.primary_action === "open_pull_request"}<button type="button" class="launch" on:click={openSelectedQuestReview}>Open Pull Request</button>{:else if selectedQuest.lifecycle.primary_action === "retry_publishing"}<button type="button" on:click={retrySelectedQuestPublishing}>Retry Publishing</button>{/if}</section>{/if}<div class="split"><ul>{#each product.quests as item}<li><button on:click={() => item.tactic_source.type === "definition" ? editQuest(item) : selectedQuest = item}>{item.title}</button>{#if item.tactic_source.type === "inline"}<small> inline tactic — read only</small>{/if}</li>{/each}</ul><form on:submit|preventDefault={saveQuest}><h3>{selectedQuest ? "Edit" : "Create"} Quest</h3>{#if selectedQuest?.tactic_source.type === "inline"}<p>This Quest uses an inline Tactic and remains read-only.</p>{:else}<label>Title <input bind:value={questDraft.title} required /></label><label>Objective <textarea bind:value={questDraft.objective} required></textarea></label><label>Project <select bind:value={questDraft.workspace_id}>{#each product.workspaces as workspace}<option value={workspace.id}>{workspace.name}</option>{/each}</select></label><label>Squad <select bind:value={questDraft.squad_id}>{#each product.squads as squad}<option value={squad.id}>{squad.name}</option>{/each}</select></label><label>Tactic <select bind:value={questDraft.tactic_definition_id}>{#each product.tactics as tactic}<option value={tactic.id}>{tactic.name} — {tactic.description}</option>{/each}</select></label><ValidationSummary details={$errorStore?.details ?? []} /><button>Save Quest</button>{#if selectedQuest}<button type="button" on:click={previewQuest}>Preview</button>{#if selectedQuest.lifecycle.primary_action === "launch"}<button type="button" class="launch" on:click={launchQuest}>Launch Quest</button>{:else if selectedQuest.lifecycle.primary_action === "run_again"}<button type="button" class="launch" on:click={launchQuest}>Run Again</button>{/if}<button type="button" class="danger" on:click={archiveQuest}>Archive</button>{/if}<button type="button" on:click={newQuest}>New</button>{/if}</form></div>{#if preview}<pre>{JSON.stringify(preview, null, 2)}</pre>{/if}<h3>Reusable Tactics</h3>{#each product.tactics as tactic}<article><strong>{tactic.name}</strong><p>{tactic.description}</p></article>{/each}</aside>{/if}

  {#if $selectedBuildingStore === "work-area"}<WorkYardWindow {store} {product} initialMemberKey={selectedMemberKey} onMember={(key) => (selectedMemberKey = key)} scene={store.fixture ? new URLSearchParams(location.search).get("work-yard") : null} onClose={requestCloseWindow} />{/if}
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
  h2, h3 { color: #f3d783; text-shadow: 1px 2px #111; }
  .hint, small { color: #a9c8b5; }
  .quest-lifecycle { position: sticky; z-index: 3; top: -.85rem; display: flex; align-items: center; gap: .6rem; margin: -.1rem -.1rem .6rem; padding: .45rem .55rem; background: #120e23f2; border-left: 4px solid #c9c03d; }
  .quest-lifecycle strong { flex: 1; color: #c9c03d; }
  .quest-lifecycle button { padding-block: .3rem; }
  .split { display: grid; grid-template-columns: minmax(8rem, .7fr) minmax(16rem, 1.3fr); gap: .7rem; }
  ul { padding: 0; list-style: none; }
  li { margin: .35rem 0; }
  form { display: grid; align-content: start; gap: .3rem; }
  .run-status { position: absolute; z-index: 4; left: .75rem; bottom: .75rem; width: min(19rem, calc(100vw - 1.5rem)); max-height: 42vh; overflow: auto; padding: .65rem; display: grid; gap: .35rem; }
  .run-status div { display: flex; gap: .4rem; flex-wrap: wrap; font-size: .75rem; }
  .member-status { text-align: left; }
  .pill { color: #13242a; background: #d6c684; padding: .12rem .38rem; border: 1px solid #fff0ad; }
  .danger { border-color: #c46a62; color: #ffc0a9; }
  .launch { background: #4f7447; }
  code { color: #b6d6ca; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0a151a; border: 1px solid #695d43; padding: .7rem; }
  article { border-left: 3px solid #d9c28f; padding-left: .5rem; }
  @media (max-width: 1000px) { .panel { width: min(27rem, 48vw); min-width: 24rem; } .split { grid-template-columns: 1fr; } .run-status.window-open { width: 15rem; max-height: 13rem; } .run-status.window-open .member-status { display: none; } .topbar { align-items: flex-start; flex-wrap: wrap; } nav { margin-left: 0; } .version { display: none; } }
  @media (max-width: 760px) { .panel { left: .5rem; right: .5rem; width: auto; min-width: 0; } .run-status { max-height: 35vh; } }
</style>
