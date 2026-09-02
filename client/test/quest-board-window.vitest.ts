import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { ApiError, type Quest } from "../src/api/contracts";
import QuestBoardWindow from "../src/components/quest-board/QuestBoardWindow.svelte";
import { type ClientFixture, createFixture } from "../src/fixtures/fixtures";
import { createAppStore } from "../src/state/app-store";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

function fixture(name = "quest-board-ready"): ClientFixture {
  const value = createFixture(name);
  if (!value) throw new Error("Quest Board fixture unavailable");
  return value;
}

function setup(name = "quest-board-ready", scene: string | null = null) {
  const value = fixture(name);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const callbacks = {
    onClose: vi.fn(),
    onOpenWorkYard: vi.fn(),
    onOpenProjects: vi.fn(),
    onOpenTavern: vi.fn(),
  };
  const rendered = render(QuestBoardWindow, {
    props: { store, product: value.product, scene, ...callbacks },
  });
  return { value, store, rendered, ...callbacks };
}

test("opens browse-first with lifecycle Quest cards and a read view", async () => {
  setup();

  expect(
    await screen.findByRole("heading", { name: "Add login validation" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Improve onboarding Working/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Fix export handling Needs attention/ }),
  ).toBeTruthy();
  expect(screen.getAllByText("Ready to launch").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText("Title")).toBeNull();
  expect(screen.getByRole("button", { name: "+ New Quest" })).toBeTruthy();
});

test("empty state invites an intentional first Quest before showing inputs", async () => {
  setup("quest-board-empty");

  expect(
    await screen.findByRole("heading", { name: "No Quests yet" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Title")).toBeNull();
  await fireEvent.click(
    screen.getByRole("button", { name: "Create Your First Quest" }),
  );
  expect(
    screen.getByRole("heading", {
      name: "Give your crew something to work on",
    }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Title")).toBeTruthy();
});

test("single choices preselect while multiple meaningful choices remain intentional", async () => {
  const single = fixture("quest-board-new");
  single.product.workspaces = single.product.workspaces.slice(0, 1);
  single.product.squads = single.product.squads.slice(0, 1);
  single.product.tactics = single.product.tactics.slice(0, 1);
  const singleStore = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    single,
  );
  render(QuestBoardWindow, {
    props: {
      store: singleStore,
      product: single.product,
      scene: "new",
      onClose: vi.fn(),
      onOpenWorkYard: vi.fn(),
      onOpenProjects: vi.fn(),
      onOpenTavern: vi.fn(),
    },
  });
  expect(
    await screen.findByRole("button", { name: /Quest Engineering/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Engineering Pair/ })).toBeTruthy();
  cleanup();

  setup("quest-board-new", "new");
  expect(
    await screen.findByRole("button", { name: /Choose a Project/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Choose a Squad/ })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Choose an Approach/ }),
  ).toBeTruthy();
});

test("rich pickers show Product meaning without raw IDs", async () => {
  setup("quest-board-new", "new");
  await fireEvent.click(
    await screen.findByRole("button", { name: /Choose a Project/ }),
  );
  expect(
    screen.getByRole("heading", { name: "Choose a Project" }),
  ).toBeTruthy();
  expect(screen.getByText("emeraldarcher/quest-engineering")).toBeTruthy();
  expect(document.body.textContent).not.toContain(
    "workspace-quest-engineering",
  );
  await fireEvent.click(screen.getByRole("button", { name: "Close picker" }));

  await fireEvent.click(screen.getByRole("button", { name: /Choose a Squad/ }));
  expect(screen.getByText(/Rowan · Builder · Coding Tools/)).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Close picker" }));

  await fireEvent.click(
    screen.getByRole("button", { name: /Choose an Approach/ }),
  );
  expect(screen.getByText("Implement → Review")).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Reusable Tactics" }),
  ).toBeNull();
});

test("Create persists intent separately and does not launch implicitly", async () => {
  const { store, value } = setup();
  const baseQuest = value.product.quests[0];
  if (!baseQuest) throw new Error("Expected a base Quest");
  const create = vi
    .spyOn(store.api, "createQuest")
    .mockImplementation(async (input) => ({
      ...baseQuest,
      id: "quest-created",
      title: input.title ?? "",
      objective: input.objective ?? "",
      workspace_id: input.workspace_id ?? "",
      squad_id: input.squad_id ?? "",
      tactic_source: input.tactic_source ?? baseQuest.tactic_source,
    }));
  const launch = vi.spyOn(store.api, "launchQuest");

  await fireEvent.click(
    await screen.findByRole("button", { name: "+ New Quest" }),
  );
  await fireEvent.input(screen.getByLabelText("Title"), {
    target: { value: "Validate sessions" },
  });
  await fireEvent.input(screen.getByLabelText("Objective"), {
    target: { value: "Reject expired sessions safely." },
  });

  await fireEvent.click(
    screen.getByRole("button", { name: /Choose a Project/ }),
  );
  await fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: /Quest Engineering/,
    }),
  );
  await fireEvent.click(screen.getByRole("button", { name: /Choose a Squad/ }));
  await fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: /Engineering Pair/,
    }),
  );
  await fireEvent.click(
    screen.getByRole("button", { name: /Choose an Approach/ }),
  );
  await fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: /Implement & Review/,
    }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Create Quest" }));

  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Validate sessions",
      objective: "Reject expired sessions safely.",
    }),
  );
  expect(launch).not.toHaveBeenCalled();
  expect(
    await screen.findByRole("heading", { name: "Validate sessions" }),
  ).toBeTruthy();
});

