import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import {
  ApiError,
  type HumanAttention,
  type LocalSessionAttachmentDescriptor,
  type RunProjection,
} from "../src/api/contracts";
import WorkYardWindow from "../src/components/work-yard/WorkYardWindow.svelte";
import { type ClientFixture, createFixture } from "../src/fixtures/fixtures";
import * as liveSessionPlatform from "../src/platform/live-session";
import { createAppStore } from "../src/state/app-store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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
    screen.getByText("Review: Accepted", { selector: ".result-section h3" }),
  ).toBeTruthy();
  expect(screen.queryByText("occ-implement")).toBeNull();
  expect(
    document.querySelector<HTMLDetailsElement>("details.technical")?.open,
  ).toBe(false);
  expect(screen.queryByText(/Duration/)).toBeNull();
});

test("shows concurrent live sessions, waiting attention, exact open and takeover actions", async () => {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const [first, second] = run.steps;
  if (!first?.attempt || !second?.attempt)
    throw new Error("Expected concurrent Step attempts");
  first.session = harnessSession("session-a", "running", null);
  second.session = harnessSession("session-b", "waiting_for_human", {
    attention_id: "attention-b",
    category: "needs_permission",
    message: "Permission required to continue.",
    requested_at: "2026-09-06T00:00:00Z",
  });
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const open = vi.spyOn(store, "openLiveSession").mockResolvedValue(true);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(screen.getByRole("heading", { name: "Live Session" })).toBeTruthy();
  expect(screen.getByText(/Permission required to continue\./)).toBeTruthy();
  expect(screen.getByText("Waiting for you")).toBeTruthy();
  const cards = document.querySelectorAll(".session-list article");
  expect(cards).toHaveLength(2);
  const waitingCard = cards[1] as HTMLElement;
  await fireEvent.click(
    within(waitingCard).getByRole("button", { name: "Take Control" }),
  );
  expect(open).toHaveBeenCalledWith(
    run.id,
    second.attempt.id,
    second.session,
    "takeover",
  );
  const runningCard = cards[0] as HTMLElement;
  expect(
    within(runningCard).queryByRole("button", { name: "Take Control" }),
  ).toBeNull();
  await fireEvent.click(
    within(runningCard).getByRole("button", { name: "Open Session" }),
  );
  expect(open).toHaveBeenCalledWith(
    run.id,
    first.attempt.id,
    first.session,
    "observe",
  );
});

test("pre-prompt execution exposes distinct confirmed authorization and cancellation commands", async () => {
  const { value, run, step, store, identity } = operatorSetup();
  const authorize = vi.spyOn(store, "authorizePrompt").mockResolvedValue(true);
  const cancelExecution = vi
    .spyOn(store, "cancelExecution")
    .mockResolvedValue(null);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(screen.getByRole("button", { name: "Open Session" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Authorize inference" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel execution" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Take Control" })).toBeNull();

  await fireEvent.click(
    screen.getByRole("button", { name: "Authorize inference" }),
  );
  let dialog = screen.getByRole("dialog", { name: "Authorize inference?" });
  expect(dialog.textContent).toContain(
    "allows the current Attempt to submit its configured Pi model prompt",
  );
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Not yet" }),
  );
  expect(authorize).not.toHaveBeenCalled();

  await fireEvent.click(
    screen.getByRole("button", { name: "Authorize inference" }),
  );
  dialog = screen.getByRole("dialog", { name: "Authorize inference?" });
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Authorize inference" }),
  );
  expect(authorize).toHaveBeenCalledWith(identity);

  await fireEvent.click(
    screen.getByRole("button", { name: "Cancel execution" }),
  );
  dialog = screen.getByRole("dialog", { name: "Cancel this execution?" });
  expect(dialog.textContent).toContain("Existing history will be preserved");
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Keep execution" }),
  );
  expect(cancelExecution).not.toHaveBeenCalled();

  await fireEvent.click(
    screen.getByRole("button", { name: "Cancel execution" }),
  );
  dialog = screen.getByRole("dialog", { name: "Cancel this execution?" });
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Cancel execution" }),
  );
  expect(cancelExecution).toHaveBeenCalledWith(identity);
  expect(step.attempt?.id).toBe(identity.attemptId);
  expect(run.id).toBe(identity.runId);
});

