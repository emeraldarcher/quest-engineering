import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentCommand,
  EnvironmentLease,
} from "../src/execution-environment/types.ts";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  encodeAntigravityInteractivePrompt,
  initialPromptSubmissionState,
  transitionPromptSubmissionState,
} from "../src/harnesses/antigravity/interactive-prompt.ts";

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
  const script = observed?.args.join("\n") ?? "";
  expect(script).toContain("home/'.cache'");
  expect(script).toContain("home/'.tmp'");
  expect(script).toContain("home/'.gemini/config/projects'");
  expect(script).toContain("home/'.gemini/antigravity'");
  expect(script).toContain("home/'.gemini/antigravity-cli/cache'");
  expect(script).toContain(
    "home/'.gemini/antigravity-cli/cache/onboarding.json'",
  );
  expect(script).toContain(
    "value['trustedWorkspaces']=[os.environ['QE_WORKSPACE']]",
  );
  expect(script).not.toContain("trusted.append");
  expect(script).toContain("p.mkdir(parents=True,exist_ok=True)");
  expect(script.indexOf("for p in directories:")).toBeLessThan(
    script.indexOf("for source,target in sources:"),
  );
  expect(script).not.toContain("target.parent.mkdir");
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

test("interactive prompt encoding preserves literal multiline Unicode and shell metacharacters", () => {
  const prompt = "first line\n第二行 $HOME `uname` && echo nope\nthird line";
  const encoded = encodeAntigravityInteractivePrompt(prompt);
  expect(encoded).toBe(
    `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`,
  );
  expect(
    encoded.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length),
  ).toBe(prompt);
  expect(() =>
    encodeAntigravityInteractivePrompt("unsafe\u001b[201~tail"),
  ).toThrow("terminal control bytes");
  expect(() => encodeAntigravityInteractivePrompt("unsafe\u009btail")).toThrow(
    "terminal control bytes",
  );
});

test("interactive prompt submission state permits one staged text and one submit action", () => {
  const binding = {
    workerId: "worker-1",
    questLaunchId: "launch-1",
    runId: "run-1",
    actionId: "action-1",
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    physicalLineageId: "lineage-1",
    environmentId: "environment-1",
    environmentIncarnation: "incarnation-1",
    herdrEndpointGeneration: 1,
    herdrServerGeneration: "server-1",
    herdrSession: "session-1",
    herdrSessionIncarnation: "session-incarnation-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "terminal-1",
    agentName: "agent-1",
    resultNonce: "nonce-1",
  };
  const initial = initialPromptSubmissionState(
    binding,
    "exact prompt",
    "2026-10-01T00:00:00.000Z",
  );
  const stageRequested = transitionPromptSubmissionState(
    initial,
    "text_stage_requested",
    "2026-10-01T00:00:01.000Z",
  );
  const staged = transitionPromptSubmissionState(
    stageRequested,
    "text_staged",
    "2026-10-01T00:00:02.000Z",
  );
  const requested = transitionPromptSubmissionState(
    staged,
    "submit_requested",
    "2026-10-01T00:00:03.000Z",
  );
  const sent = transitionPromptSubmissionState(
    requested,
    "submit_sent",
    "2026-10-01T00:00:04.000Z",
  );
  expect(sent).toMatchObject({
    phase: "submit_sent",
    textStageRequestedAt: "2026-10-01T00:00:01.000Z",
    textStagedAt: "2026-10-01T00:00:02.000Z",
    submitRequestedAt: "2026-10-01T00:00:03.000Z",
    submitSentAt: "2026-10-01T00:00:04.000Z",
  });
  expect(() =>
    transitionPromptSubmissionState(
      sent,
      "submit_sent",
      "2026-10-01T00:00:04.000Z",
    ),
  ).toThrow("Invalid Antigravity prompt submission transition");
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
