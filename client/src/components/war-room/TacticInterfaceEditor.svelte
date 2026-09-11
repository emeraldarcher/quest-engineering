<script lang="ts">
import type {
  ArtifactRefContract,
  TacticInputPortContract,
  TacticInterfaceContract,
  TacticOutputPortContract,
} from "../../api/contracts";
import ArtifactTypeSelect from "./ArtifactTypeSelect.svelte";
import {
  artifactTypeLabel,
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
function inputKey(
  port: TacticInputPortContract,
  index: number,
  label = port.label,
  kind = port.kind,
) {
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
        key: generatedPortKey(
          label,
          "",
          "input",
          [...value.inputs, ...value.outputs].map((port) => port.key),
        ),
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
        key: generatedPortKey(
          label,
          "",
          "output",
          [...value.inputs, ...value.outputs].map((port) => port.key),
        ),
        label,
        kind: "",
        source: { type: "binding", binding: { producer: "", output: "" } },
      },
    ],
  });
}
function removeInput(index: number) {
  onChange({
    ...value,
    inputs: value.inputs.filter((_, current) => current !== index),
  });
}
function removeOutput(index: number) {
  onChange({
    ...value,
    outputs: value.outputs.filter((_, current) => current !== index),
  });
}
function parseBinding(selected: string): ArtifactRefContract | null {
  const split = selected.lastIndexOf("::");
  return split > 0
    ? {
        producer: selected.slice(0, split),
        output: selected.slice(split + 2),
      }
    : null;
}
function bindingValue(ref: ArtifactRefContract): string {
  return ref.producer && ref.output ? `${ref.producer}::${ref.output}` : "";
}
function exportAvailable(
  port: TacticOutputPortContract,
  accepted: AcceptedCandidate[],
  internal: OutputCandidate[],
): boolean {
  const source = port.source;
  if (source.type === "accepted_subject")
    return accepted.some(
      (candidate) => candidate.gateKey === source.gate_key,
    );
  return internal.some(
    (candidate) => bindingValue(candidate.ref) === bindingValue(source.binding),
  );
}
function changeInputKind(
  index: number,
  port: TacticInputPortContract,
  kind: string,
) {
  patchInput(index, {
    kind,
    key: inputKey(port, index, port.label, kind),
  });
}
function changeOutputKind(
  index: number,
  port: TacticOutputPortContract,
  kind: string,
) {
  const accepted = acceptedCandidates(kind);
  const emptySource =
    port.source.type === "binding" && !port.source.binding.producer;
  const source =
    emptySource && accepted.length === 1
      ? {
          type: "accepted_subject" as const,
          gate_key: accepted[0]!.gateKey,
        }
      : port.source;
  const label =
    port.label === "New Output" && source.type === "accepted_subject"
      ? `Accepted ${artifactTypeLabel(kind)}`
      : port.label;
  patchOutput(index, {
    kind,
    label,
    source,
    key: outputKey(port, index, label, kind, source),
  });
}
function changeExportMode(
  index: number,
  port: TacticOutputPortContract,
  mode: string,
) {
  const accepted = acceptedCandidates(port.kind);
  const source: TacticOutputPortContract["source"] =
    mode === "accepted"
      ? {
          type: "accepted_subject",
          gate_key: accepted.length === 1 ? accepted[0]!.gateKey : "",
        }
      : { type: "binding", binding: { producer: "", output: "" } };
  const label =
    mode === "accepted" && port.label === "New Output"
      ? `Accepted ${artifactTypeLabel(port.kind)}`
      : port.label;
  patchOutput(index, {
    source,
    label,
    key: outputKey(port, index, label, port.kind, source),
  });
}
function chooseAcceptedGate(
  index: number,
  port: TacticOutputPortContract,
  gateKey: string,
) {
  const source = { type: "accepted_subject" as const, gate_key: gateKey };
  patchOutput(index, {
    source,
    key: outputKey(port, index, port.label, port.kind, source),
  });
}
function chooseInternalOutput(
  index: number,
  port: TacticOutputPortContract,
  selected: string,
) {
  const binding = parseBinding(selected) ?? { producer: "", output: "" };
  const source = { type: "binding" as const, binding };
  patchOutput(index, {
    source,
    key: outputKey(port, index, port.label, port.kind, source),
  });
}
</script>