test("Work Yard preserves the exact pane ID through inputless native attachment", async () => {
  const { value, api, store } = operatorSetup();
  const descriptor: LocalSessionAttachmentDescriptor = {
    descriptor_token: "descriptor-token",
    expires_at: "2099-01-01T00:00:00Z",
    mode: "local_native_terminal",
    worker_id: "local-worker",
    worker_generation: 4,
    session_id: "session-pre-prompt",
    state: "waiting_for_human",
    takeover_allowed: false,
    recovery_allowed: false,
    terminal: {
      attachment_mode: "local_native_terminal",
      backend_kind: "herdr",
      terminal_session_id: "worker-session",
      pane_id: "w2:p2",
      terminal_id: "terminal-1",
      supports_observation: true,
      supports_takeover: true,
    },
  };
  vi.spyOn(api, "getSessionAttachment").mockResolvedValue(descriptor);
  vi.spyOn(api, "recordSessionOpened").mockResolvedValue("session-pre-prompt");
  const nativeOpen = vi
    .spyOn(liveSessionPlatform, "openLocalLiveSession")
    .mockResolvedValue();
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  await fireEvent.click(screen.getByRole("button", { name: "Open Session" }));

  await waitFor(() =>
    expect(nativeOpen).toHaveBeenCalledWith(descriptor, "observe"),
  );
  expect(descriptor.terminal.pane_id).toBe("w2:p2");
  expect(api.recordSessionOpened).toHaveBeenCalledWith(
    "descriptor-token",
    "observe",
  );
});

test("operator command pending state does not block inputless Open Session", async () => {
  const { value, step, store, identity } = operatorSetup();
  store.executionCommands.set([
    {
      operation: "cancel",
      identity,
      requestId: "pending-cancel",
      status: "pending",
      error: null,
    },
  ]);
  const open = vi.spyOn(store, "openLiveSession").mockResolvedValue(true);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  const openButton = screen.getByRole("button", { name: "Open Session" });
  const authorizeButton = screen.getByRole("button", {
    name: "Authorize inference",
  }) as HTMLButtonElement;
  const cancelButton = screen.getByRole("button", {
    name: "Requesting cancellation…",
  }) as HTMLButtonElement;
  expect(authorizeButton.disabled).toBe(true);
  expect(cancelButton.disabled).toBe(true);
  expect((openButton as HTMLButtonElement).disabled).toBe(false);
  await fireEvent.click(openButton);
  expect(open).toHaveBeenCalledWith(
    identity.runId,
    identity.attemptId,
    step.session,
    "observe",
  );
});

test("cancellation remains available before a live session is projected", () => {
  const { value, step, store } = operatorSetup();
  step.session = null;
  step.recovery = null;
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(
    screen.getByRole("heading", { name: "Execution control" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel execution" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open Session" })).toBeNull();
});

test("realtime Attempt replacement closes stale confirmation and clears old affordances", async () => {
  const { value, run, store } = operatorSetup();
  const cancelExecution = vi
    .spyOn(store, "cancelExecution")
    .mockResolvedValue(null);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  await fireEvent.click(
    screen.getByRole("button", { name: "Cancel execution" }),
  );
  expect(
    screen.getByRole("dialog", { name: "Cancel this execution?" }),
  ).toBeTruthy();

  const replacement = structuredClone(run);
  const replacementStep = replacement.steps.at(-1);
  if (!replacementStep?.attempt)
    throw new Error("Expected replacement Attempt");
  replacementStep.attempt.id = "replacement-attempt";
  replacementStep.attempt.can_cancel = false;
  replacementStep.recovery = null;
  store.selectedRun.set(replacement);

  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Cancel this execution?" }),
    ).toBeNull(),
  );
  expect(cancelExecution).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Authorize inference" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel execution" })).toBeNull();
});

