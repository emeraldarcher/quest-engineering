import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HARNESS_CONTROL_PATH_ENV } from "../src/harnesses/control/descriptor.ts";
import { collectStepResult } from "../src/harnesses/control/result-envelope.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import stepResultExtension from "../src/harnesses/pi/step-result-extension.ts";
import { action } from "./support.ts";

const cleanups: Array<() => Promise<void>> = [];
const originalPath = process.env[HARNESS_CONTROL_PATH_ENV];
afterEach(async () => {
  if (originalPath === undefined) delete process.env[HARNESS_CONTROL_PATH_ENV];
  else process.env[HARNESS_CONTROL_PATH_ENV] = originalPath;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test.serial(
  "Pi native extension is a thin transport into the generic control bridge",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "pi-control-bridge-"));
    const registry = new DispatchRegistry(
      join(root, "dispatches.sqlite"),
      root,
      "pi",
    );
    const dispatch = registry.accept(action()).dispatch;
    if (!dispatch.lineageId) throw new Error("Fixture has no lineage.");
    registry.occupy(dispatch.lineageId, dispatch.action.action_id);
    const lineage = registry.getLineage(dispatch.lineageId);
    const authority = new HarnessControlAuthority(registry);
    const server = new HarnessControlServer(authority);
    await server.start();
    await authority.bind(dispatch, lineage);
    process.env[HARNESS_CONTROL_PATH_ENV] = controlDescriptorPath(lineage);
    cleanups.push(async () => {
      await server.stop();
      registry.close();
      await rm(root, { recursive: true, force: true });
    });

    const faux = fauxProvider({
      api: `qe-result-${crypto.randomUUID()}`,
      provider: `qe-result-${crypto.randomUUID()}`,
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("qe_step_result", {
          outputs: { change_set: { files: ["src/a.ts"] } },
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
      credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
    const settings = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: settings,
      extensionFactories: [stepResultExtension],
    });
    await loader.reload();
    const session = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      model: faux.getModel(),
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager: settings,
      tools: ["qe_step_result"],
      noTools: "builtin",
    });
    await session.session.prompt("Return the deterministic result.");
    expect((await collectStepResult(dispatch)).envelope.outputs).toEqual({
      change_set: { files: ["src/a.ts"] },
    });
    session.session.dispose();
    modelRuntime.unregisterProvider(faux.provider.id);
  },
);
