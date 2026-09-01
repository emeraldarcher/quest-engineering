<script context="module" lang="ts">
let rememberedClassId: string | null = null;
</script>

<script lang="ts">
import { get } from "svelte/store";
import { onMount, tick } from "svelte";
import type { ApiError, ClassDefinition } from "../../api/contracts";
import type { AppStore, ProductState } from "../../state/app-store";
import "../management/management-window.css";
import { createClassWithGeneratedKey } from "./class-creation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let scene: string | null = null;

type Mode = "detail" | "create" | "edit";
type Draft = { name: string; description: string; instructions: string };
type DraftErrors = Partial<Record<keyof Draft, string>>;

let mode: Mode = "detail";
let selectedId: string | null = null;
let draft: Draft = emptyDraft();
let fieldErrors: DraftErrors = {};
let localIssue = "";
let busy = false;
let initialized = false;
let suppressDefaultSelection = false;
let advancedOpen = false;
let windowElement: HTMLElement;
let archiveDialog: HTMLDialogElement;
let archiveTrigger: HTMLButtonElement;
let archiveCancel: HTMLButtonElement;
let dirtyDialog: HTMLDialogElement;
let dirtyKeepButton: HTMLButtonElement;
let dirtyReturnFocus: HTMLElement | null = null;
let pendingContinuation: (() => void) | null = null;

$: selectedClass =
  product.classes.find((classDefinition) => classDefinition.id === selectedId) ??
  null;
$: if (
  initialized &&
  mode === "detail" &&
  !product.classes.some((item) => item.id === selectedId) &&
  product.classes.length > 0 &&
  !suppressDefaultSelection
) {
  ensureDefaultSelection(product.classes);
}
$: selectedUsage = selectedClass ? usageCount(selectedClass.id) : 0;

onMount(async () => {
  initialized = true;
  const preferred =
    product.classes.find((item) => item.id === rememberedClassId) ??
    product.classes[0] ??
    null;
  selectedId = preferred?.id ?? null;

  if (scene === "list") {
    suppressDefaultSelection = true;
    selectedId = null;
  } else if (scene === "builder") {
    selectedId = product.classes.find((item) => item.key === "builder")?.id ?? selectedId;
  } else if (scene === "reviewer") {
    selectedId = product.classes.find((item) => item.key === "reviewer")?.id ?? selectedId;
  } else if (scene === "new") {
    startCreate();
  } else if (scene === "edit") {
    if (preferred) startEdit(preferred);
  } else if (scene === "advanced") {
    advancedOpen = true;
  } else if (scene === "archive") {
    await tick();
    openArchiveDialog();
  } else if (scene === "dirty" && preferred) {
    startEdit(preferred);
    draft = { ...draft, description: `${draft.description} Unsaved revision.` };
    await tick();
    requestLeave(() => undefined);
  }
});

function ensureDefaultSelection(classes: ClassDefinition[]) {
  selectedId =
    classes.find((item) => item.id === rememberedClassId)?.id ??
    classes[0]?.id ??
    null;
}

function emptyDraft(): Draft {
  return { name: "", description: "", instructions: "" };
}

function usageCount(classId: string): number {
  return product.squads.reduce(
    (count, squad) =>
      count + squad.members.filter((member) => member.class_id === classId).length,
    0,
  );
}

function usageLabel(count: number): string {
  return `Used by ${count} active Squad ${count === 1 ? "Member" : "Members"}`;
}

function selectClass(classDefinition: ClassDefinition) {
  requestTransition(() => {
    selectedId = classDefinition.id;
    rememberedClassId = classDefinition.id;
    mode = "detail";
    advancedOpen = false;
    clearIssues();
  });
}

function startCreate() {
  mode = "create";
  draft = emptyDraft();
  advancedOpen = false;
  clearIssues();
  void focusField("class-name");
}

function beginCreate() {
  requestTransition(startCreate);
}

function startEdit(classDefinition: ClassDefinition) {
  selectedId = classDefinition.id;
  rememberedClassId = classDefinition.id;
  mode = "edit";
  draft = {
    name: classDefinition.name,
    description: classDefinition.description,
    instructions: classDefinition.instructions,
  };
  clearIssues();
  void focusField("class-name");
}

