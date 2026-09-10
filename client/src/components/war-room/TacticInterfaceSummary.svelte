<script lang="ts">
import type { TacticInterfaceContract } from "../../api/contracts";
import { artifactTypeLabel } from "./tactic-model";

export let value: TacticInterfaceContract;
export let onEdit: (() => void) | null = null;
</script>

<section class="interface-summary" aria-label="Tactic interface summary">
  <div class="summary-heading">
    <div>
      <span class="eyebrow">Contract</span>
      <h3>Interface</h3>
    </div>
    <span>{value.inputs.length} {value.inputs.length === 1 ? "input" : "inputs"} · {value.outputs.length} {value.outputs.length === 1 ? "output" : "outputs"}</span>
    {#if onEdit}<button type="button" on:click={onEdit}>Edit</button>{/if}
  </div>
  <div class="port-summary">
    <div><b>Inputs</b>{#if value.inputs.length}{#each value.inputs as port}<span title={`${port.label} · ${artifactTypeLabel(port.kind)}`}>{port.label} · {port.required ? "Required" : "Optional"}</span>{/each}{:else}<span>None</span>{/if}</div>
    <div><b>Outputs</b>{#if value.outputs.length}{#each value.outputs as port}<span title={`${port.label} · ${artifactTypeLabel(port.kind)}`}>{port.label}</span>{/each}{:else}<span>None</span>{/if}</div>
  </div>
</section>

<style>
.interface-summary{display:grid;gap:.38rem;min-width:0;padding:.5rem .7rem;background:#f6e6c4;border:1px solid #c49b6d;border-radius:8px}.summary-heading{display:flex;align-items:center;gap:.55rem;min-width:0}.summary-heading>div{display:flex;align-items:baseline;gap:.4rem}.summary-heading h3{margin:0;color:#314442;font:700 .95rem Georgia,serif}.summary-heading>span{min-width:0;color:#756a5b;font-size:.7rem}.summary-heading button{margin-left:auto;min-height:1.9rem!important;padding:.2rem .5rem;color:#35645f;background:#fff9e9;border:1px solid #b7956b;box-shadow:none;font-size:.72rem}.port-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}.port-summary>div{display:flex;min-width:0;gap:.35rem;align-items:baseline;flex-wrap:wrap;font-size:.7rem}.port-summary b{color:#315f58}.port-summary span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#665f54}@media(max-width:600px){.port-summary{grid-template-columns:1fr}.summary-heading .eyebrow{display:none}}
</style>
