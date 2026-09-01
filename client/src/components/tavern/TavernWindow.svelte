<script context="module" lang="ts">
let rememberedSquadId: string | null = null;
</script>

<script lang="ts">
import { get } from "svelte/store";
import { onMount, tick } from "svelte";
import type {
  ApiError,
  ClassDefinition,
  Loadout,
  Squad,
  SquadMember,
} from "../../api/contracts";
import type { AppStore, ProductState } from "../../state/app-store";
import "../management/management-window.css";
import { createSquadWithGeneratedKey } from "./squad-creation";
import {
  copyMember,
  draftFromSquad,
  emptySquadDraft,
  generatedMemberKey,
  moveRosterMember,
  referenceIssues,
  squadInput,
  type SquadDraft,
} from "./squad-draft";
import {
  activeQuestUsageLabel,
  classReference,
  loadoutAccessSummary,
  loadoutModelSummary,
  loadoutReference,
} from "./squad-presentation";

export let store: AppStore;
export let product: ProductState;
export let onClose: () => void;
export let scene: string | null = null;

type Mode = "detail" | "create" | "edit";
type Picker = "class" | "loadout" | null;
type MemberEditor = {
  mode: "add" | "edit";
  index: number | null;
  name: string;
  classId: string;
  loadoutId: string;
  picker: Picker;
};
type SquadErrors = { name?: string; members?: string };
type MemberErrors = { name?: string; classId?: string; loadoutId?: string };

let mode: Mode = "detail";
let selectedId: string | null = null;
let draft: SquadDraft = emptySquadDraft();
let squadErrors: SquadErrors = {};
let memberErrors: MemberErrors = {};
let memberEditor: MemberEditor | null = null;
let reservedMemberKeys = new Set<string>();
let localIssue = "";
let busy = false;
let initialized = false;
let suppressDefaultSelection = false;
let advancedOpen = false;
let windowElement: HTMLElement;
let archiveDialog: HTMLDialogElement;
let archiveCancel: HTMLButtonElement;
let dirtyDialog: HTMLDialogElement;
let dirtyKeepButton: HTMLButtonElement;
let dirtyReturnFocus: HTMLElement | null = null;
let pendingContinuation: (() => void) | null = null;
let memberCanConfirm = false;
let selectedMemberClass: ClassDefinition | null = null;
let selectedMemberLoadout: Loadout | null = null;

$: classCatalog = product.classCatalog.length
  ? product.classCatalog
  : product.classes;
$: loadoutCatalog = product.loadoutCatalog.length
  ? product.loadoutCatalog
  : product.loadouts;
$: activeClasses = product.classes.filter((item) => !item.archived_at);
$: activeLoadouts = product.loadouts.filter((item) => !item.archived_at);
$: selectedMemberClass =
  classCatalog.find((item) => item.id === memberEditor?.classId) ?? null;
$: selectedMemberLoadout =
  loadoutCatalog.find((item) => item.id === memberEditor?.loadoutId) ?? null;
$: memberCanConfirm = Boolean(
  memberEditor?.name.trim() &&
    activeClasses.some((item) => item.id === memberEditor?.classId) &&
    activeLoadouts.some((item) => item.id === memberEditor?.loadoutId),
);
$: selectedSquad =
  product.squads.find((squad) => squad.id === selectedId) ?? null;
$: selectedReferenceIssues = selectedSquad
  ? referenceIssues(selectedSquad.members, classCatalog, loadoutCatalog)
  : [];
$: draftReferenceIssues = referenceIssues(
  draft.members,
  classCatalog,
  loadoutCatalog,
);
$: selectedUsage = selectedSquad ? usageCount(selectedSquad.id) : 0;
$: if (
  initialized &&
  mode === "detail" &&
  !product.squads.some((item) => item.id === selectedId) &&
  product.squads.length > 0 &&
  !suppressDefaultSelection
) {
  ensureDefaultSelection(product.squads);
}

onMount(async () => {
  void store.loadTavernCatalogs();
  initialized = true;
  const preferred =
    product.squads.find((item) => item.id === rememberedSquadId) ??
    product.squads[0] ??
    null;
  selectedId = preferred?.id ?? null;

  if (scene === "list") {
    suppressDefaultSelection = true;
    selectedId = null;
  } else if (scene === "engineering") {
    selectedId =
      product.squads.find((item) => item.key === "engineering-pair")?.id ??
      selectedId;
  } else if (scene === "backend") {
    selectedId =
      product.squads.find((item) => item.key === "backend-team")?.id ??
      selectedId;
  } else if (scene === "new") {
    startCreate();
  } else if (scene === "edit" && preferred) {
    startEdit(preferred);
  } else if (scene === "add-member" && preferred) {
    startEdit(preferred);
    beginAddMember();
  } else if (scene === "edit-member" && preferred) {
    startEdit(preferred);
    beginEditMember(0);
  } else if (scene === "class-picker" && preferred) {
    startEdit(preferred);
    beginAddMember();
    if (memberEditor)
      memberEditor = { ...memberEditor, name: "Theo", picker: "class" };
    scheduleContentTarget(".definition-picker");
  } else if (scene === "loadout-picker" && preferred) {
    startEdit(preferred);
    beginAddMember();
    if (memberEditor)
      memberEditor = {
        ...memberEditor,
        name: "Theo",
        classId: activeClasses[0]?.id ?? "",
        picker: "loadout",
      };
    scheduleContentTarget(".definition-picker");
  } else if (scene === "reordered" && preferred) {
    startEdit(preferred);
    moveMember(1, -1);
    scheduleContentTarget(".editable-roster");
  } else if (scene === "advanced") {
    advancedOpen = true;
  } else if (scene === "archive" && preferred) {
    await tick();
    openArchiveDialog();
  } else if (scene === "dirty" && preferred) {
    startEdit(preferred);
    draft = { ...draft, description: `${draft.description} Unsaved revision.` };
    await tick();
    requestLeave(() => undefined);
  }
});

