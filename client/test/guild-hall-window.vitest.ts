import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { writable } from "svelte/store";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { ClassInput } from "../src/api/client";
import {
  ApiError,
  type ClassDefinition,
  type Squad,
} from "../src/api/contracts";
import GuildHallWindow from "../src/components/guild/GuildHallWindow.svelte";
import type { AppStore, ProductState } from "../src/state/app-store";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(cleanup);

const builder: ClassDefinition = {
  id: "class-builder",
  key: "builder",
  name: "Builder",
  description: "Builds and implements changes.",
  instructions: "Implement carefully and report factual results.",
  archived_at: null,
};
const reviewer: ClassDefinition = {
  id: "class-reviewer",
  key: "reviewer",
  name: "Reviewer",
  description: "Independently reviews completed work.",
  instructions: "Review independently and report findings.",
  archived_at: null,
};
const squad: Squad = {
  id: "squad-one",
  key: "engineering",
  name: "Engineering",
  description: "Fixture squad.",
  members: [
    {
      member_key: "one",
      name: "One",
      class_id: builder.id,
      loadout_id: "loadout",
    },
    {
      member_key: "two",
      name: "Two",
      class_id: builder.id,
      loadout_id: "loadout",
    },
    {
      member_key: "three",
      name: "Three",
      class_id: reviewer.id,
      loadout_id: "loadout",
    },
  ],
  archived_at: null,
};
const product: ProductState = {
  classes: [builder, reviewer],
  loadouts: [],
  squads: [squad],
  tactics: [],
  quests: [],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [],
  runs: [],
};

type StoreOptions = {
  createClass?: (input: Required<ClassInput>) => Promise<ClassDefinition>;
  updateClass?: (id: string, input: ClassInput) => Promise<ClassDefinition>;
  archiveClass?: (id: string) => Promise<ClassDefinition>;
};

function fakeStore(options: StoreOptions = {}): AppStore {
  const error = writable<ApiError | null>(null);
  const api = {
    createClass: vi.fn(
      options.createClass ??
        (async (input) => ({ ...builder, id: "class-created", ...input })),
    ),
    updateClass: vi.fn(
      options.updateClass ?? (async (_id, input) => ({ ...builder, ...input })),
    ),
    archiveClass: vi.fn(
      options.archiveClass ??
        (async () => ({ ...builder, archived_at: "2026-09-01T00:00:00Z" })),
    ),
  };
  return {
    api,
    error,
    refreshProduct: vi.fn(async () => undefined),
    command: vi.fn(async (operation: () => Promise<unknown>) => {
      error.set(null);
      try {
        return await operation();
      } catch (cause) {
        error.set(cause as ApiError);
        return null;
      }
    }),
  } as unknown as AppStore;
}

function renderGuild(
  store = fakeStore(),
  value = product,
  scene: string | null = "builder",
) {
  return render(GuildHallWindow, {
    props: { store, product: value, onClose: vi.fn(), scene },
  });
}

