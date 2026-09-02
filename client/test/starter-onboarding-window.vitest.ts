import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { ApiError, type StarterCrewStatus } from "../src/api/contracts";
import StarterCrewOnboarding from "../src/components/onboarding/StarterCrewOnboarding.svelte";
import { type ClientFixture, createFixture } from "../src/fixtures/fixtures";
import { createAppStore } from "../src/state/app-store";

afterEach(cleanup);

function fixture(
  name: string,
): ClientFixture & { starterStatus: StarterCrewStatus } {
  const value = createFixture(name);
  if (!value?.starterStatus) throw new Error("Starter fixture unavailable");
  return value as ClientFixture & { starterStatus: StarterCrewStatus };
}

function setup(name: string, scene: string | null = null) {
  const value = fixture(name);
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/client",
    value,
  );
  const callbacks = {
    onAddProject: vi.fn(),
    onOpenProjects: vi.fn(),
    onNavigate: vi.fn(),
    onDismiss: vi.fn(),
    onCompleted: vi.fn(),
  };
  render(StarterCrewOnboarding, {
    props: {
      store,
      product: value.product,
      status: value.starterStatus,
      scene,
      ...callbacks,
    },
  });
  return { value, store, ...callbacks };
}

test("no-Project state presents Project as the current welcoming step", async () => {
  const { onAddProject } = setup("starter-empty");

  expect(screen.getByText("Step 1 · Add a Project")).toBeTruthy();
  expect(
    screen.getByRole("heading", {
      name: "First, choose where your crew will work",
    }),
  ).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
  expect(onAddProject).toHaveBeenCalledOnce();
});

test("preparing and attention Project states remain separate truthful states", () => {
  setup("starter-preparing");
  expect(
    screen.getByRole("heading", { name: "Preparing Quest Engineering…" }),
  ).toBeTruthy();
  cleanup();

  setup("starter-attention");
  expect(
    screen.getByRole("heading", { name: "Quest Engineering isn't ready yet" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Projects" })).toBeTruthy();
});

test("ready compatible Project shows the exact friendly starter preview", () => {
  setup("starter-ready");

  expect(
    screen.getByRole("heading", { name: "Your starter crew" }),
  ).toBeTruthy();
  expect(screen.getByText("Builds the requested change.")).toBeTruthy();
  expect(
    screen.getByText("Independently reviews completed work."),
  ).toBeTruthy();
  expect(screen.getByText("Coding Loadout")).toBeTruthy();
  expect(screen.getByText("Review Loadout")).toBeTruthy();
  expect(screen.getByText("Implement → Review")).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Classes define behavior. Loadouts define models and capabilities.",
  );
});

test("ready Project without a compatible advertised option waits safely", () => {
  const value = fixture("starter-ready");
  value.product.executionOptions = [];
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://fixture.invalid" }),
    "ws://fixture.invalid/client",
    value,
  );
  render(StarterCrewOnboarding, {
    props: {
      store,
      product: value.product,
      status: value.starterStatus,
      onAddProject: vi.fn(),
      onOpenProjects: vi.fn(),
      onNavigate: vi.fn(),
      onDismiss: vi.fn(),
      onCompleted: vi.fn(),
    },
  });

  expect(
    screen.getByText(/No compatible execution host is available yet/),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Create Starter Crew" }),
  ).toBeNull();
});

test("single-submit guard keeps one atomic command in flight", async () => {
  const { store } = setup("starter-ready");
  let finish:
    | ((value: { status: "ready"; recovered: true }) => void)
    | undefined;
  const operation = new Promise<{ status: "ready"; recovered: true }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const command = vi
    .spyOn(store, "createStarterCrew")
    .mockReturnValue(operation);
  const action = screen.getByRole("button", { name: "Create Starter Crew" });

  await fireEvent.click(action);
  await fireEvent.click(action);
  expect(command).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("heading", { name: "Creating your starter crew…" }),
  ).toBeTruthy();
  finish?.({ status: "ready", recovered: true });
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Your crew is ready" }),
    ).toBeTruthy(),
  );
});

test("atomic failure offers safe retry without staged progress claims", () => {
  setup("starter-failure", "failure");

  expect(
    screen.getByRole("heading", {
      name: "We couldn't create your starter crew",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Nothing was changed. You can safely try the same setup again.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
  expect(screen.queryByText(/Builder created/)).toBeNull();
});

test("unconfirmed network outcome does not falsely promise that nothing changed", async () => {
  const { store } = setup("starter-failure", "failure");
  store.error.set(
    new ApiError("network_unavailable", "Quest Engineering is unavailable."),
  );

  expect(
    await screen.findByRole("heading", {
      name: "We couldn't confirm starter setup",
    }),
  ).toBeTruthy();
  expect(screen.queryByText("Nothing was changed.")).toBeNull();
});

test("recoverable partial state offers one finish action", () => {
  setup("starter-partial");

  expect(
    screen.getByRole("heading", {
      name: "Finish setting up your starter crew",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Finish Starter Setup" }),
  ).toBeTruthy();
});

test("canonical conflict is non-destructive and routes to the relevant manager", async () => {
  const { onNavigate } = setup("starter-conflict");

  expect(
    screen.getByText(/Loadout “coding” is already configured differently/),
  ).toBeTruthy();
  expect(screen.getByText(/won't overwrite it/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Try Again/ })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Open Loadout" }));
  expect(onNavigate).toHaveBeenCalledWith("blacksmith");
});

test("completion remains visible and navigates through the town system", async () => {
  const { onNavigate } = setup("starter-complete", "success");

  expect(
    screen.getByRole("heading", { name: "Your crew is ready" }),
  ).toBeTruthy();
  await fireEvent.click(
    screen.getByRole("button", { name: "Go to Quest Board" }),
  );
  expect(onNavigate).toHaveBeenCalledWith("quest-board");
});

test("normal onboarding excludes developer and persistence terminology", () => {
  setup("starter-ready");
  const copy = document.body.textContent ?? "";
  for (const forbidden of [
    "ordinary Product rows",
    "database rows",
    "workspace binding",
    "source fingerprint",
    "immutable key",
    "Worker generation",
  ])
    expect(copy).not.toContain(forbidden);
});