function scheduleContentTarget(selector: string) {
  window.setTimeout(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    const content = windowElement?.querySelector<HTMLElement>(".squad-content");
    const target = windowElement?.querySelector<HTMLElement>(selector);
    if (content && target)
      content.scrollTop = Math.max(0, target.offsetTop - content.offsetTop - 80);
  }, 500);
}

function ensureDefaultSelection(squads: Squad[]) {
  selectedId =
    squads.find((item) => item.id === rememberedSquadId)?.id ??
    squads[0]?.id ??
    null;
}

function usageCount(squadId: string): number {
  return product.quests.filter((quest) => quest.squad_id === squadId).length;
}

function roleSummary(squad: Squad): string {
  const names = Array.from(
    new Set(
      squad.members.map(
        (member) =>
          classReference(member, classCatalog).definition?.name ??
          "Needs configuration",
      ),
    ),
  );
  return names.slice(0, 3).join(" · ");
}

function selectSquad(squad: Squad) {
  requestTransition(() => {
    selectedId = squad.id;
    rememberedSquadId = squad.id;
    mode = "detail";
    memberEditor = null;
    advancedOpen = false;
    clearIssues();
  });
}

function startCreate() {
  mode = "create";
  draft = emptySquadDraft();
  reservedMemberKeys = new Set();
  memberEditor = null;
  advancedOpen = false;
  clearIssues();
  void focusField("squad-name");
}

function beginCreate() {
  requestTransition(startCreate);
}

function startEdit(squad: Squad) {
  selectedId = squad.id;
  rememberedSquadId = squad.id;
  mode = "edit";
  draft = draftFromSquad(squad);
  reservedMemberKeys = new Set(squad.members.map((member) => member.member_key));
  memberEditor = null;
  clearIssues();
  void focusField("squad-name");
}

function cancelForm() {
  mode = "detail";
  memberEditor = null;
  clearIssues();
  void tick().then(() =>
    windowElement
      ?.querySelector<HTMLButtonElement>(`[data-squad-id="${selectedId}"]`)
      ?.focus(),
  );
}

function clearIssues() {
  squadErrors = {};
  memberErrors = {};
  localIssue = "";
}

function isDirty(): boolean {
  const editorDirty = memberEditor
    ? memberEditor.mode === "add"
      ? Boolean(
          memberEditor.name || memberEditor.classId || memberEditor.loadoutId,
        )
      : memberEditorChanged()
    : false;
  if (mode === "create")
    return (
      editorDirty ||
      Boolean(draft.name || draft.description || draft.members.length)
    );
  if (mode !== "edit" || !selectedSquad) return false;
  return (
    editorDirty ||
    JSON.stringify(draft) !== JSON.stringify(draftFromSquad(selectedSquad))
  );
}

