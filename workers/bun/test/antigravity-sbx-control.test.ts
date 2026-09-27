import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentCommand,
  EnvironmentLease,
} from "../src/execution-environment/types.ts";
import {
  initialConversationArgs,
  parseInitialConversationBinding,
  parseInitialConversationRequest,
} from "../src/harnesses/antigravity/initial-conversation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Run-private Antigravity HOME owns runtime directories and trusts only its isolated workspace", async () => {
  let observed: EnvironmentCommand | undefined;
  const manager = Object.create(SbxRunExecutionManager.prototype) as {
    seedAntigravityHome(
      lease: EnvironmentLease,
      guestHome: string,
      guestWorkspace: string,
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
    "/qe/workspaces/lineage-a",
  );
  expect(observed?.executable).toBe("/usr/bin/python3");
  expect(observed?.environment).toEqual({
    QE_HOME: "/qe/state/antigravity-lineages/lineage-a/home",
    QE_WORKSPACE: "/qe/workspaces/lineage-a",
  });
  expect(observed?.args.join("\n")).toContain("home/'.cache'");
  expect(observed?.args.join("\n")).toContain("home/'.tmp'");
  expect(observed?.args.join("\n")).toContain(
    "home/'.gemini/antigravity-cli/cache/onboarding.json'",
  );
  expect(observed?.args.join("\n")).toContain(
    "value['trustedWorkspaces']=[os.environ['QE_WORKSPACE']]",
  );
  expect(observed?.args.join("\n")).not.toContain("trusted.append");
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

test("native initial-conversation launch preserves frozen model and effort and passes the exact prompt once", () => {
  const base = [
    "--model",
    "gemini-3.8-flash-high",
    "--effort",
    "high",
    "--dangerously-skip-permissions",
    "--log-file",
    "/qe/control/antigravity.log",
  ];
  const prompt = "exact Product prompt\nwith literal newlines";
  expect(
    initialConversationArgs(
      base,
      prompt,
      "/qe/control/antigravity-conversation.log",
    ),
  ).toEqual([
    ...base.slice(0, -1),
    "/qe/control/antigravity-conversation.log",
    "--prompt-interactive",
    prompt,
  ]);
  expect(() =>
    initialConversationArgs(
      ["--conversation", "stale", ...base],
      prompt,
      "/qe/control/antigravity-conversation.log",
    ),
  ).toThrow("fresh conversation-free argv");
});

test("initial-conversation request is identity fenced", () => {
  const binding = {
    actionId: "action-1",
    attemptId: "attempt-1",
    lineageId: "lineage-1",
    resultNonce: "nonce-1",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
  };
  const prompt = "exact prompt";
  const request = JSON.stringify({
    schemaVersion: 1,
    kind: "antigravity_initial_conversation",
    nonce: "request-1",
    ...binding,
    prompt,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    requestedAt: "2026-09-27T00:00:00.000Z",
  });
  expect(parseInitialConversationRequest(request, binding)).toMatchObject({
    ...binding,
    prompt,
  });
  expect(() =>
    parseInitialConversationRequest(request, {
      ...binding,
      lineageId: "another-lineage",
    }),
  ).toThrow("lineageId is stale");

  const launchBinding = parseInitialConversationBinding(
    JSON.stringify({
      lineageId: binding.lineageId,
      environmentId: binding.environmentId,
      incarnation: binding.incarnation,
    }),
  );
  expect(
    parseInitialConversationRequest(
      JSON.stringify({
        ...JSON.parse(request),
        actionId: "adopted-action",
        attemptId: "adopted-attempt",
        resultNonce: "adopted-result-nonce",
      }),
      launchBinding,
    ),
  ).toMatchObject({
    actionId: "adopted-action",
    attemptId: "adopted-attempt",
    lineageId: binding.lineageId,
  });
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
