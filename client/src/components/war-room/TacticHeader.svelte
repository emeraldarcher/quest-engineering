<script lang="ts">
export let name: string;
export let description: string;
export let mode: "create" | "edit";
export let status: { label: string; tone: string };
export let onEditDetails: () => void;
export let onEditInterface: () => void;
</script>

<header class="tactic-header">
  <div class="tactic-copy">
    <span class="eyebrow">{mode === "create" ? "New Tactic" : "Tactic workspace"}</span>
    <h2>{name || "Untitled Tactic"}</h2>
    <p>{description || "Build the crew's approach to this Quest."}</p>
    <div class="header-links">
      <button type="button" on:click={onEditDetails}>Edit details</button>
      <button type="button" on:click={onEditInterface}>Edit interface</button>
    </div>
  </div>
  <span class="status-chip tone-{status.tone}">{status.label}</span>
</header>

<style>
.tactic-header{display:flex;align-items:flex-start;gap:.75rem;min-width:0;padding:.65rem .8rem;background:#fff3d2;border:1px solid #c49b6d;border-radius:9px}.tactic-copy{min-width:0;flex:1}.tactic-copy h2{margin:.08rem 0;color:#293b39;font:700 1.35rem Georgia,serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tactic-copy p{margin:.15rem 0;color:#65726e;font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.header-links{display:flex;gap:.25rem;margin-top:.3rem}.header-links button{min-height:1.8rem!important;padding:.18rem .4rem;color:#35645f;background:transparent;border:0;box-shadow:none;font-size:.72rem;font-weight:750;text-decoration:underline;text-underline-offset:2px}.status-chip{flex:0 0 auto;padding:.3rem .55rem;border-radius:999px;font-size:.7rem;font-weight:800}.tone-success{background:#d7ebd1;color:#2f6543}.tone-warning{background:#f3dfaa;color:#74541f}.tone-danger{background:#f5cec3;color:#8a443d}.tone-active{background:#cde4df;color:#315f5c}.tone-neutral{background:#e7e2d2;color:#576864}@media(max-width:700px){.tactic-header{padding:.5rem .6rem}.tactic-copy p{white-space:normal}.status-chip{display:none}}
</style>
