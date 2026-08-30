import { mount } from "svelte";
import App from "./App.svelte";
import { ApiClient } from "./api/client";
import { clientConfig } from "./config";
import { createAppStore } from "./state/app-store";

const query = new URLSearchParams(location.search);
if (import.meta.env.DEV && query.get("capture") === "dom")
  document.documentElement.dataset.capture = "dom";

const target = document.getElementById("app");
if (!target) throw new Error("Missing application root.");
const fixture = import.meta.env.DEV
  ? (await import("./fixtures/fixtures")).createFixture(query.get("fixture"))
  : null;
const store = createAppStore(
  new ApiClient({ httpBaseUrl: clientConfig.httpBaseUrl }),
  clientConfig.socketUrl,
  fixture,
);
mount(App, { target, props: { store } });
