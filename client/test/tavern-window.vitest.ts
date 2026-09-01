import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { writable } from "svelte/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SquadInput } from "../src/api/client";
import {
  ApiError,
  type ClassDefinition,
  type Loadout,
  type Quest,
  type Squad,
} from "../src/api/contracts";
import TavernWindow from "../src/components/tavern/TavernWindow.svelte";
import type { AppStore, ProductState } from "../src/state/app-store";

const builder: ClassDefinition = {
  id: "class-builder",
  key: "builder",
  name: "Builder",
  description: "Builds Product changes.",
  instructions: "Build.",
  archived_at: null,
};
const reviewer: ClassDefinition = {
  id: "class-reviewer",
  key: "reviewer",
  name: "Reviewer",
  description: "Reviews completed work.",
  instructions: "Review.",
  archived_at: null,
};
const coding: Loadout = {
  id: "loadout-coding",
  key: "coding",
  name: "Coding",
  description: "Implementation equipment.",
  model: { provider: "fixture", model: "town-model" },
  reasoning: "high",
  tools: ["workspace.filesystem", "terminal.shell"],
  workspace_access: "read_write",
  archived_at: null,
};
const review: Loadout = {
  ...coding,
  id: "loadout-review",
  key: "review",
  name: "Review",
  reasoning: "medium",
  workspace_access: "read_only",
};
const pair: Squad = {
  id: "squad-pair",
  key: "engineering-pair",
  name: "Engineering Pair",
  description: "Implementation and review team.",
  members: [
    {
      member_key: "rowan",
      name: "Rowan",
      class_id: builder.id,
      loadout_id: coding.id,
    },
    {
      member_key: "mira",
      name: "Mira",
      class_id: reviewer.id,
      loadout_id: review.id,
    },
  ],
  archived_at: null,
};
const backend: Squad = {
  ...pair,
  id: "squad-backend",
  key: "backend-team",
  name: "Backend Team",
  members: pair.members.slice(0, 1),
};
const quest = (id: string): Quest => ({
  id,
  title: id,
  objective: "Test Tavern.",
  workspace_id: "workspace",
  squad_id: pair.id,
  tactic_source: { type: "definition", tactic_definition_id: "tactic" },
  completion: { completed_at: null, completed_by_run_id: null },
  lifecycle: {
    state: "working",
    label: "Working",
    current_run_id: null,
    primary_action: null,
  },
  archived_at: null,
});

const product: ProductState = {
  classes: [builder, reviewer],
  classCatalog: [builder, reviewer],
  loadouts: [coding, review],
  loadoutCatalog: [coding, review],
  squads: [pair, backend],
  tactics: [],
  quests: [quest("one"), quest("two"), quest("three")],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [],
  runs: [],
};

type StoreOptions = {
  createSquad?: (input: Required<SquadInput>) => Promise<Squad>;
  updateSquad?: (id: string, input: SquadInput) => Promise<Squad>;
  archiveSquad?: (id: string) => Promise<Squad>;
};

function fakeStore(options: StoreOptions = {}): AppStore {
  const error = writable<ApiError | null>(null);
  const api = {
    createSquad: vi.fn(
      options.createSquad ??
        (async (input: Required<SquadInput>) => ({
          ...pair,
          id: "squad-created",
          ...input,
        })),
    ),
    updateSquad: vi.fn(
      options.updateSquad ??
        (async (_id: string, input: SquadInput) => ({ ...pair, ...input })),
    ),
    archiveSquad: vi.fn(
      options.archiveSquad ??
        (async () => ({ ...pair, archived_at: "2026-01-01T00:00:00Z" })),
    ),
  };
  return {
    api,
    error,
    command: async <T>(operation: () => Promise<T>) => {
      error.set(null);
      try {
        return await operation();
      } catch (cause) {
        error.set(
          cause instanceof ApiError
            ? cause
            : new ApiError("client_error", "Failed"),
        );
        return null;
      }
    },
    refreshProduct: vi.fn(async () => undefined),
    loadTavernCatalogs: vi.fn(async () => undefined),
  } as unknown as AppStore;
}

function renderTavern(
  state: ProductState = product,
  store = fakeStore(),
  onClose = vi.fn(),
) {
  return {
    ...render(TavernWindow, {
      props: { store, product: state, onClose, scene: "engineering" },
    }),
    store,
    onClose,
  };
}

function memberComposer() {
  const heading = screen.getByRole("heading", {
    name: /Add Member|Edit /,
    level: 3,
  });
  const composer = heading.closest("section");
  if (!composer) throw new Error("Member composer was not rendered");
  return within(composer);
}

