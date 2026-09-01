<script context="module" lang="ts">
let rememberedLoadoutId: string | null = null;
</script>

<script lang="ts">
import { get } from "svelte/store";
import { onMount, tick } from "svelte";
import type {
  ApiError,
  ExecutionOption,
  Loadout,
  Reasoning,
  WorkspaceAccess,
} from "../../api/contracts";
import type { AppStore, ProductState } from "../../state/app-store";
import "../management/management-window.css";
import { createLoadoutWithGeneratedKey } from "./loadout-creation";
import {
  applyExecutionOption,
  customCapabilities,
  draftFromLoadout,
  emptyLoadoutDraft,
  loadoutInputFromDraft,
  replaceCustomCapabilities,
  toggleKnownCapability,
  type LoadoutDraft,
} from "./loadout-draft";
import {
  accessLabel,
  canonicalModel,
  isKnownCapability,
  knownCapabilities,
  knownCapability,
  modelIsDiscovered,
  modelLabel,
  modelRefKey,
  optionKey,
  presetLabel,
  providerLabel,
  reasoningLabel,
  uniqueModelOptions,
} from "./loadout-presentation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let scene: string | null = null;

type Mode = "detail" | "create" | "edit";
type DraftErrors = Partial<
  Record<"name" | "provider" | "model" | "tools", string>
>;

const reasoningChoices: Reasoning[] = ["low", "medium", "high"];
const accessChoices: WorkspaceAccess[] = ["none", "read_only", "read_write"];
let mode: Mode = "detail";
let selectedId: string | null = null;
let draft: LoadoutDraft = emptyLoadoutDraft();
let fieldErrors: DraftErrors = {};
let localIssue = "";
let busy = false;
let initialized = false;
let suppressDefaultSelection = false;
let advancedOpen = false;
let customOpen = false;
let customToolsText = "";
let selectedPresetKey = "";
let windowElement: HTMLElement;
let archiveDialog: HTMLDialogElement;
let archiveTrigger: HTMLButtonElement;
let archiveCancel: HTMLButtonElement;
let dirtyDialog: HTMLDialogElement;
let dirtyKeepButton: HTMLButtonElement;
let dirtyReturnFocus: HTMLElement | null = null;
let pendingContinuation: (() => void) | null = null;

$: selectedLoadout =
  product.loadouts.find((loadout) => loadout.id === selectedId) ?? null;
$: if (
  initialized &&
  mode === "detail" &&
  !product.loadouts.some((loadout) => loadout.id === selectedId) &&
  product.loadouts.length > 0 &&
  !suppressDefaultSelection
) {
  ensureDefaultSelection(product.loadouts);
}
$: selectedUsage = selectedLoadout ? usageCount(selectedLoadout.id) : 0;
$: modelChoices = uniqueModelOptions(product.executionOptions);
$: selectedPreset =
  product.executionOptions.find(
    (option) => optionKey(option) === selectedPresetKey,
  ) ?? null;
$: currentModelDiscovered =
  !!draft.provider &&
  !!draft.model &&
  modelIsDiscovered(
    { provider: draft.provider, model: draft.model },
    product.executionOptions,
  );

