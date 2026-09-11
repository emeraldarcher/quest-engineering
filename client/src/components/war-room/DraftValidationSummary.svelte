<script lang="ts">
import type { DraftValidationIssue } from "./tactic-model";

export let issues: DraftValidationIssue[];
export let mode: "create" | "edit";
export let onSelect: (issue: DraftValidationIssue) => void = () => {};
</script>

{#if issues.length}
  <section class="draft-validation" aria-live="polite" aria-label="Tactic validation">
    <strong>Can't {mode === "create" ? "create" : "save"} this Tactic yet</strong>
    <span>{issues.length} {issues.length === 1 ? "thing needs" : "things need"} attention.</span>
    <ul>
      {#each issues as issue}
        <li><button type="button" on:click={() => onSelect(issue)}>{issue.message}</button></li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .draft-validation {
    display: grid;
    gap: 0.16rem;
    max-height: 7.2rem;
    padding: 0.5rem 0.65rem;
    overflow: auto;
    color: #783f34;
    background: #fff0d2;
    border: 1px solid #cf8b53;
    border-left: 5px solid #bd5d55;
    border-radius: 7px;
  }
  strong {
    font-size: 0.76rem;
  }
  span {
    color: #765c4f;
    font-size: 0.68rem;
  }
  ul {
    display: grid;
    gap: 0.08rem;
    margin: 0.15rem 0 0;
    padding-left: 1rem;
  }
  li {
    font-size: 0.67rem;
  }
  button {
    min-height: auto !important;
    padding: 0.05rem;
    color: inherit;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: #b97b68;
    background: transparent;
    border: 0;
    box-shadow: none;
  }
</style>