test("terminal cancellation removes commands while retained observation remains", async () => {
  const { value, run, step, store } = operatorSetup();
  if (!step.attempt || !step.session)
    throw new Error("Expected execution state");
  step.state = "cancelled";
  step.recovery = null;
  step.attempt.state = "cancelled";
  step.attempt.can_cancel = false;
  step.attempt.cancellation = {
    state: "cancelled",
    request_id: "cancel-request",
    origin: "product_operator",
    reason: null,
    requested_generation: 3,
    requested_at: "2026-09-23T00:00:00Z",
    cancelled_at: "2026-09-23T00:00:01Z",
  };
  step.session.state = "retained";
  step.session.attachment.can_takeover = false;
  run.status = "cancelled";
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(screen.getByRole("button", { name: "Inspect Session" })).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Execution cancelled · session history retained.",
  );
  expect(
    screen.queryByRole("button", { name: "Authorize inference" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel execution" })).toBeNull();
});

test("operator command failures are scoped and dismissible", async () => {
  const { value, store, identity } = operatorSetup();
  store.executionCommands.set([
    {
      operation: "authorize",
      identity,
      requestId: "authorize-request",
      status: "error",
      error: new ApiError(
        "prompt_authorization_not_ready",
        "The current Attempt is no longer ready for authorization.",
      ),
    },
  ]);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Authorization not completed");
  await fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(screen.queryByText("Authorization not completed")).toBeNull(),
  );
});

test("shows conversational human control and the explicit hand-back command", async () => {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps[0];
  if (!step) throw new Error("Expected Step");
  step.session = harnessSession("session-conversation", "waiting_for_human", {
    attention_id: "attention-conversation",
    category: "needs_input",
    message: "Choose a filename with Pi.",
    requested_at: "2026-09-06T00:00:00Z",
    interaction: {
      kind: "conversational_intervention",
      control_state: "human_control",
      resume_command: "/qe-resume",
    },
  });
  step.session.events = [
    {
      id: "event-human-control",
      type: "local_session_opened",
      attention_id: "attention-conversation",
      metadata: { mode: "takeover", human_control_started: true },
      occurred_at: "2026-09-06T00:01:00Z",
    },
  ];
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(screen.getByText("Human controlling session")).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Use normal Pi chat for as many turns as needed",
  );
  expect(document.body.textContent).toContain("/qe-resume");
  await fireEvent.click(screen.getByText("Session history"));
  expect(screen.getByText(/Human control started/)).toBeTruthy();
});

test("retained sessions are inspectable without being presented as live", () => {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps[0];
  if (!step) throw new Error("Expected Step");
  step.session = harnessSession("session-retained", "retained", null);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });
  expect(screen.getByText("Session retained")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Inspect Session" })).toBeTruthy();
});

