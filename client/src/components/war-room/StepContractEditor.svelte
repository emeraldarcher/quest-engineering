<script lang="ts">
import type { SemanticArtifactBinding } from "../../api/contracts";
import ArtifactTypeSelect from "./ArtifactTypeSelect.svelte";
import {
  artifactContractLabel,
  artifactTypeLabel,
  generatedArtifactName,
  suggestedInputLabel,
  type ArtifactInputDraft,
  type ArtifactOutputDraft,
  type ArtifactRefDraft,
  type ArtifactSourceCandidate,
  type StepNode,
} from "./tactic-model";

export let step: StepNode;
export let candidates: (kind: string) => ArtifactSourceCandidate[];
export let resolvedBindings: SemanticArtifactBinding[] = [];
export let onChange: (step: StepNode) => void;
export let onChangeOutput: (
  index: number,
  output: ArtifactOutputDraft,
) => void;
export let onRenameOutput: (index: number, name: string) => void;

function refValue(source: ArtifactRefDraft | null): string {
  return source ? `${source.producer}::${source.output}` : "";
}
function inputDisplayName(input: ArtifactInputDraft): string {
  if (input.name === "current_plan") return "Current Quest Plan";
  if (input.name === "current_change_set") return "Current Change Set";
  if (input.name === "review_feedback") return "Review Feedback";
  if (input.kind === "quest_plan")
    return artifactContractLabel(step, input, "consumes");
  if (input.kind === "change_set") return "Current Change Set";
  if (input.kind === "review_verdict")
    return "Review Feedback";
  return input.name === "input"
    ? artifactContractLabel(step, input, "consumes")
    : input.name
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
function outputDisplayName(output: ArtifactOutputDraft): string {
  return output.name
    ? output.name
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
    : "";
}
function updateInput(index: number, patch: Partial<ArtifactInputDraft>) {
  const oldName = step.consumes[index]?.name;
  const consumes = step.consumes.map((input, current) =>
    current === index ? { ...input, ...patch } : input,
  );
  const produces =
    patch.name && oldName && patch.name !== oldName
      ? step.produces.map((output) =>
          output.review?.subject_input === oldName
            ? {
                ...output,
                review: { ...output.review, subject_input: patch.name! },
              }
            : output,
        )
      : step.produces;
  onChange({ ...step, consumes, produces });
}
function changeInputName(index: number, label: string) {
  const input = step.consumes[index];
  if (!input) return;
  updateInput(index, {
    name: generatedArtifactName(
      label,
      input.kind,
      "input",
      step.consumes
        .filter((_, current) => current !== index)
        .map((item) => item.name),
    ),
  });
}
function changeInputKind(index: number, kind: string) {
  const input = step.consumes[index];
  if (!input) return;
  const generic = !input.name || /^input(?:_\d+)?$/.test(input.name);
  const matching = candidates(kind);
  const label = suggestedInputLabel(kind, matching.length === 1 ? matching[0] : undefined);
  updateInput(index, {
    kind,
    name: generic
      ? generatedArtifactName(
          label,
          kind,
          "input",
          step.consumes
            .filter((_, current) => current !== index)
            .map((item) => item.name),
        )
      : input.name,
  });
}
function chooseInputSource(index: number, value: string) {
  const input = step.consumes[index];
  if (!input) return;
  const candidate = candidates("").find(
    (item) => refValue(item.ref) === value,
  );
  if (!candidate) {
    updateInput(index, { source: null });
    return;
  }
  const generic = !input.name || /^input(?:_\d+)?$/.test(input.name);
  const label = suggestedInputLabel(candidate.kind, candidate);
  updateInput(index, {
    source: candidate.ref,
    kind: input.kind || candidate.kind,
    name: generic
      ? generatedArtifactName(
          label,
          candidate.kind,
          "input",
          step.consumes
            .filter((_, current) => current !== index)
            .map((item) => item.name),
        )
      : input.name,
  });
}
function addInput() {
  const available = candidates("");
  const candidate = available.length === 1 ? available[0] : undefined;
  const kind = candidate?.kind ?? "";
  const label = suggestedInputLabel(kind, candidate);
  const input: ArtifactInputDraft = {
    name: generatedArtifactName(
      label,
      kind,
      "input",
      step.consumes.map((item) => item.name),
    ),
    kind,
    source: candidate?.ref ?? null,
    required: true,
  };
  onChange({ ...step, consumes: [...step.consumes, input] });
}
function removeInput(index: number) {
  const removed = step.consumes[index];
  onChange({
    ...step,
    consumes: step.consumes.filter((_, current) => current !== index),
    produces: step.produces.map((output) =>
      output.review?.subject_input === removed?.name
        ? {
            ...output,
            review: {
              gate_key: output.review?.gate_key ?? "",
              subject_input: "",
            },
          }
        : output,
    ),
  });
}
function defaultGate(subject: ArtifactInputDraft | undefined): string {
  if (subject?.kind === "quest_plan") return "plan_acceptance";
  if (subject?.kind === "change_set") return "implementation_acceptance";
  return "";
}
function updateOutput(index: number, patch: Partial<ArtifactOutputDraft>) {
  const output = step.produces[index];
  if (output) onChangeOutput(index, { ...output, ...patch });
}
function changeOutputKind(index: number, kind: string) {
  const output = step.produces[index];
  if (!output) return;
  const subject = step.consumes.find(
    (input) => input.kind === "quest_plan" || input.kind === "change_set",
  );
  updateOutput(index, {
    kind,
    name:
      !output.name || output.name === "result" || /^new_output(?:_\d+)?$/.test(output.name)
        ? generatedArtifactName(
            artifactTypeLabel(kind),
            kind,
            "output",
            step.produces
              .filter((_, current) => current !== index)
              .map((item) => item.name),
          )
        : output.name,
    review:
      kind === "review_verdict"
        ? (output.review ?? {
            gate_key: defaultGate(subject),
            subject_input: subject?.name ?? "",
          })
        : null,
  });
}
function chooseReviewSubject(index: number, name: string) {
  const output = step.produces[index];
  if (!output) return;
  const subject = step.consumes.find((input) => input.name === name);
  updateOutput(index, {
    review: {
      gate_key: defaultGate(subject),
      subject_input: name,
    },
  });
}
function addOutput() {
  const subject = step.consumes.find(
    (input) => input.kind === "quest_plan" || input.kind === "change_set",
  );
  const output: ArtifactOutputDraft = subject
    ? {
        name: "verdict",
        kind: "review_verdict",
        review: {
          gate_key: defaultGate(subject),
          subject_input: subject.name,
        },
      }
    : {
        name: generatedArtifactName(
          "New Output",
          "",
          "output",
          step.produces.map((item) => item.name),
        ),
        kind: "",
        review: null,
      };
  onChange({ ...step, produces: [...step.produces, output] });
}
function removeOutput(index: number) {
  onChange({
    ...step,
    produces: step.produces.filter((_, current) => current !== index),
  });
}
function sourcePlaceholder(input: ArtifactInputDraft): string {
  if (!input.kind) return "Choose a type or concrete source…";
  const matching = candidates(input.kind);
  if (matching.length > 1) return "Choose a source · multiple compatible values";
  if (matching.length === 1)
    return matching[0]?.semantic === "current"
      ? `Automatic · ${matching[0].label}`
      : "Automatic · only compatible value";
  return "Automatic · resolved from surrounding context";
}
function selectedCandidate(input: ArtifactInputDraft): ArtifactSourceCandidate | undefined {
  return input.source
    ? candidates("").find((candidate) => refValue(candidate.ref) === refValue(input.source))
    : undefined;
}
function isBuiltInGate(gate: string): boolean {
  return gate === "plan_acceptance" || gate === "implementation_acceptance";
}
</script>

<section class="artifact-editor">
  <div class="inspector-section-title">
    <div><h3>Uses</h3><small>Named artifacts this Step receives</small></div>
    <button type="button" on:click={addInput}>+ Input</button>
  </div>
  {#each step.consumes as input, index}
    {@const allCandidates = candidates("")}
    {@const matchingCandidates = candidates(input.kind)}
    {@const selected = selectedCandidate(input)}
    {@const sourceKind = selected?.kind}
    {@const semanticSource = selected ?? (matchingCandidates.length === 1 ? matchingCandidates[0] : undefined)}
    {@const resolved = resolvedBindings.find((binding) => binding.input_name === input.name)}
    <article class="artifact-card" class:incomplete={!input.kind}>
      <div class="card-heading">
        <strong>{inputDisplayName(input) || `Input ${index + 1}`}</strong>
        <button
          aria-label={`Remove input ${inputDisplayName(input) || index + 1}`}
          type="button"
          on:click={() => removeInput(index)}
        >×</button>
      </div>
      <label>
        Name
        <input
          aria-label={`Input name ${index + 1}`}
          value={inputDisplayName(input)}
          on:change={(event) => changeInputName(index, event.currentTarget.value)}
        />
      </label>
      <ArtifactTypeSelect
        kind={input.kind}
        label={`Input type ${index + 1}`}
        onChange={(kind) => changeInputKind(index, kind)}
      />
      <label>
        Source
        <select
          aria-label={`Source for ${inputDisplayName(input) || `input ${index + 1}`}`}
          value={refValue(input.source)}
          class:incomplete={!input.kind || (!input.source && matchingCandidates.length > 1)}
          on:change={(event) => chooseInputSource(index, event.currentTarget.value)}
        >
          <option value="">{sourcePlaceholder(input)}</option>
          {#if input.source && !selected}
            <option value={refValue(input.source)}>Unavailable source · choose another</option>
          {/if}
          {#each allCandidates as candidate}
            <option value={refValue(candidate.ref)}>
              {candidate.label} · {artifactTypeLabel(candidate.kind)}{input.kind && candidate.kind !== input.kind ? " · incompatible" : ""}
            </option>
          {/each}
        </select>
      </label>
      {#if semanticSource?.semantic === "current"}
        <p class="source-help">Initially produced before this loop and replaced by each successful Remediate result.</p>
      {:else if semanticSource?.semantic === "rejected_review"}
        <p class="source-help">The exact rejected Review Verdict that caused this remediation.</p>
      {/if}
      {#if !input.kind}
        <p class="inline-issue">Choose what artifact this input expects.</p>
      {:else if sourceKind && sourceKind !== input.kind}
        <p class="inline-issue">This source produces {artifactTypeLabel(sourceKind)}, not {artifactTypeLabel(input.kind)}.</p>
      {:else if !input.source && matchingCandidates.length > 1}
        <p class="inline-issue">More than one {artifactTypeLabel(input.kind)} is available. Choose the exact source.</p>
      {/if}
      <label class="requirement">
        <input
          type="checkbox"
          checked={input.required}
          on:change={(event) => updateInput(index, { required: event.currentTarget.checked })}
        />
        <span><b>{input.required ? "Required" : "Optional"}</b><small>{input.required ? "This Step must receive it." : "It may be absent."}</small></span>
      </label>
      {#if resolved}
        <small class="resolved-binding">Resolved as {resolved.source.kind === "remediation" ? `Current ${artifactTypeLabel(input.kind)}` : selected?.label ?? "the exact selected artifact"}.</small>
      {/if}
      <details>
        <summary>Advanced</summary>
        <label>
          Input slot
          <input
            value={input.name}
            on:change={(event) => updateInput(index, { name: event.currentTarget.value })}
          />
        </label>
        <small>Stable semantic wiring key.</small>
      </details>
    </article>
  {:else}
    <p class="contract-empty">Inputs · None</p>
  {/each}
</section>

<section class="artifact-editor">
  <div class="inspector-section-title">
    <div><h3>Produces</h3><small>Named artifacts this Step creates</small></div>
    <button type="button" on:click={addOutput}>+ Output</button>
  </div>
  {#each step.produces as output, index}
    {@const subject = step.consumes.find((input) => input.name === output.review?.subject_input)}
    <article class="artifact-card" class:incomplete={!output.kind}>
      <div class="card-heading">
        <strong>{outputDisplayName(output) || `Output ${index + 1}`}</strong>
        <button
          aria-label={`Remove output ${outputDisplayName(output) || index + 1}`}
          type="button"
          on:click={() => removeOutput(index)}
        >×</button>
      </div>
      <label>
        Name
        <input
          aria-label={`Output name ${index + 1}`}
          value={outputDisplayName(output)}
          on:change={(event) => onRenameOutput(index, event.currentTarget.value)}
        />
      </label>
      <ArtifactTypeSelect
        kind={output.kind}
        label={`Output type ${index + 1}`}
        onChange={(kind) => changeOutputKind(index, kind)}
      />
      {#if output.kind === "review_verdict"}
        <section class="review-contract" aria-label={`${step.name} review contract`}>
          <div><span class="review-kicker">Semantic review</span><h4>Reviews</h4></div>
          <label>
            Artifact being reviewed
            <select
              aria-label="Reviews"
              value={output.review?.subject_input ?? ""}
              class:incomplete={!subject}
              on:change={(event) => chooseReviewSubject(index, event.currentTarget.value)}
            >
              <option value="">Choose a Step input…</option>
              {#each step.consumes as input}
                <option value={input.name}>{inputDisplayName(input)} · {input.kind ? artifactTypeLabel(input.kind) : "Type needed"}</option>
              {/each}
            </select>
          </label>
          {#if !subject}<p class="inline-issue">{step.name} needs an artifact to review.</p>{/if}
          <label>
            Acceptance
            <select
              aria-label="Acceptance gate"
              value={isBuiltInGate(output.review?.gate_key ?? "") ? output.review?.gate_key : "__custom__"}
              on:change={(event) =>
                updateOutput(index, {
                  review: {
                    gate_key: event.currentTarget.value === "__custom__" ? output.review?.gate_key ?? "" : event.currentTarget.value,
                    subject_input: output.review?.subject_input ?? "",
                  },
                })}
            >
              <option value="">Choose acceptance gate…</option>
              <option value="plan_acceptance">Plan Acceptance</option>
              <option value="implementation_acceptance">Implementation Acceptance</option>
              {#if output.review?.gate_key && !isBuiltInGate(output.review.gate_key)}<option value="__custom__">Custom acceptance gate</option>{/if}
            </select>
          </label>
          {#if !output.review?.gate_key}
            <p class="inline-issue">Choose the acceptance decision this Review records.</p>
          {:else if subject?.kind === "quest_plan" && output.review.gate_key !== "plan_acceptance"}
            <p class="inline-issue">A Quest Plan Review normally records Plan Acceptance.</p>
          {:else if subject?.kind === "change_set" && output.review.gate_key !== "implementation_acceptance"}
            <p class="inline-issue">An implementation Review records Implementation Acceptance.</p>
          {/if}
          <p class="review-result"><b>Produces</b> Verdict · Review Verdict</p>
        </section>
      {/if}
      <details>
        <summary>Advanced</summary>
        <label>
          Output slot
          <input
            value={output.name}
            on:change={(event) => onRenameOutput(index, event.currentTarget.value)}
          />
        </label>
        {#if output.review?.gate_key && !isBuiltInGate(output.review.gate_key)}
          <label>
            Custom acceptance gate
            <input
              value={output.review.gate_key}
              on:input={(event) => updateOutput(index, { review: { ...output.review!, gate_key: event.currentTarget.value } })}
            />
          </label>
        {/if}
        <small>Stable semantic output and gate keys.</small>
      </details>
    </article>
  {:else}
    <p class="contract-empty">Outputs · None</p>
  {/each}
</section>

<style>
  .artifact-editor {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.65rem;
    padding: 0.6rem;
    background: #f6e6c4;
    border: 1px solid #cfad7d;
    border-radius: 10px;
  }
  .inspector-section-title,
  .card-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .inspector-section-title h3,
  .review-contract h4 {
    margin: 0;
    color: #314442;
    font: 700 1rem Georgia, serif;
  }
  .inspector-section-title small {
    display: block;
    color: #756b5f;
    font-size: 0.65rem;
  }
  .inspector-section-title button {
    min-height: 1.9rem;
    padding: 0.22rem 0.5rem;
    color: #3f6c65;
    background: #fffaf0;
    border: 1px solid #aa8b67;
    box-shadow: none;
    font-size: 0.72rem;
  }
  .artifact-card {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.55rem;
    background: #fff9eb;
    border: 1px solid #d2b386;
    border-radius: 8px;
  }
  .artifact-card.incomplete {
    border-color: #c68738;
  }
  .card-heading strong {
    min-width: 0;
    overflow: hidden;
    color: #315f58;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
  }
  .card-heading button {
    width: 1.9rem;
    min-height: 1.9rem;
    padding: 0;
    color: #8b4e48;
    background: #fffdf6;
    border: 1px solid #c8a77b;
    box-shadow: none;
  }
  .artifact-card > label,
  .artifact-card details label,
  .review-contract label {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
    color: #42504e;
    font-size: 0.68rem;
    font-weight: 800;
  }
  .artifact-card input:not([type="checkbox"]),
  .artifact-card select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 2.3rem;
    padding: 0.45rem 0.55rem;
    color: #293b39;
    background: #fffdf6;
    border: 1px solid #b7956b;
    border-radius: 7px;
    box-shadow: inset 0 1px 2px #69492e12;
  }
  select.incomplete {
    border-color: #c68738;
    box-shadow: 0 0 0 2px #c6873822;
  }
  .requirement {
    display: flex !important;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.45rem;
    background: #f8ecd1;
    border-radius: 6px;
  }
  .requirement input {
    width: 1rem;
    height: 1rem;
    accent-color: #4c8179;
  }
  .requirement span {
    display: grid;
  }
  .requirement small {
    color: #746c60;
    font-weight: 400;
  }
  .source-help {
    margin: -0.08rem 0 0;
    color: #65706a;
    font-size: 0.64rem;
    line-height: 1.35;
  }
  .inline-issue {
    margin: 0;
    padding: 0.38rem 0.45rem;
    color: #874a32;
    background: #fff0cc;
    border-left: 3px solid #c68738;
    border-radius: 0 5px 5px 0;
    font-size: 0.68rem;
  }
  .resolved-binding {
    color: #3d6e66;
    font-size: 0.68rem;
  }
  .artifact-card details {
    padding-top: 0.35rem;
    border-top: 1px solid #d4b88d;
  }
  .artifact-card summary {
    cursor: pointer;
    color: #3d625d;
    font-size: 0.7rem;
    font-weight: 750;
  }
  .artifact-card details label {
    margin-top: 0.4rem;
  }
  .artifact-card details small {
    color: #746c60;
    font-size: 0.64rem;
  }
  .review-contract {
    display: grid;
    gap: 0.4rem;
    padding: 0.55rem;
    background: #edf2dc;
    border: 1px solid #9daf82;
    border-left: 4px solid #4c8179;
    border-radius: 7px;
  }
  .review-kicker {
    color: #6f765c;
    font-size: 0.58rem;
    font-weight: 850;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .review-result {
    margin: 0;
    color: #50615c;
    font-size: 0.7rem;
  }
  .review-result b {
    color: #35645f;
  }
  .contract-empty {
    margin: 0;
    color: #71695d;
    font-size: 0.7rem;
  }
</style>
