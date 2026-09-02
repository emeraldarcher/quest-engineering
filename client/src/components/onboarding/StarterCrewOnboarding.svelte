<script lang="ts">
import { onMount, tick } from "svelte";
import type { StarterCrewStatus } from "../../api/contracts";
import { starterChoice } from "../../domain/starter-crew";
import type { AppStore, BuildingId, ProductState } from "../../state/app-store";
import "../management/management-window.css";

export let store: AppStore;
export let product: ProductState;
export let status: StarterCrewStatus;
export let onAddProject: () => void;
export let onOpenProjects: () => void;
export let onNavigate: (building: BuildingId) => void;
export let onDismiss: () => void;
export let onCompleted: () => void;
export let scene: string | null = null;

type Phase = "setup" | "creating" | "failure" | "success";
let phase: Phase = "setup";
let heading: HTMLElement;
let busy = false;

const {
  error: errorStore,
  bootstrapRunning: bootstrapRunningStore,
  starterStatus: starterStatusStore,
} = store;

$: choice = starterChoice(product.workspaces, product.executionOptions);
$: conflict = status.conflict;
$: preparingProject = product.workspaces.find(
  (workspace) => workspace.binding.state === "preparing",
);
$: attentionProject = product.workspaces.find((workspace) =>
  ["attention_required", "unbound"].includes(workspace.binding.state),
);
$: offlineProject = product.workspaces.find(
  (workspace) => workspace.binding.state === "offline",
);
$: readyProject = product.workspaces.find(
  (workspace) => workspace.binding.state === "ready",
);
$: projectComplete = product.workspaces.length > 0;
$: crewComplete = phase === "success" || status.state === "complete";
$: failureRollbackConfirmed = Boolean(
  !$errorStore ||
    $errorStore.meta.starter_status_refetched === true ||
    !["network_unavailable", "invalid_response"].includes($errorStore.code),
);

onMount(() => {
  if (scene === "creating") phase = "creating";
  if (scene === "failure") phase = "failure";
  if (scene === "success") phase = "success";
  void tick().then(() => heading?.focus());
});

async function createCrew() {
  if (busy || !choice) return;
  busy = true;
  phase = "creating";
  onCompleted();
  $bootstrapRunningStore = true;
  const result = await store.createStarterCrew(choice.workspace.id);
  $bootstrapRunningStore = false;
  busy = false;
  if (result) {
    phase = "success";
    await tick();
    heading?.focus();
  } else {
    phase = $starterStatusStore?.state === "conflict" ? "setup" : "failure";
    await tick();
    heading?.focus();
  }
}

function conflictLabel(type: NonNullable<StarterCrewStatus["conflict"]>["entity_type"]): string {
  if (type === "class") return "Class";
  if (type === "loadout") return "Loadout";
  if (type === "squad") return "Squad";
  return "workflow";
}

function conflictBuilding(type: NonNullable<StarterCrewStatus["conflict"]>["entity_type"]): BuildingId {
  if (type === "class") return "guild";
  if (type === "loadout") return "blacksmith";
  return "tavern";
}
</script>