test("opens in read mode with informative selectable Class cards", () => {
  renderGuild();

  expect(
    screen.getByRole("heading", { name: "Builder", level: 2 }),
  ).toBeTruthy();
  expect(
    screen.getByText("Builds and implements changes.", {
      selector: ".detail-description",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
  expect(
    screen.getAllByText("Used by 2 active Squad Members").length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("Used by 1 active Squad Member")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(screen.getByText("Advanced").closest("details")?.open).toBe(false);
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
});

test("Class cards support keyboard focus and native keyboard selection", async () => {
  renderGuild();
  const card = screen.getByRole("button", {
    name: /Reviewer Independently reviews completed work. Used by 1 active Squad Member/,
  });
  card.focus();
  expect(document.activeElement).toBe(card);
  await fireEvent.keyDown(card, { key: "Enter" });
  await fireEvent.click(card);
  expect(
    screen.getByRole("heading", { name: "Reviewer", level: 2 }),
  ).toBeTruthy();
});

test("remembers the selected Class when Guild Hall is reopened in-session", async () => {
  const first = renderGuild();
  await fireEvent.click(
    screen.getByRole("button", { name: /Reviewer Independently/ }),
  );
  first.unmount();

  renderGuild(fakeStore(), product, null);
  expect(
    screen.getByRole("heading", { name: "Reviewer", level: 2 }),
  ).toBeTruthy();
});

test("Edit is an explicit mode and Cancel returns to read mode", async () => {
  renderGuild();
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  expect(screen.getByRole("heading", { name: "Edit Builder" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
  expect(screen.queryByText("Class key")).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Builder", level: 2 }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
});

test("Save Changes updates normal fields without sending the immutable key", async () => {
  const updateClass = vi.fn(async (_id: string, input: ClassInput) => ({
    ...builder,
    ...input,
  }));
  const store = fakeStore({ updateClass });
  renderGuild(store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Lead Builder" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  expect(updateClass).toHaveBeenCalledWith(builder.id, {
    name: "Lead Builder",
    description: builder.description,
    instructions: builder.instructions,
  });
  expect(updateClass.mock.calls[0]?.[1]).not.toHaveProperty("key");
});

test("New Class hides Key and creates with an automatically generated key", async () => {
  const createClass = vi.fn(async (input: Required<ClassInput>) => ({
    ...builder,
    id: "class-senior-reviewer",
    ...input,
  }));
  const store = fakeStore({ createClass });
  renderGuild(store);
  await fireEvent.click(screen.getByRole("button", { name: "+ New Class" }));

  expect(screen.getByRole("heading", { name: "Create Class" })).toBeTruthy();
  expect(screen.queryByLabelText(/Key/)).toBeNull();
  expect(screen.getByRole("button", { name: "Create Class" })).toBeTruthy();
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Senior Reviewer" },
  });
  await fireEvent.input(screen.getByRole("textbox", { name: /Instructions/ }), {
    target: { value: "Review risky work independently." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Create Class" }));

  expect(createClass.mock.calls[0]?.[0]).toEqual({
    key: "senior-reviewer",
    name: "Senior Reviewer",
    description: "",
    instructions: "Review risky work independently.",
  });
});

test("Cancel leaves New Class mode without creating anything", async () => {
  const store = fakeStore();
  renderGuild(store);
  await fireEvent.click(screen.getByRole("button", { name: "+ New Class" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Architect" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(
    screen.getByRole("heading", { name: "Builder", level: 2 }),
  ).toBeTruthy();
  expect(store.api.createClass).not.toHaveBeenCalled();
});

test("Advanced is the only normal place that exposes the immutable Class key", async () => {
  renderGuild();
  const disclosure = screen.getByText("Advanced").closest("details");
  expect(disclosure?.open).toBe(false);
  await fireEvent.click(screen.getByText("Advanced"));
  expect(disclosure?.open).toBe(true);
  expect(screen.getByText("Class key")).toBeTruthy();
  expect(screen.getByText("builder", { selector: "code" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /key/i })).toBeNull();
});

test("archive requires an accessible confirmation and uses centralized commands", async () => {
  const store = fakeStore();
  renderGuild(store);
  await fireEvent.click(screen.getByRole("button", { name: "Archive" }));

  const dialog = screen.getByRole("dialog", { name: "Archive Builder?" });
  expect(within(dialog).getByText(/cannot launch new Runs/)).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Archive Class" }),
  );
  expect(store.command).toHaveBeenCalled();
  expect(store.api.archiveClass).toHaveBeenCalledWith(builder.id);
});

test("dirty Class selection offers Keep Editing, Discard, and Save", async () => {
  renderGuild();
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Changed Builder" },
  });
  const reviewerCard = screen.getByRole("button", {
    name: /Reviewer Independently/,
  });
  await fireEvent.click(reviewerCard);

  let dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
  expect(
    within(dialog).getByRole("button", { name: "Keep Editing" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Discard" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Keep Editing" }),
  );
  expect(screen.getByRole("heading", { name: "Edit Builder" })).toBeTruthy();

  await fireEvent.click(reviewerCard);
  dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Discard" }),
  );
  expect(
    screen.getByRole("heading", { name: "Reviewer", level: 2 }),
  ).toBeTruthy();
});

test("Save in the dirty-state dialog commits before changing selection", async () => {
  const updateClass = vi.fn(async (_id: string, input: ClassInput) => ({
    ...builder,
    ...input,
  }));
  const store = fakeStore({ updateClass });
  renderGuild(store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Changed Builder" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: /Reviewer Independently/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
  await fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(updateClass).toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Reviewer", level: 2 }),
    ).toBeTruthy(),
  );
});

test("maps centralized validation failures to friendly field messages", async () => {
  const updateClass = vi.fn(async () => {
    throw new ApiError(
      "validation_failed",
      "The request is invalid.",
      [{ code: "invalid_instructions", path: ["instructions"], details: {} }],
      {},
      422,
    );
  });
  renderGuild(fakeStore({ updateClass }));
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  expect(
    screen.getByText("Add valid instructions for this Class."),
  ).toBeTruthy();
  expect(screen.getByRole("alert").textContent).not.toContain(
    "invalid_instructions",
  );
});

test("empty state explains Classes and offers an intentional create action", () => {
  renderGuild(fakeStore(), { ...product, classes: [], squads: [] });
  expect(screen.getByRole("heading", { name: "No Classes yet" })).toBeTruthy();
  expect(screen.getByText(/Builder, Reviewer, or Architect/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create Class" })).toBeTruthy();
});
