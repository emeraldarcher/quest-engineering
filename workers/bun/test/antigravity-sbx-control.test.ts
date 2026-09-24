import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentCommand,
  EnvironmentLease,
} from "../src/execution-environment/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Run-private Antigravity HOME owns cache and temporary directories", async () => {
  let observed: EnvironmentCommand | undefined;
  const manager = Object.create(SbxRunExecutionManager.prototype) as {
    seedAntigravityHome(
      lease: EnvironmentLease,
      guestHome: string,
    ): Promise<void>;
  };
  await manager.seedAntigravityHome(
    {
      workerExec: async (command) => {
        observed = command;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as EnvironmentLease,
    "/qe/state/antigravity-lineages/lineage-a/home",
  );
  expect(observed?.executable).toBe("/usr/bin/python3");
  expect(observed?.environment).toEqual({
    QE_HOME: "/qe/state/antigravity-lineages/lineage-a/home",
  });
  expect(observed?.args.join("\n")).toContain("home/'.cache'");
  expect(observed?.args.join("\n")).toContain("home/'.tmp'");
  expect(observed?.args.join("\n")).toContain(
    "p.mkdir(parents=True,exist_ok=True)",
  );
});

test("guest Stop bridge is bundled for Node and never resolves a host executable", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "antigravity-sbx-control-"));
  roots.push(root);
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../src/harnesses/control/bridge-cli.ts"),
    ],
    target: "node",
    format: "esm",
    splitting: false,
  });
  expect(build.success).toBe(true);
  const path = join(root, "bridge-cli.mjs");
  const bridgeOutput = build.outputs[0];
  if (!bridgeOutput) throw new Error("Bridge build produced no output.");
  await writeFile(path, new Uint8Array(await bridgeOutput.arrayBuffer()));
  const node = Bun.which("node");
  if (!node) throw new Error("Node is unavailable for guest bundle test.");
  const child = Bun.spawn([node, path, "hook", "stop"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    JSON.stringify({
      terminationReason: "qe_zero_inference_readiness",
      fullyIdle: true,
      modelName: "synthetic-no-inference",
    }),
  );
  child.stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(2);
  expect(stderr).not.toContain("Bun is not defined");
  expect(stderr).toContain("QE_HARNESS_CONTROL_PATH");
});

test("guest attestation launcher refuses every executable except pinned Antigravity", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "antigravity-sbx-launcher-"));
  roots.push(root);
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../src/harnesses/antigravity/sbx-launcher.ts"),
    ],
    target: "node",
    format: "esm",
    splitting: false,
  });
  expect(build.success).toBe(true);
  const path = join(root, "sbx-launcher.mjs");
  const launcherOutput = build.outputs[0];
  if (!launcherOutput) throw new Error("Launcher build produced no output.");
  await writeFile(path, new Uint8Array(await launcherOutput.arrayBuffer()));
  const node = Bun.which("node");
  if (!node) throw new Error("Node is unavailable for guest bundle test.");
  const child = Bun.spawn([node, path, "agy-from-PATH"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(74);
  expect(stderr).toContain("unexpected executable");

  const sandbox = Bun.spawn(
    [node, path, "/opt/qe/antigravity/agy", "--sandbox"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        QE_ANTIGRAVITY_EXPECTED_ARGV_JSON: JSON.stringify(["--sandbox"]),
      },
    },
  );
  const [sandboxStderr, sandboxExit] = await Promise.all([
    new Response(sandbox.stderr).text(),
    sandbox.exited,
  ]);
  expect(sandboxExit).toBe(74);
  expect(sandboxStderr).toContain("unexpected argv");
});
