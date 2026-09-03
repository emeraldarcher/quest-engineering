<script lang="ts">
import anvilIcon from "../../assets/sunnyside/props/anvil.png";
import attentionIcon from "../../assets/sunnyside/ui/expression_alerted.png";
import questIcon from "../../assets/sunnyside/ui/plan-alt.png";
import workingIcon from "../../assets/sunnyside/ui/expression_working.png";
import type { RealtimeStatus } from "../../realtime/client";
import type { ProductState } from "../../state/app-store";
import ConnectionIndicator from "./ConnectionIndicator.svelte";
import HudMetric from "./HudMetric.svelte";
import { countLabel, townHudCounts } from "./hud-presentation";

export let product: ProductState;
export let realtimeStatus: RealtimeStatus;
export let serverReachable: boolean | null = null;

$: counts = townHudCounts(product.quests);
$: activeLabel = `${countLabel(counts.activeQuests, "active Quest")}`;
$: activeTooltip = `${activeLabel} that ${counts.activeQuests === 1 ? "is" : "are"} not complete.${counts.preparingReviewQuests ? ` ${countLabel(counts.preparingReviewQuests, "Quest")} preparing review.` : ""}`;
</script>

<header class="town-hud" aria-label="Quest Engineering town status">
  <div class="identity" title="Navigate by selecting town buildings or using keys 1 through 7.">
    <span class="crest" aria-hidden="true"><img src={anvilIcon} alt="" /></span>
    <strong>QUEST ENGINEERING</strong>
  </div>

  <div class="hud-metrics" aria-label="Current Product activity">
    <HudMetric
      count={counts.activeQuests}
      label="Quests"
      accessibleLabel={activeLabel}
      tooltip={activeTooltip}
      icon={questIcon}
      tone="quests"
    />
    <HudMetric
      count={counts.workingQuests}
      label="Working Quests"
      accessibleLabel={countLabel(counts.workingQuests, "working Quest")}
      tooltip={`${countLabel(counts.workingQuests, "active Quest")} currently working.`}
      icon={workingIcon}
      tone="working"
    />
    <HudMetric
      count={counts.attentionQuests}
      label="Attention"
      accessibleLabel={`${countLabel(counts.attentionQuests, "active Quest")} ${counts.attentionQuests === 1 ? "needs" : "need"} attention`}
      tooltip={`${countLabel(counts.attentionQuests, "active Quest")} ${counts.attentionQuests === 1 ? "needs" : "need"} attention.`}
      icon={attentionIcon}
      tone="attention"
    />
    <HudMetric
      count={counts.reviewQuests}
      label="Reviews"
      accessibleLabel={`${countLabel(counts.reviewQuests, "Quest")} awaiting review`}
      tooltip={`${countLabel(counts.reviewQuests, "Quest")} ${counts.reviewQuests === 1 ? "has" : "have"} a Pull Request awaiting review.`}
      symbol="✉"
      tone="reviews"
    />
  </div>

  <div class="hud-health">
    <span class="shortcut-hint" title="Town shortcuts: keys 1–7 open buildings.">Keys 1–7</span>
    <ConnectionIndicator status={realtimeStatus} {serverReachable} />
  </div>
</header>

<style>
.town-hud { position:relative; z-index:5; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; min-height:3rem; padding:.32rem .75rem; color:#fff1cf; background:linear-gradient(180deg,#543a30f8,#35251ff9); border-top:2px solid #9e7754; border-bottom:3px double #e1b76d; box-shadow:0 5px 15px #24171380,inset 0 1px #f2d39a38; }
.identity { display:flex; align-items:center; gap:.55rem; min-width:0; padding-right:.85rem; }
.crest { display:grid; place-items:center; width:2rem; height:2rem; background:#e7c77f18; border:1px solid #d6ad6a88; border-radius:50%; box-shadow:inset 0 0 0 2px #3a2922; }
.crest img { width:1.45rem; image-rendering:pixelated; filter:drop-shadow(1px 1px #211713); }
.identity strong { color:#fff0bd; font:800 .92rem Georgia,serif; letter-spacing:.1em; text-transform:uppercase; white-space:nowrap; text-shadow:1px 2px #2a1c18; }
.hud-metrics { display:flex; align-items:center; justify-content:center; min-width:0; }
.hud-health { display:flex; align-items:center; justify-content:flex-end; min-width:0; padding-left:.6rem; border-left:1px solid #b988574d; }
.shortcut-hint { color:#e4cfaa; font-size:.68rem; font-weight:650; letter-spacing:.035em; white-space:nowrap; }
@media(max-width:1100px){.shortcut-hint{display:none}}
@media(max-width:760px){.town-hud{grid-template-columns:auto minmax(0,1fr) auto;padding-inline:.45rem}.identity{padding-right:.35rem}.identity strong{font-size:.78rem;letter-spacing:.065em}.crest{width:1.7rem;height:1.7rem}.crest img{width:1.2rem}.hud-health{padding-left:.25rem}}
@media(max-width:520px){.identity strong{max-width:6.5rem;white-space:normal;line-height:1}.town-hud{min-height:3.1rem}}
</style>
