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
import App from "../src/App.svelte";
import { ApiClient } from "../src/api/client";
import TownHud from "../src/components/hud/TownHud.svelte";
import { type ClientFixture, createFixture } from "../src/fixtures/fixtures";
import { type BuildingId, createAppStore } from "../src/state/app-store";
import { attachTestLiveSession } from "./live-session-fixture";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

beforeEach(() => {
  history.replaceState(null, "", "/?capture=dom");
});

function fixture(name: string): ClientFixture {
  const value = createFixture(name);
  if (!value) throw new Error(`Missing fixture '${name}'`);
  return value;
}

function appSetup(name = "town-hud-mixed") {
  const value = fixture(name);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const rendered = render(App, { props: { store } });
  return { value, store, rendered };
}

test("the HUD is passive status rather than building navigation", () => {
  const value = fixture("town-hud-mixed");
  render(TownHud, {
    props: { product: value.product, realtimeStatus: "connected" },
  });
  const hud = screen.getByLabelText("Quest Engineering town status");

  expect(within(hud).queryAllByRole("button")).toHaveLength(0);
  for (const label of [
    "Projects",
    "Guild Hall",
    "Forge",
    "Tavern",
    "Quest Board",
    "Work Yard",
    "War Room",
  ])
    expect(within(hud).queryByText(label)).toBeNull();

  expect(within(hud).getByText("6 active Quests")).toBeTruthy();
  expect(within(hud).getByText("2 working Quests")).toBeTruthy();
  expect(within(hud).getByText("1 active Quest needs attention")).toBeTruthy();
  expect(within(hud).getByText("2 Quests awaiting review")).toBeTruthy();
});

test("live session attention is counted while remaining distinguishable", () => {
  const value = fixture("town-hud-idle");
  render(TownHud, {
    props: {
      product: value.product,
      realtimeStatus: "connected",
      liveAttentionCount: 2,
    },
  });
  expect(
    screen.getByText(
      "2 attention items includes 2 live sessions waiting for help",
    ),
  ).toBeTruthy();
  expect(
    screen.getByTitle(/2 live sessions waiting for human help/),
  ).toBeTruthy();
});

test("attention-toast Open Session observes without Take Control authority", async () => {
  const value = fixture("work-yard-running");
  const run = value.selectedRunId ? value.runs[value.selectedRunId] : null;
  const step = run?.steps.at(-1);
  if (!run || !step?.attempt) throw new Error("Expected current Attempt");
  const session = attachTestLiveSession(step, {
    canObserve: true,
    canTakeover: false,
  });
  const target = {
    attentionId: "attention-observe-only",
    runId: run.id,
    occurrenceId: step.occurrence_id,
    attemptId: step.attempt.id,
    sessionId: session.id,
    questTitle: run.quest.title,
    memberName: step.member?.name ?? "Builder",
    stepName: step.name ?? step.semantic_step_key,
    harnessName: session.harness.display_name,
    message: "Inspect the live session before deciding.",
  };
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/socket",
    value,
  );
  const observe = vi.spyOn(store, "openSession").mockResolvedValue(true);
  const takeover = vi.spyOn(store, "takeControl").mockResolvedValue(true);
  store.attentionNotifications.set([target]);
  render(App, { props: { store } });

  expect(screen.queryByRole("button", { name: "Take Control" })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Open Session" }));

  expect(observe).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(target);
  expect(takeover).not.toHaveBeenCalled();
});