function cancelForm() {
  mode = "detail";
  clearIssues();
  void tick().then(() =>
    windowElement
      ?.querySelector<HTMLButtonElement>(`[data-class-id="${selectedId}"]`)
      ?.focus(),
  );
}

function clearIssues() {
  fieldErrors = {};
  localIssue = "";
}

function isDirty(): boolean {
  if (mode === "create") return Object.values(draft).some((value) => value !== "");
  if (mode !== "edit" || !selectedClass) return false;
  return (
    draft.name !== selectedClass.name ||
    draft.description !== selectedClass.description ||
    draft.instructions !== selectedClass.instructions
  );
}

function requestTransition(continuation: () => void) {
  requestLeave(continuation);
}

export function requestLeave(continuation: () => void) {
  if (!isDirty() || !dirtyDialog) {
    continuation();
    return;
  }
  pendingContinuation = continuation;
  dirtyReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!dirtyDialog.open) dirtyDialog.showModal();
  void tick().then(() => dirtyKeepButton?.focus());
}

function keepEditing() {
  pendingContinuation = null;
  dirtyDialog.close();
  void tick().then(() => dirtyReturnFocus?.focus());
}

function discardAndContinue() {
  const continuation = pendingContinuation;
  pendingContinuation = null;
  dirtyDialog.close();
  continuation?.();
}

async function saveAndContinue() {
  const continuation = pendingContinuation;
  pendingContinuation = null;
  dirtyDialog.close();
  if (await saveClass()) continuation?.();
}

function validateDraft(): boolean {
  const errors: DraftErrors = {};
  if (!draft.name.trim()) errors.name = "Enter a Class name.";
  if (!draft.instructions.trim())
    errors.instructions = "Add instructions for this Class.";
  fieldErrors = errors;
  if (Object.keys(errors).length === 0) return true;
  localIssue = "Review the highlighted fields and try again.";
  void focusField(errors.name ? "class-name" : "class-instructions");
  return false;
}

async function saveClass(): Promise<boolean> {
  if (busy || !validateDraft()) return false;
  busy = true;
  clearIssues();
  const input = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
  };

  try {
    const saved =
      mode === "edit" && selectedClass
        ? await store.command(() => store.api.updateClass(selectedClass.id, input))
        : await store.command(() =>
            createClassWithGeneratedKey(
              store.api,
              input,
              product.classes.map((item) => item.key),
            ),
          );
    if (!saved) {
      applyServerError(get(store.error));
      return false;
    }

    selectedId = saved.id;
    rememberedClassId = saved.id;
    mode = "detail";
    await store.refreshProduct();
    return true;
  } finally {
    busy = false;
  }
}

function applyServerError(failure: ApiError | null) {
  const errors: DraftErrors = {};
  for (const detail of failure?.details ?? []) {
    if (detail.path[0] === "name") errors.name = "Enter a valid Class name.";
    if (detail.path[0] === "description")
      errors.description = "Enter a valid short description.";
    if (detail.path[0] === "instructions")
      errors.instructions = "Add valid instructions for this Class.";
  }
  fieldErrors = errors;
  localIssue =
    Object.keys(errors).length > 0
      ? "Review the highlighted fields and try again."
      : mode === "create"
        ? "Quest Engineering couldn't create that Class. Try a different name."
        : "Quest Engineering couldn't save those Class changes.";
}

async function focusField(id: string) {
  await tick();
  windowElement?.querySelector<HTMLElement>(`#${id}`)?.focus();
}

function openArchiveDialog() {
  if (!selectedClass || archiveDialog?.open) return;
  archiveDialog.showModal();
  void tick().then(() => archiveCancel?.focus());
}

async function archiveClass() {
  if (busy || !selectedClass) return;
  busy = true;
  clearIssues();
  const archivedId = selectedClass.id;
  const nextId = product.classes.find((item) => item.id !== archivedId)?.id ?? null;
  const archived = await store.command(() => store.api.archiveClass(archivedId));
  archiveDialog.close();
  if (archived) {
    if (rememberedClassId === archivedId) rememberedClassId = nextId;
    selectedId = nextId;
    mode = "detail";
    await store.refreshProduct();
    await tick();
    windowElement?.querySelector<HTMLButtonElement>(".class-card")?.focus();
  } else {
    localIssue = "Quest Engineering couldn't archive this Class.";
    await tick();
    archiveTrigger?.focus();
  }
  busy = false;
}
</script>

