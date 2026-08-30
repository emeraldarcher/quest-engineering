<script lang="ts">
import { fixtureNames } from "../fixtures/fixtures";

const params = new URLSearchParams(location.search);
let selected = params.get("fixture") ?? "";
function choose() {
  const next = new URL(location.href);
  if (selected) next.searchParams.set("fixture", selected);
  else next.searchParams.delete("fixture");
  location.href = next.toString();
}
</script>

<div class="fixture-chooser">
  <label>Development scene
    <select bind:value={selected} on:change={choose}>
      <option value="">Live Product</option>
      {#each fixtureNames as name}<option value={name}>{name.replaceAll("-", " ")}</option>{/each}
    </select>
  </label>
</div>

<style>
.fixture-chooser { position: fixed; z-index: 30; left: .65rem; bottom: .65rem; padding: .35rem .5rem; border: 1px solid #aea47e; background: #120e23e8; color: #dacea4; font: 600 .72rem system-ui, sans-serif; }
label { display: flex; align-items: center; gap: .4rem; }
select { max-width: 10rem; padding: .2rem; color: #fff1a9; background: #2a2942; border: 1px solid #aea47e; }
</style>