test("failed retained execution distinguishes inspection, Help & Retry, and fresh recovery", async () => {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps[0];
  if (!step) throw new Error("Expected Step");
  step.state = "failed";
  const initialAttempt = step.attempt;
  if (!initialAttempt) throw new Error("Expected Attempt");
  initialAttempt.state = "failed";
  initialAttempt.operational = {
    recovery_epoch: 0,
    recovery_kind: "initial",
    attempt_in_epoch: 1,
    attempt_allowance: 2,
    policy_source: "configured",
    continuation_mode: "fresh",
    recovery_authorized_at: "2026-09-06T00:00:00Z",
  };
  const recoveryAttempt = {
    ...initialAttempt,
    id: "recovery-attempt-2",
    number: 2,
    retry_of_attempt_id: initialAttempt.id,
    operational: {
      ...initialAttempt.operational,
      recovery_epoch: 1,
      recovery_kind: "human" as const,
      continuation_mode: "retained" as const,
    },
  };
  step.attempt = recoveryAttempt;
  step.attempts = [initialAttempt, recoveryAttempt];
  step.session = harnessSession("session-failed-retained", "retained", null);
  step.recovery = {
    can_retry: false,
    can_mark_failed: false,
    can_human_retry: true,
    can_retry_fresh: true,
    retained_session_available: true,
    classification: "operator_recovery_required",
    message: "Authentication requires human recovery.",
  };
  run.issues = [{ code: "step_failed", message: step.recovery.message }];
  run.operational_recovery = [
    {
      id: "recovery-1",
      occurrence_id: step.occurrence_id,
      epoch_number: 1,
      authorization_kind: "human",
      attempt_allowance: 2,
      policy_source: "configured",
      continuation_mode: "retained",
      authorized_at: "2026-09-06T00:00:00Z",
      attempts_scheduled: 1,
    },
  ];
  run.semantic_remediation = [
    {
      region_occurrence_id: "region-1",
      semantic_region_id: "review-loop",
      remediations_completed: 2,
      maximum_remediations: 3,
      status: "remediating",
      review_shaped: true,
    },
  ];
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(screen.getByRole("button", { name: "Inspect Session" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Help & Retry" })).toBeTruthy();
  expect(document.body.textContent).toContain("/qe-retry");
  expect(screen.queryByRole("button", { name: "Take Control" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry with fresh session" }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
  expect(document.body.textContent).toContain("2 of 3 repairs used");
  expect(document.body.textContent).toContain(
    "Human recovery 1 · Fresh allowance: 2",
  );
  expect(document.body.textContent).toContain(
    "Human recovery 1 · Attempt 1 of 2",
  );
});

test("an unavailable Worker is explicit without an attach action", () => {
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps[0];
  if (!step) throw new Error("Expected Step");
  step.session = harnessSession("session-offline", "unavailable", null);
  step.session.worker.state = "disconnected";
  step.session.attachment.available = false;
  step.session.attachment.reason = "worker_offline";
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(document.body.textContent).toContain(
    "Session unavailable · Worker offline",
  );
  expect(screen.queryByRole("button", { name: "Open Session" })).toBeNull();
});

test("web clients show the hosting Worker without pretending to attach", () => {
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps[0];
  if (!step) throw new Error("Expected Step");
  step.session = harnessSession("session-remote", "running", null);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });
  expect(document.body.textContent).toContain(
    "Live session available on local-worker. Browser attachment is unavailable.",
  );
  expect(screen.queryByRole("button", { name: "Open Session" })).toBeNull();
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

test("remediation history separates semantic Reviews from operational attempts", async () => {
  setup("work-yard-remediation", "remediation");

  expect(screen.getByRole("heading", { name: "Review 1" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Repair 1" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Review 2" })).toBeTruthy();
  expect(screen.getByText(/Rejected/)).toBeTruthy();
  expect(screen.getByText("Accepted")).toBeTruthy();

  const attempts = document.querySelector<HTMLDetailsElement>(
    "details.attempt-history",
  );
  const summary = attempts?.querySelector("summary");
  if (!attempts || !summary) throw new Error("Expected attempt history");
  expect(attempts.open).toBe(false);
  await fireEvent.click(summary);
  expect(attempts.textContent).toContain("Attempt 1");
  expect(attempts.textContent).toContain("Uncertain · Retried");
  expect(attempts.textContent).toContain("No output produced");
  expect(attempts.textContent).toContain("Attempt 2");
  expect(attempts.textContent).toContain("Produced Review Verdict");
  expect(screen.queryByText("occ-review-first")).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "Overview" }));
  expect(
    screen.getByText("Review: Accepted", { selector: ".result-section h3" }),
  ).toBeTruthy();
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

test("uncertain execution offers confirmed retry and mark-failed recovery", async () => {
  const value = fixture("work-yard-overview");
  const run = requiredRun(value);
  const uncertain = run.steps[0];
  if (!uncertain) throw new Error("Expected Step fixture");
  run.status = "uncertain";
  run.delivery = null;
  run.issues = [
    { code: "execution_uncertain", message: "Execution outcome is unknown." },
  ];
  uncertain.state = "uncertain";
  uncertain.issue = run.issues[0] ?? null;
  uncertain.recovery = {
    can_retry: true,
    can_mark_failed: true,
    message: "Pi settled without a structured Step result.",
  };

  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const retry = vi.spyOn(store, "retryExecution").mockResolvedValue(undefined);
  const markFailed = vi
    .spyOn(store, "markExecutionFailed")
    .mockResolvedValue(undefined);
  render(WorkYardWindow, {
    props: { store, product: value.product, onClose: vi.fn() },
  });

  expect(
    screen.getByText("Pi settled without a structured Step result."),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Retry Step" }));
  let dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("may repeat external effects");
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Retry Step" }),
  );
  expect(retry).toHaveBeenCalledWith(run.id, uncertain.occurrence_id);

  await fireEvent.click(
    screen.getByRole("button", { name: "Mark Run Failed" }),
  );
  dialog = screen.getByRole("dialog");
  await fireEvent.click(
    within(dialog).getByRole("button", { name: "Mark Run Failed" }),
  );
  expect(markFailed).toHaveBeenCalledWith(run.id, uncertain.occurrence_id);
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
    artifacts: current.artifacts.filter(
      (item) => item.type !== "review_verdict",
    ),
  };
  store.selectedRun.set(withoutVerdict);

  expect(
    await screen.findByRole("heading", { name: "Select an artifact" }),
  ).toBeTruthy();
});

function operatorSetup() {
  vi.spyOn(liveSessionPlatform, "canOpenLocalLiveSession").mockReturnValue(
    true,
  );
  const value = fixture("work-yard-running");
  const run = requiredRun(value);
  const step = run.steps.at(-1);
  if (!step?.attempt) throw new Error("Expected current Attempt");
  step.attempt.can_cancel = true;
  step.recovery = {
    can_retry: false,
    can_mark_failed: false,
    can_authorize_prompt: true,
    message: "Explicit authorization is required.",
  };
  step.session = harnessSession("session-pre-prompt", "waiting_for_human", {
    attention_id: `qe-prompt-authorization-${step.attempt.id}`,
    category: "needs_confirmation",
    message: "Explicit authorization is required.",
    requested_at: "2026-09-06T00:00:00Z",
  });
  step.session.native_identity.conversation_id = null;
  step.session.attachment.can_takeover = false;
  const api = new ApiClient({ httpBaseUrl: "http://fixture.invalid" });
  const store = createAppStore(api, "ws://fixture.invalid/socket", value);
  return {
    value,
    run,
    step,
    api,
    store,
    identity: {
      runId: run.id,
      occurrenceId: step.occurrence_id,
      attemptId: step.attempt.id,
    },
  };
}

function harnessSession(
  id: string,
  state: "running" | "waiting_for_human" | "unavailable" | "retained",
  attention: HumanAttention | null,
): NonNullable<RunProjection["steps"][number]["session"]> {
  return {
    id,
    harness: { kind: "pi", display_name: "Pi" },
    worker: {
      id: "local-worker",
      display_name: "local-worker",
      state: "connected",
    },
    state,
    native_identity: {
      conversation_id: "conversation-1",
      terminal_id: "terminal-1",
    },
    capabilities: {
      can_attach_terminal: true,
      can_send_input: true,
      can_interrupt: true,
      can_detect_attention: true,
      can_resume: true,
      can_observe_structured_events: true,
      structured_confirmation: true,
      structured_text_response: false,
      structured_choice_response: false,
      structured_multiline_response: false,
      native_prompt_control: true,
      conversational_takeover: true,
      automation_resume: true,
    },
    attachment: {
      mode: "local_native_terminal",
      available: true,
      reason: null,
      can_observe: true,
      can_takeover: state === "waiting_for_human",
      can_recover: state === "retained",
    },
    attention,
    started_at: "2026-09-06T00:00:00Z",
    last_activity_at: "2026-09-06T00:00:01Z",
    events: [],
  };
}

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
