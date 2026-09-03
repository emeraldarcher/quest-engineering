<script lang="ts">
import type { SemanticArtifactBinding, Tactic } from "../../api/contracts";
import type { NodePath, TacticNode } from "../war-room/tactic-model";
import { pathKey } from "../war-room/tactic-model";

export let node: TacticNode;
export let bindings: SemanticArtifactBinding[] = [];
export let tactics: Tactic[] = [];
export let path: NodePath = [];
export let selectedPath = "";
export let interactive = false;
export let onSelect: (path: NodePath) => void = () => {};
export let compact = false;

$: currentPath = pathKey(path);
$: stepConsumes =
  node.type === "step" && Array.isArray(node.consumes) ? node.consumes : [];
$: stepProduces =
  node.type === "step" && Array.isArray(node.produces) ? node.produces : [];
$: stepBindings =
  node.type === "step"
    ? bindings.filter(
        (binding) =>
          binding.consumer.local_key === node.key ||
          node.key.endsWith(`/${binding.consumer.local_key}`),
      )
    : [];
$: reused =
  node.type === "use"
    ? tactics.find((tactic) => tactic.id === node.tactic_definition_id) ?? null
    : null;

function untilConditionSummary(value: TacticNode): string {
  if (value.type !== "until") return "the check is accepted";
  const condition = value.condition as unknown as
    | {
        artifact?: { type?: unknown };
        field?: unknown;
        value?: unknown;
      }
    | undefined;
  const artifact =
    typeof condition?.artifact?.type === "string"
      ? condition.artifact.type
      : "result";
  const field = typeof condition?.field === "string" ? condition.field : "status";
  const expected = condition ? JSON.stringify(condition.value) : '"accepted"';
  return `${artifact}.${field} equals ${expected}`;
}

function sourceLabel(binding: SemanticArtifactBinding): string {
  if (binding.source.kind === "step") {
    const step = binding.source.step;
    const prefix = step.instance_path.map((item) => item.instance_key).join(" · ");
    return `${binding.selection === "explicit" ? "explicitly" : "inferred"} from ${prefix ? `${prefix} · ` : ""}${step.name ?? step.local_key}`;
  }
  const initial = binding.source.initial_step?.name ?? binding.source.initial_step?.local_key;
  const remediation =
    binding.source.remediation_step?.name ?? binding.source.remediation_step?.local_key;
  return initial && remediation
    ? `current value from ${initial} or ${remediation}`
    : "current remediation value";
}
</script>

