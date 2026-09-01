import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { expect, test } from "vitest";
import App from "../src/App.svelte";
import { ApiClient } from "../src/api/client";
import type { ClassDefinition } from "../src/api/contracts";
import type { ClientFixture } from "../src/fixtures/fixtures";
import { createAppStore, type ProductState } from "../src/state/app-store";

const emptyProduct: ProductState = {
  classes: [],
  loadouts: [],
  squads: [],
  tactics: [],
  quests: [],
  workspaces: [],
  workspaceSources: [],
  executionOptions: [],
  runs: [],
};

test("hides the starter-crew prompt when Product data is populated", async () => {
  history.replaceState(null, "", "?capture=dom");
  const fixture: ClientFixture = {
    name: "idle",
    product: emptyProduct,
    runs: {},
    selectedRunId: null,
  };
  const store = createAppStore(
    new ApiClient({ httpBaseUrl: "http://example.test" }),
    "ws://example.test/client",
    fixture,
  );
  render(App, { props: { store } });

  expect(screen.getByText("Raise a starter crew")).toBeTruthy();

  store.product.set({
    ...emptyProduct,
    classes: [{} as ClassDefinition],
  });
  await tick();

  expect(screen.queryByText("Raise a starter crew")).toBeNull();
});