<section class="interface-editor" aria-label="Tactic interface editor">
  <header>
    <div><span class="eyebrow">Reusable contract</span><h2>Tactic Interface</h2></div>
    <p>Define only what surrounding Tactics need to provide or receive.</p>
  </header>

  <section class="port-section">
    <div class="section-title">
      <div><h3>Inputs</h3><small>What this Tactic accepts</small></div>
      <button type="button" on:click={addInput}>+ Input</button>
    </div>
    {#each value.inputs as port, index}
      {@const uses = inputUses(port.key)}
      <article class="port-card input-port" class:incomplete-card={!port.kind}>
        <div class="card-heading">
          <div><span class="port-direction">Input</span><strong>{port.label || "Unnamed input"}</strong></div>
          <button class="remove-port" aria-label={`Remove input ${port.label}`} title="Remove input" type="button" on:click={() => removeInput(index)}>×</button>
        </div>
        <label>
          Name
          <input
            aria-label={`Input name ${index + 1}`}
            value={port.label}
            on:input={(event) =>
              patchInput(index, {
                label: event.currentTarget.value,
                key: inputKey(port, index, event.currentTarget.value),
              })}
          />
        </label>
        <ArtifactTypeSelect
          kind={port.kind}
          label={`Input type ${index + 1}`}
          onChange={(kind) => changeInputKind(index, port, kind)}
        />
        <label class="requirement">
          <input type="checkbox" checked={port.required} on:change={(event) => patchInput(index, { required: event.currentTarget.checked })} />
          <span><b>{port.required ? "Required" : "Optional"}</b><small>{port.required ? "Every use must connect this input." : "A parent may leave this unconnected."}</small></span>
        </label>
        {#if uses.length}<p class="usage"><b>Used by</b> {uses.join(", ")}</p>{/if}
        <details>
          <summary>Advanced</summary>
          <label>
            Internal key
            <input aria-label={`Input key ${index + 1}`} value={port.key} on:input={(event) => { manuallyEditedInputs.add(index); patchInput(index, { key: event.currentTarget.value }); }} />
          </label>
          <small>Used for stable wiring. Most authors never need to change this.</small>
        </details>
      </article>
    {:else}<p class="empty-copy">Inputs · None</p>{/each}
  </section>

  <section class="port-section">
    <div class="section-title">
      <div><h3>Outputs</h3><small>What this Tactic exposes</small></div>
      <button type="button" on:click={addOutput}>+ Output</button>
    </div>
    {#each value.outputs as port, index}
      {@const accepted = acceptedCandidates(port.kind)}
      {@const internal = outputCandidates(port.kind)}
      <article class="port-card output-port" class:incomplete-card={!port.kind || !exportAvailable(port, accepted, internal)}>
        <div class="card-heading">
          <div><span class="port-direction">Output</span><strong>{port.label || "Unnamed output"}</strong></div>
          <button class="remove-port" aria-label={`Remove output ${port.label}`} title="Remove output" type="button" on:click={() => removeOutput(index)}>×</button>
        </div>
        <label>
          Name
          <input
            aria-label={`Output name ${index + 1}`}
            value={port.label}
            on:input={(event) =>
              patchOutput(index, {
                label: event.currentTarget.value,
                key: outputKey(port, index, event.currentTarget.value),
              })}
          />
        </label>
        <ArtifactTypeSelect
          kind={port.kind}
          label={`Output type ${index + 1}`}
          onChange={(kind) => changeOutputKind(index, port, kind)}
        />
        <label>
          Export
          <select
            aria-label={`Export mode for ${port.label}`}
            value={port.source.type === "accepted_subject" ? "accepted" : "internal"}
            on:change={(event) => changeExportMode(index, port, event.currentTarget.value)}
          >
            <option value="accepted">Accepted artifact</option>
            <option value="internal">Internal output</option>
          </select>
        </label>
        {#if port.source.type === "accepted_subject"}
          {@const acceptedGateKey = port.source.gate_key}
          <label>
            Acceptance gate
            <select
              aria-label={`Export source for ${port.label}`}
              value={port.source.gate_key}
              class:incomplete={!exportAvailable(port, accepted, internal)}
              on:change={(event) => chooseAcceptedGate(index, port, event.currentTarget.value)}
            >
              <option value="">Choose an acceptance gate…</option>
              {#if acceptedGateKey && !accepted.some((candidate) => candidate.gateKey === acceptedGateKey)}
                <option value={acceptedGateKey}>Unavailable gate · choose another</option>
              {/if}
              {#each accepted as candidate}
                <option value={candidate.gateKey}>{candidate.label} → Accepted {artifactTypeLabel(port.kind)}</option>
              {/each}
            </select>
          </label>
          <p class="export-help">Exports the exact artifact accepted at this gate—not the newest artifact by time.</p>
        {:else}
          <label>
            Internal output
            <select
              aria-label={`Export source for ${port.label}`}
              value={bindingValue(port.source.binding)}
              class:incomplete={!exportAvailable(port, accepted, internal)}
              on:change={(event) => chooseInternalOutput(index, port, event.currentTarget.value)}
            >
              <option value="">Choose an internal output…</option>
              {#if bindingValue(port.source.binding) && !internal.some((candidate) => bindingValue(candidate.ref) === bindingValue(port.source.type === "binding" ? port.source.binding : { producer: "", output: "" }))}
                <option value={bindingValue(port.source.binding)}>Unavailable output · choose another</option>
              {/if}
              {#each internal as candidate}
                <option value={bindingValue(candidate.ref)}>{candidate.label}</option>
              {/each}
            </select>
          </label>
          <p class="export-help">Exports this producer's artifact directly, even if another revision is later accepted.</p>
        {/if}
        {#if port.kind && !exportAvailable(port, accepted, internal)}
          <p class="incomplete">{port.label || "This Tactic output"} needs an export source.</p>
        {/if}
        <details>
          <summary>Advanced</summary>
          <label>
            Internal key
            <input aria-label={`Output key ${index + 1}`} value={port.key} on:input={(event) => { manuallyEditedOutputs.add(index); patchOutput(index, { key: event.currentTarget.value }); }} />
          </label>
          <small>Used for stable parent bindings. Most authors never need to change this.</small>
        </details>
      </article>
    {:else}<p class="empty-copy">Outputs · None</p>{/each}
  </section>
</section>

<style>
  .interface-editor{display:grid;gap:.85rem;min-width:0}.interface-editor header{padding-bottom:.65rem;border-bottom:1px solid #d0ae80}.interface-editor header h2{margin:.1rem 0;color:#293b39;font:700 1.3rem Georgia,serif}.interface-editor header p{margin:.2rem 0;color:#68736d;font-size:.75rem;line-height:1.4}.port-section{display:grid;gap:.5rem;min-width:0}.section-title{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.section-title h3{margin:0;color:#314442;font:700 1rem Georgia,serif}.section-title small{display:block;color:#756b5f;font-size:.67rem}.section-title button{min-height:1.95rem!important;padding:.25rem .5rem;color:#3f6c65;background:#fffaf0;border:1px solid #aa8b67;box-shadow:none;font-size:.72rem}.port-card{display:grid;gap:.5rem;min-width:0;padding:.65rem;background:#f6e6c4;border:1px solid #c6a070;border-radius:9px;box-shadow:0 2px 5px #72503518}.port-card.incomplete-card{border-color:#c68738;box-shadow:0 0 0 2px #c6873822}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:.4rem;min-width:0}.card-heading>div{display:grid;min-width:0}.card-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#314442;font:700 .92rem Georgia,serif}.port-direction{color:#896742;font-size:.62rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.remove-port{width:1.9rem;min-height:1.9rem!important;padding:0;color:#914b44;background:#fff9eb;border:1px solid #c7a274;box-shadow:none}.port-card>label,.port-card details label{display:grid;gap:.2rem;min-width:0;color:#42504e;font-size:.68rem;font-weight:800}.port-card input:not([type=checkbox]),.port-card select{box-sizing:border-box;width:100%;min-width:0;min-height:2.3rem;padding:.45rem .55rem;color:#293b39;background:#fffdf6;border:1px solid #b7956b;border-radius:7px;box-shadow:inset 0 1px 2px #69492e12}.port-card select.incomplete{border-color:#c68738;box-shadow:0 0 0 2px #c6873822}.requirement{display:flex!important;align-items:center;gap:.5rem;padding:.45rem .5rem;background:#fff8e8;border:1px solid #d1b184;border-radius:7px}.requirement input{width:1rem;height:1rem;accent-color:#4c8179}.requirement span{display:grid}.requirement small{color:#746c60;font-weight:400}.usage{margin:0;padding:.4rem .5rem;color:#5e665e;background:#fff4d6;border-left:3px solid #6f9587;font-size:.7rem}.port-card details{padding-top:.35rem;border-top:1px solid #d4b88d}.port-card summary{cursor:pointer;color:#3d625d;font-size:.72rem;font-weight:750}.port-card details label{margin-top:.45rem}.port-card details small{display:block;margin-top:.25rem;color:#746c60;font-size:.65rem}.incomplete,.empty-copy{margin:0;padding:.45rem .5rem;color:#765d38;background:#fff2cc;border-left:3px solid #c28a35;border-radius:0 6px 6px 0;font-size:.7rem}.empty-copy{color:#71695d;background:#f3e7cb;border-color:#9c8c72}.export-help{margin:0;color:#6c695f;font-size:.66rem;line-height:1.35}
</style>