test("inline Tactic data is preserved through ordinary Quest edits", async () => {
  const value = fixture();
  const original = value.product.quests[0];
  if (!original) throw new Error("Expected an inline Quest fixture");
  original.tactic_source = {
    type: "inline",
    body: { type: "step", key: "legacy", name: "Legacy Step" },
  };
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const update = vi
    .spyOn(store.api, "updateQuest")
    .mockImplementation(async (_id, input) => ({
      ...original,
      title: input.title ?? original.title,
    }));
  render(QuestBoardWindow, {
    props: {
      store,
      product: value.product,
      onClose: vi.fn(),
      onOpenWorkYard: vi.fn(),
      onOpenProjects: vi.fn(),
      onOpenTavern: vi.fn(),
    },
  });

  await fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(screen.getByText(/Inline Tactic/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Choose an Approach/ }),
  ).toBeNull();
  await fireEvent.input(screen.getByLabelText("Title"), {
    target: { value: "Updated legacy Quest" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[1]?.tactic_source).toEqual(
    original.tactic_source,
  );
});

test.each([
  [
    "quest-board-project-offline",
    "Offline",
    /still launch the Quest; work will wait/,
  ],
  ["quest-board-project-preparing", "Preparing…", /You can launch now/],
] as const)("%s remains launchable with truthful Project availability", async (name, state, copy) => {
  setup(name);
  expect(await screen.findByText(state)).toBeTruthy();
  expect(screen.getByText(copy)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Launch Quest" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.getAllByText("Ready to launch").length).toBeGreaterThan(0);
});

test("invalid Squad configuration remains visible and blocks the previewed launch", async () => {
  setup("quest-board-invalid-squad");
  expect(
    await screen.findByRole("heading", { name: "Squad needs configuration" }),
  ).toBeTruthy();
  expect(screen.getByText(/archived Class/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Launch Quest" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("contextual Tactic failure remains friendly and omits compiler internals", async () => {
  setup("quest-board-tactic-error");
  expect(
    await screen.findByRole("heading", { name: "Approach needs attention" }),
  ).toBeTruthy();
  const copy = document.body.textContent ?? "";
  for (const forbidden of [
    "execution_plan",
    "occurrence",
    "barrier",
    "frontier",
    "Worker ID",
  ])
    expect(copy).not.toContain(forbidden);
});

test("launch is single-submit and server failure preserves the selected Quest", async () => {
  const { store } = setup();
  let rejectLaunch: ((error: Error) => void) | undefined;
  const operation = new Promise<never>((_resolve, reject) => {
    rejectLaunch = reject;
  });
  const launch = vi.spyOn(store.api, "launchQuest").mockReturnValue(operation);
  const action = await screen.findByRole("button", { name: "Launch Quest" });
  await fireEvent.click(action);
  await fireEvent.click(action);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole("button", { name: "Launching…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  rejectLaunch?.(
    new ApiError(
      "launch_failed",
      "The requested operation could not be completed.",
      [{ code: "missing_or_archived_definition", path: [], details: {} }],
    ),
  );
  expect(
    await screen.findByText(/Squad needs configuration before a new Run/),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Add login validation" }),
  ).toBeTruthy();
  expect(
    screen.queryByText("Working", { selector: ".status-chip" }),
  ).toBeNull();
});

test("lifecycle views preserve execution, Delivery, and Quest completion separation", async () => {
  setup("quest-board-working");
  expect(
    await screen.findByText("Working", { selector: ".status-chip" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Execution in progress" }),
  ).toBeTruthy();
  cleanup();

  setup("quest-board-preparing-review");
  expect(
    await screen.findByText("Preparing review", { selector: ".status-chip" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Execution complete" }),
  ).toBeTruthy();
  cleanup();

  setup("quest-board-execution-complete");
  expect(
    await screen.findByRole("heading", { name: "Execution complete" }),
  ).toBeTruthy();
  expect(
    screen.queryByText("Complete", { selector: ".status-chip" }),
  ).toBeNull();
  cleanup();

  setup("quest-board-complete");
  expect(
    await screen.findByText("Complete", { selector: ".status-chip" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/merged Delivery proves Quest completion/),
  ).toBeTruthy();
});

test("awaiting review uses canonical PR action and Run Again stays authoritative", async () => {
  setup("quest-board-awaiting-review");
  expect(
    await screen.findByRole("button", { name: "Open Pull Request #142" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Work Yard" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Run Again" })).toBeNull();
  cleanup();

  setup("quest-board-closed-unmerged");
  expect(await screen.findByRole("button", { name: "Run Again" })).toBeTruthy();
  expect(screen.getByText(/closed without merge/)).toBeTruthy();
  cleanup();

  setup("quest-board-no-changes");
  expect(await screen.findByRole("button", { name: "Run Again" })).toBeTruthy();
  expect(screen.getByText(/no repository changes to publish/)).toBeTruthy();
  cleanup();

  setup("quest-board-attention");
  expect(
    await screen.findByText("Needs attention", { selector: ".status-chip" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Run Again" })).toBeNull();
});

test("Open Work Yard passes the authoritative current Run", async () => {
  const { onOpenWorkYard } = setup("quest-board-working");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Open Work Yard" }),
  );
  expect(onOpenWorkYard).toHaveBeenCalledWith("run-quest-board-current");
});

test.each([
  ["quest-board-working", /current Run will continue/, /does not cancel work/],
  [
    "quest-board-awaiting-review",
    /Pull Request and review lifecycle will continue/,
    /Run history remains/,
  ],
] as const)("active archive for %s is explicit and never invokes cancellation", async (name, first, second) => {
  const { store } = setup(name);
  const archive = vi
    .spyOn(store.api, "archiveQuest")
    .mockResolvedValue({} as Quest);
  await fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  expect(screen.getByText(first)).toBeTruthy();
  expect(screen.getByText(second)).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Archive Quest" }));
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  const apiNames = Object.keys(store.api).join(" ").toLocaleLowerCase();
  expect(apiNames).not.toContain("cancelquest");
  expect(apiNames).not.toContain("stopquest");
  expect(apiNames).not.toContain("terminatequest");
});

test("dirty edit guard protects switching and supports Keep Editing", async () => {
  setup();
  await fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const objective = screen.getByLabelText("Objective");
  await fireEvent.input(objective, { target: { value: "Unsaved objective" } });
  await fireEvent.click(
    screen.getByRole("button", { name: /Improve onboarding Working/ }),
  );

  expect(
    screen.getByRole("dialog", { name: "Save your Quest changes?" }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
  expect(screen.getByDisplayValue("Unsaved objective")).toBeTruthy();
});

test("selection survives a lifecycle refresh without returning to Create mode", async () => {
  const { value, rendered } = setup();
  await fireEvent.click(
    await screen.findByRole("button", { name: /Improve onboarding Working/ }),
  );
  expect(
    screen.getByRole("heading", { name: "Improve onboarding" }),
  ).toBeTruthy();
  const refreshed = value.product.quests.map((quest) =>
    quest.id === "quest-onboarding"
      ? { ...quest, lifecycle: { ...quest.lifecycle, label: "Working now" } }
      : quest,
  );
  await rendered.rerender({ product: { ...value.product, quests: refreshed } });

  expect(
    screen.getByRole("heading", { name: "Improve onboarding" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Title")).toBeNull();
});

test("normal Quest Board excludes orchestration and persistence terminology", async () => {
  setup();
  await screen.findByRole("heading", { name: "Add login validation" });
  const copy = document.body.textContent ?? "";
  for (const forbidden of [
    "workspace_id",
    "squad_id",
    "execution plan",
    "occurrence ID",
    "attempt ID",
    "LaunchSnapshot",
    "Worker ID",
    "Herdr",
    "Pi session",
  ])
    expect(copy).not.toContain(forbidden);
});
