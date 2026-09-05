<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { Workspace } from "../api/contracts";
import type { BuildingId } from "../state/app-store";
import { loadBundledWorldTemplates } from "../world/authored/map-loader";
import { WorldComposer } from "../world/composition/world-composer";
import type { ActiveCrewActivity } from "../world/crew/active-crew";
import {
  crewDemoActivities,
  type CrewDemoScenario,
  crewDemoTransitions,
} from "../world/crew/crew-demo";
import { projectCrewPresentation } from "../world/crew/crew-presentation";
import { TownWorld, type TownStatusModel } from "../world/town-world";

export let activities: ActiveCrewActivity[] = [];
export let projects: Workspace[] = [];
export let status: TownStatusModel = { preparingReview: 0, awaitingReview: 0, attention: 0, complete: 0 };
export let selectedBuilding: BuildingId | null = null;
export let onBuilding: (id: BuildingId) => void;
export let onMember: (runId: string, memberKey: string) => void;
let host: HTMLDivElement;
let world: TownWorld | null = null;
let mutationObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedPanel: HTMLElement | null = null;
const query = new URLSearchParams(location.search);
const requestedScale = Number(query.get("scale"));
const keepHomeFocused = query.get("camera") === "town" || query.get("camera") === "home";
const requestedProjectFocus = query.get("focusProject");
const requestedWorldFocus = import.meta.env.DEV && query.get("focusWorld") === "1";
const requestedWorldDemoProjects = import.meta.env.DEV
  ? Math.max(0, Math.min(50, Number(query.get("worldDemoProjects") ?? 0)))
  : 0;
const debugMap = import.meta.env.DEV && query.get("debugMap") === "1";
const facingSheet = import.meta.env.DEV && query.get("facingSheet") === "1";
const facingSheetDirection = facingSheet
  ? query.get("facingDirection") ?? undefined
  : undefined;
const groundingAnimation = import.meta.env.DEV
  ? query.get("groundingAnimation") ?? undefined
  : undefined;
const groundingElapsedMs = groundingAnimation
  ? Math.max(0, Number(query.get("groundingElapsed") ?? 0))
  : undefined;
const groundingLegacyAnchor =
  import.meta.env.DEV && query.get("groundingLegacy") === "1";
const crewDemoScenarios = new Set<CrewDemoScenario>([
  "none",
  "entering",
  "crafting",
  "research",
  "mining",
  "woodcutting",
  "parallel",
  "short",
  "short-500",
  "short-1500",
  "short-5000",
  "long-running",
  "real-short-crafting",
  "same-member-relocation",
  "sequential",
  "parallel-tail",
  "facing-fixture",
  "research-facing",
  "crafting-facing",
  "woodcutting-facing",
  "mining-facing",
  "showcase",
]);
const requestedCrewDemo = query.get("crewDemo") as CrewDemoScenario | null;
const demoActivities =
  import.meta.env.DEV &&
  requestedCrewDemo &&
  crewDemoScenarios.has(requestedCrewDemo)
    ? crewDemoActivities(requestedCrewDemo)
    : null;
const crewDemoTimeMs = demoActivities
  ? Math.max(0, Number(query.get("crewDemoTime") ?? 0))
  : undefined;
const crewDemoMinimumWorkMs =
  import.meta.env.DEV && query.has("crewDemoMinimumWork")
    ? Math.max(0, Number(query.get("crewDemoMinimumWork")))
    : undefined;
const demoTransitions =
  demoActivities && requestedCrewDemo
    ? crewDemoTransitions(requestedCrewDemo).map((transition) => ({
        atMs: transition.atMs,
        crew: projectCrewPresentation(transition.activities),
      }))
    : [];
const projectTemplateSelection =
  import.meta.env.DEV && query.get("worldTemplate") === "fixture"
    ? "reference-fixture"
    : "production";
const result = loadBundledWorldTemplates(projectTemplateSelection);
const composer = result.templates ? new WorldComposer(result.templates) : null;
$: effectiveActivities = demoActivities ?? activities;
$: crew = projectCrewPresentation(effectiveActivities);
$: projectIdentities = requestedWorldDemoProjects
  ? Array.from({ length: requestedWorldDemoProjects }, (_, index) => ({
      id: `archipelago-demo-${index}`,
      key: `project-${index * 17 + 3}`,
      name: `Project ${index + 1}`,
    }))
  : demoActivities
    ? []
    : projects
        .filter((project) => project.archived_at === null)
        .map((project) => ({ id: project.id, key: project.key, name: project.name }));
$: expansionProjectIds = new Set(
  query.get("worldFixture") === "expansion" && projectIdentities[0]
    ? [projectIdentities[0].id]
    : [],
);
$: composition = composer?.compose({
  projects: projectIdentities,
  activeCrew: effectiveActivities,
  expansionProjectIds,
}) ?? null;
let cameraProjectId = "";
let scale = [1, 2, 3].includes(requestedScale)
  ? requestedScale
  : innerWidth <= 960
    ? 1
    : 2;

