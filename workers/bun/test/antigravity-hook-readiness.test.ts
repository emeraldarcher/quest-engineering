import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  type AntigravityCommandHookSpec,
  inspectAntigravityCommandHook,
  installAntigravityCommandHook,
  proveAntigravityStopHookReadiness,
  removeAntigravityCommandHook,
  runSyntheticAntigravityHook,
} from "../src/harnesses/antigravity/hook-readiness.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import { action } from "./support.ts";

const bridgeCli = resolve(
  import.meta.dir,
  "..",
  "src",
  "harnesses",
  "control",
  "bridge-cli.ts",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "antigravity-hook-readiness-"));
  const hookConfigPath = join(root, "workspace", ".agents", "hooks.json");
  const logPath = join(root, "agy.log");
  const spec: AntigravityCommandHookSpec = {
    name: "qe-test-stop",
    event: "Stop",
    command: `${process.execPath} ${bridgeCli} hook stop`,
    timeoutSeconds: 10,
  };
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "antigravity",
  );
  const accepted = registry.accept(action()).dispatch;
  if (!accepted.lineageId) throw new Error("fixture has no lineage");
  registry.occupy(accepted.lineageId, accepted.action.action_id);
  const lineage = registry.getLineage(accepted.lineageId);
  const authority = new HarnessControlAuthority(registry, 1);
  const server = new HarnessControlServer(authority);
  await server.start();
  await authority.bind(accepted, lineage);
  cleanups.push(async () => {
    await server.stop();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    hookConfigPath,
    logPath,
    spec,
    authority,
    dispatch: accepted,
    lineage,
    descriptorPath: controlDescriptorPath(lineage),
  };
}

function syntheticPayload() {
  return {
    conversationId: "00000000-0000-4000-8000-000000000001",
    terminationReason: "qe_zero_inference_readiness",
    fullyIdle: true,
  };
}

function hookArgv() {
  return [process.execPath, bridgeCli, "hook", "stop"];
}

function environment(descriptorPath: string) {
  return { ...process.env, QE_HARNESS_CONTROL_PATH: descriptorPath };
}

test("hook config is namespaced and preserves unrelated user hooks", async () => {
  const value = await fixture();
  await mkdir(join(value.root, "workspace", ".agents"), { recursive: true });
  await writeFile(
    value.hookConfigPath,
    `${JSON.stringify({
      "user-existing-hook": {
        PreInvocation: [
          { type: "command", command: "user-command", timeout: 5 },
        ],
      },
    })}\n`,
  );

  await installAntigravityCommandHook(value.hookConfigPath, value.spec);
  const config = JSON.parse(await readFile(value.hookConfigPath, "utf8"));
  expect(config["user-existing-hook"]).toEqual({
    PreInvocation: [{ type: "command", command: "user-command", timeout: 5 }],
  });
  expect(config["qe-test-stop"].Stop).toEqual([
    {
      type: "command",
      command: value.spec.command,
      timeout: 10,
    },
  ]);
  expect(
    await inspectAntigravityCommandHook(value.hookConfigPath, value.spec),
  ).toEqual({
    hookConfigPresent: true,
    namespacedHookPresent: true,
    eventRegistered: true,
    commandMatches: true,
    timeoutMatches: true,
    namedHookCount: 2,
    unrelatedHookNames: ["user-existing-hook"],
  });
});

test("hook teardown removes only the QE namespace", async () => {
  const value = await fixture();
  await mkdir(join(value.root, "workspace", ".agents"), { recursive: true });
  await writeFile(
    value.hookConfigPath,
    `${JSON.stringify({
      "user-existing-hook": {
        Stop: [{ type: "command", command: "user-command", timeout: 5 }],
      },
    })}\n`,
  );
  await installAntigravityCommandHook(value.hookConfigPath, value.spec);
  await removeAntigravityCommandHook(value.hookConfigPath, value.spec.name);
  expect(JSON.parse(await readFile(value.hookConfigPath, "utf8"))).toEqual({
    "user-existing-hook": {
      Stop: [{ type: "command", command: "user-command", timeout: 5 }],
    },
  });
});

test("native log plus synthetic bridge invocation proves readiness without a hooks screen", async () => {
  const value = await fixture();
  await installAntigravityCommandHook(value.hookConfigPath, value.spec);
  await writeFile(
    value.logPath,
    "hooks_manager.go:53] loaded 2 named hooks from 1 hooks.json file(s)\n",
  );

  const readiness = await proveAntigravityStopHookReadiness({
    hookConfigPath: value.hookConfigPath,
    spec: value.spec,
    logPath: value.logPath,
    syntheticArgv: hookArgv(),
    syntheticPayload: syntheticPayload(),
    env: environment(value.descriptorPath),
  });
  expect(readiness).toMatchObject({
    hookConfigPresent: true,
    namespacedHookPresent: true,
    stopEventRegistered: true,
    hookDiscoveredByAntigravity: true,
    hookCommandRunnable: true,
    hookControlContextValid: true,
    syntheticHookInvocationSucceeded: true,
  });
});

test("stale and wrong Stop-hook control contexts fail closed", async () => {
  const value = await fixture();
  const stalePath = join(value.root, "stale.json");
  await writeFile(stalePath, await readFile(value.descriptorPath));
  await value.authority.bind(value.dispatch, value.lineage);
  const stale = await runSyntheticAntigravityHook({
    argv: hookArgv(),
    payload: syntheticPayload(),
    env: environment(stalePath),
  });
  expect(stale.exitCode).toBe(2);
  expect(stale.stderr).toContain("unknown or has been invalidated");

  const wrongPath = join(value.root, "wrong.json");
  const wrong = JSON.parse(await readFile(value.descriptorPath, "utf8"));
  wrong.bridgeGeneration = crypto.randomUUID();
  await writeFile(wrongPath, JSON.stringify(wrong));
  const wrongResult = await runSyntheticAntigravityHook({
    argv: hookArgv(),
    payload: syntheticPayload(),
    env: environment(wrongPath),
  });
  expect(wrongResult.exitCode).toBe(2);
  expect(wrongResult.stderr).toContain("another Worker controller generation");
});

test("an actually missing namespaced Stop hook fails readiness", async () => {
  const value = await fixture();
  await writeFile(
    value.logPath,
    "hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)\n",
  );
  await expect(
    proveAntigravityStopHookReadiness({
      hookConfigPath: value.hookConfigPath,
      spec: value.spec,
      logPath: value.logPath,
      syntheticArgv: hookArgv(),
      syntheticPayload: syntheticPayload(),
      env: environment(value.descriptorPath),
    }),
  ).rejects.toThrow("configuration is missing or incompatible");
});