test("zero metric slots remain present and connectivity changes emphasis truthfully", async () => {
  const idle = fixture("town-hud-idle");
  const rendered = render(TownHud, {
    props: { product: idle.product, realtimeStatus: "connected" },
  });
  expect(screen.getByText("0 active Quests")).toBeTruthy();
  expect(screen.getByText("0 working Quests")).toBeTruthy();
  expect(screen.getByText("0 active Quests need attention")).toBeTruthy();
  expect(screen.getByText("0 Quests awaiting review")).toBeTruthy();
  expect(screen.getByText("Quest Engineering server connected")).toBeTruthy();

  await rendered.rerender({
    product: idle.product,
    realtimeStatus: "disconnected",
  });
  expect(
    screen.getByText("Quest Engineering server disconnected"),
  ).toBeTruthy();

  await rendered.rerender({
    product: idle.product,
    realtimeStatus: "reconnecting",
    serverReachable: true,
  });
  expect(screen.getByText("Online")).toBeTruthy();
  expect(
    screen.getByText(
      "Quest Engineering server connected; live updates reconnecting",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Reconnecting")).toBeNull();
});

test("non-archived Projects are discoverable in the island camera navigator", () => {
  const { value } = appSetup();
  const navigator = screen.getByLabelText(
    "Focus Project island",
  ) as HTMLSelectElement;
  const options = [...navigator.options].map((option) => option.textContent);
  for (const project of value.product.workspaces.filter(
    (workspace) => workspace.archived_at === null,
  ))
    expect(options).toContain(project.name);
});

test("town proxies and all existing building hotkeys retain their navigation path", async () => {
  const { store, rendered } = appSetup();
  const projectsProxy = Array.from(
    rendered.container.querySelectorAll<HTMLButtonElement>(
      ".world-proxies button",
    ),
  ).find((button) => button.textContent === "Projects");
  if (!projectsProxy) throw new Error("Missing authored Projects proxy");
  await fireEvent.click(projectsProxy);
  expect(get(store.selectedBuilding)).toBe("gatehouse");
  store.selectBuildingId(null);

  const shortcuts: Array<[string, BuildingId]> = [
    ["1", "gatehouse"],
    ["2", "guild"],
    ["3", "blacksmith"],
    ["4", "tavern"],
    ["5", "quest-board"],
    ["6", "work-area"],
    ["7", "war-room"],
  ];
  for (const [key, building] of shortcuts) {
    await fireEvent.keyDown(window, { key });
    expect(get(store.selectedBuilding)).toBe(building);
    store.selectBuildingId(null);
    await Promise.resolve();
  }
});

test("War Room remains reachable from its authored town proxy and hotkey 7", async () => {
  const { store, rendered } = appSetup();
  const warRoomProxy = Array.from(
    rendered.container.querySelectorAll<HTMLButtonElement>(
      ".world-proxies button",
    ),
  ).find((button) => button.textContent === "War Room");
  if (!warRoomProxy) throw new Error("Missing authored War Room proxy");

  await fireEvent.click(warRoomProxy);
  expect(get(store.selectedBuilding)).toBe("war-room");
  store.selectBuildingId(null);
  await Promise.resolve();
  await fireEvent.keyDown(window, { key: "7" });
  expect(get(store.selectedBuilding)).toBe("war-room");
});

test("Product invalidation-style updates refresh counters without resetting window state", async () => {
  const { store } = appSetup("town-hud-working");
  store.selectBuildingId("gatehouse");
  const reviews = fixture("town-hud-reviews");
  store.product.set(reviews.product);

  await waitFor(() =>
    expect(screen.getByText("3 Quests awaiting review")).toBeTruthy(),
  );
  expect(get(store.selectedBuilding)).toBe("gatehouse");
});

test("the legacy Journal, J shortcut, query route, and obsolete credits are gone", async () => {
  history.replaceState(null, "", "/?capture=dom&journal=1");
  const { store } = appSetup();

  expect(screen.queryByLabelText("Recent Quest and Run journal")).toBeNull();
  expect(screen.queryByText("Quest Journal")).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /Mini Medieval|VEXED|fruitpunch24|CC BY 4\.0/,
  );
  expect(
    within(screen.getByLabelText("Quest Engineering town status")).queryByText(
      /Journal/,
    ),
  ).toBeNull();

  await fireEvent.keyDown(window, { key: "j" });
  expect(screen.queryByLabelText("Recent Quest and Run journal")).toBeNull();
  expect(get(store.selectedBuilding)).toBeNull();
});