async function chooseMemberComposition(
  name: string,
  className = "Builder",
  loadoutName = "Coding",
) {
  const composer = memberComposer();
  await fireEvent.input(composer.getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
  await fireEvent.click(
    composer.getByRole("button", { name: /Choose Class|Change Class/ }),
  );
  await fireEvent.click(
    composer.getByRole("button", { name: new RegExp(`^${className}`) }),
  );
  await fireEvent.click(
    composer.getByRole("button", { name: /Choose Loadout|Change Loadout/ }),
  );
  await fireEvent.click(
    composer.getByRole("button", { name: new RegExp(`^${loadoutName}`) }),
  );
}

afterEach(cleanup);

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

test("opens browse-first with active Squad cards and read-only roster detail", () => {
  renderTavern();
  expect(
    screen
      .getByRole("button", { name: /Engineering Pair/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByRole("heading", { name: "Engineering Pair", level: 2 }),
  ).toBeTruthy();
  expect(screen.getByText("Rowan")).toBeTruthy();
  expect(screen.getAllByText("Used by 3 active Quests").length).toBeGreaterThan(
    0,
  );
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  const technicalKey = screen.getByText("engineering-pair");
  expect(
    (technicalKey.closest("details") as HTMLDetailsElement | null)?.open,
  ).toBe(false);
  expect(screen.queryByText("rowan")).toBeNull();
});

test("selects another Squad card without entering Edit", async () => {
  renderTavern();
  await fireEvent.click(screen.getByRole("button", { name: /Backend Team/ }));
  expect(
    screen.getByRole("heading", { name: "Backend Team", level: 2 }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit Squad" })).toBeTruthy();
});

test("shows an intentional empty Tavern state", () => {
  renderTavern({ ...product, squads: [], quests: [] });
  expect(screen.getByRole("heading", { name: "No Squads yet" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create Squad" })).toBeTruthy();
});

test("Create is explicit, hides immutable key, and Cancel returns to detail", async () => {
  renderTavern();
  await fireEvent.click(screen.getByRole("button", { name: "+ New Squad" }));
  expect(screen.getByRole("heading", { name: "Create Squad" })).toBeTruthy();
  expect(screen.queryByLabelText(/Squad key/i)).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Engineering Pair", level: 2 }),
  ).toBeTruthy();
});

test("adding a Member requires intentional Class and Loadout choices", async () => {
  renderTavern();
  await fireEvent.click(screen.getByRole("button", { name: "+ New Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  const composer = memberComposer();
  expect(composer.getByText("Choose a Class…")).toBeTruthy();
  expect(composer.getByText("Choose a Loadout…")).toBeTruthy();
  expect(
    (composer.getByRole("button", { name: "Add Member" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByText("New Member")).toBeNull();
});

test("Add Member enables when Class and Loadout are chosen before Name", async () => {
  renderTavern();
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  const composer = memberComposer();
  const addButton = composer.getByRole("button", {
    name: "Add Member",
  }) as HTMLButtonElement;
  await fireEvent.click(composer.getByRole("button", { name: "Choose Class" }));
  await fireEvent.click(composer.getByRole("button", { name: /^Builder/ }));
  expect(composer.getByRole("button", { name: "Change Class" })).toBeTruthy();
  await fireEvent.click(
    composer.getByRole("button", { name: "Choose Loadout" }),
  );
  await fireEvent.click(composer.getByRole("button", { name: /^Coding/ }));
  expect(composer.getByRole("button", { name: "Change Loadout" })).toBeTruthy();
  expect(composer.getAllByText("Builder").length).toBeGreaterThan(0);
  expect(composer.getAllByText("Coding").length).toBeGreaterThan(0);
  expect(addButton.disabled).toBe(true);
  await fireEvent.input(composer.getByRole("textbox", { name: "Name" }), {
    target: { value: "Theo" },
  });
  expect(addButton.disabled).toBe(false);
  await fireEvent.click(addButton);
  expect(screen.getByRole("button", { name: "Edit Theo" })).toBeTruthy();
});

test("Member name remains required after Class and Loadout are chosen", async () => {
  renderTavern();
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  const composer = memberComposer();
  await fireEvent.click(composer.getByRole("button", { name: "Choose Class" }));
  await fireEvent.click(composer.getByRole("button", { name: /^Builder/ }));
  await fireEvent.click(
    composer.getByRole("button", { name: "Choose Loadout" }),
  );
  await fireEvent.click(composer.getByRole("button", { name: /^Coding/ }));
  expect(
    (composer.getByRole("button", { name: "Add Member" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("explains unavailable Class and Loadout prerequisites", async () => {
  renderTavern({
    ...product,
    classes: [],
    classCatalog: [],
    loadouts: [],
    loadoutCatalog: [],
  });
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  expect(screen.getByText("No Classes available")).toBeTruthy();
  expect(screen.getByText(/Create a Class in the Guild Hall/)).toBeTruthy();
  expect(screen.getByText("No Loadouts available")).toBeTruthy();
  expect(screen.getByText(/Create a Loadout in the Forge/)).toBeTruthy();
});

test("creates a Squad with generated keys and canonical Member payload only", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "+ New Squad" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Platform Pair" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  await chooseMemberComposition("Alex");
  await fireEvent.click(
    memberComposer().getByRole("button", { name: "Add Member" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Create Squad" }));

  const payload = vi.mocked(store.api.createSquad).mock.calls[0]?.[0];
  expect(payload?.key).toBe("platform-pair");
  expect(payload?.members[0]).toEqual({
    member_key: "alex",
    name: "Alex",
    class_id: builder.id,
    loadout_id: coding.id,
  });
  expect(Object.keys(payload?.members[0] ?? {}).sort()).toEqual([
    "class_id",
    "loadout_id",
    "member_key",
    "name",
  ]);
});

test("new Member key is stable after the Member is added to an unsaved draft", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "+ New Squad" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "New Pair" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  await chooseMemberComposition("Rowan");
  await fireEvent.click(
    memberComposer().getByRole("button", { name: "Add Member" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Edit Rowan" }));
  await fireEvent.input(
    memberComposer().getByRole("textbox", { name: "Name" }),
    {
      target: { value: "Rowan Smith" },
    },
  );
  await fireEvent.click(
    memberComposer().getByRole("button", { name: "Save Member" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Create Squad" }));
  expect(
    vi.mocked(store.api.createSquad).mock.calls[0]?.[0].members[0],
  ).toMatchObject({
    member_key: "rowan",
    name: "Rowan Smith",
  });
});

test("Member key collisions use deterministic suffixes", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  await chooseMemberComposition("Rowan");
  await fireEvent.click(
    memberComposer().getByRole("button", { name: "Add Member" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    vi.mocked(store.api.updateSquad).mock.calls[0]?.[1].members?.at(-1)
      ?.member_key,
  ).toBe("rowan-2");
});

test("rename, Class change, and Loadout change preserve persisted Member identity", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "Edit Rowan" }));
  const composer = memberComposer();
  await fireEvent.input(composer.getByRole("textbox", { name: "Name" }), {
    target: { value: "Ro" },
  });
  await fireEvent.click(composer.getByRole("button", { name: "Change Class" }));
  await fireEvent.click(composer.getByRole("button", { name: /^Reviewer/ }));
  await fireEvent.click(
    composer.getByRole("button", { name: "Change Loadout" }),
  );
  await fireEvent.click(composer.getByRole("button", { name: /^Review/ }));
  await fireEvent.click(composer.getByRole("button", { name: "Save Member" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    vi.mocked(store.api.updateSquad).mock.calls[0]?.[1].members?.[0],
  ).toEqual({
    member_key: "rowan",
    name: "Ro",
    class_id: reviewer.id,
    loadout_id: review.id,
  });
});

test("remove and accessible reorder remain local until one whole-roster Save", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "Move Mira up" }));
  expect(
    screen.getAllByText(/Roster position/).map((node) => node.textContent),
  ).toEqual(["Roster position 1", "Roster position 2"]);
  await fireEvent.click(screen.getByRole("button", { name: "Remove Rowan" }));
  expect(store.api.updateSquad).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(vi.mocked(store.api.updateSquad).mock.calls[0]?.[1].members).toEqual([
    pair.members[1],
  ]);
});

test("reorder persists exact visible order without regenerating identity", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "Move Mira up" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    vi
      .mocked(store.api.updateSquad)
      .mock.calls[0]?.[1].members?.map((member) => member.member_key),
  ).toEqual(["mira", "rowan"]);
});

test("archived references render truthfully and viewing never mutates persisted data", async () => {
  const archivedReviewer = { ...reviewer, archived_at: "2026-01-01T00:00:00Z" };
  const archivedReview = { ...review, archived_at: "2026-01-01T00:00:00Z" };
  const state = {
    ...product,
    classes: [builder],
    classCatalog: [builder, archivedReviewer],
    loadouts: [coding],
    loadoutCatalog: [coding, archivedReview],
    squads: [pair],
  };
  const original = structuredClone(pair);
  renderTavern(state);
  expect(screen.getByText("Needs configuration")).toBeTruthy();
  expect(
    screen.getByText(/Mira uses the archived Class “Reviewer”/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Mira uses the archived Loadout “Review”/),
  ).toBeTruthy();
  expect(screen.getAllByText("Archived").length).toBe(2);
  expect(pair).toEqual(original);
});

test("Edit preserves archived references and blocks unrelated whole-roster saves", async () => {
  const archivedReviewer = { ...reviewer, archived_at: "2026-01-01T00:00:00Z" };
  const archivedReview = { ...review, archived_at: "2026-01-01T00:00:00Z" };
  const state = {
    ...product,
    classes: [builder],
    classCatalog: [builder, archivedReviewer],
    loadouts: [coding],
    loadoutCatalog: [coding, archivedReview],
    squads: [pair],
  };
  const store = fakeStore();
  renderTavern(state, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  expect(screen.getAllByText("Archived").length).toBe(2);
  await fireEvent.input(
    screen.getByLabelText("Description Short, human-facing summary"),
    {
      target: { value: "Unrelated edit" },
    },
  );
  expect(
    (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(store.api.updateSquad).not.toHaveBeenCalled();
});

test("replacing every archived reference permits the ordinary atomic update", async () => {
  const archivedReviewer = { ...reviewer, archived_at: "2026-01-01T00:00:00Z" };
  const archivedReview = { ...review, archived_at: "2026-01-01T00:00:00Z" };
  const state = {
    ...product,
    classes: [builder],
    classCatalog: [builder, archivedReviewer],
    loadouts: [coding],
    loadoutCatalog: [coding, archivedReview],
    squads: [pair],
  };
  const store = fakeStore();
  renderTavern(state, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "Edit Mira" }));
  const composer = memberComposer();
  await fireEvent.click(composer.getByRole("button", { name: "Change Class" }));
  await fireEvent.click(composer.getByRole("button", { name: /^Builder/ }));
  await fireEvent.click(
    composer.getByRole("button", { name: "Change Loadout" }),
  );
  await fireEvent.click(composer.getByRole("button", { name: /^Coding/ }));
  await fireEvent.click(composer.getByRole("button", { name: "Save Member" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    vi.mocked(store.api.updateSquad).mock.calls[0]?.[1].members?.[1],
  ).toEqual({
    member_key: "mira",
    name: "Mira",
    class_id: builder.id,
    loadout_id: coding.id,
  });
});

test("failed Save retains complete roster draft and order", async () => {
  const store = fakeStore({
    updateSquad: async () => {
      throw new ApiError("validation_failed", "No", [], {});
    },
  });
  renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.click(screen.getByRole("button", { name: "Move Mira up" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Member" }));
  await chooseMemberComposition("Theo");
  await fireEvent.click(
    memberComposer().getByRole("button", { name: "Add Member" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Remove Rowan" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(
    screen.getByRole("heading", { name: /Edit Engineering Pair/ }),
  ).toBeTruthy();
  expect(screen.getByText("Theo")).toBeTruthy();
  expect(screen.queryByText("Rowan")).toBeNull();
  expect(screen.getByText(/complete draft is still here/)).toBeTruthy();
});

test("selection and close use the shared dirty-state choices", async () => {
  const onClose = vi.fn();
  renderTavern(product, fakeStore(), onClose);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.input(
    screen.getByLabelText("Description Short, human-facing summary"),
    {
      target: { value: "Dirty" },
    },
  );
  await fireEvent.click(screen.getByRole("button", { name: /Backend Team/ }));
  expect(
    screen.getByRole("dialog", { name: "Unsaved Squad changes" }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
  expect(
    screen.getByRole("heading", { name: /Edit Engineering Pair/ }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Close Tavern" }));
  expect(onClose).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("Save-before-navigation awaits success and failed Save keeps editing", async () => {
  let reject = true;
  const updateSquad = vi.fn(async (_id: string, input: SquadInput) => {
    if (reject) throw new ApiError("validation_failed", "No", [], {});
    return { ...pair, ...input };
  });
  const store = fakeStore({ updateSquad });
  const view = renderTavern(product, store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit Squad" }));
  await fireEvent.input(
    screen.getByLabelText("Description Short, human-facing summary"),
    {
      target: { value: "Dirty" },
    },
  );
  const continuation = vi.fn();
  view.component.requestLeave(continuation);
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(updateSquad).toHaveBeenCalledTimes(1));
  expect(continuation).not.toHaveBeenCalled();
  expect(
    screen.getByRole("heading", { name: /Edit Engineering Pair/ }),
  ).toBeTruthy();

  reject = false;
  view.component.requestLeave(continuation);
  await fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(continuation).toHaveBeenCalledOnce());
});

test("Advanced and archive dialog expose only appropriate technical and usage detail", async () => {
  const store = fakeStore();
  renderTavern(product, store);
  await fireEvent.click(screen.getByText("Advanced"));
  expect(screen.getByText("engineering-pair")).toBeTruthy();
  expect(screen.queryByText("rowan")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(
    screen.getByRole("dialog", { name: "Archive Engineering Pair?" }),
  ).toBeTruthy();
  expect(screen.getByText("Used by 3 active Quests.")).toBeTruthy();
  expect(
    screen.getByText(/Existing Quests retain their reference/),
  ).toBeTruthy();
  expect(screen.getByText("Existing Run history remains intact.")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Archive Squad" }));
  expect(store.api.archiveSquad).toHaveBeenCalledWith(pair.id);
});
