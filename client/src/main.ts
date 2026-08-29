import { mount } from "svelte";
import App from "./App.svelte";
import { ApiClient } from "./api/client";
import { clientConfig } from "./config";
import { createAppStore } from "./state/app-store";

const target = document.getElementById("app");
if (!target) throw new Error("Missing application root.");
const store = createAppStore(
  new ApiClient({ httpBaseUrl: clientConfig.httpBaseUrl }),
  clientConfig.socketUrl,
);
mount(App, { target, props: { store } });
