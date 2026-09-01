<script lang="ts">
import { onMount, tick } from "svelte";
import type {
  ArtifactDetail,
  ArtifactSummary,
  Quest,
  RunProjection,
  SnapshotMember,
} from "../../api/contracts";
import { openPullRequest } from "../../platform/open-pull-request";
import type { AppStore, ProductState } from "../../state/app-store";
import "../management/management-window.css";
import {
  artifactPreview,
  artifactProducer,
  artifactTypeLabel,
  canCleanUp,
  canRunAgain,
  deliveryPresentation,
  diagnosticPresentation,
  executionPresentation,
  formatLaunchTime,
  friendlyArtifact,
  humanize,
  questPresentation,
  runProgress,
  stepDisplayName,
  stepResult,
  totalSteps,
  workspacePresentation,
} from "./run-presentation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let initialMemberKey: string | null = null;
export let onMember: (key: string) => void = () => undefined;
export let scene: string | null = null;

const { error: errorStore, selectedRun: selectedRunStore } = store;

type Tab = "overview" | "timeline" | "artifacts" | "delivery";

let tab: Tab = "overview";
let selectedMemberKey: string | null = initialMemberKey;
let selectedArtifactId: string | null = null;
let selectedArtifact: ArtifactDetail | null = null;
let artifactLoading = false;
let artifactRequest = 0;
let technicalOpen = false;
let busy = false;
let activeRunId: string | null = null;
let search = "";
let cleanupDialog: HTMLDialogElement;
let cleanupCancel: HTMLButtonElement;
let cleanupTrigger: HTMLButtonElement;

$: run = $selectedRunStore;
$: normalizedSearch = search.trim().toLocaleLowerCase();
$: visibleRuns = product.runs.filter((summary) =>
  `${summary.quest_title} ${summary.status} ${summary.delivery?.state ?? ""}`
    .toLocaleLowerCase()
    .includes(normalizedSearch),
);
$: quest = run
  ? (product.quests.find((item) => item.id === run?.quest.id) ?? null)
  : null;
$: selectedMember =
  run?.squad.members.find((item) => item.member_key === selectedMemberKey) ?? null;
$: selectedMemberSteps = run
  ? run.steps.filter((step) => step.member?.member_key === selectedMemberKey)
  : [];
$: execution = run ? executionPresentation(run.status) : null;
$: delivery = run ? deliveryPresentation(run.delivery) : null;
$: workspace = run
  ? workspacePresentation(run.execution_environment.state)
  : null;
$: questStatus = run ? questPresentation(run, quest) : null;
$: resultArtifact = run?.artifacts.find((item) => item.type === "verdict") ?? null;
$: resultText = resultArtifact ? artifactPreview(resultArtifact) : null;
$: if (run?.id !== activeRunId) {
  activeRunId = run?.id ?? null;
  selectedArtifactId = null;
  selectedArtifact = null;
  artifactLoading = false;
  selectedMemberKey =
    run?.squad.members.some((member) => member.member_key === initialMemberKey)
      ? initialMemberKey
      : null;
}
$: if (
  selectedArtifactId &&
  run &&
  !run.artifacts.some((item) => item.id === selectedArtifactId)
) {
  selectedArtifactId = null;
  selectedArtifact = null;
}

onMount(async () => {
  if (!run && product.runs[0]) await store.selectRun(product.runs[0].id);
  if (scene === "timeline" || scene === "remediation") tab = "timeline";
  if (["artifacts", "artifact-detail", "artifact-raw"].includes(scene ?? ""))
    tab = "artifacts";
  if (scene === "delivery" || scene === "cleanup") tab = "delivery";
  if (scene === "technical") {
    tab = "delivery";
    technicalOpen = true;
  }
  if (scene === "member") selectedMemberKey = run?.squad.members[0]?.member_key ?? null;
  if (["artifact-detail", "artifact-raw"].includes(scene ?? "")) {
    await tick();
    const item =
      scene === "artifact-raw"
        ? run?.artifacts.find((artifact) => artifact.type === "custom_metrics")
        : run?.artifacts.find((artifact) => artifact.type === "verdict");
    if (item) await selectArtifact(item);
  }
  if (scene === "cleanup" && run?.delivery?.state === "closed_unmerged") {
    await tick();
    openCleanupConfirmation();
  }
});

async function selectRun(id: string) {
  if (id === run?.id) return;
  await store.selectRun(id);
}

function selectMember(member: SnapshotMember) {
  selectedMemberKey = member.member_key;
  onMember(member.member_key);
}

async function selectArtifact(summary: ArtifactSummary) {
  if (!run) return;
  selectedArtifactId = summary.id;
  selectedArtifact = null;
  artifactLoading = true;
  const request = ++artifactRequest;
  const requestedRun = run.id;
  const requestedArtifact = summary.id;
  const detail = await store.loadArtifact(requestedRun, requestedArtifact);
  if (
    request === artifactRequest &&
    run?.id === requestedRun &&
    selectedArtifactId === requestedArtifact
  ) {
    selectedArtifact = detail;
    artifactLoading = false;
  }
}

