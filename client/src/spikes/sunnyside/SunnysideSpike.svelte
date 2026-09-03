<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { createFixture } from "../../fixtures/fixtures";
import { projectRunWorld } from "../../world/projector";
import {
  SunnysideSpikeWorld,
  type PaletteTreatment,
  type SpikeScene,
} from "./sunnyside-spike-world";

const query = new URLSearchParams(location.search);
const fixture = createFixture("density");
if (!fixture?.selectedRunId) throw new Error("Missing Sunnyside density fixture.");
const run = fixture.runs[fixture.selectedRunId];
if (!run) throw new Error("Missing Sunnyside density Run.");
const model = projectRunWorld(run);
const paletteValue = query.get("palette");
const palette: PaletteTreatment = ["native", "management", "earthy"].includes(
  paletteValue ?? "",
)
  ? (paletteValue as PaletteTreatment)
  : "management";
const scene: SpikeScene = query.get("scene") === "town" ? "town" : "parity";
const scaleValue = Number(query.get("scale"));
const scale = ([1, 2, 3].includes(scaleValue) ? scaleValue : 2) as 1 | 2 | 3;
const showPanel = query.get("panel") === "1" || (scene === "parity" && query.get("panel") !== "0");
const awaitingReview = fixture.product.quests.filter(
  (quest) => quest.lifecycle.state === "awaiting_review",
).length;
const counts = {
  working: model.members.filter((member) => member.visual === "working").length,
  moving: model.members.filter((member) => member.visual === "moving_to_work").length,
  failed: model.members.filter((member) => member.visual === "failed").length,
  uncertain: model.members.filter((member) => member.visual === "uncertain").length,
  idle: model.members.filter((member) => member.visual === "idle").length,
  waiting: model.orderMarkers.filter((order) => order.state === "waiting").length,
};
let host: HTMLDivElement;
let town: SunnysideSpikeWorld | null = null;

onMount(() => {
  if (query.get("capture") === "dom") return;
  town = new SunnysideSpikeWorld(host, {
    model,
    palette,
    scene,
    zoom: scale,
    showPanel,
    awaitingReview,
  });
  void town.mount();
});

onDestroy(() => town?.destroy());

const paletteLabel = {
  native: "Native Cozy",
  management: "Warm Management",
  earthy: "Soft Earthy",
}[palette];
</script>

<svelte:head><title>Sunnyside Checkpoint A · Quest Engineering</title></svelte:head>

