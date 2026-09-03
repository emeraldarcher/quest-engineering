<script lang="ts">
export let count: number;
export let label: string;
export let accessibleLabel: string;
export let tooltip: string;
export let icon: string | null = null;
export let symbol: string | null = null;
export let tone: "quests" | "working" | "attention" | "reviews" = "quests";
</script>

<span class="hud-metric {tone}" class:zero={count === 0} class:hot={tone === "attention" && count > 0} title={tooltip}>
  <span class="icon-slot" aria-hidden="true">
    {#if icon}<img src={icon} alt="" />{:else}<span class="symbol">{symbol}</span>{/if}
  </span>
  <span class="visible-value" aria-hidden="true"><strong>{count}</strong><span class="metric-label">{label}</span></span>
  <span class="sr-only">{accessibleLabel}</span>
</span>

<style>
.hud-metric { display:flex; align-items:center; gap:.38rem; min-width:0; padding:.2rem 1rem; color:#fff1cf; border-left:1px solid #c292626b; white-space:nowrap; }
.icon-slot { display:grid; place-items:center; flex:0 0 1.25rem; width:1.25rem; height:1.25rem; }
.icon-slot img { display:block; max-width:1.15rem; max-height:1.15rem; image-rendering:pixelated; filter:drop-shadow(1px 1px #2c201a); }
.symbol { color:#e6c886; font-size:1.05rem; line-height:1; text-shadow:1px 1px #2c201a; }
.visible-value { display:flex; align-items:baseline; gap:.3rem; }
.visible-value strong { min-width:1ch; color:#fff8e3; font:800 1.04rem Georgia,serif; font-variant-numeric:tabular-nums; }
.metric-label { color:#f0dbb5; font-size:.8rem; font-weight:780; letter-spacing:.015em; }
.working .metric-label { color:#d3ead3; }
.reviews .metric-label { color:#cfe8e3; }
.attention .metric-label { color:#f2d4a4; }
.hud-metric.zero { opacity:.82; }
.hud-metric.hot { color:#ffd6a0; background:linear-gradient(90deg,transparent,#8c4b3d42,transparent); opacity:1; }
.hot .visible-value strong,.hot .metric-label { color:#ffd09b; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media(max-width:980px){.hud-metric{padding-inline:.62rem}.metric-label{display:none}.visible-value strong{font-size:.95rem}}
@media(max-width:620px){.hud-metric{padding-inline:.42rem}.hud-metric.quests{display:none}}
</style>
