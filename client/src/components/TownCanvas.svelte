<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { BuildingId } from "../state/app-store";
import { loadBundledTownMap } from "../world/authored/map-loader";
import type { RunWorldModel } from "../world/projector";
import { TownWorld, type TownStatusModel } from "../world/town-world";

export let model: RunWorldModel | null = null;
export let status: TownStatusModel = { preparingReview: 0, awaitingReview: 0, attention: 0, complete: 0 };
export let selectedBuilding: BuildingId | null = null;
export let selectedMember: string | null = null;
export let onBuilding: (id: BuildingId) => void;
export let onMember: (key: string) => void;
let host: HTMLDivElement;
let world: TownWorld | null = null;
let mutationObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedPanel: HTMLElement | null = null;
const query = new URLSearchParams(location.search);
const requestedScale = Number(query.get("scale"));
const keepTownFocused = query.get("camera") === "town";
const debugMap = import.meta.env.DEV && query.get("debugMap") === "1";
const result = loadBundledTownMap();
let scale = [1, 2, 3].includes(requestedScale)
  ? requestedScale
  : innerWidth <= 960
    ? 1
    : 2;

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
  if (query.get("capture") === "dom" || !result.map) return;
  world = new TownWorld(
    host,
    {
      onBuildingSelected: onBuilding,
      onMemberSelected: onMember,
    },
    result.map,
    scale,
    { debugMap },
  );
  void world.mount().then(() => {
    world?.setModel(model);
    world?.setStatus(status);
    updatePanelBounds();
    if (selectedBuilding && !keepTownFocused)
      world?.focusBuilding(selectedBuilding);
    else world?.focusTown();
    if (selectedMember) world?.focusMember(selectedMember);
  });
  mutationObserver = new MutationObserver(() => requestAnimationFrame(updatePanelBounds));
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", updatePanelBounds);
});
$: world?.setModel(model);
$: world?.setStatus(status);
$: if (selectedBuilding && !keepTownFocused) world?.focusBuilding(selectedBuilding);
$: if (!selectedBuilding) world?.clearBuildingFocus();
$: if (selectedMember) world?.focusMember(selectedMember);
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
    <strong>Town map could not be loaded.</strong>
    {#if import.meta.env.DEV}<pre>{result.error.message}</pre>{/if}
  </div>
{:else}
  <div class="town-canvas" bind:this={host} role="img" aria-label="Quest Engineering authored Sunnyside town. Use camera controls or arrow keys to navigate."></div>
  <div class="camera-controls" aria-label="Town camera controls">
    {#each [1, 2, 3] as value}<button class:active={scale === value} aria-pressed={scale === value} on:click={() => setScale(value)}>{value}×</button>{/each}
    <button title="Fit authored functional-town bounds" on:click={() => world?.focusTown()}>Town</button>
  </div>
  {#if debugMap && result.map}
    <div class="map-diagnostics">Town map v{result.map.schemaVersion} · {result.map.hash} · loaded {new Date().toLocaleTimeString()}</div>
  {/if}
  <div class="world-proxies" aria-label="Town locations">
    {#each result.map?.locations ?? [] as location}
      <button on:focus={() => world?.focusBuilding(location.id as BuildingId)} on:click={() => onBuilding(location.id as BuildingId)}>{location.label}</button>
    {/each}
    {#each model?.members ?? [] as member}
      <button on:focus={() => world?.focusMember(member.member.member_key)} on:click={() => onMember(member.member.member_key)}>Inspect {member.member.name}: {member.visual.replaceAll("_", " ")}</button>
    {/each}
  </div>
{/if}

<style>
  .town-canvas { position: absolute; inset: 0; overflow: hidden; outline: none; }
  .camera-controls { position: absolute; z-index: 5; right: .75rem; bottom: .75rem; display: flex; gap: .25rem; padding: .25rem; background: #314b46dd; border: 1px solid #d6ad6a; }
  .camera-controls button { min-width: 2.2rem; padding: .28rem .4rem; border: 1px solid #91aa8d; background: #405c57; color: #fff2d1; font: 700 .72rem system-ui, sans-serif; }
  .camera-controls button.active { color: #29373a; background: #f3dfb5; }
  .map-diagnostics { position: absolute; z-index: 7; left: .75rem; top: 4rem; padding: .35rem .5rem; color: #fff3d4; background: #29373ae8; border: 1px solid #d6ad6a; font: 700 .7rem ui-monospace, monospace; }
  .map-fatal { position: absolute; z-index: 20; inset: 5rem 1rem auto; padding: 1rem; color: #fff3d4; background: #5b3435; border: 2px solid #d6ad6a; }
  .map-fatal pre { white-space: pre-wrap; }
  .world-proxies { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .world-proxies:focus-within { z-index: 20; top: 4rem; left: 1rem; width: auto; height: auto; max-height: calc(100vh - 5rem); overflow: auto; clip-path: none; display: grid; padding: .5rem; background: #29373a; border: 2px solid #d6ad6a; }
  .town-canvas :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
</style>
