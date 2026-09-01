<script lang="ts">
import { onMount, tick } from "svelte";
import type { Workspace, WorkspaceSource } from "../../api/contracts";
import type { ProductState, AppStore } from "../../state/app-store";
import { ProjectAddCoordinator } from "./project-add-coordinator";
import {
  defaultProjectName,
  matchingSource,
  projectRepositoryIdentity,
  projectStatus,
  sourceIdentity,
} from "./project-presentation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let scene: string | null = null;

type Mode = "detail" | "add-select" | "add-confirm" | "reconnect" | "edit";
let mode: Mode = "detail";
let selectedId: string | null = null;
let selectedSourceId: string | null = null;
let projectSearch = "";
let repositorySearch = "";
let projectName = "";
let editName = "";
let busy = false;
let scanning = false;
let localIssue = "";
let optimisticProject: Workspace | null = null;
let reconnectProject: Workspace | null = null;
let archiveDialog: HTMLDialogElement;
let archiveTrigger: HTMLButtonElement;
let addCoordinator = coordinator();

$: persistedSelectedProject =
  product.workspaces.find((workspace) => workspace.id === selectedId) ?? null;
$: selectedProject =
  persistedSelectedProject ??
  (optimisticProject?.id === selectedId ? optimisticProject : null);
$: if (optimisticProject &&
    product.workspaces.some((workspace) => workspace.id === optimisticProject?.id)) {
  optimisticProject = null;
}
$: normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
$: visibleProjects = product.workspaces.filter((workspace) => {
  const identity = projectRepositoryIdentity(workspace, product.workspaceSources);
  return `${workspace.name} ${identity}`.toLocaleLowerCase().includes(normalizedProjectSearch);
});
$: normalizedRepositorySearch = repositorySearch.trim().toLocaleLowerCase();
$: compatibleSources = product.workspaceSources.filter((source) => {
  if (reconnectProject && !sourceIsCompatible(reconnectProject, source)) return false;
  const searchValue = `${source.name} ${sourceIdentity(source)}`.toLocaleLowerCase();
  return searchValue.includes(normalizedRepositorySearch);
});
$: selectedSource =
  product.workspaceSources.find((source) => source.candidate_id === selectedSourceId) ?? null;

onMount(async () => {
  if (scene === "list") selectedId = null;
  else selectedId = product.workspaces[0]?.id ?? null;
  if (scene === "add-selection") await beginAdd(false);
  if (scene === "add-confirm") {
    await beginAdd(false);
    const source = product.workspaceSources[0];
    if (source) chooseSource(source);
  }
  if (scene === "advanced") selectedId = product.workspaces[0]?.id ?? null;
  if (scene === "archive") {
    selectedId = product.workspaces[0]?.id ?? null;
    await tick();
    openArchiveDialog();
  }
});

function coordinator() {
  return new ProjectAddCoordinator({
    createWorkspace: store.api.createWorkspace,
    bindWorkspaceSource: store.api.bindWorkspaceSource,
  });
}

function selectProject(workspace: Workspace) {
  selectedId = workspace.id;
  mode = "detail";
  reconnectProject = null;
  localIssue = "";
}

async function beginAdd(scan = true) {
  mode = "add-select";
  reconnectProject = null;
  selectedSourceId = null;
  repositorySearch = "";
  projectName = "";
  localIssue = "";
  addCoordinator = coordinator();
  if (scan) await refreshRepositories();
}

async function beginReconnect(workspace: Workspace) {
  mode = "reconnect";
  reconnectProject = workspace;
  selectedSourceId = null;
  repositorySearch = "";
  localIssue = "";
  addCoordinator = coordinator();
  addCoordinator.useExistingProject(workspace);
  await refreshRepositories();
}

function chooseSource(source: WorkspaceSource) {
  selectedSourceId = source.candidate_id;
  if (mode === "reconnect") return;
  projectName = defaultProjectName(source);
  mode = "add-confirm";
  void tick().then(() => document.querySelector<HTMLInputElement>("#project-name")?.select());
}