<aside
  bind:this={windowElement}
  class="guild-window management-window management-window-shell panel"
  aria-labelledby="guild-title"
>
  <header class="window-header">
    <div>
      <span class="window-kicker">Professions and roles</span>
      <h1 id="guild-title">Guild Hall</h1>
    </div>
    <button class="icon-button" type="button" aria-label="Close Guild Hall" on:click={onClose}>×</button>
  </header>

  <div class="window-body">
    <section class="class-browser" aria-labelledby="classes-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Guild professions</span>
          <h2 id="classes-title">Classes</h2>
        </div>
        <button class="primary compact" type="button" on:click={beginCreate}>+ New Class</button>
      </div>

      {#if product.classes.length}
        <div class="class-list" aria-label="Classes">
          {#each product.classes as classDefinition}
            {@const count = usageCount(classDefinition.id)}
            <button
              type="button"
              class="class-card"
              class:selected={selectedId === classDefinition.id && mode !== "create"}
              aria-pressed={selectedId === classDefinition.id && mode !== "create"}
              data-class-id={classDefinition.id}
              on:click={() => selectClass(classDefinition)}
            >
              <span class="card-heading"><strong>{classDefinition.name}</strong><span aria-hidden="true">✦</span></span>
              <span class="card-description">{classDefinition.description || "No description yet."}</span>
              <span class="card-usage">{usageLabel(count)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="browser-empty">
          <span aria-hidden="true">✦</span>
          <p>No professions have been defined.</p>
        </div>
      {/if}
    </section>

    <section class="class-content" aria-live="polite">
      {#if localIssue}
        <div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>
      {/if}

      {#if mode === "create"}
        <div class="content-heading">
          <span class="eyebrow">New profession</span>
          <h2>Create Class</h2>
          <p>Define the behavioral role an agent can play in your guild.</p>
        </div>
        <form class="class-form" on:submit|preventDefault={saveClass}>
          <label for="class-name">Name</label>
          <input
            id="class-name"
            bind:value={draft.name}
            required
            maxlength="160"
            aria-invalid={fieldErrors.name ? "true" : undefined}
            aria-describedby={fieldErrors.name ? "class-name-error" : undefined}
          />
          {#if fieldErrors.name}<small id="class-name-error" class="field-error">{fieldErrors.name}</small>{/if}

          <label for="class-description">Description <span>Short, human-facing summary</span></label>
          <textarea
            id="class-description"
            class="description-editor"
            bind:value={draft.description}
            rows="2"
            aria-invalid={fieldErrors.description ? "true" : undefined}
            aria-describedby={fieldErrors.description ? "class-description-error" : undefined}
          ></textarea>
          {#if fieldErrors.description}<small id="class-description-error" class="field-error">{fieldErrors.description}</small>{/if}

          <label for="class-instructions">Instructions <span>The behavioral guidance for this role</span></label>
          <textarea
            id="class-instructions"
            class="instructions-editor"
            bind:value={draft.instructions}
            rows="8"
            required
            aria-invalid={fieldErrors.instructions ? "true" : undefined}
            aria-describedby={fieldErrors.instructions ? "class-instructions-error" : undefined}
          ></textarea>
          {#if fieldErrors.instructions}<small id="class-instructions-error" class="field-error">{fieldErrors.instructions}</small>{/if}

          <footer class="action-row">
            <button class="secondary" type="button" on:click={cancelForm}>Cancel</button>
            <button class="primary" disabled={busy}>{busy ? "Creating…" : "Create Class"}</button>
          </footer>
        </form>
      {:else if mode === "edit" && selectedClass}
        <div class="content-heading">
          <span class="eyebrow">Class settings</span>
          <h2>Edit {selectedClass.name}</h2>
          <p>Update this role's description and behavioral guidance.</p>
        </div>
        <form class="class-form" on:submit|preventDefault={saveClass}>
          <label for="class-name">Name</label>
          <input
            id="class-name"
            bind:value={draft.name}
            required
            maxlength="160"
            aria-invalid={fieldErrors.name ? "true" : undefined}
            aria-describedby={fieldErrors.name ? "class-name-error" : undefined}
          />
          {#if fieldErrors.name}<small id="class-name-error" class="field-error">{fieldErrors.name}</small>{/if}

          <label for="class-description">Description <span>Short, human-facing summary</span></label>
          <textarea
            id="class-description"
            class="description-editor"
            bind:value={draft.description}
            rows="2"
            aria-invalid={fieldErrors.description ? "true" : undefined}
            aria-describedby={fieldErrors.description ? "class-description-error" : undefined}
          ></textarea>
          {#if fieldErrors.description}<small id="class-description-error" class="field-error">{fieldErrors.description}</small>{/if}

          <label for="class-instructions">Instructions <span>The behavioral guidance for this role</span></label>
          <textarea
            id="class-instructions"
            class="instructions-editor"
            bind:value={draft.instructions}
            rows="8"
            required
            aria-invalid={fieldErrors.instructions ? "true" : undefined}
            aria-describedby={fieldErrors.instructions ? "class-instructions-error" : undefined}
          ></textarea>
          {#if fieldErrors.instructions}<small id="class-instructions-error" class="field-error">{fieldErrors.instructions}</small>{/if}

          <footer class="action-row">
            <button class="secondary" type="button" on:click={cancelForm}>Cancel</button>
            <button class="primary" disabled={busy}>{busy ? "Saving…" : "Save Changes"}</button>
          </footer>
        </form>
      {:else if selectedClass}
        <article class="class-detail">
          <span class="eyebrow">Class · Behavioral role</span>
          <h2>{selectedClass.name}</h2>
          <p class="detail-description">{selectedClass.description || "No description has been added yet."}</p>
          <p class="detail-usage">{usageLabel(selectedUsage)}</p>

          <section class="instructions-panel" aria-labelledby="instructions-title">
            <div class="instructions-heading">
              <span aria-hidden="true">✦</span>
              <h3 id="instructions-title">Instructions</h3>
            </div>
            <p>{selectedClass.instructions}</p>
          </section>

          <details class="advanced" bind:open={advancedOpen}>
            <summary>Advanced</summary>
            <dl>
              <div><dt>Class key</dt><dd><code>{selectedClass.key}</code><small>Immutable</small></dd></div>
            </dl>
          </details>

          <footer class="detail-actions">
            <button class="secondary" type="button" on:click={() => startEdit(selectedClass)}>Edit</button>
            <button bind:this={archiveTrigger} class="destructive-link" type="button" on:click={openArchiveDialog}>Archive</button>
          </footer>
        </article>
      {:else if product.classes.length}
        <div class="empty-state detail-empty">
          <span class="empty-icon" aria-hidden="true">↖</span>
          <h3>Choose a Class</h3>
          <p>Select a profession to read its description and instructions.</p>
        </div>
      {:else}
        <div class="empty-state detail-empty">
          <span class="empty-icon" aria-hidden="true">✦</span>
          <h3>No Classes yet</h3>
          <p>Classes define the roles your agents can play. Start with a Builder, Reviewer, or Architect.</p>
          <button class="primary" type="button" on:click={startCreate}>Create Class</button>
        </div>
      {/if}
    </section>
  </div>

  <dialog bind:this={archiveDialog} aria-labelledby="archive-title" on:close={() => archiveTrigger?.focus()}>
    <form method="dialog" class="dialog-card" on:submit|preventDefault>
      <span class="dialog-icon" aria-hidden="true">!</span>
      <h2 id="archive-title">Archive {selectedClass?.name}?</h2>
      <p>This Class will no longer be available for Squad configuration. Squads that still reference it cannot launch new Runs. Existing historical Runs are unaffected.</p>
      {#if selectedUsage > 0}<p class="dialog-usage">{usageLabel(selectedUsage)}</p>{/if}
      <footer class="action-row">
        <button bind:this={archiveCancel} class="secondary" type="button" on:click={() => archiveDialog.close()}>Cancel</button>
        <button class="destructive" type="button" disabled={busy} on:click={archiveClass}>{busy ? "Archiving…" : "Archive Class"}</button>
      </footer>
    </form>
  </dialog>

  <dialog
    bind:this={dirtyDialog}
    aria-labelledby="dirty-title"
    on:cancel={(event) => {
      event.preventDefault();
      keepEditing();
    }}
  >
    <form method="dialog" class="dialog-card" on:submit|preventDefault>
      <span class="dialog-icon unsaved" aria-hidden="true">✎</span>
      <h2 id="dirty-title">Unsaved changes</h2>
      <p>Save your Class changes, discard them, or keep editing.</p>
      <footer class="action-row dirty-actions">
        <button bind:this={dirtyKeepButton} class="secondary" type="button" on:click={keepEditing}>Keep Editing</button>
        <button class="destructive-link dialog-discard" type="button" on:click={discardAndContinue}>Discard</button>
        <button class="primary" type="button" disabled={busy} on:click={saveAndContinue}>Save</button>
      </footer>
    </form>
  </dialog>
</aside>

<style>
  .window-body {
    display: grid;
    grid-template-columns: minmax(17rem, 0.68fr) minmax(29rem, 1.32fr);
    min-height: 34rem;
    max-height: calc(100vh - 10.4rem);
  }
  .class-browser,
  .class-content {
    overflow: auto;
    overscroll-behavior: contain;
  }
  .class-browser {
    padding: 1.15rem;
    background: var(--app-paper-soft);
    border-right: 1px solid #c9aa7b;
  }
  .class-content {
    padding: 1.65rem 1.8rem;
    background: linear-gradient(145deg, #fff8e7, var(--app-cream));
  }
  .section-heading {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    margin-bottom: 1rem;
  }
  .section-heading > div {
    flex: 1;
  }
  .section-heading h2 {
    margin: 0.15rem 0 0;
    color: var(--app-ink);
    font: 700 1.25rem Georgia, ui-serif, serif;
  }
  .class-list {
    display: grid;
    gap: 0.65rem;
  }
  .class-card {
    display: grid;
    gap: 0.35rem;
    width: 100%;
    padding: 0.85rem 0.9rem;
    text-align: left;
    color: var(--app-ink);
    background: #fff7df;
    border: 1px solid #c5a97b;
    box-shadow: 0 3px 9px #70583f16;
  }
  .class-card:hover {
    background: #fffbed;
    border-color: var(--app-teal);
    transform: translateY(-1px);
  }
  .class-card.selected {
    color: #fff9e9;
    background: linear-gradient(135deg, #578a82, var(--app-teal));
    border-color: var(--app-teal-dark);
    box-shadow: inset 4px 0 #e3b35e, 0 5px 12px #355e5438;
  }
  .card-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .card-heading strong {
    flex: 1;
    font: 700 1rem Georgia, ui-serif, serif;
  }
  .card-heading > span {
    color: #b5843e;
    font-size: 0.8rem;
  }
  .card-description {
    color: #596660;
    font-size: 0.82rem;
    line-height: 1.35;
  }
  .card-usage {
    margin-top: 0.15rem;
    color: #64766e;
    font-size: 0.72rem;
    font-weight: 750;
  }
  .class-card.selected .card-description,
  .class-card.selected .card-usage {
    color: #e5efe9;
  }
  .class-card.selected .card-heading > span {
    color: #ffe5a7;
  }
  .browser-empty {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    padding: 3rem 0.5rem;
    color: var(--app-muted);
    text-align: center;
  }
  .browser-empty > span,
  .empty-icon {
    color: var(--app-teal);
    font-size: 1.5rem;
  }
  .browser-empty p {
    margin: 0;
    font-size: 0.85rem;
  }
  .content-heading {
    margin-bottom: 1.15rem;
  }
  .content-heading h2,
  .class-detail h2 {
    margin: 0.2rem 0 0.25rem;
    color: var(--app-ink);
    font: 700 2rem Georgia, ui-serif, serif;
  }
  .content-heading p {
    margin: 0.2rem 0;
    color: var(--app-muted);
    line-height: 1.45;
  }
  .class-detail {
    padding: 0;
    border: 0;
  }
  .detail-description {
    max-width: 38rem;
    margin: 0.2rem 0 0.35rem;
    color: #4c5b57;
    font-size: 1.02rem;
    line-height: 1.5;
  }
  .detail-usage {
    margin: 0 0 1.25rem;
    color: var(--app-teal-dark);
    font-size: 0.78rem;
    font-weight: 750;
  }
  .instructions-panel {
    padding: 1.05rem 1.15rem;
    background: #f2e1bd;
    border: 1px solid #d4b888;
    border-left: 5px solid var(--app-teal);
    border-radius: 9px;
    box-shadow: inset 0 1px #fff8e8;
  }
  .instructions-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid #ceb487;
  }
  .instructions-heading span {
    color: var(--app-teal-dark);
  }
  .instructions-heading h3 {
    margin: 0;
    color: var(--app-ink);
    font: 700 1.05rem Georgia, ui-serif, serif;
  }
  .instructions-panel p {
    margin: 0.8rem 0 0;
    color: #354744;
    line-height: 1.65;
    white-space: pre-wrap;
  }
  .advanced {
    margin-top: 1.25rem;
    border-top: 1px solid #d7c5a5;
    border-bottom: 1px solid #d7c5a5;
  }
  .advanced summary {
    padding: 0.8rem 0;
    color: #5b554b;
    cursor: pointer;
    font-weight: 750;
  }
  .advanced dl {
    margin: 0 0 0.9rem;
  }
  .advanced dl > div {
    display: grid;
    grid-template-columns: 7rem 1fr;
    gap: 0.7rem;
  }
  .advanced dt {
    color: var(--app-muted);
    font-size: 0.78rem;
  }
  .advanced dd {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .advanced code {
    color: #35494a;
    font: 0.78rem ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .advanced small {
    color: var(--app-muted);
    font-size: 0.7rem;
  }
  .detail-actions {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-top: 1.25rem;
  }
  .destructive-link {
    min-height: auto;
    margin: 0 0 0 auto;
    padding: 0.2rem 0;
    color: #a74f49;
    background: transparent;
    border: 0;
    box-shadow: none;
    font-weight: 750;
  }
  .class-form {
    display: grid;
    gap: 0.42rem;
  }
  .class-form label {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    margin: 0.35rem 0 0;
    color: #5a4d42;
    font-size: 0.82rem;
    font-weight: 800;
  }
  .class-form label span {
    color: var(--app-muted);
    font-size: 0.7rem;
    font-weight: 500;
  }
  .class-form input,
  .class-form textarea {
    width: 100%;
    padding: 0.65rem 0.75rem;
    color: var(--app-ink);
    background: #fffdf6;
    border: 1px solid #bfa37a;
    border-radius: 8px;
    box-shadow: inset 0 1px 2px #59422d16;
    resize: vertical;
  }
  .class-form input {
    min-height: 2.75rem;
  }
  .description-editor {
    min-height: 3.7rem;
    max-height: 7rem;
  }
  .instructions-editor {
    min-height: 9rem;
    max-height: 18rem;
    line-height: 1.5;
  }
  .class-form [aria-invalid="true"] {
    border-color: var(--app-coral);
    box-shadow: 0 0 0 2px #bd5d5522;
  }
  .field-error {
    color: #9b4743;
    font-size: 0.75rem;
  }
  .detail-empty {
    min-height: 24rem;
    align-content: center;
  }
  .dialog-usage {
    margin-top: 0.8rem !important;
    color: var(--app-teal-dark) !important;
    font-size: 0.78rem;
    font-weight: 750;
  }
  .dialog-icon.unsaved {
    background: var(--app-teal);
  }
  .dirty-actions {
    width: 100%;
  }
  .dialog-discard {
    margin: 0 auto 0 0;
  }
  @media (max-width: 1000px) {
    .window-body {
      grid-template-columns: minmax(15rem, 0.7fr) minmax(22rem, 1.3fr);
      max-height: calc(100vh - 10.3rem);
    }
    .class-content {
      padding: 1.25rem 1.35rem;
    }
    .instructions-editor {
      min-height: 7rem;
    }
  }
  @media (max-width: 720px) {
    .window-body {
      display: block;
      overflow: auto;
    }
    .class-browser,
    .class-content {
      overflow: visible;
    }
    .class-browser {
      border-right: 0;
      border-bottom: 1px solid #c9aa7b;
    }
    .class-list {
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    }
    .class-content {
      min-height: 23rem;
    }
  }
</style>
