<script lang="ts">
import {
  artifactTypeLabel,
  BUILT_IN_ARTIFACT_KINDS,
} from "./tactic-model";

export let kind: string;
export let label: string;
export let onChange: (kind: string) => void;

$: builtIn = (BUILT_IN_ARTIFACT_KINDS as readonly string[]).includes(kind);
$: selectValue = !kind ? "" : builtIn ? kind : "__custom__";

function choose(value: string) {
  if (value === "__custom__")
    onChange(kind && !builtIn ? kind : "custom_artifact");
  else onChange(value);
}
</script>

<label class="artifact-type-field">
  Type
  <select
    aria-label={label}
    value={selectValue}
    class:incomplete={!kind}
    on:change={(event) => choose(event.currentTarget.value)}
  >
    <option value="">Choose artifact type…</option>
    {#each BUILT_IN_ARTIFACT_KINDS as value}
      <option value={value}>{artifactTypeLabel(value)}</option>
    {/each}
    <option value="__custom__">Custom…</option>
  </select>
</label>
{#if selectValue === "__custom__"}
  <label class="custom-kind-field">
    Custom artifact kind
    <input
      aria-label={`Custom ${label.toLocaleLowerCase()}`}
      value={kind}
      placeholder="architecture_spec"
      on:input={(event) => onChange(event.currentTarget.value)}
    />
  </label>
{/if}
{#if !kind}<p class="field-guidance">Choose an artifact type.</p>{/if}

<style>
  .artifact-type-field,
  .custom-kind-field {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
    color: #42504e;
    font-size: 0.68rem;
    font-weight: 800;
  }
  select,
  input {
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
    font: inherit;
  }
  select.incomplete {
    border-color: #c68738;
    box-shadow: 0 0 0 2px #c6873822;
  }
  .field-guidance {
    margin: -0.1rem 0 0;
    color: #865d26;
    font-size: 0.68rem;
  }
</style>
