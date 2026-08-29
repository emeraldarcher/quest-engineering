<script lang="ts">
import type { ApiErrorDetail } from "../api/contracts";
export let details: ApiErrorDetail[] = [];
</script>

{#if details.length}
  <ul class="validation" role="alert">
    {#each details as detail}
      <li>{detail.path.join(".") || "request"}: {detail.code}</li>
    {/each}
  </ul>
{/if}
