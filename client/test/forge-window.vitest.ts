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
import type { LoadoutInput } from "../src/api/client";
import {
  ApiError,
  type ExecutionOption,
  type Loadout,
  type Squad,
} from "../src/api/contracts";
import ForgeWindow from "../src/components/forge/ForgeWindow.svelte";
import { optionKey } from "../src/components/forge/loadout-presentation";
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

const coding: Loadout = {
  id: "loadout-coding",
  key: "coding",
  name: "Coding",
  description: "Full coding environment for implementation work.",
  model: { provider: "openai-codex", model: "gpt-5.6-sol" },
  reasoning: "high",
  tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  workspace_access: "read_write",
  archived_at: null,
};
const review: Loadout = {
  ...coding,
  id: "loadout-review",
  key: "review",
  name: "Review",
  description: "Read-only review equipment.",
  reasoning: "medium",
  tools: ["workspace.filesystem", "workspace.search"],
  workspace_access: "read_only",
};
const custom: Loadout = {
  ...coding,
  id: "loadout-custom",
  key: "custom",
  name: "Custom Bench",
  description: "Specialist equipment.",
  model: { provider: "custom-provider", model: "custom-model-x" },
  tools: ["workspace.filesystem", "acme.special-tool"],
};
const option: ExecutionOption = {
  model: coding.model,
  reasoning: ["low", "medium", "high"],
  tools: [...coding.tools],
  workspaces: [
    {
      workspace_id: "workspace-1",
      workspace_access: ["none", "read_only", "read_write"],
    },
  ],
  available: true,
};
const squad: Squad = {
  id: "squad-1",
  key: "squad",
  name: "Squad",
  description: "Fixture.",
  members: [
    {
      member_key: "one",
      name: "One",
      class_id: "class",
      loadout_id: coding.id,
    },
    {
      member_key: "two",
      name: "Two",
      class_id: "class",
      loadout_id: coding.id,
    },
    {
      member_key: "three",
      name: "Three",
      class_id: "class",
      loadout_id: review.id,
    },
  ],
  archived_at: null,
};
const product: ProductState = {
  classes: [],
  loadouts: [coding, review, custom],
  squads: [squad],
  tactics: [],
  quests: [],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [option],
  runs: [],
};

type StoreOptions = {
  createLoadout?: (input: Required<LoadoutInput>) => Promise<Loadout>;
  updateLoadout?: (id: string, input: LoadoutInput) => Promise<Loadout>;
  archiveLoadout?: (id: string) => Promise<Loadout>;
};

