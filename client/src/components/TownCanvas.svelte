<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { BuildingId } from "../state/app-store";
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
const query = new URLSearchParams(location.search);
const requestedScale = Number(query.get("scale"));
const keepTownFocused = query.get("camera") === "town";
let scale = [2, 3, 4].includes(requestedScale) ? requestedScale : innerWidth <= 960 ? 2 : 3;

onMount(() => {
  if (new URLSearchParams(location.search).get("capture") === "dom") return;
  world = new TownWorld(host, {
    onBuildingSelected: onBuilding,
    onMemberSelected: onMember,
  }, scale);
  void world.mount().then(() => {
    world?.setModel(model);
    world?.setStatus(status);
    if (keepTownFocused) world?.focusTown();
  });
});
$: world?.setModel(model);
$: world?.setStatus(status);
$: if (selectedBuilding && !keepTownFocused) world?.focusBuilding(selectedBuilding);
$: if (!selectedBuilding) world?.clearBuildingFocus();
$: if (selectedMember) world?.focusMember(selectedMember);
onDestroy(() => world?.destroy());

function setScale(value: number) {
  scale = value;
  world?.setZoom(value);
  host.querySelector("canvas")?.focus({ preventScroll: true });
}
</script>

<div class="town-canvas" bind:this={host} role="img" aria-label="Quest Engineering town world. Use camera controls or arrow keys to navigate."></div>
<div class="camera-controls" aria-label="Town camera controls">
  {#each [2, 3, 4] as value}<button class:active={scale === value} aria-pressed={scale === value} on:click={() => setScale(value)}>{value}×</button>{/each}
  <button title="Focus town" on:click={() => world?.focusTown()}>Town</button>
</div>
<div class="world-proxies" aria-label="Town locations">
  {#each [
    ["gatehouse", "Projects"], ["guild", "Guild Hall"], ["blacksmith", "Forge"],
    ["tavern", "Tavern"], ["quest-board", "Quest Board"], ["work-area", "Work Yard"],
  ] as location}
    <button on:focus={() => world?.focusBuilding(location[0] as BuildingId)} on:click={() => onBuilding(location[0] as BuildingId)}>{location[1]}</button>
  {/each}
  {#each model?.members ?? [] as member}
    <button on:focus={() => world?.focusMember(member.member.member_key)} on:click={() => onMember(member.member.member_key)}>Inspect {member.member.name}: {member.visual.replaceAll("_", " ")}</button>
  {/each}
</div>

<style>
  .town-canvas { position: absolute; inset: 0; overflow: hidden; outline: none; }
  .camera-controls { position: absolute; z-index: 5; right: .75rem; bottom: .75rem; display: flex; gap: .25rem; padding: .25rem; background: #120e23cc; border: 1px solid #aea47e; }
  .camera-controls button { min-width: 2.2rem; padding: .28rem .4rem; border: 1px solid #aea47e; background: #2a2942; color: #dacea4; font: 700 .72rem system-ui, sans-serif; }
  .camera-controls button.active { color: #120e23; background: #c9c03d; }
  .world-proxies { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .world-proxies:focus-within { z-index: 20; top: 4rem; left: 1rem; width: auto; height: auto; max-height: calc(100vh - 5rem); overflow: auto; clip-path: none; display: grid; padding: .5rem; background: #120e23; border: 2px solid #aea47e; }
  .town-canvas :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
</style>
