#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AntigravityCommandHookSpec,
  installAntigravityCommandHook,
  proveAntigravityStopHookReadiness,
  runSyntheticAntigravityHook,
} from "../../src/harnesses/antigravity/hook-readiness.ts";
import { HerdrSocketClient } from "../../src/session-host/herdr/client.ts";
import {
  assertInstalledAgyVersion,
  createProbeControl,
  newProbeRoot,
  requireHumanProbeApproval,
} from "./antigravity-probe-control.ts";

const mode = process.argv[2];
if (mode === "hook-pre-invocation") await recordPreInvocation();
else if (mode === "hook-stop") await recordStop();
else await runProbe(mode === "preflight");

async function runProbe(preflightOnly: boolean): Promise<void> {
  if (!preflightOnly) requireHumanProbeApproval(2);
  assertInstalledAgyVersion();
  const socketPath = required("HERDR_SOCKET_PATH");
  const herdrWorkspaceId = required("HERDR_WORKSPACE_ID");
  const root = newProbeRoot(
    preflightOnly ? "stop-hook-preflight" : "stop-hook",
  );
  const workspace = resolve(
    process.env.QE_ANTIGRAVITY_STOP_PROBE_WORKSPACE?.trim() ||
      join(root, "workspace"),
  );
  const agents = join(workspace, ".agents");
  const eventLog = join(root, "hook-events.jsonl");
  const preflightLog = join(root, "preflight-events.jsonl");
  const agyLog = join(root, "agy.log");
  await mkdir(agents, { recursive: true });
  const control = await createProbeControl(root, 1);
  const script = resolve(import.meta.path);
  const bridge = resolve(
    import.meta.dir,
    "..",
    "..",
    "src",
    "harnesses",
    "control",
    "bridge-cli.ts",
  );
  const agyArgs = ["--model", "gemini-3.8-flash-low", "--log-file", agyLog];
  const prompt =
    "Reply with exactly QE_STOP_HOOK_INITIAL_CYCLE. Do not call tools, inspect files, or modify anything.";
  const hooksPath = join(agents, "hooks.json");
  const preInvocationSpec: AntigravityCommandHookSpec = {
    name: "qe-stop-probe-pre-invocation",
    event: "PreInvocation",
    command: `${process.execPath} '${script}' hook-pre-invocation`,
    timeoutSeconds: 10,
  };
  const stopSpec: AntigravityCommandHookSpec = {
    name: "qe-stop-probe",
    event: "Stop",
    command: `${process.execPath} '${script}' hook-stop`,
    timeoutSeconds: 10,
  };
  await installAntigravityCommandHook(hooksPath, preInvocationSpec);
  await installAntigravityCommandHook(hooksPath, stopSpec);
  const command = ["agy", ...agyArgs];
  await writeFile(
    join(root, "probe.json"),
    `${JSON.stringify(
      {
        preflightOnly,
        expectedMaximumInferenceCycles: preflightOnly ? 0 : 2,
        command,
        prompt,
        workspace,
        hooksPath,
        eventLog,
        preflightLog,
        agyLog,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    preflightOnly
      ? "\nAntigravity Stop-hook zero-inference preflight"
      : "\nAntigravity Stop-hook continuation probe",
  );
  console.log(
    preflightOnly
      ? "Expected subscription-backed inference: 0 model cycles."
      : "Expected subscription-backed inference: at most 2 model cycles.",
  );
  console.log(`Exact workspace: ${workspace}`);
  console.log(`Exact hook configuration: ${hooksPath}`);
  console.log(`Hook command target: ${script}`);
  console.log(`Bridge command target: ${bridge}`);
  console.log(`Native launch: ${shellCommand(command)}`);
  if (!preflightOnly) {
    console.log(
      "The prompt is sent only after the same TUI proves hook discovery and command execution.",
    );
    console.log("Expected visible markers:");
    console.log("  QE_STOP_HOOK_INITIAL_CYCLE");
    console.log("  QE_STOP_HOOK_REENTERED");
  }
  console.log(
    "Safe abort: Ctrl+C; from another terminal use the printed Herdr emergency command.\n",
  );

  const herdr = new HerdrSocketClient(socketPath);
  const pane = await herdr.createTab({
    workspaceId: herdrWorkspaceId,
    cwd: workspace,
    label: preflightOnly
      ? "Antigravity Stop-hook preflight"
      : "Antigravity Stop-hook probe",
    env: {
      QE_HARNESS_CONTROL_PATH: control.descriptorPath,
      QE_PROBE_EVENT_LOG: eventLog,
      QE_PROBE_BRIDGE_CLI: bridge,
    },
  });
  const agentName = `qe-agy-stop-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`Herdr agent: ${agentName}`);
  console.log(`Herdr pane: ${pane.paneId}`);
  console.log(
    `Emergency abort: herdr agent send-keys '${agentName}' ctrl+c ctrl+c`,
  );

  let finalAgentState = "unknown";
  try {
    const launched = await herdr.startAgent({
      paneId: pane.paneId,
      name: agentName,
      integrationKind: "agy",
      args: agyArgs,
      timeoutMs: 90_000,
    });
    console.log(`Initial Herdr state: ${launched.status}`);
    const environment = {
      ...process.env,
      QE_HARNESS_CONTROL_PATH: control.descriptorPath,
      QE_PROBE_EVENT_LOG: preflightLog,
      QE_PROBE_BRIDGE_CLI: bridge,
    };
    const readiness = await proveAntigravityStopHookReadiness({
      hookConfigPath: hooksPath,
      spec: stopSpec,
      logPath: agyLog,
      syntheticArgv: [process.execPath, script, "hook-stop"],
      syntheticPayload: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        executionNum: 1,
        terminationReason: "synthetic_no_inference",
        fullyIdle: true,
        modelName: "synthetic-no-inference",
      },
      env: environment,
    });
    const preInvocation = await runSyntheticAntigravityHook({
      argv: [process.execPath, script, "hook-pre-invocation"],
      payload: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        invocationNum: 0,
        initialNumSteps: 0,
        modelName: "synthetic-no-inference",
      },
      env: environment,
    });
    if (
      preInvocation.exitCode !== 0 ||
      preInvocation.output.decision !== undefined
    )
      throw new Error(
        "Synthetic PreInvocation hook command did not run successfully.",
      );
    const discovery = {
      ...readiness.discovery,
      hooksScreenCorroborated: false,
    };
    if (
      !String(readiness.syntheticOutput.reason ?? "").includes(
        "QE_STOP_HOOK_CONTINUATION_PROBE",
      )
    )
      throw new Error(
        "Synthetic Stop hook did not preserve the continuation instruction.",
      );
    const synthetic = {
      preInvocationOutput: preInvocation.output,
      stopOutput: readiness.syntheticOutput,
      hookConfigPresent: readiness.hookConfigPresent,
      hookCommandRunnable: readiness.hookCommandRunnable,
      hookControlContextValid: readiness.hookControlContextValid,
      syntheticHookInvocationSucceeded:
        readiness.syntheticHookInvocationSucceeded,
      eventLog: preflightLog,
    };
    await writeFile(
      join(root, "preflight-summary.json"),
      `${JSON.stringify({ discovery, synthetic }, null, 2)}\n`,
    );
    console.log("Zero-inference preflight: PASS");
    console.log(JSON.stringify({ discovery, synthetic }, null, 2));

    // The synthetic Stop call consumed one enforcement count. Rotate the opaque
    // context before any real prompt so the paid probe still permits exactly one continuation.
    await control.reset();
    await writeFile(eventLog, "");

    if (preflightOnly) {
      await herdr.sendKeys(agentName, ["ctrl+c", "ctrl+c"]);
      await Bun.sleep(500);
      finalAgentState = (await safeAgentState(herdr, agentName)) ?? "closed";
      console.log(`Final Herdr state: ${finalAgentState}`);
      console.log(`Preflight evidence: ${root}`);
      return;
    }

    console.log(
      "\nPreflight passed; sending the one initial subscription-backed prompt now.",
    );
    await herdr.prompt(agentName, prompt, {
      until: ["working", "blocked", "unknown"],
      timeoutMs: 30_000,
    });
    const outcome = await waitForProbeOutcome(
      herdr,
      agentName,
      eventLog,
      120_000,
    );
    const terminalOutput = await commandOutput([
      "herdr",
      "agent",
      "read",
      agentName,
      "--source",
      "recent-unwrapped",
      "--lines",
      "120",
    ]);
    await writeFile(join(root, "terminal-output.txt"), terminalOutput);
    await herdr.sendKeys(agentName, ["ctrl+c", "ctrl+c"]);
    await Bun.sleep(500);
    finalAgentState = (await safeAgentState(herdr, agentName)) ?? "closed";
    await printSummary(
      eventLog,
      finalAgentState,
      root,
      terminalOutput,
      outcome,
    );
  } finally {
    await control.close();
    herdr.disconnect();
  }
}

