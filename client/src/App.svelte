<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import TownCanvas from "./components/TownCanvas.svelte";
import TownHud from "./components/hud/TownHud.svelte";
import ProjectsWindow from "./components/projects/ProjectsWindow.svelte";
import GuildHallWindow from "./components/guild/GuildHallWindow.svelte";
import ForgeWindow from "./components/forge/ForgeWindow.svelte";
import TavernWindow from "./components/tavern/TavernWindow.svelte";
import WorkYardWindow from "./components/work-yard/WorkYardWindow.svelte";
import QuestBoardWindow from "./components/quest-board/QuestBoardWindow.svelte";
import WarRoomWindow from "./components/war-room/WarRoomWindow.svelte";
import StarterCrewOnboarding from "./components/onboarding/StarterCrewOnboarding.svelte";
import type { AppStore, BuildingId } from "./state/app-store";

export let store: AppStore;
const {
  product: productStore,
  selectedBuilding: selectedBuildingStore,
  activeCrew: activeCrewStore,
  liveAttentions: liveAttentionsStore,
  attentionNotifications: attentionNotificationsStore,
  loading: loadingStore,
  error: errorStore,
  realtimeStatus: realtimeStatusStore,
  serverReachable: serverReachableStore,
  starterStatus: starterStatusStore,
} = store;
let selectedMemberKey: string | null = null;
let previousFocus: HTMLElement | null = null;
let guildWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let forgeWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let tavernWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let questWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let warRoomWindow: { requestLeave: (continuation: () => void) => void } | null = null;
let onboardingDismissed = false;
let starterCompletionVisible = false;
let onboardingProjectFlow = false;
const onboardingScene = store.fixture
  ? new URLSearchParams(location.search).get("onboarding")
  : null;

onMount(async () => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  const params = new URLSearchParams(location.search);
  const fixtureBuilding = (params.get("window") ?? params.get("building")) as BuildingId | null;
  if (buildings.some((item) => item.id === fixtureBuilding)) selectBuilding(fixtureBuilding as BuildingId);
  if (store.fixture?.name === "member-inspector") selectedMemberKey = "member-1";
  await store.loadProduct();
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
  { id: "war-room", label: "War Room", hotkey: "7" },
];
$: product = $productStore;
$: starterStatus = $starterStatusStore;
$: showOnboarding = Boolean(
  !$loadingStore &&
    !$selectedBuildingStore &&
    !onboardingDismissed &&
    starterStatus &&
    (starterCompletionVisible ||
      onboardingScene ||
      ["empty", "recoverable_partial", "conflict"].includes(starterStatus.state)),
);
$: activeCrew = $activeCrewStore;
$: townStatus = {
  preparingReview: product.quests.filter((quest) => quest.lifecycle.state === "preparing_review").length,
  awaitingReview: product.quests.filter((quest) => quest.lifecycle.state === "awaiting_review").length,
  attention: product.quests.filter((quest) => quest.lifecycle.state === "needs_attention").length,
  complete: product.quests.filter((quest) => quest.lifecycle.state === "complete").length,
};
function handleUnhandledRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
  store.reportError(event.reason);
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (document.querySelector("dialog[open]")) return;
    if ($selectedBuildingStore) requestCloseWindow();
    return;
  }
  if (
    event.target instanceof HTMLElement &&
    event.target.matches("input, textarea, select")
  )
    return;
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
  if ($selectedBuildingStore === "quest-board" && id !== "quest-board" && questWindow) {
    questWindow.requestLeave(() => commitBuildingSelection(id));
    return;
  }
  if ($selectedBuildingStore === "war-room" && id !== "war-room" && warRoomWindow) {
    warRoomWindow.requestLeave(() => commitBuildingSelection(id));
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
  void tick().then(() => document.querySelector<HTMLElement>(".panel input:not([disabled]), .panel select, .panel button, .management-window button")?.focus());
}
function isWindowDirty() {
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
  if ($selectedBuildingStore === "quest-board" && questWindow) {
    questWindow.requestLeave(closeWindow);
    return;
  }
  if ($selectedBuildingStore === "war-room" && warRoomWindow) {
    warRoomWindow.requestLeave(closeWindow);
    return;
  }
  if (isWindowDirty() && !confirm("Discard unsaved changes and close this window?")) return;
  closeWindow();
}
function closeWindow() {
  if ($selectedBuildingStore === "gatehouse") onboardingProjectFlow = false;
  store.selectBuildingId(null);
  void tick().then(() => previousFocus?.focus());
}
function addOnboardingProject() {
  onboardingProjectFlow = true;
  selectBuilding("gatehouse");
}
function projectAddedFromOnboarding() {
  if (!onboardingProjectFlow) return;
  onboardingProjectFlow = false;
  closeWindow();
}
function navigateFromOnboarding(building: BuildingId) {
  if (building === "quest-board") {
    starterCompletionVisible = false;
    onboardingDismissed = true;
  }
  selectBuilding(building);
}
async function selectMember(runId: string, key: string) {
  await store.selectRun(runId);
  selectedMemberKey = key;
  selectBuilding("work-area");
}
function openWarRoomTactic(tacticId: string) {
  sessionStorage.setItem("qe-war-room-selection", tacticId);
  selectBuilding("war-room");
}