function memberEditorChanged(): boolean {
  if (!memberEditor || memberEditor.mode !== "edit" || memberEditor.index === null)
    return false;
  const member = draft.members[memberEditor.index];
  return Boolean(
    member &&
      (memberEditor.name !== member.name ||
        memberEditor.classId !== member.class_id ||
        memberEditor.loadoutId !== member.loadout_id),
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
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
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
  if (draftReferenceIssues.length || memberEditor) return;
  const continuation = pendingContinuation;
  if (await saveSquad()) {
    pendingContinuation = null;
    dirtyDialog.close();
    continuation?.();
  }
}

function beginAddMember() {
  memberEditor = {
    mode: "add",
    index: null,
    name: "",
    classId: "",
    loadoutId: "",
    picker: null,
  };
  memberErrors = {};
  void focusField("member-name");
}

function beginEditMember(index: number) {
  const member = draft.members[index];
  if (!member) return;
  memberEditor = {
    mode: "edit",
    index,
    name: member.name,
    classId: member.class_id,
    loadoutId: member.loadout_id,
    picker: null,
  };
  memberErrors = {};
  void focusField("member-name");
}

function cancelMemberEditor() {
  memberEditor = null;
  memberErrors = {};
}

function updateMemberName(name: string) {
  if (!memberEditor) return;
  memberEditor = { ...memberEditor, name };
  const { name: _nameError, ...remainingErrors } = memberErrors;
  memberErrors = remainingErrors;
}

function chooseClass(classId: string) {
  if (!memberEditor) return;
  memberEditor = { ...memberEditor, classId, picker: null };
  const { classId: _classError, ...remainingErrors } = memberErrors;
  memberErrors = remainingErrors;
}

function chooseLoadout(loadoutId: string) {
  if (!memberEditor) return;
  memberEditor = { ...memberEditor, loadoutId, picker: null };
  const { loadoutId: _loadoutError, ...remainingErrors } = memberErrors;
  memberErrors = remainingErrors;
}

function togglePicker(picker: Exclude<Picker, null>) {
  if (!memberEditor) return;
  memberEditor = {
    ...memberEditor,
    picker: memberEditor.picker === picker ? null : picker,
  };
}

function confirmMember() {
  if (!memberEditor) return;
  const errors: MemberErrors = {};
  if (!memberEditor.name.trim()) errors.name = "Enter a Member name.";
  if (!activeClasses.some((item) => item.id === memberEditor?.classId))
    errors.classId = "Choose an active Class.";
  if (!activeLoadouts.some((item) => item.id === memberEditor?.loadoutId))
    errors.loadoutId = "Choose an active Loadout.";
  memberErrors = errors;
  if (Object.keys(errors).length) {
    void focusField(
      errors.name
        ? "member-name"
        : errors.classId
          ? "member-class-picker"
          : "member-loadout-picker",
    );
    return;
  }

  if (memberEditor.mode === "add") {
    const member: SquadMember = {
      member_key: generatedMemberKey(
        memberEditor.name,
        new Set([
          ...reservedMemberKeys,
          ...draft.members.map((item) => item.member_key),
        ]),
      ),
      name: memberEditor.name.trim(),
      class_id: memberEditor.classId,
      loadout_id: memberEditor.loadoutId,
    };
    reservedMemberKeys.add(member.member_key);
    draft = { ...draft, members: [...draft.members, member] };
  } else if (memberEditor.index !== null) {
    const existing = draft.members[memberEditor.index];
    if (!existing) return;
    const members = draft.members.map((member, index) =>
      index === memberEditor?.index
        ? {
            member_key: existing.member_key,
            name: memberEditor.name.trim(),
            class_id: memberEditor.classId,
            loadout_id: memberEditor.loadoutId,
          }
        : copyMember(member),
    );
    draft = { ...draft, members };
  }

  memberEditor = null;
  memberErrors = {};
  const { members: _memberError, ...remainingErrors } = squadErrors;
  squadErrors = remainingErrors;
}

function removeMember(index: number) {
  draft = {
    ...draft,
    members: draft.members.filter((_member, memberIndex) => memberIndex !== index),
  };
  if (memberEditor?.index === index) memberEditor = null;
}

function moveMember(index: number, direction: -1 | 1) {
  draft = {
    ...draft,
    members: moveRosterMember(draft.members, index, direction),
  };
}

function validateDraft(): boolean {
  const errors: SquadErrors = {};
  if (!draft.name.trim()) errors.name = "Enter a Squad name.";
  if (!draft.members.length)
    errors.members = "Add at least one Member to this Squad.";
  squadErrors = errors;
  if (draftReferenceIssues.length) {
    localIssue =
      "Replace every archived or unavailable Class and Loadout before saving changes.";
    return false;
  }
  if (memberEditor) {
    localIssue = "Finish or cancel the open Member editor before saving the Squad.";
    return false;
  }
  if (Object.keys(errors).length) {
    localIssue = "Review the highlighted fields and try again.";
    void focusField(errors.name ? "squad-name" : "add-member-button");
    return false;
  }
  return true;
}

async function saveSquad(): Promise<boolean> {
  if (busy || !validateDraft()) return false;
  busy = true;
  clearIssues();
  const input = squadInput(draft);

  try {
    const saved =
      mode === "edit" && selectedSquad
        ? await store.command(() =>
            store.api.updateSquad(selectedSquad.id, input),
          )
        : await store.command(() =>
            createSquadWithGeneratedKey(
              store.api,
              input,
              product.squads.map((item) => item.key),
            ),
          );
    if (!saved) {
      applyServerError(get(store.error));
      return false;
    }

    selectedId = saved.id;
    rememberedSquadId = saved.id;
    mode = "detail";
    memberEditor = null;
    await store.refreshProduct();
    return true;
  } finally {
    busy = false;
  }
}

function applyServerError(failure: ApiError | null) {
  const errors: SquadErrors = {};
  const memberFailure = (failure?.details ?? []).find(
    (detail) => detail.path[0] === "members",
  );
  for (const detail of failure?.details ?? []) {
    if (detail.path[0] === "name") errors.name = "Enter a valid Squad name.";
  }
  if (memberFailure)
    errors.members = "Review the highlighted Member configuration.";
  squadErrors = errors;
  localIssue =
    Object.keys(errors).length > 0
      ? "Review the highlighted fields and try again. Your complete draft is still here."
      : mode === "create"
        ? "Quest Engineering couldn't create that Squad. Your complete draft is still here."
        : "Quest Engineering couldn't save those Squad changes. Your complete draft is still here.";
}

async function focusField(id: string) {
  await tick();
  windowElement?.querySelector<HTMLElement>(`#${id}`)?.focus();
}

function issueSentence(issue: (typeof selectedReferenceIssues)[number]): string {
  const subject = issue.memberName || `Member ${issue.memberIndex + 1}`;
  const definition = issue.definitionName
    ? `the ${issue.state} ${issue.kind === "class" ? "Class" : "Loadout"} “${issue.definitionName}”`
    : `an unavailable ${issue.kind === "class" ? "Class" : "Loadout"}`;
  return `${subject} uses ${definition}.`;
}

function openArchiveDialog() {
  if (!selectedSquad || archiveDialog?.open) return;
  archiveDialog.showModal();
  void tick().then(() => archiveCancel?.focus());
}

async function archiveSquad() {
  if (busy || !selectedSquad) return;
  busy = true;
  const archivedId = selectedSquad.id;
  const nextId = product.squads.find((item) => item.id !== archivedId)?.id ?? null;
  const archived = await store.command(() => store.api.archiveSquad(archivedId));
  archiveDialog.close();
  if (archived) {
    if (rememberedSquadId === archivedId) rememberedSquadId = nextId;
    selectedId = nextId;
    mode = "detail";
    await store.refreshProduct();
    await tick();
    windowElement?.querySelector<HTMLButtonElement>(".squad-card")?.focus();
  } else {
    localIssue = "Quest Engineering couldn't archive this Squad.";
  }
  busy = false;
}
</script>

<aside
  bind:this={windowElement}
  class="tavern-window management-window management-window-shell panel"
  aria-labelledby="tavern-title"
>
  <header class="window-header">
    <div>
      <span class="window-kicker">Reusable Quest rosters</span>
      <h1 id="tavern-title">Tavern</h1>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label="Close Tavern"
      on:click={() => requestTransition(onClose)}>×</button
    >
  </header>

  <div class="window-body">
    <section class="squad-browser" aria-labelledby="squads-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Quest teams</span>
          <h2 id="squads-title">Squads</h2>
        </div>
        <button class="primary compact" type="button" on:click={beginCreate}
          >+ New Squad</button
        >
      </div>

      {#if product.squads.length}
        <div class="squad-list" aria-label="Squads">
          {#each product.squads as squad}
            {@const usage = usageCount(squad.id)}
            <button
              type="button"
              class="squad-card"
              class:selected={selectedId === squad.id && mode !== "create"}
              aria-pressed={selectedId === squad.id && mode !== "create"}
              data-squad-id={squad.id}
              on:click={() => selectSquad(squad)}
            >
              <span class="card-heading"><strong>{squad.name}</strong><span aria-hidden="true">◆</span></span>
              <span class="card-description">{squad.description || "No description yet."}</span>
              <span class="card-summary">{squad.members.length} {squad.members.length === 1 ? "Member" : "Members"}{roleSummary(squad) ? ` · ${roleSummary(squad)}` : ""}</span>
              {#if usage}<span class="card-usage">{activeQuestUsageLabel(usage)}</span>{/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="browser-empty">
          <span aria-hidden="true">◆</span>
          <p>No teams have gathered yet.</p>
        </div>
      {/if}
    </section>

    <section class="squad-content" aria-live="polite">
      {#if localIssue}
        <div class="friendly-error" role="alert"><span aria-hidden="true">!</span><p>{localIssue}</p></div>
      {/if}

      {#if mode === "create" || mode === "edit"}
        <div class="content-heading">
          <span class="eyebrow">{mode === "create" ? "New Quest team" : "Squad settings"}</span>
          <h2>{mode === "create" ? "Create Squad" : `Edit ${selectedSquad?.name ?? "Squad"}`}</h2>
          <p>Build a Squad by giving each Member a Class and a Loadout.</p>
        </div>

        {#if draftReferenceIssues.length}
          <section class="configuration-warning" role="status" aria-labelledby="draft-warning-title">
            <strong id="draft-warning-title">Needs configuration</strong>
            <ul>{#each draftReferenceIssues as issue}<li>{issueSentence(issue)}</li>{/each}</ul>
            <p>Replace every affected reference before saving this whole-roster update.</p>
          </section>
        {/if}

        <form class="squad-form" on:submit|preventDefault={saveSquad}>
          <div class="identity-fields">
            <label for="squad-name">Name</label>
            <input id="squad-name" bind:value={draft.name} maxlength="160" required aria-invalid={squadErrors.name ? "true" : undefined} aria-describedby={squadErrors.name ? "squad-name-error" : undefined} />
            {#if squadErrors.name}<small id="squad-name-error" class="field-error">{squadErrors.name}</small>{/if}
            <label for="squad-description">Description <span>Short, human-facing summary</span></label>
            <textarea id="squad-description" class="description-editor" rows="2" bind:value={draft.description}></textarea>
          </div>

          <div class="roster-heading">
            <div><span class="eyebrow">Ordered roster</span><h3>Members</h3></div>
            <button id="add-member-button" class="secondary compact" type="button" on:click={beginAddMember} disabled={memberEditor !== null}>+ Add Member</button>
          </div>

          {#if memberEditor}
            <section class="member-composer" aria-labelledby="member-editor-title">
              <div class="composer-heading">
                <div><span class="eyebrow">Name + Class + Loadout</span><h3 id="member-editor-title">{memberEditor.mode === "add" ? "Add Member" : `Edit ${draft.members[memberEditor.index ?? -1]?.name ?? "Member"}`}</h3></div>
                <button class="text-action" type="button" on:click={cancelMemberEditor}>Cancel</button>
              </div>

              <label for="member-name">Name</label>
              <input id="member-name" value={memberEditor.name} on:input={(event) => updateMemberName(event.currentTarget.value)} maxlength="160" required aria-invalid={memberErrors.name ? "true" : undefined} />
              {#if memberErrors.name}<small class="field-error">{memberErrors.name}</small>{/if}

              <div class="composition-grid">
                <section class="composition-choice">
                  <span class="choice-label">Class</span>
                  {#if selectedMemberClass}
                    {@const definition = selectedMemberClass}
                    <strong>{definition?.name}</strong>
                    <small>{definition?.description || "Behavior defined in the Guild Hall."}</small>
                    {#if definition?.archived_at}<span class="status-badge warning">Archived</span>{/if}
                  {:else}
                    <strong>Choose a Class…</strong>
                    <small>Defines this Member’s role and behavior.</small>
                  {/if}
                  {#if activeClasses.length}
                    <button id="member-class-picker" class="secondary compact" type="button" on:click={() => togglePicker("class")}>{selectedMemberClass ? "Change Class" : "Choose Class"}</button>
                  {:else}
                    <p class="unavailable-copy"><strong>No Classes available</strong>Create a Class in the Guild Hall before adding a Member.</p>
                  {/if}
                  {#if memberErrors.classId}<small class="field-error">{memberErrors.classId}</small>{/if}
                </section>

                <section class="composition-choice">
                  <span class="choice-label">Loadout</span>
                  {#if selectedMemberLoadout}
                    {@const definition = selectedMemberLoadout}
                    <strong>{definition?.name}</strong>
                    {#if definition}<small>{loadoutModelSummary(definition)} · {loadoutAccessSummary(definition)}</small>{/if}
                    {#if definition?.archived_at}<span class="status-badge warning">Archived</span>{/if}
                  {:else}
                    <strong>Choose a Loadout…</strong>
                    <small>Defines model, capabilities, and Project access.</small>
                  {/if}
                  {#if activeLoadouts.length}
                    <button id="member-loadout-picker" class="secondary compact" type="button" on:click={() => togglePicker("loadout")}>{selectedMemberLoadout ? "Change Loadout" : "Choose Loadout"}</button>
                  {:else}
                    <p class="unavailable-copy"><strong>No Loadouts available</strong>Create a Loadout in the Forge before adding a Member.</p>
                  {/if}
                  {#if memberErrors.loadoutId}<small class="field-error">{memberErrors.loadoutId}</small>{/if}
                </section>
              </div>

              {#if memberEditor.picker === "class"}
                <div class="definition-picker" aria-label="Choose a Class">
                  <span class="eyebrow">Active Classes</span>
                  {#each activeClasses as definition}
                    <button type="button" aria-pressed={memberEditor.classId === definition.id} on:click={() => chooseClass(definition.id)}><strong>{definition.name}</strong><span>{definition.description || "Behavior defined in the Guild Hall."}</span></button>
                  {/each}
                </div>
              {:else if memberEditor.picker === "loadout"}
                <div class="definition-picker" aria-label="Choose a Loadout">
                  <span class="eyebrow">Active Loadouts</span>
                  {#each activeLoadouts as definition}
                    <button type="button" aria-pressed={memberEditor.loadoutId === definition.id} on:click={() => chooseLoadout(definition.id)}><strong>{definition.name}</strong><span>{loadoutModelSummary(definition)} · {loadoutAccessSummary(definition)}</span></button>
                  {/each}
                </div>
              {/if}

              {#if memberEditor.name || selectedMemberClass || selectedMemberLoadout}
                <div class="member-preview" aria-label="Member composition preview">
                  <strong>{memberEditor.name || "Unnamed Member"}</strong>
                  <span>{selectedMemberClass?.name ?? "Choose a Class"}</span>
                  <span>{selectedMemberLoadout?.name ?? "Choose a Loadout"}</span>
                </div>
              {/if}

              <div class="composer-actions">
                <button class="secondary" type="button" on:click={cancelMemberEditor}>Cancel</button>
                <button class="primary" type="button" on:click={confirmMember} disabled={!memberCanConfirm}>{memberEditor.mode === "add" ? "Add Member" : "Save Member"}</button>
              </div>
            </section>
          {/if}

          {#if draft.members.length}
            <div class="editable-roster" aria-label="Squad roster">
              {#each draft.members as member, index (member.member_key)}
                {@const classRef = classReference(member, classCatalog)}
                {@const loadoutRef = loadoutReference(member, loadoutCatalog)}
                <article class="member-card editable" data-member-key={member.member_key}>
                  <div class="member-heading"><span class="member-avatar" aria-hidden="true">{member.name.slice(0, 1).toLocaleUpperCase()}</span><div><h4>{member.name}</h4><small>Roster position {index + 1}</small></div></div>
                  <div class="member-definition"><span>Class</span><strong>{classRef.definition?.name ?? "Unavailable Class"}</strong>{#if classRef.state !== "active"}<em>{classRef.state === "archived" ? "Archived" : "Unavailable"}</em>{/if}</div>
                  <div class="member-definition"><span>Loadout</span><strong>{loadoutRef.definition?.name ?? "Unavailable Loadout"}</strong>{#if loadoutRef.definition}<small>{loadoutModelSummary(loadoutRef.definition)} · {loadoutAccessSummary(loadoutRef.definition)}</small>{/if}{#if loadoutRef.state !== "active"}<em>{loadoutRef.state === "archived" ? "Archived" : "Unavailable"}</em>{/if}</div>
                  <div class="member-actions">
                    <button class="secondary compact" type="button" aria-label={`Move ${member.name} up`} on:click={() => moveMember(index, -1)} disabled={index === 0}>↑ Move up</button>
                    <button class="secondary compact" type="button" aria-label={`Move ${member.name} down`} on:click={() => moveMember(index, 1)} disabled={index === draft.members.length - 1}>↓ Move down</button>
                    <button class="text-action" type="button" aria-label={`Edit ${member.name}`} on:click={() => beginEditMember(index)}>Edit</button>
                    <button class="text-action danger-text" type="button" aria-label={`Remove ${member.name}`} on:click={() => removeMember(index)}>Remove</button>
                  </div>
                </article>
              {/each}
            </div>
          {:else}
            <div class="roster-empty"><strong>No Members yet</strong><p>Add at least one Member before saving this Squad.</p></div>
          {/if}
          {#if squadErrors.members}<small class="field-error roster-error">{squadErrors.members}</small>{/if}

          <div class="action-row form-actions">
            <button class="secondary" type="button" on:click={cancelForm}>Cancel</button>
            <button class="primary" type="submit" disabled={busy || draftReferenceIssues.length > 0 || memberEditor !== null}>{mode === "create" ? "Create Squad" : "Save Changes"}</button>
          </div>
        </form>
      {:else if selectedSquad}
        <div class="content-heading detail-heading">
          <span class="eyebrow">Squad · Quest roster</span>
          <h2>{selectedSquad.name}</h2>
          <p>{selectedSquad.description || "No description yet."}</p>
          {#if selectedUsage}<strong class="usage-line">{activeQuestUsageLabel(selectedUsage)}</strong>{/if}
        </div>

        {#if selectedReferenceIssues.length}
          <section class="configuration-warning" role="status" aria-labelledby="configuration-warning-title">
            <strong id="configuration-warning-title">Needs configuration</strong>
            <ul>{#each selectedReferenceIssues as issue}<li>{issueSentence(issue)}</li>{/each}</ul>
            <p>Update affected Members before saving changes or using this Squad for new Quest Runs.</p>
          </section>
        {/if}

        <section class="roster-detail" aria-labelledby="roster-title">
          <div class="roster-heading"><div><span class="eyebrow">Named team</span><h3 id="roster-title">Roster</h3></div><span>{selectedSquad.members.length} {selectedSquad.members.length === 1 ? "Member" : "Members"}</span></div>
          {#if selectedSquad.members.length}
            <div class="member-grid">
              {#each selectedSquad.members as member}
                {@const classRef = classReference(member, classCatalog)}
                {@const loadoutRef = loadoutReference(member, loadoutCatalog)}
                <article class="member-card">
                  <div class="member-heading"><span class="member-avatar" aria-hidden="true">{member.name.slice(0, 1).toLocaleUpperCase()}</span><h4>{member.name}</h4></div>
                  <div class="member-definition"><span>Class</span><strong>{classRef.definition?.name ?? "Unavailable Class"}</strong>{#if classRef.definition?.description}<small>{classRef.definition.description}</small>{/if}{#if classRef.state !== "active"}<em>{classRef.state === "archived" ? "Archived" : "Unavailable"}</em>{/if}</div>
                  <div class="member-definition loadout"><span>Loadout</span><strong>{loadoutRef.definition?.name ?? "Unavailable Loadout"}</strong>{#if loadoutRef.definition}<small>{loadoutModelSummary(loadoutRef.definition)} · {loadoutAccessSummary(loadoutRef.definition)}</small>{/if}{#if loadoutRef.state !== "active"}<em>{loadoutRef.state === "archived" ? "Archived" : "Unavailable"}</em>{/if}</div>
                </article>
              {/each}
            </div>
          {:else}
            <div class="roster-empty"><strong>No Members</strong><p>This Squad cannot be used for new Runs until its roster is configured.</p></div>
          {/if}
        </section>

        <details class="advanced" bind:open={advancedOpen}>
          <summary>Advanced</summary>
          <dl><dt>Squad key</dt><dd><code>{selectedSquad.key}</code> <small>Immutable</small></dd></dl>
        </details>
        <div class="detail-actions"><button class="secondary" type="button" on:click={() => startEdit(selectedSquad)}>Edit Squad</button><button class="archive-action" type="button" on:click={openArchiveDialog}>Archive</button></div>
      {:else if product.squads.length}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">◆</span><h3>Choose a Squad</h3><p>Select a team to inspect its named roster, Classes, and Loadouts.</p></div>
      {:else}
        <div class="empty-state detail-empty"><span class="empty-icon" aria-hidden="true">◆</span><h3>No Squads yet</h3><p>Squads bring Classes and Loadouts together into reusable teams for your Quests.</p><button class="primary" type="button" on:click={startCreate}>Create Squad</button></div>
      {/if}
    </section>
  </div>

  <dialog bind:this={archiveDialog} aria-labelledby="archive-squad-title">
    <div class="dialog-card"><span class="dialog-icon" aria-hidden="true">!</span><h2 id="archive-squad-title">Archive {selectedSquad?.name}?</h2>{#if selectedUsage}<strong class="dialog-usage">{activeQuestUsageLabel(selectedUsage)}.</strong>{/if}<p>This Squad will no longer be available for new Quest configuration or new Runs. Existing Quests retain their reference, but cannot launch with this archived Squad.</p><p>Existing Run history remains intact.</p><div class="action-row"><button bind:this={archiveCancel} class="secondary" type="button" on:click={() => archiveDialog.close()}>Cancel</button><button class="destructive" type="button" on:click={archiveSquad} disabled={busy}>Archive Squad</button></div></div>
  </dialog>

  <dialog bind:this={dirtyDialog} aria-labelledby="dirty-squad-title">
    <div class="dialog-card"><span class="dialog-icon amber" aria-hidden="true">◆</span><h2 id="dirty-squad-title">Unsaved Squad changes</h2><p>Keep editing, discard the complete roster draft, or save it before continuing.</p>{#if draftReferenceIssues.length}<p class="dialog-warning">Save is unavailable until every Member uses an active Class and Loadout.</p>{/if}<div class="dirty-actions"><button bind:this={dirtyKeepButton} class="secondary" type="button" on:click={keepEditing}>Keep Editing</button><button class="secondary" type="button" on:click={discardAndContinue}>Discard</button><button class="primary" type="button" on:click={saveAndContinue} disabled={busy || draftReferenceIssues.length > 0 || memberEditor !== null}>Save</button></div></div>
  </dialog>
</aside>

<style>
  .window-body { display: grid; grid-template-columns: minmax(16rem, .66fr) minmax(30rem, 1.34fr); height: min(38rem, calc(100vh - 10.4rem)); overflow: hidden; }
  .squad-browser, .squad-content { min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .squad-browser { padding: 1rem; background: linear-gradient(150deg, #edd3a4, #f4dfb8); border-right: 1px solid #c9a878; }
  .squad-content { padding: 1.35rem 1.6rem; background: var(--app-cream); }
  .section-heading, .roster-heading, .composer-heading, .member-heading, .detail-actions, .member-actions, .composer-actions { display: flex; align-items: center; }
  .section-heading, .roster-heading, .composer-heading { justify-content: space-between; gap: .8rem; }
  .section-heading h2, .content-heading h2, .roster-heading h3, .member-composer h3 { margin: .05rem 0; color: var(--app-ink); font-family: Georgia, ui-serif, serif; }
  .section-heading h2 { font-size: 1.25rem; }
  .content-heading h2 { margin-top: .08rem; font-size: 1.9rem; line-height: 1.05; }
  .content-heading p { margin: .35rem 0 0; color: var(--app-muted); line-height: 1.4; }
  .squad-list { display: grid; gap: .65rem; margin-top: .85rem; }
  .squad-card { display: grid; gap: .2rem; width: 100%; min-height: 0; padding: .75rem .85rem; text-align: left; color: var(--app-ink); background: #fff4d8; border: 1px solid #c5a374; box-shadow: 0 2px 5px #75513e22; }
  .squad-card:hover { background: #fff8e8; border-color: #9f794c; }
  .squad-card.selected { color: #fff9e8; background: #548b83; border-color: #35645f; box-shadow: inset 4px 0 #e2aa48, 0 4px 8px #36544c33; }
  .card-heading { display: flex; justify-content: space-between; gap: .5rem; font: 700 1rem Georgia, ui-serif, serif; }
  .card-description { display: -webkit-box; overflow: hidden; color: var(--app-muted); font-size: .8rem; line-height: 1.25; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .selected .card-description, .selected .card-summary, .selected .card-usage { color: #e5f3e8; }
  .card-summary, .card-usage { color: #5d7069; font-size: .72rem; }
  .card-usage { margin-top: .18rem; font-weight: 750; }
  .browser-empty { display: grid; justify-items: center; gap: .45rem; padding: 3rem 1rem; color: #796851; text-align: center; }
  .content-heading { margin-bottom: 1rem; }
  .usage-line { display: block; margin-top: .45rem; color: var(--app-teal-dark); font-size: .78rem; }
  .configuration-warning { margin: .8rem 0 1rem; padding: .8rem .9rem; color: #6f4931; background: #f5dfb5; border-left: 4px solid var(--app-amber); border-radius: 7px; }
  .configuration-warning > strong { font: 700 1.05rem Georgia, ui-serif, serif; }
  .configuration-warning ul { margin: .45rem 0; padding-left: 1.2rem; }
  .configuration-warning p { margin: .35rem 0 0; color: #755c45; font-size: .8rem; line-height: 1.4; }
  .squad-form label, .member-composer label { display: block; margin: .58rem 0 .2rem; color: #625448; font-size: .78rem; font-weight: 750; }
  .squad-form label span { color: var(--app-muted); font-weight: 400; }
  .squad-form input, .squad-form textarea, .member-composer input { width: 100%; box-sizing: border-box; padding: .58rem .65rem; color: var(--app-ink); background: #fffdf5; border: 1px solid #c49d68; border-radius: 7px; }
  .description-editor { min-height: 3.2rem; resize: vertical; }
  .identity-fields { padding-bottom: .85rem; border-bottom: 1px solid #dbc39b; }
  .roster-heading { margin: 1rem 0 .6rem; }
  .roster-heading h3 { font-size: 1.2rem; }
  .roster-heading > span { color: var(--app-muted); font-size: .78rem; }
  .member-grid, .editable-roster { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .editable-roster { grid-template-columns: 1fr; }
  .member-card { position: relative; display: grid; gap: .55rem; padding: .8rem; background: #f7e8c7; border: 1px solid #d8bd8e; border-radius: 9px; }
  .member-card.editable { grid-template-columns: minmax(8rem, .7fr) minmax(8rem, .8fr) minmax(11rem, 1.15fr); align-items: center; }
  .member-heading { gap: .55rem; }
  .member-heading h4 { margin: 0; color: var(--app-ink); font: 700 1.15rem Georgia, ui-serif, serif; }
  .member-heading small { color: var(--app-muted); font-size: .68rem; }
  .member-avatar { display: grid; flex: 0 0 auto; place-items: center; width: 2.2rem; height: 2.2rem; color: #fff9e8; background: var(--app-teal); border-radius: 50%; font: 800 .9rem Georgia, ui-serif, serif; }
  .member-definition { position: relative; display: grid; gap: .08rem; min-width: 0; }
  .member-definition > span, .choice-label { color: #776a5b; font-size: .62rem; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
  .member-definition strong { color: #3b4b4b; font-size: .86rem; }
  .member-definition small { overflow: hidden; color: var(--app-muted); font-size: .69rem; line-height: 1.25; text-overflow: ellipsis; }
  .member-definition em { width: fit-content; margin-top: .18rem; padding: .08rem .38rem; color: #7c433c; background: #f4d1c7; border-radius: 999px; font-size: .65rem; font-style: normal; font-weight: 800; }
  .member-actions { grid-column: 1 / -1; justify-content: flex-end; flex-wrap: wrap; gap: .35rem; padding-top: .45rem; border-top: 1px solid #ddc49a; }
  .text-action, .archive-action { min-height: 2rem !important; padding: .25rem .45rem; color: var(--app-teal-dark); background: transparent; border: 0; font-weight: 750; }
  .danger-text, .archive-action { color: #ae504b; }
  .roster-empty { padding: 1.5rem; color: var(--app-muted); background: #f3e3c3; border: 1px dashed #c6a676; border-radius: 9px; text-align: center; }
  .roster-empty p { margin: .3rem 0 0; }
  .member-composer { margin: .7rem 0; padding: 1rem; background: #f2dfb9; border: 1px solid #c59e68; border-radius: 10px; box-shadow: 0 5px 14px #6f523122; }
  .composition-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; margin-top: .7rem; }
  .composition-choice { display: grid; align-content: start; gap: .18rem; padding: .65rem; background: #fff7e6; border: 1px solid #d5b787; border-radius: 8px; }
  .composition-choice small { color: var(--app-muted); line-height: 1.3; }
  .composition-choice button { margin-top: .45rem; }
  .status-badge { width: fit-content; margin-top: .2rem; padding: .12rem .4rem; border-radius: 999px; font-size: .65rem; font-weight: 800; }
  .status-badge.warning { color: #773e39; background: #f3cec3; }
  .unavailable-copy { display: grid; gap: .18rem; margin: .45rem 0 0; color: #765e49; font-size: .72rem; line-height: 1.35; }
  .definition-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; margin-top: .65rem; padding: .65rem; background: #fff5de; border: 1px solid #d3b27d; border-radius: 8px; }
  .definition-picker > .eyebrow { grid-column: 1 / -1; }
  .definition-picker button { display: grid; gap: .15rem; min-height: 0; padding: .55rem; color: var(--app-ink); background: #fffdf5; border: 1px solid #c7a675; text-align: left; }
  .definition-picker button[aria-pressed="true"] { background: #e0eee3; border: 2px solid var(--app-teal); }
  .definition-picker span { color: var(--app-muted); font-size: .7rem; }
  .member-preview { display: flex; flex-wrap: wrap; gap: .35rem .7rem; margin-top: .65rem; padding: .55rem .65rem; color: #435c58; background: #e2ecdf; border-left: 3px solid var(--app-teal); border-radius: 5px; }
  .member-preview strong { flex-basis: 100%; }
  .member-preview span { font-size: .75rem; }
  .composer-actions { justify-content: flex-end; gap: .5rem; margin-top: .75rem; }
  .field-error { display: block; margin-top: .18rem; color: #a54742; font-weight: 750; }
  .roster-error { margin: .45rem 0; }
  .form-actions { padding-top: .8rem; border-top: 1px solid #dbc39b; }
  .advanced { margin-top: .85rem; padding: .7rem 0; border-top: 1px solid #dbc39b; border-bottom: 1px solid #dbc39b; }
  .advanced summary { color: #65584c; cursor: pointer; font-weight: 800; }
  .advanced dl { display: grid; grid-template-columns: 7rem 1fr; gap: .45rem; margin: .75rem 0 .2rem; font-size: .78rem; }
  .advanced dt { color: var(--app-muted); }
  .advanced dd { margin: 0; }
  .advanced small { color: var(--app-muted); }
  .detail-actions { justify-content: space-between; margin-top: .8rem; }
  .detail-empty { min-height: 20rem; align-content: center; }
  .empty-icon { font-size: 2rem; color: var(--app-teal); }
  .dialog-card p + p { margin-top: .45rem; }
  .dialog-usage { margin: .25rem 0 .55rem; color: var(--app-teal-dark); }
  .dirty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .55rem; margin-top: 1.2rem; }
  .dialog-icon.amber { background: var(--app-amber); }
  .dialog-warning { color: #8a493f !important; font-weight: 700; }

  @media (max-width: 1000px) {
    .window-body { grid-template-columns: minmax(14rem, .62fr) minmax(24rem, 1.38fr); height: min(34rem, calc(100vh - 10.3rem)); }
    .squad-content { padding: 1rem; }
    .member-grid { grid-template-columns: 1fr; }
    .member-card.editable { grid-template-columns: 1fr 1fr; }
    .member-card.editable .member-heading { grid-column: 1 / -1; }
  }

  @media (max-width: 720px) {
    .window-body { display: block; overflow: auto; }
    .squad-browser, .squad-content { overflow: visible; }
    .squad-browser { border-right: 0; border-bottom: 1px solid #c9a878; }
    .squad-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .composition-grid, .definition-picker, .member-card.editable { grid-template-columns: 1fr; }
  }
</style>
