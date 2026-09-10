<script lang="ts">
type AddKind = "step" | "sequence" | "parallel" | "until" | "use";

export let hasSelection: boolean;
export let canMoveUp: boolean;
export let canMoveDown: boolean;
export let canMoveInto: boolean;
export let canMoveOut: boolean;
export let onAdd: (kind: AddKind) => void;
export let onMove: (direction: -1 | 1) => void;
export let onMoveInto: () => void;
export let onMoveOut: () => void;
export let onRemove: () => void;

let addOpen = false;
function add(kind: AddKind) {
  addOpen = false;
  onAdd(kind);
}
</script>

<nav class="tree-toolbar" aria-label="Tactic tree actions">
  <details class="add-menu" bind:open={addOpen}>
    <summary>+ Add</summary>
    <div class="add-options">
      <button type="button" on:click={() => add("step")}><strong>Step</strong><small>One crew action</small></button>
      <button type="button" on:click={() => add("sequence")}><strong>Sequence</strong><small>Ordered work</small></button>
      <button type="button" on:click={() => add("parallel")}><strong>Parallel</strong><small>Work together</small></button>
      <button type="button" on:click={() => add("until")}><strong>Until</strong><small>Review and revise</small></button>
      <button type="button" on:click={() => add("use")}><strong>Reuse</strong><small>Compose a Tactic</small></button>
    </div>
  </details>
  {#if hasSelection}
    <div class="selection-actions" aria-label="Selected item actions">
      <button aria-label="Move selected item up" title="Move up" type="button" disabled={!canMoveUp} on:click={() => onMove(-1)}>↑</button>
      <button aria-label="Move selected item down" title="Move down" type="button" disabled={!canMoveDown} on:click={() => onMove(1)}>↓</button>
      <button aria-label="Move selected item into previous group" title="Move into previous group" type="button" disabled={!canMoveInto} on:click={onMoveInto}>→ <span>Into</span></button>
      <button aria-label="Move selected item out of group" title="Move out of group" type="button" disabled={!canMoveOut} on:click={onMoveOut}>← <span>Out</span></button>
      <button class="remove" type="button" on:click={onRemove}>Remove</button>
    </div>
  {/if}
</nav>

<style>
.tree-toolbar{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-width:0}.add-menu{position:relative}.add-menu summary{display:grid;place-items:center;min-height:2.15rem;padding:.3rem .75rem;color:#fff9e9;background:linear-gradient(#5d9670,#477c5a);border:1px solid #356447;border-radius:7px;cursor:pointer;font-size:.78rem;font-weight:800;list-style:none}.add-menu summary::-webkit-details-marker{display:none}.add-options{position:absolute;top:calc(100% + .3rem);left:0;z-index:6;display:grid;width:13rem;padding:.35rem;background:#fff3d2;border:2px solid #8f6848;border-radius:9px;box-shadow:0 8px 20px #49332355}.add-options button{display:grid;gap:.05rem;min-height:2.7rem!important;padding:.35rem .5rem;color:#334643;text-align:left;background:transparent;border:0;box-shadow:none}.add-options button:hover{background:#ecd4a4}.add-options small{color:#766b5e;font-size:.67rem}.selection-actions{display:flex;min-width:0;gap:.25rem}.selection-actions button{min-width:2.15rem;min-height:2.15rem!important;padding:.25rem .45rem;color:#365e59;background:#fff8e8;border:1px solid #9e8060;border-radius:7px;box-shadow:none;font-size:.74rem}.selection-actions button:disabled{cursor:not-allowed;opacity:.4;background:#eadfc8;border-style:dashed}.selection-actions .remove{color:#934a43}.selection-actions span{font-size:.67rem}@media(max-width:980px){.selection-actions span{display:none}}@media(max-width:520px){.tree-toolbar{align-items:flex-start}.selection-actions{overflow-x:auto}}
</style>