async function retryPublishing() {
  if (!run || busy) return;
  busy = true;
  try {
    await store.retryPublishing(run.id);
  } finally {
    busy = false;
  }
}

async function runAgain() {
  if (!run || !canRunAgain(run, quest) || busy || !quest) return;
  busy = true;
  try {
    const launch = await store.command(() => store.api.launchQuest(quest.id));
    if (launch) {
      await store.refreshProduct();
      await store.selectRun(launch.runId);
    }
  } finally {
    busy = false;
  }
}

async function reviewOnGitHub() {
  const review = run?.delivery?.review;
  if (!review || store.fixture) return;
  await store.command(() => openPullRequest(review.url, review.number));
}

function requestCleanup(event: MouseEvent) {
  if (!run || !canCleanUp(run) || busy) return;
  if (run.delivery?.state === "closed_unmerged") {
    cleanupTrigger = event.currentTarget as HTMLButtonElement;
    openCleanupConfirmation();
    return;
  }
  void performCleanup(false);
}

function openCleanupConfirmation() {
  cleanupDialog?.showModal();
  void tick().then(() => cleanupCancel?.focus());
}

function closeCleanupConfirmation() {
  cleanupDialog?.close();
  cleanupTrigger?.focus();
}

async function confirmCleanup() {
  cleanupDialog.close();
  await performCleanup(true);
  cleanupTrigger?.focus();
}

async function performCleanup(acknowledgeUnmerged: boolean) {
  if (!run) return;
  busy = true;
  try {
    await store.cleanupWorktree(run.id, acknowledgeUnmerged);
  } finally {
    busy = false;
  }
}

function latestMemberStep(member: SnapshotMember) {
  return run?.steps
    .filter((step) => step.member?.member_key === member.member_key)
    .at(-1);
}

function memberActivity(member: SnapshotMember): string {
  const step = latestMemberStep(member);
  if (!step) return "No assignment";
  const result = run ? stepResult(step, run.artifacts) : null;
  return `${step.name ?? humanize(step.semantic_step_key)} · ${result ?? executionPresentation(step.state).label}`;
}

function shortRevision(value: string | null): string {
  return value ? value.slice(0, 10) : "Unavailable";
}
</script>

