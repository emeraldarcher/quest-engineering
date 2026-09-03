import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import type { RunProjection } from "../src/api/contracts";
import WorkYardWindow from "../src/components/work-yard/WorkYardWindow.svelte";
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

function fixture(name = "work-yard-overview"): ClientFixture {
  const value = createFixture(name);
  if (!value) throw new Error("Fixture unavailable");
  return value;
}

function setup(name = "work-yard-overview", scene: string | null = null) {
  const value = fixture(name);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const onMember = vi.fn();
  render(WorkYardWindow, {
    props: {
      store,
      product: value.product,
      onClose: vi.fn(),
      onMember,
      scene,
    },
  });
  return { value, store, onMember };
}

test("replaces the native dropdown with summary-only Run browser cards", () => {
  setup("work-yard-history");

  expect(
    screen.getByRole("complementary", { name: "Run browser" }),
  ).toBeTruthy();
  expect(document.querySelector("select")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Accessibility Polish/ }),
  ).toBeTruthy();
  expect(screen.getAllByText(/of 2 steps/).length).toBeGreaterThan(0);
});

test("a completed archived Quest remains discoverable through its merged Run", async () => {
  const value = fixture("work-yard-merged");
  const runId = value.selectedRunId;
  const retainedRun = runId ? value.runs[runId] : null;
  if (!runId || !retainedRun) throw new Error("Missing retained Run fixture");
  value.runs[runId] = {
    ...retainedRun,
    quest: { ...retainedRun.quest, title: "Demo For John" },
  };
  value.selectedRunId = null;
  value.product = {
    ...value.product,
    quests: [],
    runs: value.product.runs.map((summary) => ({
      ...summary,
      quest_title: "Demo For John",
    })),
  };
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: {
      store,
      product: value.product,
      onClose: vi.fn(),
    },
  });

  expect(
    screen.getByRole("button", { name: /Demo For John.*Merged/ }),
  ).toBeTruthy();
  expect(
    await screen.findByRole("heading", { name: "Demo For John" }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
  expect(screen.getAllByText("Merged").length).toBeGreaterThan(0);
});