async function openQuestRun(runId: string) {
  await store.selectRun(runId);
  selectedMemberKey = null;
  commitBuildingSelection("work-area");
}

</script>

<main>
  <TownCanvas activities={activeCrew} projects={product.workspaces} status={townStatus} selectedBuilding={$selectedBuildingStore} onBuilding={selectBuilding} onMember={selectMember} />
  <TownHud
    {product}
    realtimeStatus={$realtimeStatusStore}
    serverReachable={$serverReachableStore}
    liveAttentionCount={$liveAttentionsStore.length}
  />
  {#if $loadingStore}<div class="notice">Loading Product data…</div>{/if}
  {#if $errorStore && $selectedBuildingStore !== "quest-board"}<div class="error" role="alert"><strong>{$errorStore.code}</strong> — {$errorStore.message}</div>{/if}

  <div class="attention-toasts" aria-live="assertive">
    {#each $attentionNotificationsStore as attention (attention.attentionId)}
      <article class="attention-toast" role="alert">
        <button class="toast-dismiss" aria-label="Dismiss notification" on:click={() => store.dismissAttention(attention.attentionId)}>×</button>
        <span class="toast-kicker">Live session needs attention</span>
        <strong>{attention.memberName} needs your help</strong>
        <p>{attention.questTitle} <span aria-hidden="true">·</span> {attention.stepName}</p>
        <small>{attention.harnessName} is waiting: {attention.message}</small>
        <button class="toast-open" on:click={() => store.openSession(attention)}>Open Session</button>
      </article>
    {/each}
  </div>

  {#if showOnboarding && starterStatus}<StarterCrewOnboarding {store} {product} status={starterStatus} scene={onboardingScene} onAddProject={addOnboardingProject} onOpenProjects={() => selectBuilding("gatehouse")} onNavigate={navigateFromOnboarding} onDismiss={() => (onboardingDismissed = true)} onCompleted={() => (starterCompletionVisible = true)} />{/if}

  {#if $selectedBuildingStore && !["gatehouse", "guild", "blacksmith", "tavern", "quest-board", "war-room", "work-area"].includes($selectedBuildingStore)}<button class="window-close" aria-label="Close management window" on:click={requestCloseWindow}>×</button>{/if}

  {#if $selectedBuildingStore === "gatehouse"}<ProjectsWindow {store} {product} onClose={requestCloseWindow} onProjectAdded={projectAddedFromOnboarding} startInAddMode={onboardingProjectFlow} scene={store.fixture ? new URLSearchParams(location.search).get("projects") : null} />{/if}

  {#if $selectedBuildingStore === "guild"}<GuildHallWindow bind:this={guildWindow} {store} {product} onClose={requestCloseWindow} scene={store.fixture ? new URLSearchParams(location.search).get("guild") : null} />{/if}

  {#if $selectedBuildingStore === "blacksmith"}<ForgeWindow bind:this={forgeWindow} {store} {product} onClose={requestCloseWindow} scene={store.fixture ? new URLSearchParams(location.search).get("forge") : null} />{/if}

  {#if $selectedBuildingStore === "tavern"}<TavernWindow bind:this={tavernWindow} {store} {product} scene={store.fixture ? new URLSearchParams(location.search).get("tavern") : null} onClose={closeWindow} />{/if}

  {#if $selectedBuildingStore === "quest-board"}<QuestBoardWindow bind:this={questWindow} {store} {product} scene={store.fixture ? new URLSearchParams(location.search).get("quest-board") : null} onClose={requestCloseWindow} onOpenWorkYard={openQuestRun} onOpenProjects={() => selectBuilding("gatehouse")} onOpenTavern={() => selectBuilding("tavern")} onOpenWarRoom={openWarRoomTactic} />{/if}

  {#if $selectedBuildingStore === "war-room"}<WarRoomWindow bind:this={warRoomWindow} {store} {product} scene={store.fixture ? new URLSearchParams(location.search).get("war-room") : null} onClose={requestCloseWindow} onOpenQuestBoard={() => selectBuilding("quest-board")} />{/if}

  {#if $selectedBuildingStore === "work-area"}<WorkYardWindow {store} {product} initialMemberKey={selectedMemberKey} onMember={(key) => (selectedMemberKey = key)} scene={store.fixture ? new URLSearchParams(location.search).get("work-yard") : null} onClose={requestCloseWindow} />{/if}
</main>

<style>
  :global(:root) { --world-background: #120e23; --panel-background: #2a2942; --panel-border: #aea47e; --text-primary: #fff1a9; --text-secondary: #dacea4; --highlight: #ebb85b; --selection: #6dba79; --success: #6dba79; --warning: #ebb85b; --failure: #e67a84; --uncertain: #dacea4; --review-needed: #c9c03d; }
  :global(*) { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  :global(body) { margin: 0; overflow: hidden; background: var(--world-background); color: var(--text-primary); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :global(html[data-capture="dom"]), :global(html[data-capture="dom"] body), :global(html[data-capture="dom"] #app), :global(html[data-capture="dom"] main) { background: transparent !important; }
  main { position: relative; height: 100vh; min-height: 0; overflow: hidden; }
  button { background: #2a2942; border: 2px solid #aea47e; box-shadow: inset 0 0 0 1px #120e23; color: #fff1a9; cursor: pointer; padding: .4rem .65rem; font: inherit; }
  button:hover, button:focus-visible { background: #24505f; outline: 2px solid #6dba79; outline-offset: 1px; }
  .notice, .error { position: relative; z-index: 7; margin: .7rem; padding: .6rem; background: #27394aee; }
  .attention-toasts { position:absolute; z-index:12; top:4.2rem; right:1rem; display:grid; gap:.65rem; width:min(23rem,calc(100vw - 2rem)); }
  .attention-toast { position:relative; display:grid; gap:.25rem; padding:.85rem 1rem; color:#4b332a; background:#fff0cf; border:2px solid #c77a50; border-left:6px solid #ad4f43; border-radius:10px; box-shadow:0 8px 24px #23170f66; }
  .attention-toast strong { font:700 1.05rem Georgia,serif; }
  .attention-toast p,.attention-toast small { margin:0; }
  .attention-toast small { color:#705449; }
  .toast-kicker { color:#9b493f; font-size:.68rem; font-weight:850; letter-spacing:.06em; text-transform:uppercase; }
  .toast-dismiss { position:absolute; top:.3rem; right:.35rem; padding:.05rem .35rem; color:#775348; background:transparent; border:0; box-shadow:none; }
  .toast-open { justify-self:start; margin-top:.35rem; color:#fff8e8; background:#316d68; border-color:#214c49; border-radius:6px; font-weight:800; }
  .error { color: #ffd174; border: 2px solid #a05b58; }
  .window-close { position: absolute; z-index: 9; top: 4.55rem; right: 1.3rem; padding: .1rem .5rem; font-size: 1.2rem; }
</style>