<aside class="management-window management-window-shell work-yard-window" aria-labelledby="work-yard-title">
  <header class="window-header">
    <div>
      <span class="window-kicker">Operational observability</span>
      <h1 id="work-yard-title">Work Yard</h1>
    </div>
    <button class="icon-button" aria-label="Close Work Yard" on:click={onClose}>×</button>
  </header>

  <div class="work-yard-layout">
    <aside class="run-browser" aria-label="Run browser">
      <div class="browser-heading">
        <div><span class="eyebrow">Run history</span><h2>Recent Runs</h2></div>
        <span class="run-count">{product.runs.length}</span>
      </div>
      {#if product.runs.length > 4}
        <label class="search-label">
          <span class="sr-only">Search Runs</span>
          <input bind:value={search} type="search" placeholder="Search Runs…" />
        </label>
      {/if}
      <div class="run-list">
        {#each visibleRuns as summary}
          {@const summaryExecution = executionPresentation(summary.status)}
          {@const summaryDelivery = deliveryPresentation(summary.delivery)}
          <button
            class="run-card"
            class:selected={summary.id === run?.id}
            aria-current={summary.id === run?.id ? "true" : undefined}
            on:click={() => selectRun(summary.id)}
          >
            <strong>{summary.quest_title}</strong>
            <span class="card-status"><span class="status-dot tone-{summaryExecution.tone}"></span>{summaryExecution.label}</span>
            <small>{runProgress(summary)}</small>
            {#if summary.delivery}<span class="delivery-summary tone-text-{summaryDelivery.tone}">{summaryDelivery.label}</span>{/if}
            <time datetime={summary.launched_at}>Launched {formatLaunchTime(summary.launched_at)}</time>
          </button>
        {:else}
          <p class="browser-empty">{product.runs.length ? "No matching Runs." : "No Runs yet."}</p>
        {/each}
      </div>
    </aside>

    <section class="run-detail">
      {#if run && execution && delivery && workspace}
        <header class="run-heading">
          <div>
            <span class="eyebrow">Selected Run</span>
            <h2>{run.quest.title}</h2>
            <p>{run.execution_environment.workspace.name} <span aria-hidden="true">·</span> {run.squad.name}</p>
          </div>
          <span class="large-status tone-{execution.tone}">{execution.label}</span>
        </header>

        <nav class="run-tabs" aria-label="Run sections">
          {#each [
            ["overview", "Overview"],
            ["timeline", "Timeline"],
            ["artifacts", `Artifacts (${run.artifacts.length})`],
            ["delivery", "Delivery"],
          ] as item}
            <button
              class:active={tab === item[0]}
              aria-current={tab === item[0] ? "page" : undefined}
              on:click={() => (tab = item[0] as Tab)}
            >{item[1]}</button>
          {/each}
        </nav>

        <div class="detail-scroll" tabindex="-1">
          {#if $errorStore}<div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p><strong>That operation couldn't be completed.</strong> {$errorStore.message}</p></div>{/if}
          {#if tab === "overview"}
            <section class="overview" aria-label="Run overview">
              {#if run.delivery?.issue}
                {@const diagnostic = diagnosticPresentation(run.delivery.issue)}
                <article class="attention-card" role="status">
                  <span class="attention-icon" aria-hidden="true">!</span>
                  <div><span class="eyebrow">{delivery.label}</span><h3>{diagnostic.title}</h3><p>{diagnostic.description}</p></div>
                  {#if run.delivery.can_retry}<button class="primary" disabled={busy} on:click={retryPublishing}>Retry Publishing</button>{/if}
                </article>
              {:else if run.execution_environment.issue}
                {@const diagnostic = diagnosticPresentation(run.execution_environment.issue)}
                <article class="attention-card workspace-attention" role="status">
                  <span class="attention-icon" aria-hidden="true">!</span>
                  <div><span class="eyebrow">Run workspace · {workspace.label}</span><h3>{diagnostic.title}</h3><p>{diagnostic.description}</p></div>
                </article>
              {:else if run.issues[0]}
                {@const diagnostic = diagnosticPresentation(run.issues[0])}
                <article class="attention-card" role="status">
                  <span class="attention-icon" aria-hidden="true">!</span>
                  <div><span class="eyebrow">Execution · {execution.label}</span><h3>{diagnostic.title}</h3><p>{diagnostic.description}</p></div>
                </article>
              {/if}

              <div class="overview-grid">
                <section class="overview-section team-section">
                  <span class="eyebrow">Team</span>
                  <h3>{run.squad.name}</h3>
                  <div class="member-list">
                    {#each run.squad.members as item}
                      <button class:selected={selectedMemberKey === item.member_key} on:click={() => selectMember(item)}>
                        <span class="member-avatar" aria-hidden="true">{item.name.slice(0, 1).toLocaleUpperCase()}</span>
                        <span><strong>{item.name}</strong><small>{item.class.name} · {item.loadout.name}</small></span>
                        <em>{memberActivity(item)}</em>
                      </button>
                    {/each}
                  </div>
                </section>

                <section class="overview-section result-section">
                  <span class="eyebrow">Result</span>
                  <h3>{resultText ?? (run.status === "completed" ? "Execution completed" : "Work in progress")}</h3>
                  <p>{run.quest.objective}</p>
                  <dl class="status-table">
                    <div><dt>Execution</dt><dd class="tone-text-{execution.tone}">{execution.label}</dd></div>
                    <div><dt>Delivery</dt><dd class="tone-text-{delivery.tone}">{delivery.label}</dd></div>
                    {#if questStatus}<div><dt>Quest</dt><dd class="tone-text-{questStatus.tone}">{questStatus.label}</dd></div>{/if}
                    <div><dt>Run workspace</dt><dd class="tone-text-{workspace.tone}">{workspace.label}</dd></div>
                  </dl>
                </section>
              </div>

              {#if selectedMember}
                <section class="member-inspector" aria-label="Selected Member">
                  <div class="member-avatar large" aria-hidden="true">{selectedMember.name.slice(0, 1).toLocaleUpperCase()}</div>
                  <div><span class="eyebrow">Member snapshot</span><h3>{selectedMember.name}</h3><p>{selectedMember.class.name} <span aria-hidden="true">·</span> {selectedMember.loadout.name}</p></div>
                  <div class="member-history"><strong>{selectedMemberSteps.length} {selectedMemberSteps.length === 1 ? "assignment" : "assignments"}</strong><span>{memberActivity(selectedMember)}</span></div>
                </section>
              {/if}
            </section>
          {:else if tab === "timeline"}
            <section class="timeline-section" aria-labelledby="timeline-title">
              <div class="section-heading"><div><span class="eyebrow">Semantic Step occurrences</span><h3 id="timeline-title">Timeline</h3></div><span>{run.step_counts.completed} of {totalSteps(run.step_counts)} completed</span></div>
              <ol class="timeline">
                {#each run.steps as step, index}
                  {@const stepStatus = executionPresentation(step.state)}
                  {@const outcome = stepResult(step, run.artifacts)}
                  <li class="tone-border-{stepStatus.tone}">
                    <span class="timeline-marker tone-{stepStatus.tone}" aria-hidden="true">{step.state === "completed" ? "✓" : index + 1}</span>
                    <div class="timeline-copy">
                      <div class="timeline-title"><h4>{stepDisplayName(run.steps, index)}</h4><span class="tone-text-{stepStatus.tone}">{outcome ?? stepStatus.label}{#if step.attempt && step.attempt.number > 1} · Attempt {step.attempt.number}{/if}</span></div>
                      {#if step.member}<p><strong>{step.member.name}</strong> · {step.member.class.name} <span aria-hidden="true">·</span> {step.member.loadout.name}</p>{/if}
                      {#if step.issue}<p class="step-issue">{step.issue.message}</p>{/if}
                      {#if step.inputs.length || step.outputs.length}
                        <div class="artifact-links">
                          {#each step.inputs as reference}<button on:click={() => { tab = "artifacts"; const item = run?.artifacts.find((artifact) => artifact.id === reference.artifact_id); if (item) void selectArtifact(item); }}>Input · {artifactTypeLabel(reference.type)}</button>{/each}
                          {#each step.outputs as reference}<button on:click={() => { tab = "artifacts"; const item = run?.artifacts.find((artifact) => artifact.id === reference.artifact_id); if (item) void selectArtifact(item); }}>Output · {artifactTypeLabel(reference.type)}</button>{/each}
                        </div>
                      {/if}
                    </div>
                  </li>
                {:else}
                  <li class="timeline-empty">No Step occurrences have been created yet.</li>
                {/each}
              </ol>
            </section>
          {:else if tab === "artifacts"}
            <section class="artifacts-section" aria-labelledby="artifacts-title">
              <div class="section-heading"><div><span class="eyebrow">Run outputs</span><h3 id="artifacts-title">Artifacts</h3></div><span>{run.artifacts.length} produced</span></div>
              {#if run.artifacts.length}
                <div class="artifact-layout">
                  <div class="artifact-list">
                    {#each run.artifacts as item}
                      <button class:selected={selectedArtifactId === item.id} on:click={() => selectArtifact(item)}>
                        <span class="artifact-glyph" aria-hidden="true">◇</span>
                        <span><strong>{artifactTypeLabel(item.type)}</strong><small>{artifactPreview(item)}</small><em>{artifactProducer(item, run.steps)}</em></span>
                      </button>
                    {/each}
                  </div>
                  <div class="artifact-detail" aria-live="polite">
                    {#if artifactLoading}<p class="detail-placeholder">Loading artifact…</p>
                    {:else if selectedArtifact}
                      <span class="eyebrow">Artifact detail</span>
                      <h3>{artifactTypeLabel(selectedArtifact.type)}</h3>
                      <p class="provenance">Produced by {artifactProducer(selectedArtifact, run.steps)}</p>
                      {#if selectedArtifact.type === "change_set"}<p class="authority-note"><strong>Agent-reported output.</strong> Delivery uses separate Worker and repository evidence for publishing.</p>{/if}
                      {#if friendlyArtifact(selectedArtifact).length}
                        <dl class="artifact-fields">
                          {#each friendlyArtifact(selectedArtifact) as field}<div><dt>{field.label}</dt><dd>{field.value}</dd></div>{/each}
                        </dl>
                      {/if}
                      <details class="raw-data"><summary>Raw data</summary><pre>{JSON.stringify(selectedArtifact.value, null, 2)}</pre></details>
                    {:else}<div class="detail-placeholder"><span aria-hidden="true">◇</span><h3>Select an artifact</h3><p>Complete artifact data is loaded only when selected.</p></div>{/if}
                  </div>
                </div>
              {:else}<div class="empty-state"><span aria-hidden="true">◇</span><h3>No artifacts yet</h3><p>Outputs will appear here when Steps produce them.</p></div>{/if}
            </section>
          {:else}
            <section class="delivery-section" aria-labelledby="delivery-title">
              <div class="section-heading"><div><span class="eyebrow">Publishing lifecycle</span><h3 id="delivery-title">Delivery</h3></div><span class="status-chip tone-{delivery.tone}">{delivery.label}</span></div>
              <p class="section-intro">{delivery.description}</p>
              {#if run.delivery?.issue}
                {@const diagnostic = diagnosticPresentation(run.delivery.issue)}
                <article class="diagnostic-card"><span class="attention-icon" aria-hidden="true">!</span><div><h3>{diagnostic.title}</h3><p>{diagnostic.description}</p></div></article>
              {/if}
              <div class="delivery-grid">
                <section><span class="eyebrow">Repository evidence</span><h4>{run.delivery?.changes ? `${run.delivery.changes.files_changed} files changed` : "Not available yet"}</h4>{#if run.delivery?.changes}<p><strong>+{run.delivery.changes.additions}</strong> additions <span aria-hidden="true">·</span> <strong>−{run.delivery.changes.deletions}</strong> deletions</p>{/if}<small>Reported by Delivery and the assigned Worker.</small></section>
                <section><span class="eyebrow">Pull Request</span>{#if run.delivery?.review}<h4>GitHub Pull Request #{run.delivery.review.number}</h4><p>{humanize(run.delivery.review.state)}</p>{:else}<h4>No Pull Request</h4><p>{run.delivery?.state === "preparing_review" ? "Preparing review" : "Delivery has not produced a Pull Request."}</p>{/if}</section>
                <section><span class="eyebrow">Run workspace</span><h4>{workspace.label}</h4><p>{workspace.description}</p></section>
              </div>
              <div class="delivery-actions">
                {#if run.delivery?.can_retry}<button class="primary" disabled={busy} on:click={retryPublishing}>Retry Publishing</button>{/if}
                {#if run.delivery?.review}<button class="secondary" on:click={reviewOnGitHub}>Open Pull Request</button>{/if}
                {#if canRunAgain(run, quest)}<button class="primary" disabled={busy} on:click={runAgain}>Run Again</button>{/if}
                {#if canCleanUp(run)}<button bind:this={cleanupTrigger} class="secondary" disabled={busy} on:click={requestCleanup}>Clean Up Workspace</button>{/if}
              </div>
            </section>
          {/if}

          <details class="technical" bind:open={technicalOpen}>
            <summary>Technical details</summary>
            <div class="technical-grid">
              <div><span>Run ID</span><code>{run.id}</code></div>
              <div><span>Launch ID</span><code>{run.launch.id}</code></div>
              <div><span>Projection revision</span><code>{run.revision}</code></div>
              <div><span>Launched</span><time datetime={run.launched_at}>{formatLaunchTime(run.launched_at)}</time></div>
              <div><span>Workspace key</span><code>{run.execution_environment.workspace.key}</code></div>
              <div><span>Workspace base revision</span><code>{shortRevision(run.execution_environment.base_revision)}</code></div>
              {#if run.delivery}<div><span>Delivery base revision</span><code>{shortRevision(run.delivery.revisions.base)}</code></div><div><span>Delivery head revision</span><code>{shortRevision(run.delivery.revisions.head)}</code></div>{/if}
              <div><span>Run branch</span><code>{run.execution_environment.branch ?? "Unavailable"}</code></div>
              <div><span>Dirty source changes excluded</span><code>{run.execution_environment.source_dirty_changes_excluded === null ? "Unavailable" : run.execution_environment.source_dirty_changes_excluded ? "Yes" : "No"}</code></div>
            </div>
            {#if $errorStore}<div class="technical-code"><span>Last operation code</span><code>{$errorStore.code}</code></div>{/if}
            {#if run.delivery?.issue}<div class="technical-code"><span>Delivery issue code</span><code>{run.delivery.issue.code}</code></div>{/if}
            {#if run.execution_environment.issue}<div class="technical-code"><span>Workspace issue code</span><code>{run.execution_environment.issue.code}</code></div>{/if}
            {#if run.steps.some((step) => step.attempt)}
              <h4>Current Step attempts</h4>
              <ul class="attempt-list">{#each run.steps.filter((step) => step.attempt) as step}<li><span>{step.name ?? step.semantic_step_key}</span><span>Attempt {step.attempt?.number} · {humanize(step.attempt?.state ?? "")}</span><code>Occurrence {step.occurrence_id} · Attempt {step.attempt?.id}</code></li>{/each}</ul>
            {/if}
          </details>
        </div>
      {:else}
        <div class="empty-state run-empty"><span aria-hidden="true">◇</span><h2>No Runs yet</h2><p>Launch a Quest from the Quest Board. Its execution, Delivery, Members, and artifacts will appear here.</p></div>
      {/if}
    </section>
  </div>

  <dialog bind:this={cleanupDialog} aria-labelledby="cleanup-title" on:cancel|preventDefault={closeCleanupConfirmation}>
    <div class="dialog-card">
      <span class="dialog-icon" aria-hidden="true">!</span>
      <h2 id="cleanup-title">Remove the retained workspace?</h2>
      <p>This Pull Request closed without merge. Acknowledge that outcome before requesting removal of the isolated Run workspace.</p>
      <div class="action-row"><button bind:this={cleanupCancel} class="secondary" on:click={closeCleanupConfirmation}>Keep Workspace</button><button class="destructive" disabled={busy} on:click={confirmCleanup}>Acknowledge and Clean Up</button></div>
    </div>
  </dialog>
</aside>

<style>
  .work-yard-window { width: min(74rem, calc(100vw - 2rem)); height: min(51rem, calc(100vh - 5.4rem)); max-height: calc(100vh - 5.4rem); }
  .work-yard-layout { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); height: calc(100% - 5rem); min-height: 0; }
  .run-browser { display: flex; min-height: 0; flex-direction: column; padding: 1rem; background: #ecd3a7; border-right: 1px solid #b58f60; }
  .browser-heading, .run-heading, .section-heading, .timeline-title { display: flex; align-items: center; justify-content: space-between; gap: .8rem; }
  .browser-heading h2, .run-heading h2, .section-heading h3, .overview-section h3, .member-inspector h3, .artifact-detail h3, .diagnostic-card h3 { margin: .12rem 0; color: var(--app-ink); font-family: Georgia, ui-serif, serif; text-shadow: none; }
  .browser-heading h2 { font-size: 1.25rem; }
  .run-count { display: grid; width: 2rem; height: 2rem; place-items: center; color: #fff; background: var(--app-teal); border-radius: 50%; font-weight: 800; }
  .search-label { margin: .8rem 0 .35rem; }
  .search-label input { width: 100%; padding: .55rem .65rem; color: var(--app-ink); background: #fff8e8; border: 1px solid #b99a70; border-radius: 7px; }
  .run-list { min-height: 0; overflow: auto; padding: .3rem .15rem .5rem 0; }
  .run-card { display: grid; width: 100%; min-height: 0; margin: .45rem 0; padding: .7rem .75rem; gap: .22rem; color: var(--app-ink); background: #fff8e8; border: 1px solid #c3a477; border-radius: 9px; box-shadow: 0 2px 4px #76543a1c; text-align: left; }
  .run-card:hover { background: #fffdf5; border-color: var(--app-teal); }
  .run-card.selected { background: #f5fff4; border: 2px solid var(--app-green); box-shadow: inset 4px 0 var(--app-green); }
  .run-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card small, .run-card time { color: var(--app-muted); font-size: .72rem; }
  .card-status { display: flex; align-items: center; gap: .35rem; font-size: .8rem; font-weight: 750; }
  .delivery-summary { margin-top: .18rem; font-size: .76rem; font-weight: 750; }
  .status-dot { width: .55rem; height: .55rem; border-radius: 50%; }
  .browser-empty { color: var(--app-muted); font-size: .85rem; }
  .run-detail { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--app-cream); }
  .run-heading { padding: .9rem 1.2rem .75rem; border-bottom: 1px solid #d6bc91; }
  .run-heading h2 { font-size: 1.55rem; }
  .run-heading p { margin: .2rem 0 0; color: var(--app-muted); }
  .large-status, .status-chip { flex: none; padding: .38rem .7rem; color: white; border-radius: 999px; font-size: .78rem; font-weight: 850; }
  .run-tabs { display: flex; gap: .2rem; padding: .45rem 1.1rem 0; background: #f3dfbb; border-bottom: 1px solid #c9a978; }
  .run-tabs button { min-height: 2.45rem; padding: .55rem .8rem; color: #675748; background: transparent; border: 0; border-bottom: 3px solid transparent; border-radius: 6px 6px 0 0; box-shadow: none; font-weight: 750; }
  .run-tabs button:hover { background: #fff7e6; }
  .run-tabs button.active { color: var(--app-teal-dark); background: var(--app-cream); border-bottom-color: var(--app-teal); }
  .detail-scroll { min-height: 0; overflow: auto; padding: 1.1rem 1.2rem 1.4rem; scroll-behavior: smooth; }
  .attention-card, .diagnostic-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .8rem; margin-bottom: 1rem; padding: .8rem .9rem; background: #f8ded5; border: 1px solid #d69b88; border-left: 5px solid var(--app-coral); border-radius: 9px; }
  .attention-card.workspace-attention { background: #fff0d5; border-color: #dfbd7e; }
  .attention-card h3, .diagnostic-card h3 { font-size: 1.05rem; }
  .attention-card p, .diagnostic-card p { margin: .2rem 0 0; color: #6c5149; font-size: .85rem; line-height: 1.4; }
  .attention-icon { display: grid; width: 2rem; height: 2rem; place-items: center; color: white; background: var(--app-coral); border-radius: 50%; font-weight: 900; }
  .overview-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(15rem, .75fr); gap: 1rem; }
  .overview-section { min-width: 0; padding: .95rem; background: #fff9e9; border: 1px solid #d8bd91; border-radius: 10px; }
  .overview-section > h3 { margin-bottom: .65rem; }
  .member-list { display: grid; gap: .45rem; }
  .member-list button { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .65rem; width: 100%; min-height: 0; padding: .55rem; color: var(--app-ink); background: #fffdf7; border: 1px solid #ddc7a1; box-shadow: none; text-align: left; }
  .member-list button.selected { border-color: var(--app-teal); background: #edf8ef; }
  .member-list button span:nth-child(2) { display: grid; }
  .member-list small { color: var(--app-muted); }
  .member-list em { max-width: 12rem; color: var(--app-teal-dark); font-size: .75rem; font-style: normal; font-weight: 750; text-align: right; }
  .member-avatar { display: grid; width: 2.1rem; height: 2.1rem; place-items: center; color: #fff8e8; background: var(--app-teal); border: 2px solid #b7d7c5; border-radius: 50%; font-family: Georgia, serif; font-weight: 800; }
  .member-avatar.large { width: 2.8rem; height: 2.8rem; font-size: 1.15rem; }
  .result-section > p { margin: .35rem 0 .8rem; color: var(--app-muted); font-size: .87rem; line-height: 1.45; }
  .status-table { margin: 0; }
  .status-table div { display: flex; justify-content: space-between; gap: 1rem; padding: .48rem 0; border-top: 1px solid #e4d2b1; }
  .status-table dt { color: var(--app-muted); }
  .status-table dd { margin: 0; font-weight: 800; text-align: right; }
  .member-inspector { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .8rem; margin-top: 1rem; padding: .8rem 1rem; background: #e8f2df; border: 1px solid #b0c69e; border-radius: 10px; }
  .member-inspector p { margin: .15rem 0 0; color: var(--app-muted); }
  .member-history { display: grid; color: var(--app-teal-dark); font-size: .8rem; text-align: right; }
  .section-heading { padding-bottom: .75rem; border-bottom: 1px solid #dcc49d; }
  .section-heading h3 { font-size: 1.4rem; }
  .section-heading > span { color: var(--app-muted); font-size: .8rem; font-weight: 750; }
  .section-heading > .status-chip { color: white; }
  .timeline { margin: 0; padding: .5rem 0 0; list-style: none; }
  .timeline li { position: relative; display: grid; grid-template-columns: 2.3rem minmax(0, 1fr); gap: .7rem; padding: .65rem 0 .7rem; }
  .timeline li:not(:last-child)::after { position: absolute; top: 2.65rem; bottom: -.35rem; left: 1.05rem; width: 2px; content: ""; background: #d7c09a; }
  .timeline-marker { z-index: 1; display: grid; width: 2.15rem; height: 2.15rem; place-items: center; color: white; border: 3px solid #fff5df; border-radius: 50%; font-size: .8rem; font-weight: 900; }
  .timeline-copy { padding: .1rem .2rem .55rem; border-bottom: 1px solid #ead8b7; }
  .timeline-title h4 { margin: 0; color: var(--app-ink); font: 700 1.05rem Georgia, serif; text-shadow: none; }
  .timeline-title span { font-size: .78rem; font-weight: 800; }
  .timeline-copy p { margin: .24rem 0; color: var(--app-muted); font-size: .82rem; }
  .timeline-copy p strong { color: var(--app-ink); }
  .step-issue { padding: .4rem .55rem; color: #783f3b !important; background: #f8ded5; border-radius: 5px; }
  .artifact-links { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .45rem; }
  .artifact-links button { min-height: 2rem; padding: .25rem .5rem; color: var(--app-teal-dark); background: #edf7ef; border: 1px solid #aabfa4; font-size: .72rem; box-shadow: none; }
  .artifact-layout { display: grid; grid-template-columns: minmax(13rem, .72fr) minmax(0, 1.28fr); min-height: 24rem; margin-top: .8rem; border: 1px solid #d6bb8e; border-radius: 9px; overflow: hidden; }
  .artifact-list { padding: .5rem; background: #f0ddb9; border-right: 1px solid #d0b182; }
  .artifact-list button { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .55rem; width: 100%; min-height: 0; padding: .65rem; color: var(--app-ink); background: transparent; border: 1px solid transparent; box-shadow: none; text-align: left; }
  .artifact-list button.selected { background: #fff9e9; border-color: var(--app-teal); }
  .artifact-list button span:nth-child(2) { display: grid; gap: .1rem; }
  .artifact-list small, .artifact-list em { color: var(--app-muted); font-size: .72rem; font-style: normal; }
  .artifact-glyph { color: var(--app-teal); font-size: 1.3rem; }
  .artifact-detail { min-width: 0; padding: 1rem; background: #fff9e9; }
  .artifact-detail .provenance { margin: .2rem 0 1rem; color: var(--app-muted); font-size: .8rem; }
  .detail-placeholder { display: grid; min-height: 18rem; place-items: center; align-content: center; color: var(--app-muted); text-align: center; }
  .detail-placeholder span { color: var(--app-teal); font-size: 2rem; }
  .detail-placeholder h3 { margin: .45rem 0 .15rem; }
  .authority-note { padding: .65rem .75rem; color: #66513b; background: #fff0cf; border-left: 4px solid var(--app-amber); font-size: .83rem; line-height: 1.45; }
  .artifact-fields { margin: .7rem 0; }
  .artifact-fields div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: .7rem; padding: .45rem 0; border-bottom: 1px solid #ead6b4; }
  .artifact-fields dt { color: var(--app-muted); font-size: .8rem; }
  .artifact-fields dd { margin: 0; overflow-wrap: anywhere; font-weight: 700; }
  .raw-data { margin-top: .8rem; border-top: 1px solid #d8c09b; }
  .raw-data summary, .technical summary { padding: .7rem .2rem; color: var(--app-teal-dark); cursor: pointer; font-weight: 800; }
  .raw-data pre { max-height: 16rem; overflow: auto; padding: .7rem; color: #d9eee4; background: #263c3a; border-radius: 7px; white-space: pre-wrap; }
  .section-intro { color: var(--app-muted); }
  .diagnostic-card { grid-template-columns: auto minmax(0, 1fr); margin-top: 1rem; }
  .delivery-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .7rem; margin-top: 1rem; }
  .delivery-grid section { padding: .8rem; background: #fff9e9; border: 1px solid #d8bd91; border-radius: 8px; }
  .delivery-grid h4 { margin: .25rem 0; color: var(--app-ink); text-shadow: none; }
  .delivery-grid p { margin: .25rem 0; color: var(--app-muted); font-size: .82rem; line-height: 1.4; }
  .delivery-grid small { color: var(--app-muted); }
  .delivery-actions { display: flex; flex-wrap: wrap; gap: .55rem; margin-top: 1rem; }
  .technical { margin-top: 1rem; padding: 0 .75rem; background: #eee0c5; border: 1px solid #cdb58e; border-radius: 8px; }
  .technical-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem 1rem; padding: .25rem 0 .8rem; }
  .technical-grid div, .technical-code { display: grid; gap: .15rem; min-width: 0; }
  .technical-grid span, .technical-code span { color: var(--app-muted); font-size: .7rem; font-weight: 750; text-transform: uppercase; }
  .technical code { overflow-wrap: anywhere; color: #405d58; font-size: .76rem; }
  .technical-code { padding: .55rem 0; border-top: 1px solid #d4bd97; }
  .attempt-list { margin: 0 0 .8rem; padding: 0; list-style: none; }
  .attempt-list li { display: grid; grid-template-columns: 1fr auto; gap: .2rem 1rem; padding: .45rem 0; border-top: 1px solid #d4bd97; font-size: .78rem; }
  .attempt-list code { grid-column: 1 / -1; }
  .run-empty { align-self: center; margin: auto; }
  .tone-neutral { background: #718079; }
  .tone-active { background: var(--app-teal); }
  .tone-success { background: var(--app-green); }
  .tone-warning { background: var(--app-amber); }
  .tone-danger { background: var(--app-coral); }
  .tone-text-neutral { color: #68756e; }
  .tone-text-active { color: var(--app-teal-dark); }
  .tone-text-success { color: #3d784f; }
  .tone-text-warning { color: #9b631e; }
  .tone-text-danger { color: #a14743; }
  @media (max-width: 900px) {
    .work-yard-window { top: 4.8rem; right: .5rem; width: calc(100vw - 1rem); height: calc(100vh - 5.3rem); }
    .work-yard-layout { grid-template-columns: 14rem minmax(0, 1fr); }
    .overview-grid, .delivery-grid { grid-template-columns: 1fr; }
    .member-list em { display: none; }
  }
  @media (max-width: 680px) {
    .work-yard-layout { display: flex; flex-direction: column; }
    .run-browser { flex: none; max-height: 11.5rem; border-right: 0; border-bottom: 1px solid #b58f60; }
    .browser-heading { display: none; }
    .run-list { display: flex; gap: .5rem; overflow-x: auto; }
    .run-card { flex: 0 0 14rem; margin: 0; }
    .run-detail { flex: 1; min-height: 0; }
    .run-heading { padding: .65rem .8rem; }
    .run-heading h2 { font-size: 1.2rem; }
    .run-heading p { font-size: .78rem; }
    .large-status { padding: .3rem .5rem; }
    .run-tabs { overflow-x: auto; padding-left: .5rem; }
    .run-tabs button { flex: none; }
    .detail-scroll { padding: .8rem; }
    .attention-card { grid-template-columns: auto minmax(0, 1fr); }
    .attention-card button { grid-column: 1 / -1; }
    .member-list button { grid-template-columns: auto minmax(0, 1fr); }
    .member-list em { display: none; }
    .member-inspector { grid-template-columns: auto 1fr; }
    .member-history { grid-column: 1 / -1; text-align: left; }
    .artifact-layout { grid-template-columns: 1fr; }
    .artifact-list { max-height: 12rem; overflow: auto; border-right: 0; border-bottom: 1px solid #d0b182; }
    .technical-grid { grid-template-columns: 1fr; }
  }
</style>
