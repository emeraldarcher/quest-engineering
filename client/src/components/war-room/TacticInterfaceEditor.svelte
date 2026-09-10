<script lang="ts">
import type {
  ArtifactRefContract,
  TacticInputPortContract,
  TacticInterfaceContract,
  TacticOutputPortContract,
} from "../../api/contracts";
import {
  artifactTypeLabel,
  BUILT_IN_ARTIFACT_KINDS,
  generatedPortKey,
} from "./tactic-model";

interface OutputCandidate {
  ref: ArtifactRefContract;
  label: string;
}
interface AcceptedCandidate {
  gateKey: string;
  label: string;
}

export let value: TacticInterfaceContract;
export let outputCandidates: (kind: string) => OutputCandidate[];
export let acceptedCandidates: (kind: string) => AcceptedCandidate[];
export let inputUses: (key: string) => string[];
export let onChange: (value: TacticInterfaceContract) => void;

const manuallyEditedInputs = new Set<number>();
const manuallyEditedOutputs = new Set<number>();

function existingKeys(direction: "input" | "output", index: number): string[] {
  return [...value.inputs, ...value.outputs]
    .filter((port) =>
      direction === "input"
        ? value.inputs[index] !== port
        : value.outputs[index] !== port,
    )
    .map((port) => port.key);
}
function inputKey(port: TacticInputPortContract, index: number, label = port.label, kind = port.kind) {
  return manuallyEditedInputs.has(index)
    ? port.key
    : generatedPortKey(label, kind, "input", existingKeys("input", index));
}
function outputKey(
  port: TacticOutputPortContract,
  index: number,
  label = port.label,
  kind = port.kind,
  source = port.source,
) {
  return manuallyEditedOutputs.has(index)
    ? port.key
    : generatedPortKey(
        label,
        kind,
        "output",
        existingKeys("output", index),
        source.type === "accepted_subject",
      );
}
function patchInput(index: number, patch: Partial<TacticInputPortContract>) {
  onChange({
    ...value,
    inputs: value.inputs.map((port, current) =>
      current === index ? { ...port, ...patch } : port,
    ),
  });
}
function patchOutput(index: number, patch: Partial<TacticOutputPortContract>) {
  onChange({
    ...value,
    outputs: value.outputs.map((port, current) =>
      current === index ? { ...port, ...patch } : port,
    ),
  });
}
function addInput() {
  const label = "New Input";
  onChange({
    ...value,
    inputs: [
      ...value.inputs,
      {
        key: generatedPortKey(label, "", "input", [
          ...value.inputs,
          ...value.outputs,
        ].map((port) => port.key)),
        label,
        kind: "",
        required: false,
      },
    ],
  });
}
function addOutput() {
  const label = "New Output";
  onChange({
    ...value,
    outputs: [
      ...value.outputs,
      {
        key: generatedPortKey(label, "", "output", [
          ...value.inputs,
          ...value.outputs,
        ].map((port) => port.key)),
        label,
        kind: "",
        source: { type: "binding", binding: { producer: "", output: "" } },
      },
    ],
  });
}
function removeInput(index: number) {
  onChange({ ...value, inputs: value.inputs.filter((_, current) => current !== index) });
}
function removeOutput(index: number) {
  onChange({ ...value, outputs: value.outputs.filter((_, current) => current !== index) });
}
function kindSelectValue(kind: string): string {
  if (!kind) return "";
  return (BUILT_IN_ARTIFACT_KINDS as readonly string[]).includes(kind)
    ? kind
    : "__custom__";
}
function parseBinding(value: string): ArtifactRefContract | null {
  const split = value.lastIndexOf("::");
  return split > 0
    ? { producer: value.slice(0, split), output: value.slice(split + 2) }
    : null;
}
function bindingValue(ref: ArtifactRefContract): string {
  return ref.producer && ref.output ? `${ref.producer}::${ref.output}` : "";
}
function exportValue(port: TacticOutputPortContract): string {
  return port.source.type === "accepted_subject"
    ? `accepted::${port.source.gate_key}`
    : port.source.binding.producer
      ? `binding::${bindingValue(port.source.binding)}`
      : "";
}
function exportAvailable(
  port: TacticOutputPortContract,
  accepted: AcceptedCandidate[],
  internal: OutputCandidate[],
): boolean {
  const source = port.source;
  if (source.type === "accepted_subject")
    return accepted.some((candidate) => candidate.gateKey === source.gate_key);
  return internal.some(
    (candidate) => bindingValue(candidate.ref) === bindingValue(source.binding),
  );
}
function updateExport(index: number, port: TacticOutputPortContract, selected: string) {
  let source: TacticOutputPortContract["source"] = {
    type: "binding",
    binding: { producer: "", output: "" },
  };
  if (selected.startsWith("accepted::"))
    source = { type: "accepted_subject", gate_key: selected.slice("accepted::".length) };
  else if (selected.startsWith("binding::")) {
    const binding = parseBinding(selected.slice("binding::".length));
    if (binding) source = { type: "binding", binding };
  }
  patchOutput(index, { source, key: outputKey(port, index, port.label, port.kind, source) });
}
</script>