function fakeStore(options: StoreOptions = {}): AppStore {
  const error = writable<ApiError | null>(null);
  const api = {
    createLoadout: vi.fn(
      options.createLoadout ??
        (async (input) => ({ ...coding, id: "loadout-created", ...input })),
    ),
    updateLoadout: vi.fn(
      options.updateLoadout ??
        (async (_id, input) => ({ ...coding, ...input })),
    ),
    archiveLoadout: vi.fn(
      options.archiveLoadout ??
        (async () => ({
          ...coding,
          archived_at: "2026-09-01T00:00:00Z",
        })),
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

function renderForge(
  store = fakeStore(),
  value = product,
  scene: string | null = "coding",
) {
  return render(ForgeWindow, {
    props: { store, product: value, onClose: vi.fn(), scene },
  });
}

test("opens browse-first with rich Loadout cards and read-only detail", () => {
  renderForge();

  expect(
    screen.getByRole("heading", { name: "Coding", level: 2 }),
  ).toBeTruthy();
  expect(screen.getByText("GPT 5.6 Sol")).toBeTruthy();
  expect(screen.getAllByText("Read & write").length).toBeGreaterThan(0);
  expect(
    screen.getAllByText("Used by 2 active Squad Members").length,
  ).toBeGreaterThan(0);
  expect(
    screen.getByText(/3 capabilities/, { selector: ".card-access" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(screen.queryByText("Known execution profile")).toBeNull();
  expect(screen.queryByText("read_write")).toBeNull();
  expect(screen.queryByRole("textbox", { name: /instructions/i })).toBeNull();
});

test("custom Loadouts remain configured and understandable in read mode", () => {
  renderForge(fakeStore(), product, "custom");

  const customCard = screen.getByRole("button", {
    name: /Custom Bench Custom model · High/,
  });
  expect(customCard.textContent).not.toContain("custom-provider");
  expect(screen.getByText("Configured")).toBeTruthy();
  expect(
    screen.getByText("custom-provider / custom-model-x", {
      selector: ".custom-model code",
    }),
  ).toBeTruthy();
  expect(screen.getByText("acme.special-tool")).toBeTruthy();
  expect(screen.getAllByText("Custom").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Invalid|Broken|Unsupported/)).toBeNull();
});

test("cards are native keyboard-focusable controls", () => {
  renderForge();
  const card = screen.getByRole("button", {
    name: /Review GPT 5.6 Sol · Medium Read only/,
  });
  card.focus();
  expect(document.activeElement).toBe(card);
});

test("Edit is explicit and normal controls use Product-facing language", async () => {
  renderForge();
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  expect(screen.getByRole("heading", { name: "Edit Coding" })).toBeTruthy();
  expect(screen.getByLabelText("Model")).toBeTruthy();
  expect(screen.getByLabelText("Reasoning")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Project access" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Capabilities" })).toBeTruthy();
  expect(screen.getByText("Read & write")).toBeTruthy();
  expect(screen.queryByText("Workspace access")).toBeNull();
  expect(screen.queryByText("QE capabilities")).toBeNull();
  expect(
    screen.getByText("Custom configuration").closest("details")?.open,
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
});

test("Cancel leaves explicit Create and Edit modes without saving", async () => {
  const store = fakeStore();
  renderForge(store);
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Coding", level: 2 }),
  ).toBeTruthy();

  await fireEvent.click(screen.getByRole("button", { name: "+ New Loadout" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Temporary" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Coding", level: 2 }),
  ).toBeTruthy();
  expect(store.api.createLoadout).not.toHaveBeenCalled();
  expect(store.api.updateLoadout).not.toHaveBeenCalled();
});

test("changing Name only preserves a custom ModelRef and unknown capabilities", async () => {
  const updateLoadout = vi.fn(async (_id: string, input: LoadoutInput) => ({
    ...custom,
    ...input,
  }));
  const store = fakeStore({ updateLoadout });
  renderForge(store, product, "custom");
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Renamed Custom Bench" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  expect(updateLoadout).toHaveBeenCalledWith(custom.id, {
    name: "Renamed Custom Bench",
    description: custom.description,
    model: custom.model,
    reasoning: custom.reasoning,
    tools: custom.tools,
    workspace_access: custom.workspace_access,
  });
  expect(updateLoadout.mock.calls[0]?.[1]).not.toHaveProperty("key");
  expect(updateLoadout.mock.calls[0]?.[1]).not.toHaveProperty("instructions");
});

test("applying a preset to New Loadout creates ordinary Product fields only", async () => {
  const createLoadout = vi.fn(async (input: Required<LoadoutInput>) => ({
    ...coding,
    id: "loadout-created",
    ...input,
  }));
  const store = fakeStore({ createLoadout });
  renderForge(store);
  await fireEvent.click(screen.getByRole("button", { name: "+ New Loadout" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Preset Coding" },
  });
  expect(screen.getByRole("option", { name: /Available now/ })).toBeTruthy();
  await fireEvent.change(screen.getByLabelText(/Configuration preset/), {
    target: { value: optionKey(option) },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Apply preset" }));
  await fireEvent.click(screen.getByRole("button", { name: "Create Loadout" }));

  const submitted = createLoadout.mock.calls[0]?.[0];
  expect(submitted).toEqual({
    key: "preset-coding",
    name: "Preset Coding",
    description: "",
    model: option.model,
    reasoning: "medium",
    tools: option.tools,
    workspace_access: "read_write",
  });
  expect(submitted).not.toHaveProperty("preset_id");
  expect(submitted).not.toHaveProperty("instructions");
});

test("applying a preset while editing preserves custom capability IDs", async () => {
  const updateLoadout = vi.fn(async (_id: string, input: LoadoutInput) => ({
    ...custom,
    ...input,
  }));
  const store = fakeStore({ updateLoadout });
  renderForge(store, product, "custom");
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.change(screen.getByLabelText(/Configuration preset/), {
    target: { value: optionKey(option) },
  });
  expect(screen.getByText(/Custom capability IDs are preserved/)).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Apply preset" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  expect(updateLoadout.mock.calls[0]?.[1].tools).toContain("acme.special-tool");
});

test("Custom configuration is intentional and does not leak into normal editing", async () => {
  renderForge(fakeStore(), product, "custom");
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  const disclosure = screen
    .getByText("Custom configuration")
    .closest("details");
  expect(disclosure?.open).toBe(false);
  await fireEvent.click(screen.getByText("Custom configuration"));
  expect(disclosure?.open).toBe(true);
  expect(
    (screen.getByLabelText("Canonical provider") as HTMLInputElement).value,
  ).toBe("custom-provider");
  expect(
    (screen.getByLabelText("Canonical Model ID") as HTMLInputElement).value,
  ).toBe("custom-model-x");
  expect(
    (screen.getByLabelText(/Custom capability IDs/) as HTMLTextAreaElement)
      .value,
  ).toBe("acme.special-tool");
});

test("Advanced is the only technical disclosure in normal detail", async () => {
  renderForge();
  const disclosure = screen.getByText("Advanced").closest("details");
  expect(disclosure?.open).toBe(false);
  await fireEvent.click(screen.getByText("Advanced"));
  expect(disclosure?.open).toBe(true);
  expect(screen.getByText("Loadout key")).toBeTruthy();
  expect(screen.getByText("Canonical model")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /key/i })).toBeNull();
});

test("archive requires accessible confirmation with actual semantics", async () => {
  const store = fakeStore();
  renderForge(store);
  await fireEvent.click(screen.getByRole("button", { name: "Archive" }));

  const dialog = screen.getByRole("dialog", { name: "Archive Coding?" });
  expect(within(dialog).getByText(/cannot launch new Runs/)).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Archive Loadout" }),
  );
  expect(store.command).toHaveBeenCalled();
  expect(store.api.archiveLoadout).toHaveBeenCalledWith(coding.id);
});

test("dirty selection offers Keep Editing, Discard, and Save", async () => {
  renderForge();
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Changed Coding" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: /Review GPT 5.6 Sol/ }),
  );

  const dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
  expect(
    within(dialog).getByRole("button", { name: "Keep Editing" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Discard" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Discard" }),
  );
  expect(
    screen.getByRole("heading", { name: "Review", level: 2 }),
  ).toBeTruthy();
});

test("maps centralized validation errors to friendly custom fields", async () => {
  const updateLoadout = vi.fn(async () => {
    throw new ApiError(
      "validation_failed",
      "The request is invalid.",
      [{ code: "invalid_model_ref", path: ["model"], details: {} }],
      {},
      422,
    );
  });
  renderForge(fakeStore({ updateLoadout }), product, "custom");
  await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() =>
    expect(screen.getByText("Enter a valid Model ID.")).toBeTruthy(),
  );
  expect(screen.getByRole("alert").textContent).not.toContain(
    "invalid_model_ref",
  );
});

test("empty state explains Loadouts and offers intentional creation", () => {
  renderForge(fakeStore(), { ...product, loadouts: [], squads: [] });
  expect(screen.getByRole("heading", { name: "No Loadouts yet" })).toBeTruthy();
  expect(
    screen.getByText(/models, capabilities, and Project access/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create Loadout" })).toBeTruthy();
});