async function waitForProbeOutcome(
  herdr: HerdrSocketClient,
  agentName: string,
  eventLog: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - started < timeoutMs) {
    const events = await readEvents(eventLog);
    const stops = events.filter((event) => event.event === "Stop");
    const invocations = events.filter(
      (event) => event.event === "PreInvocation",
    );
    if (stops.length >= 2)
      return {
        reason: "two_stop_events",
        stopHookCount: stops.length,
        preInvocationCount: invocations.length,
      };
    const state = await safeAgentState(herdr, agentName);
    if (state === "idle" || state === "done") idleSince ??= Date.now();
    else idleSince = null;
    if (idleSince && Date.now() - idleSince > 5_000)
      return {
        reason: "native_execution_settled_before_second_stop",
        stopHookCount: stops.length,
        preInvocationCount: invocations.length,
        state,
      };
    await Bun.sleep(250);
  }
  return { reason: "timeout" };
}

async function recordPreInvocation(): Promise<void> {
  const input = await Bun.stdin.text();
  await appendEvent({
    event: "PreInvocation",
    input: parse(input),
    output: {},
    recordedAt: new Date().toISOString(),
  });
  process.stdout.write("{}\n");
}

async function recordStop(): Promise<void> {
  const inputText = await Bun.stdin.text();
  const bridge = required("QE_PROBE_BRIDGE_CLI");
  const child = Bun.spawn(["bun", bridge, "hook", "stop"], {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(inputText);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const bridgeOutput = parse(stdout);
  const output =
    record(bridgeOutput).decision === "continue"
      ? {
          ...record(bridgeOutput),
          reason: `${String(record(bridgeOutput).reason ?? "")}\nQE_STOP_HOOK_CONTINUATION_PROBE: This is the one permitted forced continuation. Reply with exactly QE_STOP_HOOK_REENTERED, do not call tools or modify files, and then stop.`,
        }
      : bridgeOutput;
  await appendEvent({
    event: "Stop",
    input: parse(inputText),
    output,
    bridgeExitCode: exitCode,
    bridgeStderr: stderr.trim(),
    recordedAt: new Date().toISOString(),
  });
  if (exitCode !== 0) {
    console.error(stderr.trim() || "QE Stop-hook bridge failed.");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function appendEvent(value: object): Promise<void> {
  await appendFile(
    required("QE_PROBE_EVENT_LOG"),
    `${JSON.stringify(value)}\n`,
  );
}

async function printSummary(
  eventLog: string,
  finalAgentState: string,
  root: string,
  terminalOutput: string,
  outcome: Record<string, unknown>,
): Promise<void> {
  const events = await readEvents(eventLog);
  const invocations = events.filter((event) => event.event === "PreInvocation");
  const stops = events.filter((event) => event.event === "Stop");
  const conversationIds = [
    ...new Set(
      events
        .map((event) => String(record(event.input).conversationId ?? ""))
        .filter(Boolean),
    ),
  ];
  const summary = {
    finalAgentState,
    conversationIds,
    preInvocationCount: invocations.length,
    stopHookCount: stops.length,
    stopEvidence: stops.map((event) => {
      const input = record(event.input);
      return {
        executionNum: input.executionNum ?? null,
        terminationReason: input.terminationReason ?? null,
        fullyIdle: input.fullyIdle ?? null,
        modelName: input.modelName ?? null,
        output: event.output ?? null,
      };
    }),
    initialMarkerObserved: terminalOutput.includes(
      "QE_STOP_HOOK_INITIAL_CYCLE",
    ),
    reenteredMarkerObserved: terminalOutput.includes("QE_STOP_HOOK_REENTERED"),
    forcedContinuationObserved:
      invocations.length >= 2 &&
      terminalOutput.includes("QE_STOP_HOOK_REENTERED") &&
      stops.some(
        (event) =>
          record(event.output).decision === "continue" &&
          String(record(event.output).reason ?? "").includes(
            "QE_STOP_HOOK_CONTINUATION_PROBE",
          ),
      ),
    outcome,
  };
  await writeFile(
    join(root, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log("\nProbe summary (copy this block):");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Full hook evidence: ${eventLog}`);
  console.log(`Terminal evidence: ${join(root, "terminal-output.txt")}`);
}

async function commandOutput(command: string[]): Promise<string> {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0)
    throw new Error(
      `Command failed (${result.exitCode}): ${shellCommand(command)}\n${result.stderr.toString().trim()}`,
    );
  return stdout;
}

async function safeAgentState(
  herdr: HerdrSocketClient,
  agentName: string,
): Promise<string | null> {
  try {
    return (await herdr.getAgent(agentName)).status;
  } catch {
    return null;
  }
}

async function readEvents(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => record(JSON.parse(line)));
  } catch {
    return [];
  }
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return { invalidJson: value.slice(0, 500) };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required. Run this probe inside Herdr.`);
  return value;
}

function shellCommand(command: string[]): string {
  return command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}