export function focusProject(projectId: string): boolean {
  const focused = world?.focusProject(projectId) ?? false;
  if (focused) {
    cameraProjectId = projectId;
    scale = world?.getZoom() ?? scale;
  }
  return focused;
}

export function focusHome(): void {
  cameraProjectId = "";
  world?.focusHome();
  scale = world?.getZoom() ?? scale;
}

function updatePanelBounds() {
  const panel = document.querySelector<HTMLElement>(".panel");
  if (!panel) {
    world?.setPanelBounds(null);
    resizeObserver?.disconnect();
    observedPanel = null;
    return;
  }
  const rect = panel.getBoundingClientRect();
  world?.setPanelBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  if (panel !== observedPanel) {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(updatePanelBounds);
    resizeObserver.observe(panel);
    observedPanel = panel;
  }
}

onMount(() => {
  if (query.get("capture") === "dom" || !composition) return;
  world = new TownWorld(
    host,
    {
      onBuildingSelected: onBuilding,
      onMemberSelected: onMember,
    },
    composition,
    scale,
    {
      debugMap,
      facingSheet,
      ...(facingSheetDirection === undefined ? {} : { facingSheetDirection }),
      ...(groundingAnimation === undefined ? {} : { groundingAnimation }),
      ...(groundingElapsedMs === undefined ? {} : { groundingElapsedMs }),
      groundingLegacyAnchor,
      ...(crewDemoTimeMs === undefined ? {} : { crewDemoTimeMs }),
      ...(crewDemoMinimumWorkMs === undefined ? {} : { crewDemoMinimumWorkMs }),
      ...(demoTransitions.length ? { crewDemoTransitions: demoTransitions } : {}),
      demoHoverFirst: demoActivities !== null && query.get("crewDemoHover") === "1",
    },
  );
  void world.mount().then(() => {
    world?.setCrew(crew);
    world?.setStatus(status);
    updatePanelBounds();
    if (selectedBuilding && !keepHomeFocused)
      world?.focusBuilding(selectedBuilding);
    else if (requestedWorldFocus) world?.focusWorld();
    else if (requestedProjectFocus) {
      const projectId =
        requestedProjectFocus === "first"
          ? projectIdentities[0]?.id
          : requestedProjectFocus;
      if (!projectId || !focusProject(projectId)) focusHome();
    } else focusHome();
  });
  mutationObserver = new MutationObserver(() => requestAnimationFrame(updatePanelBounds));
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", updatePanelBounds);
});
$: if (composition) world?.setComposition(composition);
$: world?.setCrew(crew);
$: world?.setStatus(status);
$: if (selectedBuilding && !keepHomeFocused) world?.focusBuilding(selectedBuilding);
$: if (!selectedBuilding) world?.clearBuildingFocus();
$: if (world) {
  selectedBuilding;
  requestAnimationFrame(updatePanelBounds);
}
onDestroy(() => {
  mutationObserver?.disconnect();
  resizeObserver?.disconnect();
  window.removeEventListener("resize", updatePanelBounds);
  world?.destroy();
});

function setScale(value: number) {
  scale = value;
  world?.setZoom(value);
  host.querySelector("canvas")?.focus({ preventScroll: true });
}
</script>