<div class="onboarding management-window" role="dialog" aria-labelledby="onboarding-title" aria-describedby="onboarding-intro">
  <header class="welcome-header">
    <div>
      <span class="window-kicker">Your engineering town awaits</span>
      <h1 id="onboarding-title" bind:this={heading} tabindex="-1">
        {phase === "success" ? "Your crew is ready" : "Welcome to Quest Engineering"}
      </h1>
      <p id="onboarding-intro">
        {phase === "success"
          ? "Everything is in place for your first Quest."
          : "Get ready for your first Quest with a Project and a small starter crew."}
      </p>
    </div>
    <div class="crew-mark" aria-hidden="true"><span>B</span><span>R</span></div>
  </header>

  <ol class="setup-steps" aria-label="First Quest setup progress">
    <li class:complete={projectComplete} class:current={!projectComplete && phase !== "success"}>
      <span>{projectComplete ? "✓" : "1"}</span><div><strong>Project</strong><small>{projectComplete ? "Added" : "First step"}</small></div>
    </li>
    <li class:complete={crewComplete} class:current={projectComplete && !crewComplete}>
      <span>{crewComplete ? "✓" : "2"}</span><div><strong>Starter crew</strong><small>{crewComplete ? "Ready" : projectComplete ? "Next step" : "Upcoming"}</small></div>
    </li>
    <li class:current={phase === "success"}>
      <span>3</span><div><strong>First Quest</strong><small>{phase === "success" ? "You're ready" : "Upcoming"}</small></div>
    </li>
  </ol>

  <div class="onboarding-body" aria-live="polite">
    {#if phase === "success"}
      <section class="success-state">
        <span class="success-seal" aria-hidden="true">✓</span>
        <div><span class="eyebrow">Setup complete</span><h2>Meet the Engineering Pair</h2><p>Builder and Reviewer are ready in the Tavern, and the Implement & Review workflow is available for your Quests.</p></div>
        <div class="success-summary"><span><strong>Builder</strong><small>Coding Loadout</small></span><span aria-hidden="true">→</span><span><strong>Reviewer</strong><small>Review Loadout</small></span></div>
        <button class="primary hero-action" type="button" on:click={() => onNavigate("quest-board")}>Go to Quest Board</button>
      </section>
    {:else if phase === "creating"}
      <section class="creating-state" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <div><span class="eyebrow">One atomic setup</span><h2>Creating your starter crew…</h2><p>Quest Engineering is assembling the complete crew and workflow together.</p></div>
        <button class="primary hero-action" type="button" disabled>Creating Starter Crew…</button>
      </section>
    {:else if phase === "failure"}
      <section class="failure-state" role="alert">
        <span class="failure-icon" aria-hidden="true">!</span>
        <div><span class="eyebrow">Setup paused</span><h2>{failureRollbackConfirmed ? "We couldn't create your starter crew" : "We couldn't confirm starter setup"}</h2><p>{failureRollbackConfirmed ? "Nothing was changed. You can safely try the same setup again." : "Quest Engineering will check the canonical starter state before safely retrying."}</p>{#if $errorStore}<p class="error-copy">{$errorStore.message}</p>{/if}</div>
        <button class="primary hero-action" type="button" disabled={!choice || busy} on:click={createCrew}>Try Again</button>
      </section>
    {:else if status.state === "conflict" && conflict}
      <section class="conflict-state" role="status">
        <span class="failure-icon" aria-hidden="true">!</span>
        <div><span class="eyebrow">Starter setup needs attention</span><h2>{conflictLabel(conflict.entity_type)} “{conflict.key}” is already configured differently</h2><p>Quest Engineering won't overwrite it. You can continue setting up your crew manually with the existing management screens.</p></div>
        <div class="button-row"><button class="secondary" type="button" on:click={onDismiss}>Continue Manually</button><button class="primary" type="button" on:click={() => onNavigate(conflictBuilding(conflict.entity_type))}>Open {conflictLabel(conflict.entity_type)}</button></div>
      </section>
    {:else if product.workspaces.length === 0}
      <section class="project-state">
        <div class="state-copy"><span class="eyebrow">Step 1 · Add a Project</span><h2>First, choose where your crew will work</h2><p>A Project tells Quest Engineering which repository your Quests should use.</p></div>
        <div class="project-illustration" aria-hidden="true"><span>⌂</span><i></i><span>◇</span></div>
        <button class="primary hero-action" type="button" on:click={onAddProject}>Add Project</button>
        <button class="quiet-action" type="button" on:click={onDismiss}>Set up manually</button>
      </section>
    {:else if preparingProject}
      <section class="project-waiting" role="status">
        <span class="spinner amber" aria-hidden="true"></span>
        <div><span class="eyebrow">Project added</span><h2>Preparing {preparingProject.name}…</h2><p>Quest Engineering is connecting the repository. Starter setup will continue when the Project is ready.</p></div>
        <button class="secondary" type="button" on:click={onOpenProjects}>View Project</button>
      </section>
    {:else if attentionProject}
      <section class="project-attention" role="status">
        <span class="failure-icon" aria-hidden="true">!</span>
        <div><span class="eyebrow">Project needs attention</span><h2>{attentionProject.name} isn't ready yet</h2><p>Open Projects to finish connecting its repository. Your starter crew has not been created.</p></div>
        <button class="primary hero-action" type="button" on:click={onOpenProjects}>Open Projects</button>
      </section>
    {:else if !choice}
      <section class="project-waiting" role="status">
        <span class="host-icon" aria-hidden="true">◇</span>
        <div><span class="eyebrow">Waiting for an execution host</span><h2>{readyProject?.name ?? offlineProject?.name ?? "Your Project"} is configured</h2><p>No compatible execution host is available yet for a writable Builder and read-only Reviewer.</p></div>
        <button class="secondary" type="button" on:click={onOpenProjects}>Open Projects</button>
        <button class="quiet-action" type="button" on:click={onDismiss}>Set up manually</button>
      </section>
    {:else}
      <section class="crew-ready-state">
        <div class="state-copy"><span class="eyebrow">Step 2 · {status.state === "recoverable_partial" ? "Finish setup" : "Create starter crew"}</span><h2>{status.state === "recoverable_partial" ? "Finish setting up your starter crew" : "Your starter crew"}</h2><p>{status.state === "recoverable_partial" ? "Part of this starter setup already exists. Quest Engineering can safely create the missing pieces." : "A compact implementation and review team, ready to customize later."}</p></div>
        <div class="starter-preview" aria-label="Starter crew preview">
          <article><span class="portrait builder" aria-hidden="true">B</span><div><strong>Builder</strong><p>Builds the requested change.</p><small>Coding Loadout</small></div></article>
          <article><span class="portrait reviewer" aria-hidden="true">R</span><div><strong>Reviewer</strong><p>Independently reviews completed work.</p><small>Review Loadout</small></div></article>
          <article class="wide"><span class="preview-icon" aria-hidden="true">♜</span><div><strong>Engineering Pair</strong><p>Builder + Reviewer</p></div></article>
          <article class="wide"><span class="preview-icon" aria-hidden="true">→</span><div><strong>Starter workflow</strong><p>Implement → Review</p></div></article>
        </div>
        <p class="teaching-copy"><strong>Classes</strong> define behavior. <strong>Loadouts</strong> define models and capabilities.</p>
        <button class="primary hero-action" type="button" disabled={busy || $bootstrapRunningStore} on:click={createCrew}>{status.state === "recoverable_partial" ? "Finish Starter Setup" : "Create Starter Crew"}</button>
        <button class="quiet-action" type="button" on:click={onDismiss}>Set up manually</button>
      </section>
    {/if}
  </div>
</div>

<style>
  .onboarding { --app-cream: #fff4d8; --app-paper: #f7e7c4; --app-paper-soft: #ecd3a7; --app-ink: #29373a; --app-muted: #68756e; --app-wood: #75513e; --app-wood-dark: #4b352e; --app-teal: #4c8179; --app-teal-dark: #35645f; --app-green: #4f8a61; --app-amber: #c68738; --app-coral: #bd5d55; position: absolute; z-index: 6; top: 50%; left: 50%; width: min(48rem, calc(100vw - 2rem)); max-height: calc(100vh - 6rem); overflow: auto; color: var(--app-ink); background: var(--app-cream); border: 2px solid var(--app-wood); border-radius: 16px; box-shadow: 0 20px 60px #20352e99, inset 0 0 0 2px #fff8e6; transform: translate(-50%, -47%); }
  .welcome-header { display: flex; align-items: center; gap: 1rem; padding: 1.25rem 1.5rem; color: #fff6de; background: linear-gradient(135deg, var(--app-wood), var(--app-wood-dark)); border-bottom: 3px solid #d9a75f; }
  .welcome-header > div:first-child { flex: 1; }
  .window-kicker, .eyebrow { color: #806d58; font-size: .68rem; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
  .window-kicker { color: #ead8b6; }
  h1, h2, p { text-shadow: none; }
  h1 { margin: .12rem 0; color: #fff7e2; font: 700 1.85rem Georgia, ui-serif, serif; outline: none; }
  .welcome-header p { margin: .25rem 0 0; color: #eadfc9; line-height: 1.4; }
  .crew-mark { position: relative; width: 5.4rem; height: 3.5rem; flex: none; }
  .crew-mark span { position: absolute; display: grid; width: 3.1rem; height: 3.1rem; place-items: center; color: #fff8e8; background: var(--app-teal); border: 3px solid #c5e0cd; border-radius: 50%; font: 800 1.2rem Georgia, serif; }
  .crew-mark span:last-child { right: 0; bottom: 0; background: #bc7745; border-color: #efd3a8; }
  .setup-steps { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; padding: .8rem 1.25rem; background: var(--app-paper-soft); border-bottom: 1px solid #c7a477; list-style: none; }
  .setup-steps li { position: relative; display: flex; align-items: center; justify-content: center; gap: .55rem; color: #7b7063; }
  .setup-steps li:not(:last-child)::after { position: absolute; right: -.5rem; width: 1rem; height: 2px; content: ""; background: #b79c75; }
  .setup-steps li > span { display: grid; width: 1.75rem; height: 1.75rem; place-items: center; background: #d7c09a; border-radius: 50%; font-size: .76rem; font-weight: 900; }
  .setup-steps li div { display: grid; }
  .setup-steps small { color: inherit; font-size: .67rem; }
  .setup-steps li.current { color: #8c5c1f; }
  .setup-steps li.current > span { color: white; background: var(--app-amber); }
  .setup-steps li.complete { color: #3e7650; }
  .setup-steps li.complete > span { color: white; background: var(--app-green); }
  .onboarding-body { padding: 1.2rem 1.4rem 1.35rem; }
  .onboarding-body section { display: grid; gap: .8rem; }
  .state-copy h2, .onboarding-body h2 { margin: .1rem 0; color: var(--app-ink); font: 700 1.42rem Georgia, ui-serif, serif; }
  .state-copy p, .onboarding-body section > div p { margin: .2rem 0; color: var(--app-muted); line-height: 1.5; }
  .project-state { grid-template-columns: minmax(0, 1fr) 10rem; }
  .project-state .hero-action, .project-state .quiet-action { grid-column: 1 / -1; justify-self: end; }
  .project-illustration { display: flex; align-items: center; justify-content: center; gap: .35rem; color: var(--app-teal); font-size: 2rem; }
  .project-illustration i { width: 2.5rem; border-top: 3px dotted #c5a46e; }
  .primary, .secondary { min-height: 2.65rem; padding: .62rem 1rem; border-radius: 8px; font-weight: 800; }
  .primary { color: #fff9e9; background: linear-gradient(#5d9670, #477c5a); border: 1px solid #356447; box-shadow: 0 2px 5px #3d583c33; }
  .secondary { color: #5b4b3e; background: #fff8e8; border: 1px solid #b99a70; box-shadow: none; }
  .hero-action { justify-self: end; min-width: 11rem; }
  .quiet-action { min-height: auto; padding: .2rem; color: var(--app-teal-dark); background: transparent; border: 0; box-shadow: none; font-weight: 750; }
  button:focus-visible { outline: 3px solid #e2a84e; outline-offset: 2px; }
  button:disabled { cursor: wait; opacity: .6; }
  .project-waiting, .project-attention, .creating-state, .failure-state, .conflict-state { grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; padding: .9rem; background: #fff9e9; border: 1px solid #d8bd91; border-left: 5px solid var(--app-amber); border-radius: 10px; }
  .project-attention, .failure-state, .conflict-state { background: #f8e2d9; border-color: #d79d8c; border-left-color: var(--app-coral); }
  .creating-state { border-left-color: var(--app-teal); }
  .spinner { width: 2.4rem; height: 2.4rem; border: 4px solid #c8ddd4; border-top-color: var(--app-teal); border-radius: 50%; animation: spin 1s linear infinite; }
  .spinner.amber { border-color: #ead9b6; border-top-color: var(--app-amber); }
  .failure-icon, .host-icon { display: grid; width: 2.4rem; height: 2.4rem; place-items: center; color: white; background: var(--app-coral); border-radius: 50%; font-weight: 900; }
  .host-icon { background: var(--app-amber); }
  .button-row { display: flex; grid-column: 1 / -1; justify-content: flex-end; gap: .6rem; }
  .error-copy { padding: .45rem .55rem; background: #fff5e9; border-radius: 5px; font-size: .82rem; }
  .crew-ready-state .state-copy { text-align: center; }
  .starter-preview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; }
  .starter-preview article { display: flex; align-items: center; gap: .7rem; min-width: 0; padding: .68rem .75rem; background: #fff9e9; border: 1px solid #ddc49b; border-radius: 9px; }
  .starter-preview article > div { min-width: 0; }
  .starter-preview article p { margin: .08rem 0 !important; font-size: .78rem; }
  .starter-preview article small { color: var(--app-teal-dark); font-size: .72rem; font-weight: 800; }
  .portrait { display: grid; width: 2.55rem; height: 2.55rem; flex: none; place-items: center; color: #fff; background: var(--app-teal); border: 2px solid #b8d4c4; border-radius: 50%; font: 800 1rem Georgia, serif; }
  .portrait.reviewer { background: #b66d44; border-color: #efd0a7; }
  .preview-icon { display: grid; width: 2.3rem; height: 2.3rem; flex: none; place-items: center; color: var(--app-teal-dark); background: #e5eedc; border-radius: 8px; font-size: 1.1rem; }
  .teaching-copy { margin: 0; color: var(--app-muted); font-size: .78rem; text-align: center; }
  .crew-ready-state > .quiet-action { justify-self: end; }
  .success-state { justify-items: center; text-align: center; }
  .success-seal { display: grid; width: 3rem; height: 3rem; place-items: center; color: white; background: var(--app-green); border: 4px solid #cfe1bf; border-radius: 50%; font-size: 1.25rem; font-weight: 900; }
  .success-state > div p { max-width: 31rem; }
  .success-summary { display: flex; align-items: center; justify-content: center; gap: 1rem; width: min(28rem, 100%); padding: .8rem; background: #eaf2df; border: 1px solid #b6ca9f; border-radius: 10px; }
  .success-summary span { display: grid; }
  .success-summary small { color: var(--app-muted); }
  .success-state .hero-action { justify-self: center; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 950px) and (max-height: 650px) {
    .onboarding { top: 4.5rem; max-height: calc(100vh - 5rem); transform: translate(-50%, 0); }
    .welcome-header { padding: .65rem 1rem; }
    .welcome-header h1 { font-size: 1.5rem; }
    .welcome-header p { margin-top: .1rem; font-size: .86rem; }
    .crew-mark { transform: scale(.82); }
    .setup-steps { padding-block: .45rem; }
    .onboarding-body { padding: .65rem .9rem .75rem; }
    .onboarding-body section { gap: .45rem; }
    .starter-preview { gap: .4rem; }
    .starter-preview article { padding: .45rem .6rem; }
    .teaching-copy { line-height: 1.2; }
  }
  @media (max-width: 720px) {
    .onboarding { top: 4.6rem; max-height: calc(100vh - 5.1rem); transform: translate(-50%, 0); }
    .welcome-header { padding: .9rem 1rem; }
    h1 { font-size: 1.5rem; }
    .crew-mark { display: none; }
    .setup-steps { padding-inline: .6rem; }
    .setup-steps li { gap: .3rem; }
    .setup-steps li div { display: none; }
    .onboarding-body { padding: .85rem; }
    .project-state { grid-template-columns: 1fr; }
    .project-illustration { display: none; }
    .project-waiting, .project-attention, .creating-state, .failure-state, .conflict-state { grid-template-columns: auto minmax(0, 1fr); }
    .project-waiting button, .project-attention button, .creating-state button, .failure-state button { grid-column: 1 / -1; justify-self: stretch; }
    .starter-preview { grid-template-columns: 1fr; }
    .hero-action { justify-self: stretch; width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