test("Overview is concise and separates execution, Delivery, Quest, and workspace", () => {
  setup();

  expect(screen.getByRole("heading", { name: "Mini Test Run" })).toBeTruthy();
  expect(document.body.textContent).toContain("QE Test Space");
  expect(document.body.textContent).toContain("Engineering Pair");
  expect(screen.getByText("Base branch couldn't be determined")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry Publishing" })).toBeTruthy();
  expect(screen.getByText("Rowan")).toBeTruthy();
  expect(screen.getByText("Mira")).toBeTruthy();
  expect(
    screen.getByText("Approved", { selector: ".result-section h3" }),
  ).toBeTruthy();
  expect(screen.queryByText("occ-implement")).toBeNull();
  expect(
    document.querySelector<HTMLDetailsElement>("details.technical")?.open,
  ).toBe(false);
  expect(screen.queryByText(/Duration/)).toBeNull();
});

test("Timeline uses snapshot Member names and current attempt without inventing history", async () => {
  setup("work-yard-running");
  await fireEvent.click(screen.getByRole("button", { name: "Timeline" }));

  expect(screen.getByRole("heading", { name: "Implement" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
  expect(screen.getByText(/Mira/)).toBeTruthy();
  expect(document.body.textContent).toContain("Running· Attempt 2");
  expect(screen.queryByRole("heading", { name: "Attempts" })).toBeNull();
});

test("remediation sequencing uses repeated semantic passes", () => {
  setup("work-yard-remediation", "remediation");

  expect(
    screen.getByRole("heading", { name: "Review · second pass" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Repair" })).toBeTruthy();
  expect(screen.getByText("Changes requested")).toBeTruthy();
  expect(screen.queryByText("occ-review-first")).toBeNull();
});

test("artifact details load lazily and arbitrary values retain Raw data fallback", async () => {
  const { store } = setup("work-yard-artifacts", "artifacts");
  const loader = vi.spyOn(store, "loadArtifact");

  expect(loader).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: /Custom metrics/ }));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Confidence")).toBeTruthy();
  expect(screen.getByText("0.94")).toBeTruthy();
  expect(screen.getByText("Raw data")).toBeTruthy();
});

test("change_set is explicitly agent-reported rather than authoritative Git evidence", async () => {
  setup("work-yard-artifacts", "artifacts");
  await fireEvent.click(
    screen.getByRole("button", { name: /Reported change set/ }),
  );

  expect(await screen.findByText("Agent-reported output.")).toBeTruthy();
  expect(
    screen.getByText(/separate Worker and repository evidence/),
  ).toBeTruthy();
  expect(screen.queryByText("Actual changes")).toBeNull();
  expect(screen.queryByRole("button", { name: /View Changes/ })).toBeNull();
});

test("preparing_review remains a single truthful public phase", async () => {
  setup("preparing-review", "delivery");

  expect(screen.getAllByText("Preparing review").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Creating pull request/i)).toBeNull();
  expect(screen.queryByText(/Pushing branch/i)).toBeNull();
  expect(screen.queryByText(/% complete/i)).toBeNull();
});

test("Delivery actions use authoritative eligibility", async () => {
  const value = fixture("work-yard-overview");
  const run = requiredRun(value);
  if (!run.delivery) throw new Error("Expected Delivery");
  run.delivery = {
    ...run.delivery,
    state: "no_changes",
    issue: null,
    can_retry: false,
  };
  run.execution_environment.state = "retained";
  const summary = value.product.runs[0];
  const quest = value.product.quests[0];
  if (!summary || !quest) throw new Error("Expected Product projections");
  summary.delivery = run.delivery;
  quest.lifecycle = {
    state: "needs_attention",
    label: "Not complete",
    current_run_id: run.id,
    primary_action: "run_again",
    delivery: run.delivery,
  };
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Delivery" }));

  expect(screen.getByRole("button", { name: "Run Again" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Clean Up Workspace" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry Publishing" })).toBeNull();
});

test("closed-unmerged cleanup requires explicit acknowledgment", async () => {
  const value = fixture("work-yard-cleanup");
  const run = requiredRun(value);
  if (!run.delivery) throw new Error("Expected Delivery");
  run.delivery = {
    ...run.delivery,
    state: "closed_unmerged",
    can_retry: false,
  };
  const summary = value.product.runs[0];
  if (!summary) throw new Error("Expected Run summary");
  summary.delivery = run.delivery;
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
  await fireEvent.click(
    screen.getByRole("button", { name: "Clean Up Workspace" }),
  );

  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Acknowledge and Clean Up" }),
  ).toBeTruthy();
});

test("realtime projection replacement preserves section, Member, artifact, and Technical disclosure", async () => {
  const { store } = setup("work-yard-artifacts");
  const rowan = screen.getByRole("button", { name: /Rowan/ });
  await fireEvent.click(rowan);
  await fireEvent.click(screen.getByRole("button", { name: /Artifacts/ }));
  const verdict = screen.getByRole("button", { name: /Verdict/ });
  await fireEvent.click(verdict);
  await screen.findByText("Raw data");
  verdict.focus();
  const technical =
    document.querySelector<HTMLDetailsElement>("details.technical");
  const technicalSummary = technical?.querySelector("summary");
  if (!technical || !technicalSummary)
    throw new Error("Expected Technical details");
  await fireEvent.click(technicalSummary);

  const current = selectedProjection(store.selectedRun);
  store.selectedRun.set({ ...current, revision: current.revision + 1 });

  await waitFor(() => expect(technical.open).toBe(true));
  expect(screen.getByText("Artifact detail")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /Verdict/ })
      .classList.contains("selected"),
  ).toBe(true);
  expect(document.activeElement).toBe(verdict);
  await fireEvent.click(screen.getByRole("button", { name: "Overview" }));
  expect(
    screen
      .getByRole("button", { name: /Rowan/ })
      .classList.contains("selected"),
  ).toBe(true);
  expect(screen.getByLabelText("Selected Member").textContent).toContain(
    "Rowan",
  );
});

test("artifact selection returns to list state when the artifact disappears", async () => {
  const { store } = setup("work-yard-artifacts", "artifacts");
  await fireEvent.click(screen.getByRole("button", { name: /Verdict/ }));
  await screen.findByText("Artifact detail");
  const current = selectedProjection(store.selectedRun);
  const withoutVerdict: RunProjection = {
    ...current,
    revision: current.revision + 1,
    artifacts: current.artifacts.filter((item) => item.type !== "verdict"),
  };
  store.selectedRun.set(withoutVerdict);

  expect(
    await screen.findByRole("heading", { name: "Select an artifact" }),
  ).toBeTruthy();
});

function requiredRun(value: ClientFixture): RunProjection {
  const run = value.runs["run-mini-test"];
  if (!run) throw new Error("Expected fixture Run");
  return run;
}

function selectedProjection(
  store: ReturnType<typeof createAppStore>["selectedRun"],
): RunProjection {
  const value = get(store);
  if (!value) throw new Error("No selected Run");
  return value;
}