{#if result.error}
  <div class="map-fatal" role="alert">
    <strong>World regions could not be loaded.</strong>
    {#if import.meta.env.DEV}<pre>{result.error.message}</pre>{/if}
  </div>
{:else}
  <div class="town-canvas" bind:this={host} role="img" aria-label="Quest Engineering authored archipelago. Use camera controls or arrow keys to navigate."></div>
  <div class="camera-controls" aria-label="World camera controls">
    <span class="camera-label" aria-hidden="true">Map view</span>
    <div class="zoom-levels" role="group" aria-label="Zoom level">
      {#each [1, 2, 3] as value}
        <button
          type="button"
          class:active={scale === value}
          aria-label={`Zoom to ${value}×`}
          aria-pressed={scale === value}
          title={`Zoom to ${value}×`}
          on:click={() => setScale(value)}
        >{value}×</button>
      {/each}
    </div>
    <button
      type="button"
      class="home-control"
      aria-label="Focus Home Island"
      title="Focus Home Island (0)"
      on:click={focusHome}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 7.2 8 2l6 5.2v6.3H9.8V9.6H6.2v3.9H2z" />
      </svg>
      <span>Home</span>
    </button>
    {#if projectIdentities.length}
      <select
        aria-label="Focus Project island"
        title="Focus a Project island"
        bind:value={cameraProjectId}
        on:change={(event) => {
          const projectId = event.currentTarget.value;
          if (projectId) focusProject(projectId);
          else focusHome();
        }}
      >
        <option value="">Project islands ({projectIdentities.length})…</option>
        {#each projectIdentities as project}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  {#if debugMap && composition}
    <div class="map-diagnostics">World · {composition.regions.length} regions · {composition.projectIslands.values().length} Project islands · loaded {new Date().toLocaleTimeString()}</div>
  {/if}
  <div class="world-proxies" aria-label="Home Island locations">
    {#each composition?.home.template.authored.locations ?? [] as location}
      <button on:focus={() => world?.focusBuilding(location.id as BuildingId)} on:click={() => onBuilding(location.id as BuildingId)}>{location.label}</button>
    {/each}
    {#each crew as member}
      <button on:click={() => onMember(member.runId, member.memberKey)}>Inspect {member.memberName}: {member.stepName} for {member.questTitle}</button>
    {/each}
  </div>
{/if}

<style>
  .town-canvas { position: absolute; inset: 0; overflow: hidden; outline: none; }
  .camera-controls {
    --camera-cream: #fff4d8;
    --camera-wood-dark: #4b352e;
    --camera-gold: #d9a75f;
    position: absolute;
    z-index: 5;
    right: .85rem;
    bottom: .85rem;
    display: flex;
    align-items: center;
    gap: .45rem;
    min-height: 3rem;
    padding: .42rem .5rem .42rem .7rem;
    color: var(--camera-cream);
    background: linear-gradient(180deg, #604436f5, var(--camera-wood-dark));
    border: 1px solid #9e7754;
    border-bottom: 3px double var(--camera-gold);
    border-radius: 11px;
    box-shadow: 0 8px 22px #24171370, inset 0 1px #f2d39a38;
  }
  .camera-label {
    padding-right: .1rem;
    color: #ead8b6;
    font: 800 .64rem system-ui, sans-serif;
    letter-spacing: .1em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .zoom-levels {
    display: flex;
    overflow: hidden;
    border: 1px solid #d7b67c;
    border-radius: 7px;
    box-shadow: 0 1px 3px #24171366;
  }
  .camera-controls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.35rem;
    min-height: 2rem;
    padding: .34rem .48rem;
    color: #5b4b3e;
    background: #fff8e8;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    font: 800 .74rem system-ui, sans-serif;
  }
  .zoom-levels button + button { border-left: 1px solid #c9ab7b; }
  .camera-controls button:hover { color: #3d332b; background: #f3dfbb; }
  .camera-controls button:focus-visible,
  .camera-controls select:focus-visible {
    position: relative;
    z-index: 1;
    outline: 3px solid #e2a84e;
    outline-offset: 2px;
  }
  .camera-controls button.active {
    color: #fff9e9;
    background: linear-gradient(#5d9670, #477c5a);
    box-shadow: inset 0 0 0 1px #356447;
  }
  .camera-controls .home-control {
    gap: .32rem;
    min-width: auto;
    padding-inline: .65rem;
    color: #fff8e8;
    background: #5b4035;
    border: 1px solid #d7b67c;
    border-radius: 7px;
  }
  .camera-controls .home-control:hover { color: #fff8e8; background: #35645f; }
  .home-control svg { width: .9rem; height: .9rem; fill: currentColor; }
  .camera-controls select {
    min-height: 2.05rem;
    max-width: min(16rem, 38vw);
    padding: .34rem 1.8rem .34rem .55rem;
    color: #4b4037;
    background: #fff8e8;
    border: 1px solid #d7b67c;
    border-radius: 7px;
    box-shadow: 0 1px 3px #24171366;
    font: 750 .74rem system-ui, sans-serif;
  }
  @media (max-width: 700px) {
    .camera-controls { right: .5rem; bottom: .5rem; gap: .35rem; padding-left: .45rem; }
    .camera-label { display: none; }
    .camera-controls .home-control span { display: none; }
    .camera-controls .home-control { min-width: 2.15rem; padding-inline: .5rem; }
    .camera-controls select { max-width: 34vw; }
  }
  .map-diagnostics { position: absolute; z-index: 7; left: .75rem; top: 4rem; padding: .35rem .5rem; color: #fff3d4; background: #29373ae8; border: 1px solid #d6ad6a; font: 700 .7rem ui-monospace, monospace; }
  .map-fatal { position: absolute; z-index: 20; inset: 5rem 1rem auto; padding: 1rem; color: #fff3d4; background: #5b3435; border: 2px solid #d6ad6a; }
  .map-fatal pre { white-space: pre-wrap; }
  .world-proxies { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .world-proxies:focus-within { z-index: 20; top: 4rem; left: 1rem; width: auto; height: auto; max-height: calc(100vh - 5rem); overflow: auto; clip-path: none; display: grid; padding: .5rem; background: #29373a; border: 2px solid #d6ad6a; }
  .town-canvas :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
</style>
