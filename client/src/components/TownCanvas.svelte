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
const debugMap = import.meta.env.DEV && query.get("debugMap") === "1";
const crewDemoScenarios = new Set<CrewDemoScenario>([
  "none",
  "entering",
  "crafting",
  "research",
  "mining",
  "woodcutting",
  "parallel",
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
const projectTemplateSelection =
  import.meta.env.DEV && query.get("worldTemplate") === "fixture"
    ? "reference-fixture"
    : "production";
const result = loadBundledWorldTemplates(projectTemplateSelection);
const composer = result.templates ? new WorldComposer(result.templates) : null;
$: effectiveActivities = demoActivities ?? activities;
$: crew = projectCrewPresentation(effectiveActivities);
$: projectIdentities = projects
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
  if (focused) cameraProjectId = projectId;
  return focused;
}

export function focusHome(): void {
  cameraProjectId = "";
  world?.focusHome();
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
      ...(crewDemoTimeMs === undefined ? {} : { crewDemoTimeMs }),
      demoHoverFirst: demoActivities !== null && query.get("crewDemoHover") === "1",
    },
  );
  void world.mount().then(() => {
    world?.setCrew(crew);
    world?.setStatus(status);
    updatePanelBounds();
    if (selectedBuilding && !keepHomeFocused)
      world?.focusBuilding(selectedBuilding);
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
    {#each [1, 2, 3] as value}<button class:active={scale === value} aria-pressed={scale === value} on:click={() => setScale(value)}>{value}×</button>{/each}
    <button title="Focus Home Island" on:click={focusHome}>Home</button>
    {#if projectIdentities.length}
      <select
        aria-label="Focus Project island"
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
  .camera-controls { position: absolute; z-index: 5; right: .75rem; bottom: .75rem; display: flex; gap: .25rem; padding: .25rem; background: #314b46dd; border: 1px solid #d6ad6a; }
  .camera-controls button { min-width: 2.2rem; padding: .28rem .4rem; border: 1px solid #91aa8d; background: #405c57; color: #fff2d1; font: 700 .72rem system-ui, sans-serif; }
  .camera-controls button.active { color: #29373a; background: #f3dfb5; }
  .camera-controls select { max-width: min(16rem, 40vw); padding: .28rem .4rem; border: 1px solid #91aa8d; background: #405c57; color: #fff2d1; font: 700 .72rem system-ui, sans-serif; }
  .map-diagnostics { position: absolute; z-index: 7; left: .75rem; top: 4rem; padding: .35rem .5rem; color: #fff3d4; background: #29373ae8; border: 1px solid #d6ad6a; font: 700 .7rem ui-monospace, monospace; }
  .map-fatal { position: absolute; z-index: 20; inset: 5rem 1rem auto; padding: 1rem; color: #fff3d4; background: #5b3435; border: 2px solid #d6ad6a; }
  .map-fatal pre { white-space: pre-wrap; }
  .world-proxies { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .world-proxies:focus-within { z-index: 20; top: 4rem; left: 1rem; width: auto; height: auto; max-height: calc(100vh - 5rem); overflow: auto; clip-path: none; display: grid; padding: .5rem; background: #29373a; border: 2px solid #d6ad6a; }
  .town-canvas :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
</style>