async function refreshRepositories() {
  if (scanning) return;
  scanning = true;
  localIssue = "";
  try {
    await store.refreshWorkspaceSources();
  } finally {
    scanning = false;
  }
}

async function addProject() {
  if (busy || !selectedSource || !projectName.trim()) return;
  busy = true;
  localIssue = "";
  try {
    const result = await addCoordinator.add(
      selectedSource,
      projectName,
      product.workspaces.map((workspace) => workspace.key),
    );
    optimisticProject = {
      ...result.project,
      binding: result.connection === "requested"
        ? { state: "preparing", message: "Preparing Project…" }
        : {
            state: "attention_required",
            message: "Quest Engineering couldn't connect this repository.",
            issue: { code: "connection_request_failed" },
          },
    };
    selectedId = result.project.id;
    reconnectProject = null;
    mode = "detail";
    if (result.connection === "issue")
      localIssue = "The Project was added, but its repository connection needs attention. The Project will not be created again.";
    await store.refreshProduct();
  } catch {
    localIssue = "Quest Engineering couldn't add this Project. Check the Project name and try again.";
  } finally {
    busy = false;
  }
}

async function reconnect() {
  if (busy || !selectedSource || !reconnectProject) return;
  busy = true;
  localIssue = "";
  try {
    const result = await addCoordinator.reconnect(selectedSource.candidate_id);
    optimisticProject = {
      ...reconnectProject,
      binding: result.connection === "requested"
        ? { state: "preparing", message: "Preparing Project…" }
        : {
            state: "attention_required",
            message: "Quest Engineering couldn't connect this repository.",
            issue: { code: "connection_request_failed" },
          },
    };
    selectedId = reconnectProject.id;
    reconnectProject = null;
    mode = "detail";
    if (result.connection === "issue")
      localIssue = "The connection request didn't complete. Refresh repositories and reconnect this same Project.";
    await store.refreshProduct();
  } finally {
    busy = false;
  }
}

function startEdit(workspace: Workspace) {
  editName = workspace.name;
  mode = "edit";
  localIssue = "";
}

async function saveName() {
  if (busy || !selectedProject || !editName.trim()) return;
  busy = true;
  localIssue = "";
  try {
    await store.api.updateWorkspace(selectedProject.id, { name: editName.trim() });
    await store.refreshProduct();
    mode = "detail";
  } catch {
    localIssue = "Quest Engineering couldn't save that Project name.";
  } finally {
    busy = false;
  }
}

function openArchiveDialog() {
  if (!selectedProject || archiveDialog?.open) return;
  archiveDialog.showModal();
}

async function archiveProject() {
  if (busy || !selectedProject) return;
  busy = true;
  localIssue = "";
  try {
    await store.api.archiveWorkspace(selectedProject.id);
    archiveDialog.close();
    await store.refreshProduct();
    selectedId = product.workspaces.find((workspace) => workspace.id !== selectedProject?.id)?.id ?? null;
    mode = "detail";
  } catch {
    archiveDialog.close();
    localIssue = "Quest Engineering couldn't archive this Project.";
  } finally {
    busy = false;
    await tick();
    archiveTrigger?.focus();
  }
}

function sourceIsCompatible(workspace: Workspace, source: WorkspaceSource): boolean {
  if (source.source_kind !== workspace.source_kind) return false;
  return !workspace.source_fingerprint ||
    workspace.source_fingerprint === source.source_fingerprint;
}
</script>