onMount(async () => {
  initialized = true;
  const preferred =
    product.loadouts.find((item) => item.id === rememberedLoadoutId) ??
    product.loadouts[0] ??
    null;
  selectedId = preferred?.id ?? null;

  if (scene === "list") {
    suppressDefaultSelection = true;
    selectedId = null;
  } else if (scene === "coding") {
    selectedId = product.loadouts.find((item) => item.key === "coding")?.id ?? selectedId;
  } else if (scene === "review") {
    selectedId = product.loadouts.find((item) => item.key === "review")?.id ?? selectedId;
  } else if (scene === "custom") {
    selectedId =
      product.loadouts.find((item) => item.key === "experimental")?.id ??
      product.loadouts.find(
        (item) => !modelIsDiscovered(item.model, product.executionOptions),
      )?.id ??
      selectedId;
  } else if (scene === "new") {
    startCreate();
  } else if (scene === "edit" && preferred) {
    startEdit(preferred);
  } else if (scene === "custom-config" && preferred) {
    const customPreferred =
      product.loadouts.find(
        (item) => !modelIsDiscovered(item.model, product.executionOptions),
      ) ?? preferred;
    startEdit(customPreferred);
    customOpen = true;
    await tick();
    scheduleContentBottom();
  } else if (scene === "advanced") {
    advancedOpen = true;
    await tick();
    scheduleContentBottom();
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

function scheduleContentBottom() {
  window.setTimeout(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    const content = windowElement?.querySelector<HTMLElement>(
      ".loadout-content",
    );
    if (content) content.scrollTop = content.scrollHeight;
  }, 500);
}

function ensureDefaultSelection(loadouts: Loadout[]) {
  selectedId =
    loadouts.find((item) => item.id === rememberedLoadoutId)?.id ??
    loadouts[0]?.id ??
    null;
}

function usageCount(loadoutId: string): number {
  return product.squads.reduce(
    (count, squad) =>
      count + squad.members.filter((member) => member.loadout_id === loadoutId).length,
    0,
  );
}

function usageLabel(count: number): string {
  return `Used by ${count} active Squad ${count === 1 ? "Member" : "Members"}`;
}

function selectLoadout(loadout: Loadout) {
  requestTransition(() => {
    selectedId = loadout.id;
    rememberedLoadoutId = loadout.id;
    mode = "detail";
    advancedOpen = false;
    clearIssues();
  });
}

function startCreate() {
  mode = "create";
  draft = emptyLoadoutDraft();
  customToolsText = "";
  selectedPresetKey = "";
  customOpen = product.executionOptions.length === 0;
  advancedOpen = false;
  clearIssues();
  void focusField("loadout-name");
}

function beginCreate() {
  requestTransition(startCreate);
}

function startEdit(loadout: Loadout) {
  selectedId = loadout.id;
  rememberedLoadoutId = loadout.id;
  mode = "edit";
  draft = draftFromLoadout(loadout);
  customToolsText = customCapabilities(draft).join("\n");
  selectedPresetKey = "";
  customOpen = false;
  clearIssues();
  void focusField("loadout-name");
}

function cancelForm() {
  mode = "detail";
  clearIssues();
  void tick().then(() =>
    windowElement
      ?.querySelector<HTMLButtonElement>(`[data-loadout-id="${selectedId}"]`)
      ?.focus(),
  );
}

function applyPreset() {
  if (!selectedPreset) return;
  draft = applyExecutionOption(draft, selectedPreset);
  customToolsText = customCapabilities(draft).join("\n");
  customOpen = customToolsText.length > 0;
  clearIssues();
}

function chooseModel(value: string) {
  const choice = modelChoices.find((model) => modelRefKey(model) === value);
  if (!choice) {
    customOpen = true;
    return;
  }
  draft = { ...draft, provider: choice.provider, model: choice.model };
  clearIssues();
}

function toggleCapability(id: string, enabled: boolean) {
  draft = toggleKnownCapability(draft, id, enabled);
}

function updateCustomCapabilities(value: string) {
  customToolsText = value;
  draft = replaceCustomCapabilities(
    draft,
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function clearIssues() {
  fieldErrors = {};
  localIssue = "";
}

function isDirty(): boolean {
  if (mode === "create")
    return JSON.stringify(draft) !== JSON.stringify(emptyLoadoutDraft());
  if (mode !== "edit" || !selectedLoadout) return false;
  return JSON.stringify(draft) !== JSON.stringify(draftFromLoadout(selectedLoadout));
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
  if (await saveLoadout()) continuation?.();
}

function validateDraft(): boolean {
  const errors: DraftErrors = {};
  if (!draft.name.trim()) errors.name = "Enter a Loadout name.";
  if (!draft.provider.trim()) errors.provider = "Choose a Model or enter a canonical provider.";
  if (!draft.model.trim()) errors.model = "Choose or enter a Model.";
  const invalidCapability = draft.tools.find(
    (tool) =>
      tool.length > 128 ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(tool),
  );
  if (invalidCapability)
    errors.tools = `“${invalidCapability}” is not a valid capability ID.`;
  fieldErrors = errors;
  if (Object.keys(errors).length === 0) return true;
  localIssue = "Review the highlighted configuration and try again.";
  if (errors.name) void focusField("loadout-name");
  else {
    customOpen = true;
    void focusField(errors.tools ? "custom-capabilities" : "custom-provider");
  }
  return false;
}

async function saveLoadout(): Promise<boolean> {
  if (busy || !validateDraft()) return false;
  busy = true;
  clearIssues();
  const input = loadoutInputFromDraft(draft);

  try {
    const saved =
      mode === "edit" && selectedLoadout
        ? await store.command(() => store.api.updateLoadout(selectedLoadout.id, input))
        : await store.command(() =>
            createLoadoutWithGeneratedKey(
              store.api,
              input,
              product.loadouts.map((item) => item.key),
            ),
          );
    if (!saved) {
      applyServerError(get(store.error));
      return false;
    }

    selectedId = saved.id;
    rememberedLoadoutId = saved.id;
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
    const field = detail.path[0];
    if (field === "name") errors.name = "Enter a valid Loadout name.";
    if (field === "model") {
      errors.provider = "Enter a valid canonical provider.";
      errors.model = "Enter a valid Model ID.";
    }
    if (field === "tools") errors.tools = "Review the custom capability IDs.";
  }
  fieldErrors = errors;
  localIssue =
    Object.keys(errors).length > 0
      ? "Review the highlighted configuration and try again."
      : mode === "create"
        ? "Quest Engineering couldn't create that Loadout. Try a different name."
        : "Quest Engineering couldn't save those Loadout changes.";
}

async function focusField(id: string) {
  await tick();
  windowElement?.querySelector<HTMLElement>(`#${id}`)?.focus();
}

function openArchiveDialog() {
  if (!selectedLoadout || archiveDialog?.open) return;
  archiveDialog.showModal();
  void tick().then(() => archiveCancel?.focus());
}

async function archiveLoadout() {
  if (busy || !selectedLoadout) return;
  busy = true;
  clearIssues();
  const archivedId = selectedLoadout.id;
  const nextId = product.loadouts.find((item) => item.id !== archivedId)?.id ?? null;
  const archived = await store.command(() => store.api.archiveLoadout(archivedId));
  archiveDialog.close();
  if (archived) {
    if (rememberedLoadoutId === archivedId) rememberedLoadoutId = nextId;
    selectedId = nextId;
    mode = "detail";
    await store.refreshProduct();
    await tick();
    windowElement?.querySelector<HTMLButtonElement>(".loadout-card")?.focus();
  } else {
    localIssue = "Quest Engineering couldn't archive this Loadout.";
    await tick();
    archiveTrigger?.focus();
  }
  busy = false;
}

function loadoutModelName(loadout: Loadout): string {
  return modelIsDiscovered(loadout.model, product.executionOptions)
    ? modelLabel(loadout.model.model)
    : "Custom model";
}
</script>

<aside
  bind:this={windowElement}
  class="forge-window management-window management-window-shell panel"
  aria-labelledby="forge-title"
>
  <header class="window-header">
    <div>
      <span class="window-kicker">Equipment and capabilities</span>
      <h1 id="forge-title">Forge</h1>
    </div>
    <button class="icon-button" type="button" aria-label="Close Forge" on:click={onClose}>×</button>
  </header>

  <div class="window-body">
    <section class="loadout-browser" aria-labelledby="loadouts-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Member equipment</span>
          <h2 id="loadouts-title">Loadouts</h2>
        </div>
        <button class="primary compact" type="button" on:click={beginCreate}>+ New Loadout</button>
      </div>

      {#if product.loadouts.length}
        <div class="loadout-list" aria-label="Loadouts">
          {#each product.loadouts as loadout}
            {@const count = usageCount(loadout.id)}
            <button
              type="button"
              class="loadout-card"
              class:selected={selectedId === loadout.id && mode !== "create"}
              aria-pressed={selectedId === loadout.id && mode !== "create"}
              data-loadout-id={loadout.id}
              on:click={() => selectLoadout(loadout)}
            >
              <span class="card-heading"><strong>{loadout.name}</strong><span aria-hidden="true">◆</span></span>
              <span class="card-model">{loadoutModelName(loadout)} · {reasoningLabel(loadout.reasoning)}</span>
              <span class="card-access">{accessLabel(loadout.workspace_access)} · {loadout.tools.length} {loadout.tools.length === 1 ? "capability" : "capabilities"}</span>
              <span class="card-usage">{usageLabel(count)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="browser-empty"><span aria-hidden="true">◆</span><p>No equipment has been forged yet.</p></div>
      {/if}
    </section>

    <section class="loadout-content" aria-live="polite">
      {#if localIssue}
        <div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>
      {/if}

      {#if mode === "create" || (mode === "edit" && selectedLoadout)}
        <div class="content-heading">
          <span class="eyebrow">{mode === "create" ? "New equipment" : "Loadout settings"}</span>
          <h2>{mode === "create" ? "Create Loadout" : `Edit ${selectedLoadout?.name}`}</h2>
          <p>Loadouts control models, capabilities, and Project access. Behavior is defined by Classes in the Guild Hall.</p>
        </div>

        <form class="loadout-form" on:submit|preventDefault={saveLoadout}>
          <section class="form-section" aria-labelledby="identity-heading">
            <div class="form-section-heading"><span aria-hidden="true">I</span><div><h3 id="identity-heading">Identity</h3><p>Name this equipment setup for your guild.</p></div></div>
            <div class="form-grid identity-grid">
              <div class="field full">
                <label for="loadout-name">Name</label>
                <input id="loadout-name" bind:value={draft.name} required maxlength="160" aria-invalid={fieldErrors.name ? "true" : undefined} aria-describedby={fieldErrors.name ? "loadout-name-error" : undefined} />
                {#if fieldErrors.name}<small id="loadout-name-error" class="field-error">{fieldErrors.name}</small>{/if}
              </div>
              <div class="field full">
                <label for="loadout-description">Description <span>Short, human-facing summary</span></label>
                <textarea id="loadout-description" class="description-editor" bind:value={draft.description} rows="2"></textarea>
              </div>
            </div>
          </section>

          <section class="form-section" aria-labelledby="model-heading">
            <div class="form-section-heading"><span aria-hidden="true">M</span><div><h3 id="model-heading">Model & reasoning</h3><p>Choose the model and depth this Loadout uses.</p></div></div>

            {#if product.executionOptions.length}
              <div class="preset-row">
                <div class="field">
                  <label for="configuration-preset">Configuration preset <span>Optional shortcut</span></label>
                  <select id="configuration-preset" bind:value={selectedPresetKey}>
                    <option value="">Choose a discovered configuration</option>
                    {#each product.executionOptions as option}
                      <option value={optionKey(option)}>{presetLabel(option)} — {option.available ? "Available now" : "Not available now"}</option>
                    {/each}
                  </select>
                </div>
                <button class="secondary apply-preset" type="button" disabled={!selectedPreset} on:click={applyPreset}>Apply preset</button>
              </div>
              <p class="preset-impact">Applying replaces Model, Reasoning, Project access, and standard capabilities. Custom capability IDs are preserved.</p>
            {/if}

            <div class="form-grid model-grid">
              <div class="field">
                <label for="loadout-model">Model</label>
                <select id="loadout-model" value={draft.provider && draft.model ? modelRefKey({ provider: draft.provider, model: draft.model }) : ""} on:change={(event) => chooseModel(event.currentTarget.value)}>
                  <option value="">Choose a discovered model</option>
                  {#each modelChoices as model}
                    <option value={modelRefKey(model)}>{modelLabel(model.model)} · {providerLabel(model.provider)}</option>
                  {/each}
                  {#if draft.provider && draft.model && !currentModelDiscovered}
                    <option value={modelRefKey({ provider: draft.provider, model: draft.model })}>Custom model — currently configured</option>
                  {/if}
                </select>
                {#if !product.executionOptions.length}<button class="custom-link" type="button" on:click={() => customOpen = true}>Use custom configuration</button>{/if}
              </div>
              <div class="field">
                <label for="loadout-reasoning">Reasoning</label>
                <select id="loadout-reasoning" bind:value={draft.reasoning}>
                  {#each reasoningChoices as reasoning}<option value={reasoning}>{reasoningLabel(reasoning)}</option>{/each}
                </select>
              </div>
            </div>
          </section>

          <section class="form-section" aria-labelledby="access-heading">
            <div class="form-section-heading"><span aria-hidden="true">A</span><div><h3 id="access-heading">Project access</h3><p>Control how this Loadout may work with a Project.</p></div></div>
            <div class="access-options">
              {#each accessChoices as access}
                <label class:selected={draft.workspaceAccess === access}>
                  <input type="radio" name="project-access" value={access} bind:group={draft.workspaceAccess} />
                  <span><strong>{accessLabel(access)}</strong><small>{access === "none" ? "No Project content." : access === "read_only" ? "Inspect without changing files." : "Read and change Project files."}</small></span>
                </label>
              {/each}
            </div>
          </section>

          <section class="form-section" aria-labelledby="capabilities-heading">
            <div class="form-section-heading"><span aria-hidden="true">C</span><div><h3 id="capabilities-heading">Capabilities</h3><p>Choose the equipment this Loadout carries.</p></div></div>
            <div class="capability-picker">
              {#each knownCapabilities as capability}
                <label class:selected={draft.tools.includes(capability.id)}>
                  <input type="checkbox" checked={draft.tools.includes(capability.id)} on:change={(event) => toggleCapability(capability.id, event.currentTarget.checked)} />
                  <span class="capability-icon" aria-hidden="true">{capability.icon}</span>
                  <span><strong>{capability.name}</strong><small>{capability.description}</small></span>
                </label>
              {/each}
            </div>
            {#if customCapabilities(draft).length}
              <p class="custom-retained">{customCapabilities(draft).length} custom {customCapabilities(draft).length === 1 ? "capability is" : "capabilities are"} preserved.</p>
            {/if}
          </section>

          <details class="custom-configuration" bind:open={customOpen}>
            <summary>Custom configuration</summary>
            <div class="custom-content">
              <p>Use canonical Product identifiers for models or capabilities not currently advertised by a Worker.</p>
              <div class="form-grid model-grid">
                <div class="field">
                  <label for="custom-provider">Canonical provider</label>
                  <input id="custom-provider" bind:value={draft.provider} aria-invalid={fieldErrors.provider ? "true" : undefined} />
                  {#if fieldErrors.provider}<small class="field-error">{fieldErrors.provider}</small>{/if}
                </div>
                <div class="field">
                  <label for="custom-model">Canonical Model ID</label>
                  <input id="custom-model" bind:value={draft.model} aria-invalid={fieldErrors.model ? "true" : undefined} />
                  {#if fieldErrors.model}<small class="field-error">{fieldErrors.model}</small>{/if}
                </div>
              </div>
              <div class="field">
                <label for="custom-capabilities">Custom capability IDs <span>One per line</span></label>
                <textarea id="custom-capabilities" rows="3" value={customToolsText} on:input={(event) => updateCustomCapabilities(event.currentTarget.value)} aria-invalid={fieldErrors.tools ? "true" : undefined}></textarea>
                {#if fieldErrors.tools}<small class="field-error">{fieldErrors.tools}</small>{/if}
              </div>
            </div>
          </details>

          <footer class="action-row">
            <button class="secondary" type="button" on:click={cancelForm}>Cancel</button>
            <button class="primary" disabled={busy}>{busy ? (mode === "create" ? "Creating…" : "Saving…") : (mode === "create" ? "Create Loadout" : "Save Changes")}</button>
          </footer>
        </form>
      {:else if selectedLoadout}
        {@const discovered = modelIsDiscovered(selectedLoadout.model, product.executionOptions)}
        <article class="loadout-detail">
          <div class="detail-title-row">
            <div><span class="eyebrow">Loadout · Equipment</span><h2>{selectedLoadout.name}</h2></div>
            <span class="configured">Configured</span>
          </div>
          <p class="detail-description">{selectedLoadout.description || "No description has been added yet."}</p>
          <p class="detail-usage">{usageLabel(selectedUsage)}</p>

          <section class="model-panel">
            <span class="panel-icon" aria-hidden="true">◆</span>
            <div><small>Model</small>{#if discovered}<strong>{modelLabel(selectedLoadout.model.model)}</strong><span>{providerLabel(selectedLoadout.model.provider)}</span>{:else}<strong class="custom-model"><code>{canonicalModel(selectedLoadout)}</code></strong><span>Custom model configuration</span>{/if}</div>
          </section>

          <div class="configuration-grid">
            <section><small>Reasoning</small><strong>{reasoningLabel(selectedLoadout.reasoning)}</strong></section>
            <section><small>Project access</small><strong>{accessLabel(selectedLoadout.workspace_access)}</strong></section>
            <section><small>Capabilities</small><strong>{selectedLoadout.tools.length}</strong></section>
          </div>

          <section class="capabilities-panel" aria-labelledby="detail-capabilities-title">
            <h3 id="detail-capabilities-title">Capabilities</h3>
            {#if selectedLoadout.tools.length}
              <ul>
                {#each selectedLoadout.tools as capabilityId}
                  {@const capability = knownCapability(capabilityId)}
                  <li class:custom={!capability}>
                    <span class="capability-icon" aria-hidden="true">{capability?.icon ?? "◇"}</span>
                    <span>{#if capability}<strong>{capability.name}</strong><small>{capability.description}</small>{:else}<strong><code>{capabilityId}</code></strong><small>Custom capability</small>{/if}</span>
                    {#if !capability}<em>Custom</em>{/if}
                  </li>
                {/each}
              </ul>
            {:else}<p>No capabilities configured.</p>{/if}
          </section>

          <details class="advanced" bind:open={advancedOpen}>
            <summary>Advanced</summary>
            <dl>
              <div><dt>Loadout key</dt><dd><code>{selectedLoadout.key}</code><small>Immutable</small></dd></div>
              <div><dt>Canonical model</dt><dd><code>{canonicalModel(selectedLoadout)}</code></dd></div>
              <div><dt>Capability IDs</dt><dd>{#if selectedLoadout.tools.length}<code>{selectedLoadout.tools.join("\n")}</code>{:else}<span>None</span>{/if}</dd></div>
            </dl>
          </details>

          <footer class="detail-actions">
            <button class="secondary" type="button" on:click={() => startEdit(selectedLoadout)}>Edit</button>
            <button bind:this={archiveTrigger} class="destructive-link" type="button" on:click={openArchiveDialog}>Archive</button>
          </footer>
        </article>
      {:else if product.loadouts.length}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">↖</span><h3>Choose a Loadout</h3><p>Select equipment to view its model, access, and capabilities.</p></div>
      {:else}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">◆</span><h3>No Loadouts yet</h3><p>Loadouts equip Members with models, capabilities, and Project access.</p><button class="primary" type="button" on:click={startCreate}>Create Loadout</button></div>
      {/if}
    </section>
  </div>

  <dialog bind:this={archiveDialog} aria-labelledby="archive-loadout-title" on:close={() => archiveTrigger?.focus()}>
    <form method="dialog" class="dialog-card" on:submit|preventDefault>
      <span class="dialog-icon" aria-hidden="true">!</span>
      <h2 id="archive-loadout-title">Archive {selectedLoadout?.name}?</h2>
      <p>This Loadout will no longer be available for Squad configuration. Squads that still reference it cannot launch new Runs. Existing historical Runs are unaffected.</p>
      {#if selectedUsage > 0}<p class="dialog-usage">{usageLabel(selectedUsage)}</p>{/if}
      <footer class="action-row">
        <button bind:this={archiveCancel} class="secondary" type="button" on:click={() => archiveDialog.close()}>Cancel</button>
        <button class="destructive" type="button" disabled={busy} on:click={archiveLoadout}>{busy ? "Archiving…" : "Archive Loadout"}</button>
      </footer>
    </form>
  </dialog>

  <dialog bind:this={dirtyDialog} aria-labelledby="dirty-loadout-title" on:cancel={(event) => { event.preventDefault(); keepEditing(); }}>
    <form method="dialog" class="dialog-card" on:submit|preventDefault>
      <span class="dialog-icon unsaved" aria-hidden="true">✎</span>
      <h2 id="dirty-loadout-title">Unsaved changes</h2>
      <p>Save your Loadout changes, discard them, or keep editing.</p>
      <footer class="action-row dirty-actions">
        <button bind:this={dirtyKeepButton} class="secondary" type="button" on:click={keepEditing}>Keep Editing</button>
        <button class="destructive-link dialog-discard" type="button" on:click={discardAndContinue}>Discard</button>
        <button class="primary" type="button" disabled={busy} on:click={saveAndContinue}>Save</button>
      </footer>
    </form>
  </dialog>
</aside>

<style>
  .window-body { display: grid; grid-template-columns: minmax(17rem, .68fr) minmax(29rem, 1.32fr); height: min(34rem, calc(100vh - 10.4rem)); overflow: hidden; }
  .loadout-browser, .loadout-content { min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .loadout-browser { padding: 1.15rem; background: var(--app-paper-soft); border-right: 1px solid #c9aa7b; }
  .loadout-content { padding: 1.45rem 1.65rem; background: linear-gradient(145deg, #fff8e7, var(--app-cream)); }
  .section-heading { display: flex; align-items: center; gap: .7rem; margin-bottom: 1rem; }
  .section-heading > div { flex: 1; }
  .section-heading h2 { margin: .15rem 0 0; color: var(--app-ink); font: 700 1.25rem Georgia, ui-serif, serif; }
  .loadout-list { display: grid; gap: .65rem; }
  .loadout-card { display: grid; gap: .28rem; width: 100%; padding: .85rem .9rem; text-align: left; color: var(--app-ink); background: #fff7df; border: 1px solid #c5a97b; box-shadow: 0 3px 9px #70583f16; }
  .loadout-card:hover { background: #fffbed; border-color: var(--app-teal); transform: translateY(-1px); }
  .loadout-card.selected { color: #fff9e9; background: linear-gradient(135deg, #578a82, var(--app-teal)); border-color: var(--app-teal-dark); box-shadow: inset 4px 0 #e3b35e, 0 5px 12px #355e5438; }
  .card-heading { display: flex; align-items: center; gap: .5rem; }
  .card-heading strong { flex: 1; font: 700 1rem Georgia, ui-serif, serif; }
  .card-heading > span { color: #b5843e; font-size: .78rem; }
  .card-model { color: #4f5e5a; font-size: .82rem; font-weight: 700; }
  .card-access { color: #66716b; font-size: .76rem; }
  .card-usage { margin-top: .12rem; color: #64766e; font-size: .7rem; font-weight: 750; }
  .loadout-card.selected .card-model, .loadout-card.selected .card-access, .loadout-card.selected .card-usage { color: #e5efe9; }
  .loadout-card.selected .card-heading > span { color: #ffe5a7; }
  .browser-empty { display: grid; justify-items: center; gap: .5rem; padding: 3rem .5rem; color: var(--app-muted); text-align: center; }
  .browser-empty > span, .empty-icon { color: var(--app-teal); font-size: 1.5rem; }
  .browser-empty p { margin: 0; font-size: .85rem; }
  .content-heading { margin-bottom: 1rem; }
  .content-heading h2, .loadout-detail h2 { margin: .18rem 0 .22rem; color: var(--app-ink); font: 700 1.9rem Georgia, ui-serif, serif; }
  .content-heading p { max-width: 36rem; margin: .15rem 0; color: var(--app-muted); font-size: .9rem; line-height: 1.42; }
  .loadout-form { display: grid; gap: .85rem; }
  .form-section { padding-bottom: .8rem; border-bottom: 1px solid #d9c7a6; }
  .form-section-heading { display: flex; align-items: center; gap: .6rem; margin-bottom: .65rem; }
  .form-section-heading > span { display: grid; place-items: center; width: 1.65rem; height: 1.65rem; color: #fff8e8; background: var(--app-teal); border-radius: 50%; font: 800 .7rem Georgia, serif; }
  .form-section-heading h3 { margin: 0; color: var(--app-ink); font: 700 1rem Georgia, ui-serif, serif; }
  .form-section-heading p { margin: .05rem 0 0; color: var(--app-muted); font-size: .72rem; }
  .form-grid { display: grid; gap: .65rem; }
  .model-grid { grid-template-columns: 1.25fr .75fr; }
  .field { display: grid; gap: .28rem; }
  .field.full { grid-column: 1 / -1; }
  .field label { color: #5a4d42; font-size: .78rem; font-weight: 800; }
  .field label span { color: var(--app-muted); font-size: .68rem; font-weight: 500; }
  .field input, .field select, .field textarea, .preset-row select { width: 100%; min-height: 2.55rem; padding: .55rem .65rem; color: var(--app-ink); background: #fffdf6; border: 1px solid #bfa37a; border-radius: 7px; box-shadow: inset 0 1px 2px #59422d16; }
  .field textarea { resize: vertical; }
  .description-editor { min-height: 3.4rem !important; max-height: 6rem; }
  .field [aria-invalid="true"] { border-color: var(--app-coral); box-shadow: 0 0 0 2px #bd5d5522; }
  .field-error { color: #9b4743; font-size: .72rem; }
  .preset-row { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: .55rem; margin-bottom: .25rem; padding: .65rem; background: #f0dfbc; border-radius: 8px; }
  .apply-preset { white-space: nowrap; }
  .preset-impact { margin: .25rem 0 .7rem; color: var(--app-muted); font-size: .68rem; line-height: 1.35; }
  .custom-link { min-height: auto !important; justify-self: start; padding: .2rem 0; color: var(--app-teal-dark); background: transparent; border: 0; box-shadow: none; font-size: .75rem; font-weight: 750; }
  .access-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; }
  .access-options label { display: flex; gap: .45rem; padding: .65rem; color: var(--app-ink); background: #fff8e7; border: 1px solid #c9ae82; border-radius: 8px; cursor: pointer; }
  .access-options label.selected { background: #e5efe4; border-color: var(--app-teal); box-shadow: inset 3px 0 var(--app-teal); }
  .access-options input { width: auto; margin: .15rem 0 0; accent-color: var(--app-teal-dark); }
  .access-options span { display: grid; gap: .12rem; }
  .access-options strong { font-size: .78rem; }
  .access-options small { color: var(--app-muted); font-size: .64rem; line-height: 1.25; }
  .capability-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; }
  .capability-picker label { display: grid; grid-template-columns: auto auto 1fr; align-items: start; gap: .4rem; padding: .6rem; color: var(--app-ink); background: #fff8e7; border: 1px solid #c9ae82; border-radius: 8px; cursor: pointer; }
  .capability-picker label.selected { background: #e5efe4; border-color: var(--app-teal); }
  .capability-picker input { width: auto; margin-top: .1rem; accent-color: var(--app-teal-dark); }
  .capability-picker label > span:last-child { display: grid; gap: .1rem; }
  .capability-picker strong { font-size: .75rem; }
  .capability-picker small { color: var(--app-muted); font-size: .62rem; line-height: 1.25; }
  .capability-icon { color: var(--app-teal-dark); font: 800 .72rem ui-monospace, monospace; }
  .custom-retained { margin: .45rem 0 0; color: var(--app-teal-dark); font-size: .72rem; font-weight: 750; }
  .custom-configuration { border-bottom: 1px solid #d7c5a5; }
  .custom-configuration summary { padding: .75rem 0; color: #5b554b; cursor: pointer; font-weight: 750; }
  .custom-content { display: grid; gap: .65rem; padding: .75rem; background: #eee0c4; border-radius: 8px; }
  .custom-content > p { margin: 0; color: var(--app-muted); font-size: .75rem; line-height: 1.4; }
  .detail-title-row { display: flex; align-items: start; gap: 1rem; }
  .detail-title-row > div { flex: 1; }
  .configured { padding: .28rem .55rem; color: #356447; background: #e3efe0; border: 1px solid #9abd9b; border-radius: 999px; font-size: .7rem; font-weight: 800; }
  .detail-description { max-width: 38rem; margin: .15rem 0 .25rem; color: #4c5b57; line-height: 1.45; }
  .detail-usage { margin: 0 0 .9rem; color: var(--app-teal-dark); font-size: .75rem; font-weight: 750; }
  .model-panel { display: flex; align-items: center; gap: .8rem; padding: .85rem 1rem; background: #f0dfbc; border-left: 5px solid var(--app-teal); border-radius: 8px; }
  .panel-icon { display: grid; place-items: center; width: 2.2rem; height: 2.2rem; color: #fff8e8; background: var(--app-teal); border-radius: 50%; }
  .model-panel > div { display: grid; gap: .08rem; }
  .model-panel small, .configuration-grid small { color: var(--app-muted); font-size: .64rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .model-panel strong { color: var(--app-ink); font: 700 1.05rem Georgia, ui-serif, serif; }
  .model-panel span:last-child { color: var(--app-muted); font-size: .76rem; }
  .custom-model code { font: .78rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .configuration-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .55rem; margin-top: .7rem; }
  .configuration-grid section { display: grid; gap: .2rem; padding: .65rem .75rem; background: #fff9e9; border: 1px solid #d6c09b; border-radius: 8px; }
  .configuration-grid strong { color: var(--app-ink); font-size: .88rem; }
  .capabilities-panel { margin-top: .75rem; }
  .capabilities-panel h3 { margin: 0 0 .45rem; color: var(--app-ink); font: 700 1rem Georgia, ui-serif, serif; }
  .capabilities-panel ul { display: grid; grid-template-columns: repeat(2, 1fr); gap: .45rem; margin: 0; padding: 0; list-style: none; }
  .capabilities-panel li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .5rem; padding: .55rem .65rem; background: #f4e6c8; border-radius: 7px; }
  .capabilities-panel li > span:nth-child(2) { display: grid; gap: .06rem; }
  .capabilities-panel strong { color: var(--app-ink); font-size: .76rem; }
  .capabilities-panel small { color: var(--app-muted); font-size: .62rem; }
  .capabilities-panel code { font: .7rem ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .capabilities-panel em { color: #8b6337; font-size: .62rem; font-style: normal; font-weight: 800; }
  .capabilities-panel > p { color: var(--app-muted); font-size: .8rem; }
  .advanced { margin-top: .8rem; border-top: 1px solid #d7c5a5; border-bottom: 1px solid #d7c5a5; }
  .advanced summary { padding: .7rem 0; color: #5b554b; cursor: pointer; font-weight: 750; }
  .advanced dl { display: grid; gap: .55rem; margin: 0 0 .75rem; }
  .advanced dl > div { display: grid; grid-template-columns: 7rem 1fr; gap: .7rem; }
  .advanced dt { color: var(--app-muted); font-size: .75rem; }
  .advanced dd { display: flex; flex-wrap: wrap; gap: .45rem; margin: 0; overflow-wrap: anywhere; }
  .advanced code { color: #35494a; white-space: pre-wrap; font: .72rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .advanced small { color: var(--app-muted); font-size: .68rem; }
  .detail-actions { display: flex; align-items: center; gap: .8rem; margin-top: .9rem; }
  .destructive-link { min-height: auto; margin: 0 0 0 auto; padding: .2rem 0; color: #a74f49; background: transparent; border: 0; box-shadow: none; font-weight: 750; }
  .detail-empty { min-height: 24rem; align-content: center; }
  .dialog-usage { margin-top: .8rem !important; color: var(--app-teal-dark) !important; font-size: .78rem; font-weight: 750; }
  .dialog-icon.unsaved { background: var(--app-teal); }
  .dirty-actions { width: 100%; }
  .dialog-discard { margin: 0 auto 0 0; }
  @media (max-width: 1000px) {
    .window-body { grid-template-columns: minmax(15rem, .7fr) minmax(22rem, 1.3fr); height: min(34rem, calc(100vh - 10.3rem)); }
    .loadout-content { padding: .95rem 1.1rem; }
    .loadout-detail h2 { font-size: 1.7rem; }
    .detail-description { line-height: 1.3; }
    .detail-usage { margin-bottom: .6rem; }
    .model-panel { padding: .6rem .75rem; }
    .configuration-grid { margin-top: .5rem; }
    .configuration-grid section { padding: .48rem .58rem; }
    .capabilities-panel { margin-top: .55rem; }
    .capabilities-panel ul { grid-template-columns: repeat(3, 1fr); }
    .capabilities-panel li { padding: .45rem .5rem; }
    .capabilities-panel li small { display: none; }
    .advanced { margin-top: .55rem; }
    .advanced summary { padding: .55rem 0; }
    .detail-actions { margin-top: .65rem; }
    .capability-picker { grid-template-columns: 1fr; }
    .capability-picker label { grid-template-columns: auto auto 1fr; }
  }
  @media (max-width: 720px) {
    .window-body { display: block; overflow: auto; }
    .loadout-browser, .loadout-content { overflow: visible; }
    .loadout-browser { border-right: 0; border-bottom: 1px solid #c9aa7b; }
    .loadout-list { grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
    .loadout-content { min-height: 23rem; }
    .model-grid, .preset-row, .access-options, .configuration-grid, .capabilities-panel ul { grid-template-columns: 1fr; }
  }
</style>