{#if node.type === "step"}
  <article
    class="semantic-node step-node"
    class:selected={selectedPath === currentPath}
    class:compact
  >
    <button
      type="button"
      class="node-select"
      disabled={!interactive}
      aria-pressed={interactive ? selectedPath === currentPath : undefined}
      on:click={() => onSelect(path)}
    >
      <span class="node-kind">Step</span>
      <strong>{node.name || node.key}</strong>
      {#if !compact}<small>{node.instruction || "Add an instruction"}</small>{/if}
    </button>
    {#if stepProduces.length || stepConsumes.length}
      <div class="artifact-lines">
        {#each stepConsumes as artifact}
          {@const binding = stepBindings.find((item) => item.artifact_type === artifact.type)}
          <span><b>Uses</b> {artifact.type}{#if binding}<em>{sourceLabel(binding)}</em>{:else if artifact.source}<em>from {artifact.source}</em>{:else}<em>source automatic</em>{/if}</span>
        {/each}
        {#each stepProduces as artifact}<span><b>Produces</b> {artifact.type}</span>{/each}
      </div>
    {/if}
  </article>
{:else if node.type === "sequence"}
  <section class="semantic-container sequence" class:selected={selectedPath === currentPath}>
    {#if interactive}<button class="container-label" type="button" on:click={() => onSelect(path)} aria-pressed={selectedPath === currentPath}>Then · Sequence</button>{/if}
    {#each node.children as child, index}
      <svelte:self {bindings} {tactics} node={child} path={[...path, index]} {selectedPath} {interactive} {onSelect} {compact} />
      {#if index < node.children.length - 1}<span class="flow-arrow" aria-hidden="true">↓</span>{/if}
    {:else}
      <button class="empty-flow" type="button" disabled={!interactive} on:click={() => onSelect(path)}>+ Add the first item</button>
    {/each}
  </section>
{:else if node.type === "parallel"}
  <section class="semantic-container parallel" class:selected={selectedPath === currentPath}>
    <button class="container-label" type="button" disabled={!interactive} on:click={() => onSelect(path)} aria-pressed={interactive ? selectedPath === currentPath : undefined}>At the same time</button>
    <div class="parallel-branches">
      {#each node.children as child, index}
        <div class="parallel-branch"><span>Branch {index + 1}</span><svelte:self {bindings} {tactics} node={child} path={[...path, index]} {selectedPath} {interactive} {onSelect} {compact} /></div>
      {:else}<p class="empty-flow">Add a parallel branch.</p>{/each}
    </div>
    <span class="flow-arrow" aria-hidden="true">↓</span><small class="continue-label">Continue when every branch is complete</small>
  </section>
{:else if node.type === "until"}
  <section class="semantic-container until" class:selected={selectedPath === currentPath}>
    <button class="container-label" type="button" disabled={!interactive} on:click={() => onSelect(path)} aria-pressed={interactive ? selectedPath === currentPath : undefined}>Repeat until…</button>
    <div class="until-grid">
      <div><span class="phase-label">Check</span><svelte:self {bindings} {tactics} node={node.check} path={[...path, "check"]} {selectedPath} {interactive} {onSelect} {compact} /></div>
      <div class="condition-copy"><b>Accepted when</b><span>{untilConditionSummary(node)}</span></div>
      <div><span class="phase-label">If not accepted · Remediate</span><svelte:self {bindings} {tactics} node={node.otherwise} path={[...path, "otherwise"]} {selectedPath} {interactive} {onSelect} {compact} /></div>
    </div>
    {#if typeof node.max_remediations === "number"}<small>Up to {node.max_remediations} {node.max_remediations === 1 ? "remediation" : "remediations"}; the check may run up to {node.max_remediations + 1} times.</small>{/if}
  </section>
{:else}
  <article class="semantic-node use-node" class:selected={selectedPath === currentPath}>
    <button type="button" class="node-select" disabled={!interactive} on:click={() => onSelect(path)} aria-pressed={interactive ? selectedPath === currentPath : undefined}>
      <span class="node-kind">Reuse tactic</span><strong>{reused?.name ?? "Reusable Tactic unavailable"}</strong><small>{reused?.description ?? "This saved reference is not currently available."}</small>
      {#if reused?.archived_at}<em class="archived">Archived</em>{/if}
    </button>
  </article>
{/if}

<style>
.semantic-node,.semantic-container{position:relative;min-width:0;border:1px solid #b68b59;border-radius:9px;background:#fff9e9;box-shadow:0 2px 6px #65482f1c}.semantic-node.selected,.semantic-container.selected{outline:3px solid #4e8177;outline-offset:1px}.node-select{display:grid;gap:.18rem;width:100%;padding:.7rem .8rem;color:#29373a;text-align:left;background:transparent;border:0;box-shadow:none}.node-select:disabled,.container-label:disabled{cursor:default;opacity:1}.node-select strong{font:700 1rem Georgia,serif}.node-select small{color:#68736d}.node-kind,.phase-label{color:#896742;font-size:.66rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.artifact-lines{display:grid;gap:.25rem;padding:.45rem .8rem .65rem;border-top:1px solid #dcc49c;font-size:.76rem}.artifact-lines span{display:flex;gap:.35rem;align-items:baseline;flex-wrap:wrap}.artifact-lines b{color:#3c6f68}.artifact-lines em{color:#7b7569;font-style:normal}.sequence{display:grid;justify-items:stretch;gap:.3rem;padding:.65rem;background:#f7e6bd}.container-label{justify-self:start;padding:.15rem .35rem;color:#765736;background:transparent;border:0;box-shadow:none;font-size:.68rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.flow-arrow{justify-self:center;color:#a7773d;font-weight:900}.parallel{padding:.65rem;background:#f1dfb3}.parallel-branches{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(11rem,100%),1fr));gap:.55rem}.parallel-branch{display:grid;align-content:start;gap:.25rem;padding:.4rem;background:#f9eccd;border:1px dashed #b99568;border-radius:8px}.parallel-branch>span,.continue-label{color:#796c59;font-size:.68rem;font-weight:700}.until{display:grid;gap:.45rem;padding:.7rem;background:#f4dfc4;border-color:#bf765f}.until-grid{display:grid;gap:.5rem}.until-grid>div{display:grid;gap:.25rem}.condition-copy{padding:.5rem .65rem;background:#fff3d7;border-left:4px solid #d08a43;font-size:.78rem}.condition-copy span{color:#656d67}.until>small{color:#7a6654}.use-node{background:#f0ead0;border-style:dashed}.archived{color:#a04f49;font-size:.72rem;font-style:normal;font-weight:800}.empty-flow{padding:.7rem;color:#6b6e66;background:#fff8e5;border:1px dashed #b58d5d;box-shadow:none}.compact .node-select{padding:.45rem .6rem}.compact .artifact-lines{display:none}@media(max-width:700px){.parallel-branches{grid-template-columns:1fr}}
</style>