<aside class="projects-window panel" aria-labelledby="projects-title">
  <header class="window-header">
    <div>
      <span class="window-kicker">Repository wayfinder</span>
      <h1 id="projects-title">Projects</h1>
    </div>
    <button class="icon-button" type="button" aria-label="Close Projects" on:click={onClose}>×</button>
  </header>

  <div class="window-body">
    <section class="project-browser" aria-labelledby="your-projects-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Quest destinations</span>
          <h2 id="your-projects-title">Your Projects</h2>
        </div>
        <button class="primary compact" type="button" on:click={() => beginAdd()}>+ Add Project</button>
      </div>

      {#if product.workspaces.length}
        <label class="search-field">
          <span class="sr-only">Search projects and repositories</span>
          <span aria-hidden="true">⌕</span>
          <input bind:value={projectSearch} placeholder="Search Projects…" />
        </label>
        <div class="project-list" aria-label="Projects">
          {#each visibleProjects as workspace}
            {@const status = projectStatus(workspace.binding.state)}
            <button
              type="button"
              class:selected={selectedId === workspace.id && mode === "detail"}
              class="project-card"
              aria-pressed={selectedId === workspace.id && mode === "detail"}
              on:click={() => selectProject(workspace)}
            >
              <strong>{workspace.name}</strong>
              <span class="repository-name">{projectRepositoryIdentity(workspace, product.workspaceSources)}</span>
              <span class="status {status.tone}"><span aria-hidden="true">{status.icon}</span> {status.shortLabel}</span>
            </button>
          {:else}
            <p class="no-results">No Projects match that search.</p>
          {/each}
        </div>
      {:else}
        <div class="empty-state list-empty">
          <span class="empty-icon" aria-hidden="true">⌂</span>
          <h3>No Projects yet</h3>
          <p>Add a repository so Quest Engineering knows where your Quests should work.</p>
          <button class="primary" type="button" on:click={() => beginAdd()}>Add Project</button>
        </div>
      {/if}
    </section>

    <section class="project-content" aria-live="polite">
      {#if localIssue}<div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>{/if}

      {#if mode === "add-select" || mode === "reconnect"}
        <div class="content-heading">
          <button class="back-button" type="button" on:click={() => { mode = "detail"; reconnectProject = null; }}>← Projects</button>
          <span class="eyebrow">{mode === "reconnect" ? "Restore connection" : "New Project"}</span>
          <h2>{mode === "reconnect" ? "Reconnect Project" : "Add Project"}</h2>
          <p>{mode === "reconnect" ? `Choose the repository for ${reconnectProject?.name ?? "this Project"}.` : "Choose a repository available to Quest Engineering."}</p>
        </div>
        <div class="repository-tools">
          <label class="search-field">
            <span class="sr-only">Search repositories</span>
            <span aria-hidden="true">⌕</span>
            <input bind:value={repositorySearch} placeholder="Search repositories…" />
          </label>
          <button class="secondary refresh" type="button" disabled={scanning} on:click={refreshRepositories}>
            <span aria-hidden="true">↻</span> {scanning ? "Scanning…" : "Refresh repositories"}
          </button>
        </div>
        {#if compatibleSources.length}
          <div class="repository-list" aria-label="Available repositories">
            {#each compatibleSources as source}
              <button
                type="button"
                class:selected={selectedSourceId === source.candidate_id}
                class="repository-card"
                on:click={() => chooseSource(source)}
              >
                <span class="repo-copy"><strong>{defaultProjectName(source)}</strong><span>{sourceIdentity(source)}</span></span>
                <span class="available"><span aria-hidden="true">●</span> Available</span>
              </button>
            {/each}
          </div>
          {#if mode === "reconnect" && selectedSource}
            <footer class="action-row">
              <button class="secondary" type="button" on:click={() => { mode = "detail"; reconnectProject = null; }}>Cancel</button>
              <button class="primary" type="button" disabled={busy} on:click={reconnect}>{busy ? "Connecting…" : "Reconnect Project"}</button>
            </footer>
          {/if}
        {:else}
          <div class="empty-state">
            <span class="empty-icon" aria-hidden="true">⌕</span>
            <h3>No repositories found</h3>
            <p>Make sure a Worker is online and has a project folder configured.</p>
            <button class="secondary" type="button" disabled={scanning} on:click={refreshRepositories}>{scanning ? "Refreshing…" : "Refresh"}</button>
          </div>
        {/if}
      {:else if mode === "add-confirm" && selectedSource}
        <div class="content-heading">
          <button class="back-button" type="button" on:click={() => mode = "add-select"}>← Repositories</button>
          <span class="eyebrow">Almost there</span>
          <h2>Name your Project</h2>
          <p>Use the suggested name or make it friendlier for your team.</p>
        </div>
        <form class="name-form" on:submit|preventDefault={addProject}>
          <label for="project-name">Project name</label>
          <input id="project-name" bind:value={projectName} required maxlength="160" />
          <div class="repository-summary">
            <span class="summary-icon" aria-hidden="true">⌂</span>
            <span><small>Repository</small><strong>{sourceIdentity(selectedSource)}</strong></span>
            <span class="available"><span aria-hidden="true">●</span> Available</span>
          </div>
          <footer class="action-row">
            <button class="secondary" type="button" on:click={() => mode = "add-select"}>Cancel</button>
            <button class="primary" disabled={busy || !projectName.trim()}>{busy ? "Adding Project…" : "Add Project"}</button>
          </footer>
        </form>
      {:else if mode === "edit" && selectedProject}
        <div class="content-heading">
          <button class="back-button" type="button" on:click={() => mode = "detail"}>← Project</button>
          <span class="eyebrow">Project settings</span>
          <h2>Edit Project</h2>
          <p>The repository association and Project key remain unchanged.</p>
        </div>
        <form class="name-form" on:submit|preventDefault={saveName}>
          <label for="edit-project-name">Display name</label>
          <input id="edit-project-name" bind:value={editName} required maxlength="160" />
          <footer class="action-row">
            <button class="secondary" type="button" on:click={() => mode = "detail"}>Cancel</button>
            <button class="primary" disabled={busy || !editName.trim()}>{busy ? "Saving…" : "Save"}</button>
          </footer>
        </form>
      {:else if selectedProject}
        {@const status = projectStatus(selectedProject.binding.state)}
        <article class="project-detail">
          <span class="eyebrow">Project</span>
          <h2>{selectedProject.name}</h2>
          <p class="detail-repository">{projectRepositoryIdentity(selectedProject, product.workspaceSources)}</p>

          <section class="status-panel {status.tone}">
            <div class="status-title"><span aria-hidden="true">{status.icon}</span><strong>{status.detailLabel}</strong></div>
            <p>{status.description}</p>
            {#if selectedProject.binding.state === "attention_required" || selectedProject.binding.state === "unbound"}
              <button class="primary" type="button" on:click={() => beginReconnect(selectedProject)}>Reconnect Project</button>
            {/if}
          </section>

          <details class="diagnostics" open={scene === "advanced"}>
            <summary>Advanced diagnostics</summary>
            <dl>
              <div><dt>Project key</dt><dd><code>{selectedProject.key}</code><small>Immutable</small></dd></div>
              <div><dt>Source kind</dt><dd>{selectedProject.source_kind === "local_git" ? "Local Git repository" : "Git remote"}</dd></div>
              {#if selectedProject.source_fingerprint}<div><dt>Repository fingerprint</dt><dd><code>{selectedProject.source_fingerprint}</code></dd></div>{/if}
              <div><dt>Connection state</dt><dd>{status.shortLabel}</dd></div>
              {#if selectedProject.binding.issue}<div><dt>Diagnostic code</dt><dd><code>{selectedProject.binding.issue.code}</code></dd></div>{/if}
            </dl>
          </details>

          <footer class="detail-actions">
            <button class="secondary" type="button" on:click={() => startEdit(selectedProject)}>Edit</button>
            <button bind:this={archiveTrigger} class="destructive-link" type="button" on:click={openArchiveDialog}>Archive</button>
          </footer>
        </article>
      {:else if product.workspaces.length}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">↖</span><h3>Choose a Project</h3><p>Select a Project to view its readiness and details.</p></div>
      {:else}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">✦</span><h3>A place for every Quest</h3><p>Your first Project starts with a repository.</p><button class="primary" type="button" on:click={() => beginAdd()}>Add Project</button></div>
      {/if}
    </section>
  </div>

  <dialog bind:this={archiveDialog} aria-labelledby="archive-title" on:close={() => archiveTrigger?.focus()}>
    <form method="dialog" class="dialog-card" on:submit|preventDefault>
      <span class="dialog-icon" aria-hidden="true">!</span>
      <h2 id="archive-title">Archive {selectedProject?.name}?</h2>
      <p>Existing Quest and Run history remains available. New Quests will no longer use this Project.</p>
      <footer class="action-row">
        <button class="secondary" type="button" on:click={() => archiveDialog.close()}>Cancel</button>
        <button class="destructive" type="button" disabled={busy} on:click={archiveProject}>{busy ? "Archiving…" : "Archive Project"}</button>
      </footer>
    </form>
  </dialog>
</aside>

<style>
  .projects-window {
    --app-cream: #fff4d8;
    --app-paper: #f7e7c4;
    --app-paper-soft: #ecd3a7;
    --app-ink: #29373a;
    --app-muted: #68756e;
    --app-wood: #75513e;
    --app-wood-dark: #4b352e;
    --app-teal: #4c8179;
    --app-teal-dark: #35645f;
    --app-green: #4f8a61;
    --app-amber: #c68738;
    --app-coral: #bd5d55;
    position: absolute;
    z-index: 8;
    top: 4.4rem;
    right: 1rem;
    width: min(56rem, calc(100vw - 2rem));
    max-height: calc(100vh - 5.4rem);
    overflow: hidden;
    padding: 0;
    color: var(--app-ink);
    background: var(--app-cream);
    border: 2px solid var(--app-wood);
    border-radius: 14px;
    box-shadow: 0 18px 48px #24383266, inset 0 0 0 2px #fff9e8aa;
  }
  button, input { font: inherit; }
  button { min-height: 2.6rem; border-radius: 8px; }
  button:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid #e2a84e; outline-offset: 2px; }
  .window-header { display: flex; align-items: center; min-height: 5rem; padding: .9rem 1.2rem; color: #fff6de; background: linear-gradient(135deg, var(--app-wood), var(--app-wood-dark)); border-bottom: 3px solid #d9a75f; }
  .window-header > div { flex: 1; }
  .window-kicker, .eyebrow { color: #806d58; font-size: .7rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .window-kicker { color: #ead8b6; }
  h1, h2, h3, p { text-shadow: none; }
  h1 { margin: .05rem 0 0; font: 700 1.8rem Georgia, ui-serif, serif; }
  h2, h3 { color: var(--app-ink); }
  .window-header h1 { color: #fff6de; }
  .icon-button { width: 2.75rem; padding: 0; color: #fff4d7; background: #5b4035; border: 1px solid #d7b67c; font-size: 1.6rem; }
  .window-body { display: grid; grid-template-columns: minmax(17rem, .78fr) minmax(24rem, 1.22fr); min-height: 34rem; max-height: calc(100vh - 10.4rem); }
  .project-browser, .project-content { overflow: auto; overscroll-behavior: contain; }
  .project-browser { padding: 1.2rem; background: var(--app-paper-soft); border-right: 1px solid #c9aa7b; }
  .project-content { padding: 2rem; background: linear-gradient(145deg, #fff8e7, var(--app-cream)); }
  .section-heading { display: flex; align-items: center; gap: .7rem; margin-bottom: 1rem; }
  .section-heading > div { flex: 1; }
  .section-heading h2 { margin: .15rem 0 0; font: 700 1.25rem Georgia, ui-serif, serif; }
  .primary, .secondary, .destructive { padding: .62rem 1rem; border: 1px solid transparent; font-weight: 750; }
  .primary { color: #fff9e9; background: linear-gradient(#5d9670, #477c5a); border-color: #356447; box-shadow: 0 2px 5px #3d583c33; }
  .primary:hover { background: #3f7353; }
  .secondary { color: #5b4b3e; background: #fff8e8; border-color: #b99a70; box-shadow: none; }
  .secondary:hover { background: #f3dfbb; }
  .compact { min-height: 2.35rem; padding: .45rem .7rem; font-size: .82rem; }
  button:disabled { cursor: wait; opacity: .58; }
  .search-field { display: flex; align-items: center; gap: .45rem; margin: 0 0 .9rem; padding: 0 .75rem; color: #80684e; background: #fff8e7; border: 1px solid #c5aa80; border-radius: 9px; }
  .search-field input { min-height: 2.6rem; padding: .6rem 0; color: var(--app-ink); background: transparent; border: 0; outline: 0; }
  .project-list, .repository-list { display: grid; gap: .65rem; }
  .project-card, .repository-card { display: grid; width: 100%; padding: .9rem; text-align: left; color: var(--app-ink); background: #fff7df; border: 1px solid #c5a97b; box-shadow: 0 3px 9px #70583f16; }
  .project-card:hover, .repository-card:hover { background: #fffbed; border-color: var(--app-teal); transform: translateY(-1px); }
  .project-card.selected { color: #fff9e9; background: linear-gradient(135deg, #578a82, var(--app-teal)); border-color: var(--app-teal-dark); box-shadow: inset 4px 0 #e3b35e, 0 5px 12px #355e5438; }
  .project-card strong { font: 700 1rem Georgia, ui-serif, serif; }
  .repository-name { margin: .18rem 0 .65rem; color: #6a7069; font-size: .8rem; }
  .project-card.selected .repository-name { color: #e4efe9; }
  .status { display: flex; align-items: center; gap: .35rem; width: fit-content; font-size: .75rem; font-weight: 800; }
  .status.ready, .available { color: #3e7951; }
  .status.preparing { color: #9b691f; }
  .status.offline, .status.unbound { color: #68756e; }
  .status.attention { color: #a54d49; }
  .project-card.selected .status { color: #fff4ce; }
  .content-heading { margin-bottom: 1.5rem; }
  .content-heading h2, .project-detail h2 { margin: .25rem 0 .25rem; font: 700 2rem Georgia, ui-serif, serif; }
  .content-heading p { margin: .2rem 0; color: var(--app-muted); line-height: 1.5; }
  .back-button, .destructive-link { min-height: auto; margin: 0 0 1.4rem; padding: .2rem 0; color: var(--app-teal-dark); background: transparent; border: 0; box-shadow: none; font-weight: 750; }
  .repository-tools { display: grid; grid-template-columns: 1fr auto; gap: .7rem; margin-bottom: 1rem; }
  .repository-tools .search-field { margin: 0; }
  .refresh { white-space: nowrap; }
  .repository-card { grid-template-columns: 1fr auto; align-items: center; gap: 1rem; padding: 1rem; }
  .repository-card.selected { background: #e4f0e7; border: 2px solid var(--app-teal); box-shadow: inset 4px 0 var(--app-teal); }
  .repo-copy { display: grid; gap: .25rem; }
  .repo-copy strong { font: 700 1rem Georgia, ui-serif, serif; }
  .repo-copy span { color: var(--app-muted); font-size: .85rem; }
  .available { font-size: .76rem; font-weight: 800; white-space: nowrap; }
  .name-form { display: grid; gap: .55rem; }
  .name-form label { color: #5a4d42; font-size: .82rem; font-weight: 800; }
  .name-form > input { min-height: 3rem; padding: .7rem .8rem; color: var(--app-ink); background: #fffdf6; border: 1px solid #bfa37a; border-radius: 8px; box-shadow: inset 0 1px 2px #59422d16; }
  .repository-summary { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .8rem; margin-top: .8rem; padding: 1rem; background: #efe0bf; border-radius: 10px; }
  .repository-summary > span:nth-child(2) { display: grid; gap: .18rem; }
  .repository-summary small { color: var(--app-muted); font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; }
  .summary-icon, .empty-icon { color: var(--app-teal); font-size: 1.5rem; }
  .action-row { display: flex; justify-content: flex-end; gap: .65rem; margin-top: 1.4rem; }
  .detail-repository { margin: 0 0 1.6rem; color: var(--app-muted); font-size: 1rem; }
  .status-panel { padding: 1.2rem 1.3rem; background: #edf2e6; border-left: 5px solid var(--app-green); border-radius: 8px; }
  .status-panel.preparing { background: #fff0cf; border-color: var(--app-amber); }
  .status-panel.offline, .status-panel.unbound { background: #ede9df; border-color: #849086; }
  .status-panel.attention { background: #f7dfd7; border-color: var(--app-coral); }
  .status-title { display: flex; align-items: center; gap: .55rem; font: 700 1.05rem Georgia, ui-serif, serif; }
  .status-panel p { margin: .55rem 0 0; color: #50605b; line-height: 1.55; }
  .status-panel .primary { margin-top: 1rem; }
  .diagnostics { margin-top: 1.5rem; border-top: 1px solid #d7c5a5; border-bottom: 1px solid #d7c5a5; }
  .diagnostics summary { padding: .9rem 0; color: #5b554b; cursor: pointer; font-weight: 750; }
  .diagnostics dl { display: grid; gap: .75rem; margin: 0 0 1rem; }
  .diagnostics dl > div { display: grid; grid-template-columns: 8rem 1fr; gap: .7rem; }
  .diagnostics dt { color: var(--app-muted); font-size: .78rem; }
  .diagnostics dd { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0; overflow-wrap: anywhere; }
  .diagnostics code { color: #35494a; font: .78rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .diagnostics small { color: var(--app-muted); font-size: .7rem; }
  .detail-actions { display: flex; align-items: center; gap: .8rem; margin-top: 1.5rem; }
  .destructive-link { margin: 0 0 0 auto; color: #a74f49; }
  .friendly-error { display: flex; gap: .7rem; margin-bottom: 1rem; padding: .75rem .9rem; color: #7b3c38; background: #f8ded5; border-left: 4px solid var(--app-coral); border-radius: 6px; }
  .friendly-error p { margin: 0; line-height: 1.45; }
  .empty-state { display: grid; justify-items: center; padding: 2.5rem 1rem; text-align: center; color: var(--app-muted); }
  .empty-state h3 { margin: .6rem 0 .2rem; font: 700 1.25rem Georgia, ui-serif, serif; }
  .empty-state p { max-width: 23rem; margin: .2rem 0 1.1rem; line-height: 1.5; }
  .list-empty { padding: 3rem .5rem; }
  .detail-empty { min-height: 24rem; align-content: center; }
  .no-results { color: var(--app-muted); font-size: .85rem; }
  dialog { width: min(29rem, calc(100vw - 2rem)); padding: 0; color: var(--app-ink); background: var(--app-cream); border: 2px solid var(--app-wood); border-radius: 12px; box-shadow: 0 22px 70px #1d2826aa; }
  dialog::backdrop { background: #24333099; backdrop-filter: blur(2px); }
  .dialog-card { display: grid; justify-items: center; padding: 2rem; text-align: center; }
  .dialog-icon { display: grid; place-items: center; width: 2.8rem; height: 2.8rem; color: #fff9e8; background: var(--app-coral); border-radius: 50%; font-weight: 900; }
  .dialog-card h2 { margin: .8rem 0 .35rem; font: 700 1.5rem Georgia, ui-serif, serif; }
  .dialog-card p { margin: 0; color: var(--app-muted); line-height: 1.55; }
  .destructive { color: white; background: var(--app-coral); border-color: #9b4743; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 1000px) {
    .projects-window { top: 4.8rem; width: min(50rem, calc(100vw - 1rem)); max-height: calc(100vh - 5.3rem); right: .5rem; }
    .window-body { grid-template-columns: minmax(15rem, .75fr) minmax(20rem, 1.25fr); max-height: calc(100vh - 10.3rem); }
    .project-content { padding: 1.4rem; }
  }
  @media (max-width: 720px) {
    .projects-window { left: .4rem; right: .4rem; width: auto; }
    .window-body { display: block; overflow: auto; }
    .project-browser, .project-content { overflow: visible; }
    .project-browser { border-right: 0; border-bottom: 1px solid #c9aa7b; }
    .project-content { min-height: 24rem; }
    .repository-tools { grid-template-columns: 1fr; }
    .repository-card { grid-template-columns: 1fr; }
    .available { justify-self: start; }
  }
</style>
