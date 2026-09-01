import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { Workspace } from "../src/api/contracts";
import ProjectsWindow from "../src/components/projects/ProjectsWindow.svelte";
import type { AppStore, ProductState } from "../src/state/app-store";

afterEach(cleanup);

const ready: Workspace = {
  id: "workspace-1",
  key: "quest-engineering",
  name: "Quest Engineering",
  source_kind: "git_remote",
  source_fingerprint: "https://github.com/emeraldarcher/quest-engineering",
  binding: { state: "ready", message: "Project ready." },
  archived_at: null,
};
const product: ProductState = {
  classes: [],
  loadouts: [],
  squads: [],
  tactics: [],
  quests: [],
  workspaces: [ready],
  workspaceSources: [
    {
      candidate_id: "candidate-1",
      name: "quest-engineering",
      source_kind: "git_remote",
      source_fingerprint: ready.source_fingerprint,
      publication_repository_identity: "emeraldarcher/quest-engineering",
      max_access: "read_write",
      shell_available: true,
    },
  ],
  executionOptions: [],
  runs: [],
};

function fakeStore(): AppStore {
  return {
    api: {
      createWorkspace: vi.fn(),
      bindWorkspaceSource: vi.fn(),
      updateWorkspace: vi.fn(),
      archiveWorkspace: vi.fn(),
    },
    refreshWorkspaceSources: vi.fn(async () => product.workspaceSources),
    refreshProduct: vi.fn(async () => undefined),
  } as unknown as AppStore;
}

test("defaults to Product-friendly Project view without infrastructure controls", () => {
  render(ProjectsWindow, {
    props: { store: fakeStore(), product, onClose: vi.fn(), scene: null },
  });

  expect(
    screen.getByRole("heading", { name: "Quest Engineering" }),
  ).toBeTruthy();
  expect(screen.getAllByText("emeraldarcher/quest-engineering")).toHaveLength(
    2,
  );
  expect(screen.getByText("Ready for Quests")).toBeTruthy();
  expect(screen.queryByText("Worker source binding")).toBeNull();
  expect(screen.queryByText("Bind selected source")).toBeNull();
  expect(screen.queryByLabelText("Immutable key")).toBeNull();
});

test("Add Project opens keyboard-operable repository discovery", async () => {
  render(ProjectsWindow, {
    props: { store: fakeStore(), product, onClose: vi.fn(), scene: null },
  });

  await fireEvent.click(screen.getByRole("button", { name: "+ Add Project" }));

  expect(screen.getByRole("heading", { name: "Add Project" })).toBeTruthy();
  expect(screen.getByPlaceholderText("Search repositories…")).toBeTruthy();
  const repository = screen.getByRole("button", {
    name: /Quest Engineering emeraldarcher\/quest-engineering Available/,
  });
  repository.focus();
  expect(document.activeElement).toBe(repository);
});

test("offline Project explains waiting without a misleading Retry action", () => {
  const offline = {
    ...ready,
    binding: { state: "offline" as const, message: "Offline." },
  };
  render(ProjectsWindow, {
    props: {
      store: fakeStore(),
      product: { ...product, workspaces: [offline] },
      onClose: vi.fn(),
      scene: null,
    },
  });

  expect(
    screen.getByText("Offline", { selector: ".status-title strong" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/no Worker that can currently access it is online/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Reconnect Project" }),
  ).toBeNull();
});
