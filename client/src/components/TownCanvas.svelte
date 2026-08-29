<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { BuildingId } from "../state/app-store";
import type { RunWorldModel } from "../world/projector";
import { TownWorld } from "../world/town-world";

export let model: RunWorldModel | null = null;
export let selectedBuilding: BuildingId | null = null;
export let onBuilding: (id: BuildingId) => void;
export let onMember: (key: string) => void;
let host: HTMLDivElement;
let world: TownWorld | null = null;

onMount(() => {
  world = new TownWorld(host, {
    onBuildingSelected: onBuilding,
    onMemberSelected: onMember,
  });
  void world.mount().then(() => world?.setModel(model));
});
$: world?.setModel(model);
$: if (selectedBuilding) world?.focusBuilding(selectedBuilding);
onDestroy(() => world?.destroy());
</script>

<div class="town-canvas" bind:this={host} aria-label="Quest Engineering town world"></div>
<div class="world-proxies" aria-label="Town locations">
  {#each [
    ["gatehouse", "Wayfinder Lodge"], ["guild", "Guild Hall"], ["blacksmith", "Forge"],
    ["tavern", "Tavern"], ["quest-board", "Quest Board"], ["work-area", "Work Yard"],
  ] as location}
    <button on:click={() => onBuilding(location[0] as BuildingId)}>{location[1]}</button>
  {/each}
  {#each model?.members ?? [] as member}
    <button on:click={() => onMember(member.member.member_key)}>Inspect {member.member.name}</button>
  {/each}
</div>

<style>
  .town-canvas { position: absolute; inset: 0; overflow: hidden; }
  .world-proxies { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .world-proxies:focus-within { z-index: 20; top: 4rem; left: 1rem; width: auto; height: auto; overflow: visible; clip-path: none; display: grid; padding: .5rem; background: #14252d; }
  .town-canvas :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
</style>
