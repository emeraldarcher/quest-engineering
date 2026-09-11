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
import {
  ApiError,
  type Tactic,
  type TacticPreview,
} from "../src/api/contracts";
import WarRoomWindow from "../src/components/war-room/WarRoomWindow.svelte";
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

function fixture(name = "war-room-detail"): ClientFixture {
  const value = createFixture(name);
  if (!value) throw new Error("War Room fixture unavailable");
  return value;
}

function setup(name = "war-room-detail", scene: string | null = null) {
  const value = fixture(name);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const callbacks = { onClose: vi.fn(), onOpenQuestBoard: vi.fn() };
  render(WarRoomWindow, {
    props: { store, product: value.product, scene, ...callbacks },
  });
  return { value, store, ...callbacks };
}

test("opens browse-first with reusable Tactic detail and authoritative artifact flow", async () => {
  setup();
  expect(
    await screen.findByRole("heading", { name: "Implement & Review" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "What the crew will do" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.body.textContent).toContain("inferred from Implement"),
  );
  expect(screen.getByRole("button", { name: "+ New Tactic" })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /ExecutionPlan|barrier|frontier|occurrence|attempt|Worker ID|session ID|Herdr|Pi agent/i,
  );
});

test("explicit artifact sources remain distinct from inferred bindings", async () => {
  const value = fixture("war-room-detail");
  const tacticPreview = value.tacticPreviews?.["war-tactic-implement-review"];
  const binding = tacticPreview?.artifact_bindings?.[0];
  if (!binding) throw new Error("Expected artifact binding");
  binding.selection = "explicit";
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WarRoomWindow, {
    props: {
      store,
      product: value.product,
      scene: null,
      onClose: vi.fn(),
      onOpenQuestBoard: vi.fn(),
    },
  });
  await waitFor(() =>
    expect(document.body.textContent).toContain("explicitly from Implement"),
  );
});

test("ambiguous artifacts offer only authoritative server-projected candidates", async () => {
  setup("war-room-ambiguous", "ambiguous");
  const source = (await screen.findByLabelText(
    /Source for .*Change Set/,
  )) as HTMLSelectElement;
  expect(Array.from(source.options).map((option) => option.value)).toEqual([
    "",
    "backend::change_set",
    "frontend::change_set",
  ]);
  expect(screen.getByText(/more than one possible producer/)).toBeTruthy();
  expect(
    screen.getAllByText(/has multiple compatible sources\. Choose one/).length,
  ).toBeGreaterThan(0);
  expect(source.selectedOptions[0]?.textContent).toContain(
    "multiple compatible values",
  );
});