<section class="interface-editor" aria-label="Tactic interface editor">
  <header>
    <div><span class="eyebrow">Reusable contract</span><h2>Tactic Interface</h2></div>
    <p>Define only what surrounding Tactics need to provide or receive.</p>
  </header>

  <section class="port-section">
    <div class="section-title"><div><h3>Inputs</h3><small>What this Tactic accepts</small></div><button type="button" on:click={addInput}>+ Input</button></div>
    {#each value.inputs as port, index}
      {@const uses = inputUses(port.key)}
      <article class="port-card input-port">
        <div class="card-heading"><div><span class="port-direction">Input</span><strong>{port.label || "Unnamed input"}</strong></div><button class="remove-port" aria-label={`Remove input ${port.label}`} title="Remove input" type="button" on:click={() => removeInput(index)}>×</button></div>
        <label>Name<input aria-label={`Input name ${index + 1}`} value={port.label} on:input={(event) => patchInput(index, { label: event.currentTarget.value, key: inputKey(port, index, event.currentTarget.value) })} /></label>
        <label>Type<select aria-label={`Input type ${index + 1}`} value={kindSelectValue(port.kind)} on:change={(event) => { const kind = event.currentTarget.value === "__custom__" ? (port.kind && kindSelectValue(port.kind) === "__custom__" ? port.kind : "custom_artifact") : event.currentTarget.value; patchInput(index, {kind, key:inputKey(port,index,port.label,kind)}); }}><option value="">Choose artifact type…</option>{#each BUILT_IN_ARTIFACT_KINDS as kind}<option value={kind}>{artifactTypeLabel(kind)}</option>{/each}<option value="__custom__">Custom Artifact</option></select></label>
        {#if kindSelectValue(port.kind) === "__custom__"}<label>Custom type<input aria-label={`Custom input type ${index + 1}`} value={port.kind} on:input={(event) => patchInput(index, {kind:event.currentTarget.value,key:inputKey(port,index,port.label,event.currentTarget.value)})} /></label>{/if}
        <label class="requirement"><input type="checkbox" checked={port.required} on:change={(event) => patchInput(index, {required:event.currentTarget.checked})} /><span><b>{port.required ? "Required" : "Optional"}</b><small>{port.required ? "Every use must connect this input." : "A parent may leave this unconnected."}</small></span></label>
        {#if uses.length}<p class="usage"><b>Used by</b> {uses.join(", ")}</p>{/if}
        <details><summary>Advanced</summary><label>Internal key<input aria-label={`Input key ${index + 1}`} value={port.key} on:input={(event) => {manuallyEditedInputs.add(index);patchInput(index,{key:event.currentTarget.value});}} /></label><small>Used for stable wiring. Most authors never need to change this.</small></details>
      </article>
    {:else}<p class="empty-copy">Inputs · None</p>{/each}
  </section>

  <section class="port-section">
    <div class="section-title"><div><h3>Outputs</h3><small>What this Tactic exposes</small></div><button type="button" on:click={addOutput}>+ Output</button></div>
    {#each value.outputs as port, index}
      {@const accepted = acceptedCandidates(port.kind)}
      {@const internal = outputCandidates(port.kind)}
      <article class="port-card output-port">
        <div class="card-heading"><div><span class="port-direction">Output</span><strong>{port.label || "Unnamed output"}</strong></div><button class="remove-port" aria-label={`Remove output ${port.label}`} title="Remove output" type="button" on:click={() => removeOutput(index)}>×</button></div>
        <label>Name<input aria-label={`Output name ${index + 1}`} value={port.label} on:input={(event) => patchOutput(index, {label:event.currentTarget.value,key:outputKey(port,index,event.currentTarget.value)})} /></label>
        <label>Type<select aria-label={`Output type ${index + 1}`} value={kindSelectValue(port.kind)} on:change={(event) => { const kind = event.currentTarget.value === "__custom__" ? (port.kind && kindSelectValue(port.kind) === "__custom__" ? port.kind : "custom_artifact") : event.currentTarget.value; patchOutput(index,{kind,key:outputKey(port,index,port.label,kind)}); }}><option value="">Choose artifact type…</option>{#each BUILT_IN_ARTIFACT_KINDS as kind}<option value={kind}>{artifactTypeLabel(kind)}</option>{/each}<option value="__custom__">Custom Artifact</option></select></label>
        {#if kindSelectValue(port.kind) === "__custom__"}<label>Custom type<input aria-label={`Custom output type ${index + 1}`} value={port.kind} on:input={(event) => patchOutput(index,{kind:event.currentTarget.value,key:outputKey(port,index,port.label,event.currentTarget.value)})} /></label>{/if}
        <label>Export from<select aria-label={`Export source for ${port.label}`} value={exportValue(port)} on:change={(event) => updateExport(index, port, event.currentTarget.value)}><option value="">Export source not selected yet</option>{#if exportValue(port) && !exportAvailable(port, accepted, internal)}<option value={exportValue(port)}>Unavailable export · choose another</option>{/if}{#if accepted.length}<optgroup label="Acceptance gates">{#each accepted as candidate}<option value={`accepted::${candidate.gateKey}`}>{candidate.label} → Accepted Subject</option>{/each}</optgroup>{/if}{#if internal.length}<optgroup label="Step and reusable Tactic outputs">{#each internal as candidate}<option value={`binding::${bindingValue(candidate.ref)}`}>{candidate.label}</option>{/each}</optgroup>{/if}</select></label>
        {#if !port.kind}<p class="incomplete">Choose a type to see compatible exports.</p>{:else if exportValue(port) && !exportAvailable(port, accepted, internal)}<p class="incomplete">This export is no longer available. Choose another source or restore the referenced Step.</p>{:else if !accepted.length && !internal.length}<p class="incomplete">Create a compatible Step output before exporting this port.</p>{:else if !exportValue(port)}<p class="incomplete">Export source not selected yet. You can continue building the workflow.</p>{/if}
        <details><summary>Advanced</summary><label>Internal key<input aria-label={`Output key ${index + 1}`} value={port.key} on:input={(event) => {manuallyEditedOutputs.add(index);patchOutput(index,{key:event.currentTarget.value});}} /></label><small>Used for stable parent bindings. Most authors never need to change this.</small></details>
      </article>
    {:else}<p class="empty-copy">Outputs · None</p>{/each}
  </section>
</section>

<style>
.interface-editor{display:grid;gap:.85rem;min-width:0}.interface-editor header{padding-bottom:.65rem;border-bottom:1px solid #d0ae80}.interface-editor header h2{margin:.1rem 0;color:#293b39;font:700 1.3rem Georgia,serif}.interface-editor header p{margin:.2rem 0;color:#68736d;font-size:.75rem;line-height:1.4}.port-section{display:grid;gap:.5rem;min-width:0}.section-title{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.section-title h3{margin:0;color:#314442;font:700 1rem Georgia,serif}.section-title small{display:block;color:#756b5f;font-size:.67rem}.section-title button{min-height:1.95rem!important;padding:.25rem .5rem;color:#3f6c65;background:#fffaf0;border:1px solid #aa8b67;box-shadow:none;font-size:.72rem}.port-card{display:grid;gap:.5rem;min-width:0;padding:.65rem;background:#f6e6c4;border:1px solid #c6a070;border-radius:9px;box-shadow:0 2px 5px #72503518}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:.4rem;min-width:0}.card-heading>div{display:grid;min-width:0}.card-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#314442;font:700 .92rem Georgia,serif}.port-direction{color:#896742;font-size:.62rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.remove-port{width:1.9rem;min-height:1.9rem!important;padding:0;color:#914b44;background:#fff9eb;border:1px solid #c7a274;box-shadow:none}.port-card>label,.port-card details label{display:grid;gap:.2rem;min-width:0;color:#42504e;font-size:.68rem;font-weight:800}.port-card input:not([type=checkbox]),.port-card select{box-sizing:border-box;width:100%;min-width:0;min-height:2.3rem;padding:.45rem .55rem;color:#293b39;background:#fffdf6;border:1px solid #b7956b;border-radius:7px;box-shadow:inset 0 1px 2px #69492e12}.requirement{display:flex!important;align-items:center;gap:.5rem;padding:.45rem .5rem;background:#fff8e8;border:1px solid #d1b184;border-radius:7px}.requirement input{width:1rem;height:1rem;accent-color:#4c8179}.requirement span{display:grid}.requirement small{color:#746c60;font-weight:400}.usage{margin:0;padding:.4rem .5rem;color:#5e665e;background:#fff4d6;border-left:3px solid #6f9587;font-size:.7rem}.port-card details{padding-top:.35rem;border-top:1px solid #d4b88d}.port-card summary{cursor:pointer;color:#3d625d;font-size:.72rem;font-weight:750}.port-card details label{margin-top:.45rem}.port-card details small{display:block;margin-top:.25rem;color:#746c60;font-size:.65rem}.incomplete,.empty-copy{margin:0;padding:.45rem .5rem;color:#765d38;background:#fff2cc;border-left:3px solid #c28a35;border-radius:0 6px 6px 0;font-size:.7rem}.empty-copy{color:#71695d;background:#f3e7cb;border-color:#9c8c72}
</style>
