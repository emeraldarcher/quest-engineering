import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";
import App from "../src/App.svelte";
import { ApiClient } from "../src/api/client";
import { type ClientFixture, createFixture } from "../src/fixtures/fixtures";
import { createAppStore } from "../src/state/app-store";

afterEach(cleanup);

function fixture(name: string): ClientFixture {
  const value = createFixture(name);
  if (!value) throw new Error("Fixture unavailable");
  return value;
}

function setup(
  name: string,
  query = "?capture=dom",
  configure?: (value: ClientFixture) => void,
) {
  history.replaceState(null, "", query);
  const value = fixture(name);
  configure?.(value);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://example.test" }),
    "ws://example.test/client",
    value,
  );
  render(App, { props: { store } });
  return { store, value };
}

test("fresh Product state opens first-run onboarding", async () => {
  setup("starter-empty");

  expect(
    await screen.findByRole("heading", {
      name: "Welcome to Quest Engineering",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add Project" })).toBeTruthy();
});

test("Add Project enters the approved Projects Add flow directly", async () => {
  setup("starter-project-add");

  await fireEvent.click(
    await screen.findByRole("button", { name: "Add Project" }),
  );

  expect(
    await screen.findByRole("heading", { name: "Add Project", level: 2 }),
  ).toBeTruthy();
  expect(screen.getByPlaceholderText("Search repositories…")).toBeTruthy();
});

test("Project readiness updates advance onboarding without reload", async () => {
  const { store } = setup("starter-empty");
  const ready = fixture("starter-ready").product;
  await screen.findByRole("heading", { name: "Welcome to Quest Engineering" });

  store.product.set(ready);
  await tick();

  expect(
    screen.getByRole("heading", { name: "Your starter crew" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Create Starter Crew" }),
  ).toBeTruthy();
});

test("customized starter Product with manual status stays out of onboarding after reload", async () => {
  const { store } = setup("starter-complete", "?capture=dom", (value) => {
    const customized = value.product.loadouts.map((loadout) =>
      loadout.key === "coding"
        ? {
            ...loadout,
            model: { provider: "custom", model: "evolved" },
            reasoning: "high" as const,
          }
        : loadout,
    );
    value.product.loadouts = customized;
    value.product.loadoutCatalog = customized;
    value.starterStatus = { state: "manual_configuration", conflict: null };
  });
  await screen.findByText("QUEST ENGINEERING");
  await tick();

  expect(
    screen.queryByRole("heading", { name: "Welcome to Quest Engineering" }),
  ).toBeNull();
  expect(
    get(store.product).loadouts.find((loadout) => loadout.key === "coding")
      ?.model,
  ).toEqual({ provider: "custom", model: "evolved" });
});

test("completed canonical starter state does not reopen onboarding on reload", async () => {
  setup("starter-complete");
  await screen.findByText("QUEST ENGINEERING");
  await tick();

  expect(
    screen.queryByRole("heading", { name: "Welcome to Quest Engineering" }),
  ).toBeNull();
});

test("ambiguous-response recovery shows completion after status confirms the setup", async () => {
  const { store } = setup("starter-ready");
  vi.spyOn(store, "createStarterCrew").mockImplementation(async () => {
    store.starterStatus.set({ state: "complete", conflict: null });
    return { status: "ready", recovered: true };
  });
  await fireEvent.click(
    await screen.findByRole("button", { name: "Create Starter Crew" }),
  );

  expect(
    await screen.findByRole("heading", { name: "Your crew is ready" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Go to Quest Board" }),
  ).toBeTruthy();
});

test("Set up manually dismisses onboarding for the current session", async () => {
  setup("starter-empty");
  await fireEvent.click(
    await screen.findByRole("button", { name: "Set up manually" }),
  );

  expect(
    screen.queryByRole("heading", { name: "Welcome to Quest Engineering" }),
  ).toBeNull();
});