test("preview errors retain the draft and use a safe generic fallback when details are absent", async () => {
  setup("war-room-detail", "generic-error");
  expect(
    await screen.findByText(/could not resolve this semantic flow/),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
  await fireEvent.input(screen.getByLabelText("Description"), {
    target: { value: "Preserved despite preview failure." },
  });
  expect(
    (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
  ).toBe("Preserved despite preview failure.");
});

test("empty state teaches semantic composition without opening a JSON editor", async () => {
  setup("war-room-empty");
  expect(
    await screen.findByRole("heading", { name: "No Tactics yet" }),
  ).toBeTruthy();
  expect(screen.getByText(/Steps, sequences, parallel work/)).toBeTruthy();
  expect(screen.queryByText(/raw json/i)).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Create Tactic" }));
  expect(screen.getByLabelText("Name")).toBeTruthy();
  expect(screen.getByRole("button", { name: "+ Add first Step" })).toBeTruthy();
});

test("New Tactic generates an immutable key and persists one complete semantic body", async () => {
  const { store, value } = setup("war-room-empty");
  const created: Tactic = {
    id: "created-tactic",
    key: "implement-and-review",
    name: "Implement & Review",
    description: "",
    body: value.product.tactics[0]?.body ?? {
      type: "step",
      key: "implement",
      name: "Implement",
      instruction: "Implement.",
      performer: { selector: "class", value: "builder" },
      context: { selector: "fresh", value: null },
      consumes: [],
      produces: [],
    },
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  const create = vi.spyOn(store.api, "createTactic").mockResolvedValue(created);

  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.input(screen.getByLabelText("Name"), {
    target: { value: "Implement & Review" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: "+ Add first Step" }),
  );
  await fireEvent.input(screen.getByLabelText("Step name"), {
    target: { value: "Implement" },
  });
  await fireEvent.input(screen.getByLabelText("Instruction"), {
    target: { value: "Implement the Quest objective." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Create Tactic" }));

  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const payload = create.mock.calls[0]?.[0];
  expect(payload?.key).toBe("implement-review");
  expect(payload?.body).toMatchObject({ type: "sequence" });
});

test("authors a complete Plan & Review flow without opening Advanced", async () => {
  const { store } = setup("war-room-empty");
  const create = vi
    .spyOn(store.api, "createTactic")
    .mockImplementation(async (input) => ({
      id: "created-plan-review",
      ...input,
      archived_at: null,
    }));
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.input(screen.getByLabelText("Name"), {
    target: { value: "Plan & Review" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: "+ Add first Step" }),
  );
  await fireEvent.input(screen.getByLabelText("Step name"), {
    target: { value: "Plan" },
  });
  await fireEvent.input(screen.getByLabelText("Instruction"), {
    target: { value: "Create a Quest Plan." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Output" }));
  await fireEvent.change(screen.getByLabelText("Output type 1"), {
    target: { value: "quest_plan" },
  });
  expect(
    (screen.getByLabelText("Output name 1") as HTMLInputElement).value,
  ).toBe("Plan");

  await fireEvent.click(screen.getByText("+ Add", { selector: "summary" }));
  await fireEvent.click(
    screen.getByRole("button", { name: "Until Review and revise" }),
  );
  expect(screen.getAllByText("Quest Plan is accepted").length).toBeGreaterThan(
    0,
  );
  expect(
    (screen.getByLabelText("Maximum plan revisions") as HTMLInputElement).value,
  ).toBe("2");

  await fireEvent.click(screen.getByRole("button", { name: "Edit interface" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Output" }));
  await fireEvent.change(screen.getByLabelText("Output type 1"), {
    target: { value: "quest_plan" },
  });
  expect(
    (screen.getByLabelText("Output name 1") as HTMLInputElement).value,
  ).toBe("Accepted Quest Plan");
  expect(
    (
      screen.getByLabelText(
        "Export source for Accepted Quest Plan",
      ) as HTMLSelectElement
    ).value,
  ).toBe("plan_acceptance");
  expect(
    screen.queryByRole("region", { name: "Tactic validation" }),
  ).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "Create Tactic" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const payload = create.mock.calls[0]?.[0];
  expect(payload?.interface.outputs[0]).toEqual({
    key: "accepted_plan",
    label: "Accepted Quest Plan",
    kind: "quest_plan",
    source: { type: "accepted_subject", gate_key: "plan_acceptance" },
  });
  expect(JSON.stringify(payload?.body)).toContain(
    '"gate_key":"plan_acceptance","subject_input":"current_plan"',
  );
  expect(JSON.stringify(payload?.body)).toContain(
    '"name":"review_feedback","kind":"review_verdict"',
  );
});

test("Step inspector edits Class, instruction, artifacts, and stable Advanced identity", async () => {
  setup("war-room-detail", "step-advanced");
  expect(
    await screen.findByRole("heading", { name: "Implement" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Performed by")).toBeTruthy();
  expect(
    (screen.getByLabelText("Instruction") as HTMLTextAreaElement).value,
  ).toBe("implement the Quest objective.");
  expect(
    (screen.getByLabelText("Stable Step key") as HTMLInputElement).value,
  ).toBe("implement");
  expect(screen.getByRole("button", { name: "+ Output" })).toBeTruthy();
});

test("accessible structure controls insert, move, and remove without regenerating keys", async () => {
  setup("war-room-detail", "sequence");
  await screen.findByRole("heading", { name: "Then, in sequence" });
  expect(
    (
      screen.getByRole("button", {
        name: "Move selected item up",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "+ Add Step" }));
  expect(
    (
      screen.getByRole("button", {
        name: "Move selected item up",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Move selected item down",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await fireEvent.click(
    screen.getByRole("button", { name: "Move selected item up" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.queryByRole("heading", { name: "New Step" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("Parallel and Until are structured containers rather than graph nodes", async () => {
  setup("war-room-parallel", "parallel");
  expect(
    await screen.findByRole("heading", { name: "At the same time" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "+ Add branch" })).toBeTruthy();
  cleanup();

  setup("war-room-until", "until");
  expect(
    await screen.findByRole("heading", { name: "Repeat until accepted" }),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText("Maximum repairs") as HTMLInputElement).value,
  ).toBe("2");
  expect(screen.getByLabelText("Value type")).toBeTruthy();
  await fireEvent.change(screen.getByLabelText("Value type"), {
    target: { value: "boolean" },
  });
  expect(screen.getByLabelText("Accepted value")).toBeTruthy();
  expect(screen.getByText(/up to 3 total checks/)).toBeTruthy();
  expect(screen.getByText(/Up to 2 repairs/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /join node|cyclic edge|region id/i,
  );
});

test("performer affinity and continued context remain independent human controls", async () => {
  setup("war-room-affinity", "affinity");
  expect(
    ((await screen.findByLabelText("Same performer Step")) as HTMLSelectElement)
      .value,
  ).toBe("implement");
  expect(
    (screen.getByLabelText("Context source Step") as HTMLSelectElement).value,
  ).toBe("implement");
  expect(screen.getByText("Same Member as")).toBeTruthy();
  expect(screen.getByText("Continue context from")).toBeTruthy();
});

test("TacticUse hides IDs, previews nested semantics, and guards referenced navigation", async () => {
  setup("war-room-use", "use");
  expect(
    await screen.findByRole("heading", {
      name: /Plan & Review|Implement & Review/,
    }),
  ).toBeTruthy();
  expect(screen.queryByText("war-tactic-plan")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Preview ▸" }));
  expect(screen.getByText("Plan", { selector: "strong" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
  await fireEvent.input(screen.getByLabelText("Description"), {
    target: { value: "Unsaved composition." },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: "Return to selected item" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Open Tactic" }));
  expect(
    screen.getByRole("dialog", { name: "Save your Tactic changes?" }),
  ).toBeTruthy();
});

test("contextual missing artifacts are specific and do not disable Save", async () => {
  setup("war-room-contextual", "contextual");
  expect(await screen.findByText("Requires surrounding context")).toBeTruthy();
  expect(screen.getAllByText("plan").length).toBeGreaterThan(0);
  const save = screen.getByRole("button", { name: "Save Changes" });
  expect((save as HTMLButtonElement).disabled).toBe(false);
});

test("candidate cycle is presented before Save without exposing resolver machinery", async () => {
  setup("war-room-direct-cycle", "cycle");
  expect(await screen.findByText("Needs attention")).toBeTruthy();
  expect(screen.getByText(/Circular tactic reference/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /DFS|resolver stack|ExecutionPlan/i,
  );
});

test("archived Class and TacticUse references remain visible and are never replaced", async () => {
  setup("war-room-archived-class", "step");
  expect(await screen.findByText(/Auditor · Archived/)).toBeTruthy();
  expect(
    screen.getByText(/preserves an archived Class reference/),
  ).toBeTruthy();
  cleanup();

  setup("war-room-archived-use", "use");
  expect(await screen.findByLabelText("Tactic")).toBeTruthy();
  expect(screen.getAllByText("Archived Plan").length).toBeGreaterThan(0);
  expect(screen.getByText(/reference is archived/)).toBeTruthy();
});

test("shared usage explains future Runs and archive preserves references", async () => {
  setup("war-room-shared");
  expect(await screen.findByText("Used by 1 active Quest")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Edit Tactic" }));
  expect(
    screen.getByText(/Existing Runs keep the Tactic captured/),
  ).toBeTruthy();
  cleanup();

  setup("war-room-archive");
  await fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  const dialog = screen.getByRole("dialog", {
    name: /Archive Implement & Review/,
  });
  expect(
    within(dialog).getByText(/Existing Run history is unaffected/),
  ).toBeTruthy();
  expect(within(dialog).getByText(/still referenced/)).toBeTruthy();
});

test("dirty-state Save failure retains the complete structural draft", async () => {
  const { store } = setup("war-room-detail", "step");
  vi.spyOn(store.api, "updateTactic").mockRejectedValue(
    new Error("authoritative save failure"),
  );
  await fireEvent.input(await screen.findByLabelText("Instruction"), {
    target: { value: "Preserve this complete changed instruction." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Input" }));
  await fireEvent.change(screen.getByLabelText("Input type 2"), {
    target: { value: "quest_plan" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(await screen.findByText(/complete draft is still here/)).toBeTruthy();
  expect(
    (screen.getByLabelText("Instruction") as HTMLTextAreaElement).value,
  ).toBe("Preserve this complete changed instruction.");
  expect(
    (screen.getByLabelText("Input type 2") as HTMLSelectElement).value,
  ).toBe("quest_plan");
});

test("a stale semantic preview cannot overwrite the latest draft result", async () => {
  const value = fixture("war-room-detail");
  const api = new ApiClient({ httpBaseUrl: "http://fixture.invalid" });
  vi.spyOn(api, "listTactics").mockResolvedValue(value.product.tactics);
  vi.spyOn(api, "listClasses").mockResolvedValue(value.product.classCatalog);
  const current = value.tacticPreviews?.["war-tactic-implement-review"];
  if (!current) throw new Error("Expected fixture preview");
  const currentPreview: TacticPreview = current;
  let rejectOlder!: (cause: unknown) => void;
  let resolveNewer!: (preview: TacticPreview) => void;
  const older = new Promise<TacticPreview>((_resolve, reject) => {
    rejectOlder = reject;
  });
  const newer = new Promise<TacticPreview>((resolve) => {
    resolveNewer = resolve;
  });
  const preview = vi
    .spyOn(api, "previewTacticDefinition")
    .mockImplementation((_id, body) => {
      if (body === undefined) return Promise.resolve(currentPreview);
      return JSON.stringify(body).includes("Newest draft instruction")
        ? newer
        : older;
    });
  const store = createAppStore(api, "ws://fixture.invalid/socket", null);
  render(WarRoomWindow, {
    props: {
      store,
      product: value.product,
      scene: null,
      onClose: vi.fn(),
      onOpenQuestBoard: vi.fn(),
    },
  });
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  await fireEvent.click(
    await screen.findByRole("button", { name: "Edit Tactic" }),
  );
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  await fireEvent.click(screen.getByRole("button", { name: /Step Implement/ }));
  await fireEvent.input(await screen.findByLabelText("Instruction"), {
    target: { value: "Newest draft instruction." },
  });
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(3));
  expect(JSON.stringify(preview.mock.calls[2]?.[1])).toContain(
    "Newest draft instruction",
  );
  resolveNewer(currentPreview);
  await Promise.resolve();
  rejectOlder(
    new ApiError("preview_failed", "", [
      {
        code: "cyclic_tactic_reference",
        path: [],
        details: {},
        definition_path: ["old", "cycle", "old"],
      },
    ]),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByText(/Circular tactic reference/)).toBeNull();
  expect(screen.queryByText("Needs attention")).toBeNull();
});

test("interface summary opens a vertical friendly editor with advanced stable keys", async () => {
  setup("war-room-plan-interface", "interface");
  expect(
    await screen.findByRole("heading", { name: "Tactic Interface" }),
  ).toBeTruthy();
  expect(screen.getByText("0 inputs · 1 output")).toBeTruthy();
  const outputName = screen.getByLabelText("Output name 1") as HTMLInputElement;
  expect(outputName.value).toBe("Accepted Quest Plan");
  expect(
    (screen.getByLabelText("Output type 1") as HTMLSelectElement).value,
  ).toBe("quest_plan");
  const exportSource = screen.getByLabelText(
    "Export source for Accepted Quest Plan",
  ) as HTMLSelectElement;
  expect(exportSource.selectedOptions[0]?.textContent).toContain(
    "Plan Acceptance → Accepted Quest Plan",
  );
  const card = outputName.closest<HTMLElement>(".port-card");
  if (!card) throw new Error("Expected output port card");
  expect(card.querySelectorAll(":scope > label > input")).toHaveLength(1);
  await fireEvent.click(
    within(card).getByText("Advanced", { selector: "summary" }),
  );
  expect(
    (within(card).getByLabelText("Output key 1") as HTMLInputElement).value,
  ).toBe("accepted_plan");
  await fireEvent.click(
    screen.getByRole("button", { name: "Return to selected item" }),
  );
  expect(
    screen.queryByRole("heading", { name: "Tactic Interface" }),
  ).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Then, in sequence" }),
  ).toBeTruthy();
});

test("new interface ports generate keys and permit an incomplete export source", async () => {
  setup("war-room-empty");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Edit interface" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Input" }));
  await fireEvent.input(screen.getByLabelText("Input name 1"), {
    target: { value: "Quest Plan" },
  });
  await fireEvent.change(screen.getByLabelText("Input type 1"), {
    target: { value: "quest_plan" },
  });
  expect(screen.getByText("Optional", { selector: "b" })).toBeTruthy();
  const inputCard = screen
    .getByLabelText("Input name 1")
    .closest<HTMLElement>(".port-card");
  if (!inputCard) throw new Error("Expected input port card");
  await fireEvent.click(
    within(inputCard).getByText("Advanced", { selector: "summary" }),
  );
  expect(
    (within(inputCard).getByLabelText("Input key 1") as HTMLInputElement).value,
  ).toBe("plan");

  await fireEvent.click(screen.getByRole("button", { name: "+ Output" }));
  await fireEvent.input(screen.getByLabelText("Output name 1"), {
    target: { value: "Accepted Quest Plan" },
  });
  await fireEvent.change(screen.getByLabelText("Output type 1"), {
    target: { value: "quest_plan" },
  });
  expect(
    screen.getAllByText("Accepted Quest Plan needs an export source.").length,
  ).toBeGreaterThan(0);
  expect(
    (
      screen.getByLabelText(
        "Export source for Accepted Quest Plan",
      ) as HTMLSelectElement
    ).selectedOptions[0]?.textContent,
  ).toContain("Choose an internal output");
});

test("an established optional input explains which Step uses it", async () => {
  setup("war-room-detail", "interface");
  expect(await screen.findByText("Implement → Plan")).toBeTruthy();
  expect(screen.getByText("Optional", { selector: "b" })).toBeTruthy();
});

test("TacticUse inspector presents friendly optional binding and scoped output labels", async () => {
  setup("war-room-use", "use-delivery");
  expect(
    await screen.findByRole("heading", { name: "Implement & Review" }),
  ).toBeTruthy();
  const binding = screen.getByLabelText(
    "Binding for Quest Plan",
  ) as HTMLSelectElement;
  expect(binding.value).toBe("planning::accepted_plan");
  expect(binding.selectedOptions[0]?.textContent).toBe(
    "Plan & Review → Accepted Quest Plan",
  );
  expect(
    screen.getByText("Quest Plan", { selector: ".use-port strong" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Accepted Change Set", { selector: ".use-output strong" }),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("planning/plan");
});

test("Plan Review exposes visible type, exact subject, and Plan Acceptance without Advanced", async () => {
  setup("war-room-plan-interface", "edit");
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(
    screen.getByRole("button", { name: /Step Review Plan/ }),
  );

  expect(
    (screen.getByLabelText("Input name 1") as HTMLInputElement).value,
  ).toBe("Current Quest Plan");
  expect(
    (screen.getByLabelText("Input type 1") as HTMLSelectElement).value,
  ).toBe("quest_plan");
  const source = screen.getByLabelText(
    "Source for Current Quest Plan",
  ) as HTMLSelectElement;
  expect(source.selectedOptions[0]?.textContent).toContain(
    "Current Quest Plan · Quest Plan",
  );
  expect((screen.getByLabelText("Reviews") as HTMLSelectElement).value).toBe(
    "current_plan",
  );
  expect(
    (screen.getByLabelText("Acceptance gate") as HTMLSelectElement).value,
  ).toBe("plan_acceptance");
  expect(screen.getByText("Verdict · Review Verdict")).toBeTruthy();
  expect(
    screen.queryByText("Custom artifact kind", { selector: "label" }),
  ).toBeNull();
});

test("Implementation Review preserves its explicit Change Set contract", async () => {
  setup("war-room-detail", "step");
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(screen.getByRole("button", { name: /Step Review/ }));
  expect(
    (screen.getByLabelText("Input type 1") as HTMLSelectElement).value,
  ).toBe("change_set");
  expect((screen.getByLabelText("Reviews") as HTMLSelectElement).value).toBe(
    "change_set",
  );
  expect(
    (screen.getByLabelText("Acceptance gate") as HTMLSelectElement).value,
  ).toBe("implementation_acceptance");
});

test("Plan Until follows the explicit Review contract", async () => {
  setup("war-room-plan-interface", "edit");
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(screen.getByRole("button", { name: /Repeat until/ }));
  const condition = screen.getByRole("region", {
    name: "Repeat until condition",
  });
  expect(condition.textContent).toContain("Quest Plan is accepted");
  expect(condition.textContent).toContain("Review Plan · Plan Acceptance");
  expect(document.body.textContent).not.toContain("Implementation is accepted");
});

test("Plan remediation shows current Plan and rejected Review as two named inputs", async () => {
  setup("war-room-plan-interface", "edit");
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(
    screen.getByRole("button", { name: /Step Revise Plan/ }),
  );

  const names = screen.getAllByLabelText(/Input name/) as HTMLInputElement[];
  expect(names.map((input) => input.value)).toEqual([
    "Current Quest Plan",
    "Review Feedback",
  ]);
  expect(
    (screen.getByLabelText("Input type 1") as HTMLSelectElement).value,
  ).toBe("quest_plan");
  expect(
    (screen.getByLabelText("Input type 2") as HTMLSelectElement).value,
  ).toBe("review_verdict");
  expect(
    (
      screen.getByLabelText(
        "Source for Current Quest Plan",
      ) as HTMLSelectElement
    ).selectedOptions[0]?.textContent,
  ).toContain("Automatic · Current Quest Plan");
  expect(
    (screen.getByLabelText("Source for Review Feedback") as HTMLSelectElement)
      .selectedOptions[0]?.textContent,
  ).toContain("Latest rejected Plan Review");
  expect(
    screen.getByText("Plan", { selector: ".artifact-card strong" }),
  ).toBeTruthy();
});

test("Plan remediation save and reload preserves both inputs and its revised Plan output", async () => {
  const { store, value } = setup("war-room-plan-interface", "edit");
  const planning = value.product.tactics.find(
    (tactic) => tactic.id === "war-tactic-plan",
  );
  if (!planning) throw new Error("Expected Plan & Review fixture");
  const update = vi
    .spyOn(store.api, "updateTactic")
    .mockImplementation(async (_id, input) => ({ ...planning, ...input }));
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const saved = update.mock.calls[0]?.[1].body as {
    children: Array<{
      otherwise?: { consumes: unknown[]; produces: unknown[] };
    }>;
  };
  expect(saved.children[1]?.otherwise).toMatchObject({
    consumes: [
      { name: "current_plan", kind: "quest_plan", source: null },
      {
        name: "review_feedback",
        kind: "review_verdict",
        source: { producer: "review-plan", output: "verdict" },
      },
    ],
    produces: [{ name: "plan", kind: "quest_plan" }],
  });

  await fireEvent.click(
    await screen.findByRole("button", { name: "Edit Tactic" }),
  );
  await fireEvent.click(
    screen.getByRole("button", { name: /Step Revise Plan/ }),
  );
  expect(screen.getAllByLabelText(/Input name/)).toHaveLength(2);
  expect(
    (screen.getByLabelText("Input type 2") as HTMLSelectElement).value,
  ).toBe("review_verdict");
});

test("a concrete source infers an unset input type while incompatible authored types are explicit", async () => {
  setup("war-room-plan-interface", "edit");
  await screen.findByRole("button", { name: "Save Changes" });
  await fireEvent.click(
    screen.getByRole("button", { name: /Step Revise Plan/ }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "+ Input" }));
  const source = screen.getByLabelText(
    "Source for New Input",
  ) as HTMLSelectElement;
  await fireEvent.change(source, {
    target: { value: "review-plan::verdict" },
  });
  expect(
    (screen.getByLabelText("Input type 3") as HTMLSelectElement).value,
  ).toBe("review_verdict");

  await fireEvent.change(screen.getByLabelText("Input type 3"), {
    target: { value: "quest_plan" },
  });
  expect(
    screen.getByText(/source produces Review Verdict, not Quest Plan/),
  ).toBeTruthy();
});

test("invalid drafts explain every blocker during normal authoring and use the same dirty Save validation", async () => {
  setup("war-room-empty");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.input(screen.getByLabelText("Name"), {
    target: { value: "Plan & Review" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: "+ Add first Step" }),
  );
  await fireEvent.input(screen.getByLabelText("Instruction"), {
    target: { value: "Create the Plan." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Input" }));

  expect(
    screen.getByText("Choose what artifact this input expects."),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Tactic validation" })).getByText(
      "New Step → New Input needs an artifact type.",
    ),
  ).toBeTruthy();
  const create = screen.getByRole("button", { name: "Create Tactic" });
  expect((create as HTMLButtonElement).disabled).toBe(false);
  await fireEvent.click(create);
  expect(
    screen.getByRole("region", { name: "Tactic validation" }),
  ).toBeTruthy();

  await fireEvent.click(screen.getByRole("button", { name: "Close War Room" }));
  const dialog = screen.getByRole("dialog", {
    name: "Save your Tactic changes?",
  });
  expect(within(dialog).getByText("Can't save this Tactic yet")).toBeTruthy();
  expect(
    within(dialog).getByText("New Step → New Input needs an artifact type."),
  ).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Keep Editing" }),
  );
  await fireEvent.change(screen.getByLabelText("Input type 1"), {
    target: { value: "quest_plan" },
  });
  expect(
    screen.queryAllByText("New Step → New Input needs an artifact type."),
  ).toHaveLength(0);
});

test("a Review Verdict without a subject shows semantic inline guidance", async () => {
  setup("war-room-empty");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.input(screen.getByLabelText("Name"), {
    target: { value: "Review Only" },
  });
  await fireEvent.click(
    screen.getByRole("button", { name: "+ Add first Step" }),
  );
  await fireEvent.input(screen.getByLabelText("Instruction"), {
    target: { value: "Review the work." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "+ Output" }));
  await fireEvent.change(screen.getByLabelText("Output type 1"), {
    target: { value: "review_verdict" },
  });
  expect(
    screen.getAllByText("New Step needs an artifact to review.").length,
  ).toBeGreaterThan(0);
  expect(screen.getByLabelText("Reviews")).toBeTruthy();
  expect(screen.getByLabelText("Acceptance gate")).toBeTruthy();
});

test("accepted and internal Tactic export modes are separate and explicit", async () => {
  setup("war-room-plan-interface", "interface");
  await screen.findByRole("heading", { name: "Tactic Interface" });
  const mode = screen.getByLabelText(
    "Export mode for Accepted Quest Plan",
  ) as HTMLSelectElement;
  expect(mode.value).toBe("accepted");
  expect(
    (
      screen.getByLabelText(
        "Export source for Accepted Quest Plan",
      ) as HTMLSelectElement
    ).selectedOptions[0]?.textContent,
  ).toContain("Plan Acceptance → Accepted Quest Plan");
  expect(screen.getByText(/exact artifact accepted at this gate/)).toBeTruthy();

  await fireEvent.change(mode, { target: { value: "internal" } });
  const internal = screen.getByLabelText(
    "Export source for Accepted Quest Plan",
  ) as HTMLSelectElement;
  expect(
    Array.from(internal.options).map((option) => option.textContent),
  ).toEqual([
    "Choose an internal output…",
    "Plan → Quest Plan",
    "Revise Plan → Updated Quest Plan",
  ]);
  expect(screen.getByText(/producer's artifact directly/)).toBeTruthy();
});

test("a new Quest Plan interface output defaults to the explicit accepted subject", async () => {
  setup("war-room-plan-interface", "interface");
  await screen.findByRole("heading", { name: "Tactic Interface" });
  await fireEvent.click(
    screen.getByRole("button", { name: "Remove output Accepted Quest Plan" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "+ Output" }));
  await fireEvent.change(screen.getByLabelText("Output type 1"), {
    target: { value: "quest_plan" },
  });
  expect(
    (screen.getByLabelText("Output name 1") as HTMLInputElement).value,
  ).toBe("Accepted Quest Plan");
  expect(
    (
      screen.getByLabelText(
        "Export mode for Accepted Quest Plan",
      ) as HTMLSelectElement
    ).value,
  ).toBe("accepted");
  expect(
    (
      screen.getByLabelText(
        "Export source for Accepted Quest Plan",
      ) as HTMLSelectElement
    ).value,
  ).toBe("plan_acceptance");
});

test("Custom type reveals its ID only after Custom is chosen", async () => {
  setup("war-room-empty");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Tactic" }),
  );
  await fireEvent.click(screen.getByRole("button", { name: "Edit interface" }));
  await fireEvent.click(screen.getByRole("button", { name: "+ Input" }));
  expect(screen.queryByLabelText("Custom input type 1")).toBeNull();
  await fireEvent.change(screen.getByLabelText("Input type 1"), {
    target: { value: "__custom__" },
  });
  const custom = screen.getByLabelText(
    "Custom input type 1",
  ) as HTMLInputElement;
  expect(custom.value).toBe("custom_artifact");
  await fireEvent.input(custom, { target: { value: "architecture_spec" } });
  expect(custom.value).toBe("architecture_spec");
});

test("parent TacticUse saves and reloads only the accepted child boundary", async () => {
  const { store, value } = setup("war-room-use", "use-delivery");
  const composite = value.product.tactics.find(
    (tactic) => tactic.id === "war-tactic-composed",
  );
  if (!composite) throw new Error("Expected composed fixture");
  const update = vi
    .spyOn(store.api, "updateTactic")
    .mockImplementation(async (_id, input) => ({ ...composite, ...input }));
  const binding = (await screen.findByLabelText(
    "Binding for Quest Plan",
  )) as HTMLSelectElement;
  expect(
    Array.from(binding.options).map((option) => option.textContent),
  ).toEqual([
    "Not connected · Optional",
    "Plan & Review → Accepted Quest Plan",
  ]);
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(JSON.stringify(update.mock.calls[0]?.[1].body)).toContain(
    '"source":{"producer":"planning","output":"accepted_plan"}',
  );
  expect(JSON.stringify(update.mock.calls[0]?.[1].body)).not.toContain(
    '"producer":"plan"',
  );
  expect(JSON.stringify(update.mock.calls[0]?.[1].body)).not.toContain(
    '"producer":"revise-plan"',
  );
  await fireEvent.click(
    await screen.findByRole("button", { name: "Edit Tactic" }),
  );
  await fireEvent.click(
    screen.getByRole("button", { name: /Reuse tactic Implement & Review/ }),
  );
  expect(
    (screen.getByLabelText("Binding for Quest Plan") as HTMLSelectElement)
      .value,
  ).toBe("planning::accepted_plan");
});

test("new TacticUse suggests its single compatible upstream source", async () => {
  setup("war-room-use", "sequence");
  await screen.findByRole("heading", { name: "Then, in sequence" });
  await fireEvent.click(screen.getByText("+ Add", { selector: "summary" }));
  await fireEvent.click(
    screen.getByRole("button", { name: "Reuse Compose a Tactic" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Binding for Quest Plan") as HTMLSelectElement)
        .value,
    ).toBe("planning::accepted_plan"),
  );
});

test("removing an Until warns about its subtree and selects a surviving neighbor", async () => {
  setup("war-room-until", "until");
  await screen.findByRole("heading", { name: "Repeat until accepted" });
  await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = screen.getByRole("dialog", {
    name: "Remove Repeat until accepted?",
  });
  expect(within(dialog).getByText(/also removes 2 nested items/)).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove subtree" }),
  );
  expect(
    screen.queryByRole("heading", { name: "Repeat until accepted" }),
  ).toBeNull();
  expect(screen.getByRole("heading", { name: "Implement" })).toBeTruthy();
});

test("removing a Step updates selection and the saved semantic draft", async () => {
  const { store, value } = setup("war-room-detail", "step");
  const original = value.product.tactics.find(
    (tactic) => tactic.id === "war-tactic-implement-review",
  );
  if (!original) throw new Error("Expected Tactic fixture");
  const update = vi
    .spyOn(store.api, "updateTactic")
    .mockImplementation(async (_id, input) => ({ ...original, ...input }));
  await screen.findByRole("heading", { name: "Implement" });
  await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Close War Room" }));
  expect(
    screen.getByRole("dialog", { name: "Save your Tactic changes?" }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
  await fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const body = update.mock.calls[0]?.[1].body;
  expect(JSON.stringify(body)).not.toContain('"key":"implement"');
  expect(JSON.stringify(body)).toContain('"key":"review"');
  await fireEvent.click(
    await screen.findByRole("button", { name: "Edit Tactic" }),
  );
  expect(screen.queryByRole("button", { name: /Step Implement/ })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: /Step Review/ }));
  expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
});

test("referenced output removal warns and leaves actionable draft validation", async () => {
  const value = fixture("war-room-detail");
  const tactic = value.product.tactics.find(
    (item) => item.id === "war-tactic-implement-review",
  );
  if (
    !tactic ||
    !tactic.body ||
    typeof tactic.body !== "object" ||
    Array.isArray(tactic.body)
  )
    throw new Error("Expected Tactic fixture");
  const children = (tactic.body as { children: Array<Record<string, unknown>> })
    .children;
  const review = children[1];
  if (!review) throw new Error("Expected Review Step");
  review.consumes = [
    {
      name: "change_set",
      kind: "change_set",
      source: { producer: "implement", output: "change_set" },
      required: true,
    },
  ];
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WarRoomWindow, {
    props: {
      store,
      product: value.product,
      scene: "step",
      onClose: vi.fn(),
      onOpenQuestBoard: vi.fn(),
    },
  });
  await screen.findByRole("heading", { name: "Implement" });
  await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = screen.getByRole("dialog", { name: "Remove Implement?" });
  expect(within(dialog).getByText(/Review → Change Set/)).toBeTruthy();
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove subtree" }),
  );
  expect(
    (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    screen.getByRole("region", { name: "Tactic validation" }),
  ).toBeTruthy();
});

test("close and Tactic switching use shared Keep Editing, Discard, Save protection", async () => {
  const { onClose } = setup("war-room-detail", "step");
  await fireEvent.input(await screen.findByLabelText("Instruction"), {
    target: { value: "Unsaved." },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Close War Room" }));
  expect(onClose).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", {
    name: "Save your Tactic changes?",
  });
  expect(
    within(dialog).getByRole("button", { name: "Keep Editing" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Discard" })).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Save Changes" }),
  ).toBeTruthy();
});