<main class={`spike treatment-${palette}`}>
  <div
    class="world"
    bind:this={host}
    role="img"
    aria-label="Sunnyside visual spike showing twelve factual Members, work orders, town districts, animals, and review state."
  ></div>

  <header class="topbar">
    <strong>QUEST ENGINEERING</strong>
    <div class="services" aria-label="Service status">
      <span><i></i> Control Plane</span><span><i></i> Worker</span>
    </div>
    <div class="quest"><b>Living Town Overhaul</b><small>Running</small></div>
    <nav><button>Town</button></nav>
  </header>

  <aside class="run-hud" aria-label="Selected Run summary">
    <div><strong>Living Town Overhaul</strong><span class="running">● Running</span></div>
    <p>{counts.working} working · {counts.waiting} waiting · {counts.idle} idle</p>
    <small>{counts.moving} moving · {counts.failed} failed · {counts.uncertain} uncertain</small>
    <button>Inspect</button>
  </aside>

  <div class="treatment-label"><span>Checkpoint A</span><strong>{paletteLabel}</strong><small>{scale}× · {scene === "town" ? "native composition" : "semantic parity"}</small></div>

  {#if scene === "parity"}
    <div class="legend" aria-label="World status legend">
      <span><i class="working"></i>working</span>
      <span><i class="moving"></i>moving</span>
      <span><i class="failed"></i>failed</span>
      <span><i class="uncertain"></i>uncertain</span>
      <span><i class="waiting"></i>waiting work</span>
      <span><i class="review"></i>PR review</span>
    </div>
  {/if}

  {#if showPanel}
    <aside class="management-window" aria-label="Guild Hall management window">
      <header><div><small>Guild Quarter</small><h1>Guild Hall</h1></div><button aria-label="Close">×</button></header>
      <div class="window-body">
        <div class="list"><button class="selected">Builder</button><button>Reviewer</button></div>
        <article>
          <small class="eyebrow">Class</small>
          <h2>Builder</h2>
          <p class="description">Builds and validates Product changes.</p>
          <section><h3>Instructions</h3><p>Work carefully and report factual results.</p></section>
          <footer><button class="secondary">Advanced ▸</button><button class="primary">Edit</button></footer>
        </article>
      </div>
    </aside>
  {/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  :global(body) { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :global(html[data-capture="dom"]), :global(html[data-capture="dom"] body), :global(html[data-capture="dom"] #app), :global(html[data-capture="dom"] main) { background: transparent !important; }
  button { color: inherit; font: inherit; cursor: default; }
  .spike {
    --ink: #2b3738;
    --cream: #fff4d8;
    --paper: #f5e4bd;
    --paper-soft: #ead4aa;
    --wood: #75513e;
    --wood-dark: #4b352e;
    --content: #293a3c;
    --content-soft: #344b4b;
    --accent: #587f75;
    --gold: #c88a43;
    --green: #5d956d;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    color: var(--ink);
    background: #cfe7bd;
  }
  .treatment-native { --paper: #fff0c5; --paper-soft: #efd69f; --accent: #4c8a82; --content: #274346; --gold: #dc8e3d; }
  .treatment-earthy { --paper: #f2dfb8; --paper-soft: #dec49b; --wood: #79523f; --wood-dark: #49352e; --content: #3a4140; --content-soft: #4a514d; --accent: #6f806b; --gold: #b4773d; background: #c8b98b; }
  .world { position: absolute; inset: 0; }
  .world :global(canvas) { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
  .topbar {
    position: absolute;
    z-index: 10;
    top: 0;
    left: 0;
    right: 0;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 7px 14px;
    color: #fff5db;
    background: linear-gradient(180deg, #334d4cfa, #263a3afa);
    border-bottom: 3px solid #d6ad6a;
    box-shadow: 0 5px 18px #31443d55;
  }
  .topbar > strong { font-family: Georgia, ui-serif, serif; font-size: 15px; letter-spacing: .14em; white-space: nowrap; }
  .services { display: flex; gap: 14px; color: #dce8d5; font-size: 12px; }
  .services span { white-space: nowrap; }
  .services i { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: #76b783; box-shadow: 0 0 0 2px #1d302e; }
  .quest { display: flex; align-items: baseline; gap: 7px; margin-left: auto; white-space: nowrap; }
  .quest b { font-size: 13px; }
  .quest small { color: #a9d5b2; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  nav { display: flex; gap: 6px; }
  nav button, .topbar button { padding: 6px 10px; color: #fff2d1; background: #405c57; border: 1px solid #91aa8d; border-radius: 4px; }
  .run-hud {
    position: absolute;
    z-index: 8;
    left: 14px;
    bottom: 14px;
    width: 314px;
    padding: 10px 12px;
    color: var(--ink);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    border: 2px solid var(--wood);
    border-radius: 8px;
    box-shadow: 0 6px 20px #30433555, inset 0 0 0 2px #fff8dd88;
  }
  .run-hud div { display: flex; align-items: center; gap: 10px; }
  .run-hud strong { flex: 1; font-family: Georgia, ui-serif, serif; font-size: 14px; }
  .run-hud .running { color: #417650; font-size: 11px; font-weight: 800; text-transform: uppercase; }
  .run-hud p { margin: 5px 0 2px; font-size: 12px; font-weight: 700; }
  .run-hud small { color: #596a64; font-size: 10px; }
  .run-hud > button { float: right; margin-top: -24px; padding: 5px 9px; color: #fff4d8; background: var(--accent); border: 1px solid var(--wood-dark); border-radius: 4px; font-size: 11px; }
  .treatment-label {
    position: absolute;
    z-index: 7;
    right: 14px;
    bottom: 14px;
    display: grid;
    min-width: 174px;
    padding: 7px 10px;
    text-align: right;
    color: var(--ink);
    background: color-mix(in srgb, var(--paper) 91%, transparent);
    border: 1px solid var(--wood);
    border-radius: 6px;
  }
  .treatment-label span, .treatment-label small { color: #68746d; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .treatment-label strong { font-family: Georgia, ui-serif, serif; font-size: 13px; }
  .legend {
    position: absolute;
    z-index: 7;
    left: 50%;
    bottom: 15px;
    display: flex;
    gap: 10px;
    transform: translateX(-50%);
    padding: 6px 10px;
    color: #344644;
    background: #fff3d8e8;
    border: 1px solid #8a654c;
    border-radius: 20px;
    font-size: 9px;
    white-space: nowrap;
  }
  .legend span { display: flex; align-items: center; gap: 4px; }
  .legend i { width: 7px; height: 7px; border: 1px solid #fff7e6; border-radius: 50%; box-shadow: 0 0 0 1px #4d554e; }
  .legend .working { background: #4d9468; }
  .legend .moving { background: #4e8ca0; }
  .legend .failed { background: #c35458; }
  .legend .uncertain { background: #845d99; }
  .legend .waiting { background: #d99a45; }
  .legend .review { background: #d98545; }
  .management-window {
    position: absolute;
    z-index: 9;
    top: 72px;
    right: 14px;
    width: 390px;
    max-height: calc(100vh - 144px);
    overflow: hidden;
    color: var(--ink);
    background: var(--paper);
    border: 3px solid var(--wood);
    border-radius: 9px;
    box-shadow: 0 12px 34px #283d3766, inset 0 0 0 2px #fff8dcaa;
  }
  .management-window > header {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    color: #fff5dc;
    background: linear-gradient(180deg, var(--wood), var(--wood-dark));
    border-bottom: 3px solid #d6a75f;
  }
  .management-window header div { flex: 1; }
  .management-window header small { color: #ead5ac; font-size: 9px; text-transform: uppercase; letter-spacing: .13em; }
  .management-window h1 { margin: 1px 0 0; font-family: Georgia, ui-serif, serif; font-size: 22px; }
  .management-window header button { width: 28px; height: 28px; color: #fff0cb; background: #5c4036; border: 1px solid #dfbd7d; border-radius: 4px; font-size: 18px; }
  .window-body { display: grid; grid-template-columns: 112px 1fr; min-height: 350px; }
  .list { display: grid; align-content: start; gap: 7px; padding: 13px 10px; background: var(--paper-soft); border-right: 1px solid #b79769; }
  .list button { padding: 8px; text-align: left; color: #4e4136; background: #f7e9c8; border: 1px solid #a17b50; border-radius: 5px; }
  .list .selected { color: #fff4d7; background: var(--accent); border-color: var(--wood-dark); box-shadow: inset 3px 0 #d8b265; }
  article { padding: 18px; }
  .eyebrow { color: #7f6a53; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
  article h2 { margin: 3px 0 2px; color: #3c443e; font: 700 25px Georgia, ui-serif, serif; }
  .description { margin: 0 0 20px; color: #667269; font-size: 13px; }
  article section { padding: 13px 14px; color: #e7eee5; background: var(--content); border-left: 4px solid var(--accent); border-radius: 4px; }
  article h3 { margin: 0 0 6px; color: #f0d49a; font: 700 12px Georgia, ui-serif, serif; }
  article section p { margin: 0; font-size: 12px; line-height: 1.5; }
  article footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  article footer button { padding: 7px 12px; border-radius: 5px; }
  .secondary { color: #675343; background: transparent; border: 1px solid #a68a65; }
  .primary { color: #fff5dc; background: var(--accent); border: 1px solid var(--wood-dark); min-width: 70px; }
  @media (max-width: 980px) {
    .topbar { gap: 10px; padding-inline: 10px; }
    .topbar > strong { font-size: 13px; }
    .services { gap: 7px; font-size: 10px; }
    .quest { display: none; }
    nav { margin-left: auto; }
    .management-window { top: 68px; right: 10px; width: min(340px, 42vw); max-height: calc(100vh - 134px); }
    .window-body { grid-template-columns: 88px 1fr; min-height: 330px; }
    article { padding: 13px; }
    .run-hud { left: 10px; bottom: 10px; width: 285px; }
    .legend { left: 10px; bottom: 102px; transform: none; flex-wrap: wrap; width: 280px; border-radius: 7px; }
    .treatment-label { right: 10px; bottom: 10px; }
  }
  @media (max-width: 700px) {
    .services span:last-child, nav button:first-child { display: none; }
    .management-window { left: 8px; right: 8px; width: auto; }
    .run-hud { width: 260px; }
  }
</style>
