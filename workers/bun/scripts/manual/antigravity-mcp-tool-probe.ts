#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AntigravityCommandHookSpec,
  installAntigravityCommandHook,
  proveAntigravityStopHookReadiness,
  runSyntheticAntigravityHook,
} from "../../src/harnesses/antigravity/hook-readiness.ts";
import { HarnessControlClient } from "../../src/harnesses/control/client.ts";
import {
  QE_COMPLETE_STEP_TOOL,
  QE_MCP_STARTUP_EVIDENCE_ENV,
} from "../../src/harnesses/control/mcp-server.ts";
import { collectStepResult } from "../../src/harnesses/control/result-envelope.ts";
import { HerdrSocketClient } from "../../src/session-host/herdr/client.ts";
import {
  assertInstalledAgyVersion,
  createProbeControl,
  newProbeRoot,
  type ProbeControl,
  requireHumanProbeApproval,
} from "./antigravity-probe-control.ts";

const MODEL = "gemini-3.8-flash-low";
const MCP_SERVER_ENTRYPOINT = resolve(
  import.meta.dir,
  "..",
  "..",
  "src",
  "harnesses",
  "control",
  "mcp-server.ts",
);
const mode = process.argv[2];
if (mode === "hook-stop") await recordStop();
else await runProbe(mode === "preflight", mode === "readiness");

async function runProbe(
  preflightOnly: boolean,
  readinessOnly: boolean,
): Promise<void> {
  if (!preflightOnly && !readinessOnly) requireHumanProbeApproval(1);
  assertInstalledAgyVersion();
  assertStaticRegistration();
  const socketPath = required("HERDR_SOCKET_PATH");
  const workspaceId = required("HERDR_WORKSPACE_ID");
  const root = newProbeRoot(
    preflightOnly
      ? "mcp-context-preflight"
      : readinessOnly
        ? "mcp-invocation-readiness"
        : "mcp-tool-invocation",
  );
  await mkdir(root, { recursive: true });
  console.log(
    preflightOnly
      ? "\nAntigravity MCP zero-inference context preflight"
      : readinessOnly
        ? "\nAntigravity MCP and Stop-hook zero-inference readiness"
        : "\nAntigravity MCP one-turn completion probe",
  );
  console.log(
    preflightOnly || readinessOnly
      ? "Expected subscription-backed inference: 0 model turns."
      : "Expected subscription-backed inference: at most 1 tiny model turn.",
  );
  console.log(`Evidence directory: ${root}`);

  if (preflightOnly) {
    await runConcurrentPreflight(socketPath, workspaceId, root);
    return;
  }
  await runPaidInvocation(socketPath, workspaceId, root, readinessOnly);
}

async function runConcurrentPreflight(
  socketPath: string,
  workspaceId: string,
  root: string,
): Promise<void> {
  const herdr = new HerdrSocketClient(socketPath);
  const sessions: ProbeSession[] = [];
  try {
    for (const label of ["a", "b"])
      sessions.push(
        await startInteractiveSession({
          herdr,
          workspaceId,
          root: join(root, `session-${label}`),
          label,
          withStopHook: false,
        }),
      );
    await Promise.all(
      sessions.map(async (session) => {
        const evidence = await waitForStartupEvidence(
          session.startupEvidencePath,
          session.control.descriptorPath,
          30_000,
        );
        session.startupEvidence = evidence;
        session.nativeMcpScreen = await captureNativeMcpScreen(
          herdr,
          session,
          join(session.root, "mcp-screen.txt"),
        );
      }),
    );
    const [first, second] = sessions;
    if (!first || !second) throw new Error("Two sessions were not created.");
    const firstHash = descriptorHash(first.control.descriptorPath);
    const secondHash = descriptorHash(second.control.descriptorPath);
    if (firstHash === secondHash)
      throw new Error(
        "Concurrent sessions unexpectedly shared one descriptor.",
      );
    const stagesA = sessionStages(first, firstHash);
    const stagesB = sessionStages(second, secondHash);
    for (const stages of [stagesA, stagesB]) {
      if (!stages.mcpChildLaunched)
        throw new Error(
          `MCP child did not launch for session ${stages.label}.`,
        );
      if (!stages.bridgeContextObserved || !stages.bridgeContextValid)
        throw new Error(
          `MCP child did not validate the expected bridge context for session ${stages.label}.`,
        );
      if (!stages.mcpChildAlive)
        throw new Error(
          `MCP child exited after startup for session ${stages.label}.`,
        );
    }
    const summary = {
      registration: registrationLine(),
      staticRegistrationVisible: true,
      sameStaticMcpCommand: true,
      sessionA: stagesA,
      sessionB: stagesB,
      nativeMcpDiscoveryComplete: true,
      mcpChildrenLaunched: true,
      bridgeContextsObserved: true,
      bridgeContextsValid: true,
      distinctSessionContexts: true,
      concurrentIsolationProven: true,
      modelTurns: 0,
      finalStatus: "SUCCESS",
    };
    await writeFile(
      join(root, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log("\nMCP context preflight summary:");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await Promise.all(sessions.map((session) => closeSession(herdr, session)));
    herdr.disconnect();
  }
}

async function runPaidInvocation(
  socketPath: string,
  workspaceId: string,
  root: string,
  readinessOnly: boolean,
): Promise<void> {
  const herdr = new HerdrSocketClient(socketPath);
  const session = await startInteractiveSession({
    herdr,
    workspaceId,
    root,
    label: "invocation",
    withStopHook: true,
  });
  const prompt =
    `Call ${QE_COMPLETE_STEP_TOOL} exactly once with outputs ` +
    '{"probe_result":{"status":"ok"}}. Do not call any other tool, inspect files, or modify files. After the tool succeeds, stop.';
  try {
    const startupEvidence = await waitForStartupEvidence(
      session.startupEvidencePath,
      session.control.descriptorPath,
      30_000,
    );
    const nativeMcpScreen = await captureNativeMcpScreen(
      herdr,
      session,
      join(root, "mcp-screen.txt"),
    );
    const staleDescriptorPath = join(root, "pre-readiness-control.json");
    await writeFile(
      staleDescriptorPath,
      await readFile(session.control.descriptorPath),
      { mode: 0o600 },
    );
    const preReadinessContextFingerprint = await fileHash(
      session.control.descriptorPath,
    );
    const hookReadiness = await proveAntigravityStopHookReadiness({
      hookConfigPath: session.stopHookConfigPath,
      spec: session.stopHookSpec,
      logPath: session.agyLog,
      syntheticArgv: [process.execPath, session.hookScript, "hook-stop"],
      syntheticPayload: syntheticStopPayload(),
      env: hookEnvironment(
        session.control.descriptorPath,
        session.stopEventLog,
      ),
    });
    await session.control.reset();
    const postReadinessContextFingerprint = await fileHash(
      session.control.descriptorPath,
    );
    if (preReadinessContextFingerprint === postReadinessContextFingerprint)
      throw new Error("Stop-hook readiness did not rotate the probe context.");
    const currentContext = await new HarnessControlClient(
      session.control.descriptorPath,
    ).completionStatus();
    const staleContext = await runSyntheticAntigravityHook({
      argv: [process.execPath, session.hookScript, "hook-stop"],
      payload: syntheticStopPayload(),
      env: hookEnvironment(staleDescriptorPath, session.stopEventLog),
    });
    if (staleContext.exitCode === 0)
      throw new Error("The pre-readiness Stop-hook context remained usable.");
    const preInferenceSummary = {
      staticMcpRegistrationVisible: true,
      mcpChildLaunched: true,
      bridgeContextValid: startupEvidence.bridgeAcceptedContext === true,
      stopHookConfigPresent: hookReadiness.hookConfigPresent,
      stopHookDiscovered: hookReadiness.hookDiscoveredByAntigravity,
      stopHookCommandRunnable: hookReadiness.hookCommandRunnable,
      stopHookControlContextValid: hookReadiness.hookControlContextValid,
      syntheticStopHookReady: hookReadiness.syntheticHookInvocationSucceeded,
      staleStopHookContextRejected: staleContext.exitCode !== 0,
      currentContextValid: currentContext.completed === false,
      contextRotatedAfterSyntheticReadiness:
        preReadinessContextFingerprint !== postReadinessContextFingerprint,
      hooksScreenCorroborated: false,
      nativeMcpScreen,
      paidPromptSubmitted: false,
      modelTurns: 0,
      finalStatus: "READY_FOR_BOUNDED_INFERENCE",
    };
    await writeFile(
      join(root, "pre-inference-summary.json"),
      `${JSON.stringify(preInferenceSummary, null, 2)}\n`,
    );
    console.log("\nPre-inference readiness summary:");
    console.log(JSON.stringify(preInferenceSummary, null, 2));
    if (readinessOnly) {
      console.log(
        `Zero-inference MCP and Stop-hook readiness: PASS\nEvidence: ${root}`,
      );
      return;
    }

    console.log(`Herdr agent: ${session.agentName}`);
    console.log(`Herdr pane: ${session.paneId}`);
    console.log("Exact one-turn prompt:");
    console.log(prompt);
    console.log(
      `If Antigravity shows a native permission prompt, run from another terminal:\n  herdr agent attach '${session.agentName}' --takeover\nApprove only ${QE_COMPLETE_STEP_TOOL}, wait for the turn to settle, then detach with Ctrl+B, Q.`,
    );
    console.log(
      `Emergency abort: herdr agent send-keys '${session.agentName}' ctrl+c ctrl+c`,
    );

    await herdr.prompt(session.agentName, prompt, {
      until: ["working", "blocked", "unknown"],
      timeoutMs: 30_000,
    });
    const outcome = await waitForCompletion(session, herdr, 120_000);
    const collected = await collectStepResult(session.control.dispatch);
    const stopEvents = await readJsonLines(session.stopEventLog);
    const allowedStop = stopEvents.some(
      (event) => record(event.bridgeDecision).decision === "allow",
    );
    if (!allowedStop)
      throw new Error(
        "The Stop hook did not observe and allow the authorized completion.",
      );
    if (
      JSON.stringify(collected.envelope.outputs) !==
      JSON.stringify({ probe_result: { status: "ok" } })
    )
      throw new Error(
        "The MCP tool result payload was not the expected value.",
      );

    const action = session.control.dispatch.action;
    const summary = {
      startupEvidence,
      nativeMcpScreen,
      preInferenceSummary,
      modelTurns: 1,
      prompt,
      outcome,
      exactAttemptAttribution: {
        workerId: collected.envelope.workerId,
        actionId: collected.envelope.actionId,
        runId: collected.envelope.runId,
        occurrenceId: collected.envelope.occurrenceId,
        attemptId: collected.envelope.attemptId,
        matchesActiveAttempt:
          collected.envelope.workerId === action.worker_id &&
          collected.envelope.actionId === action.action_id &&
          collected.envelope.runId === action.run_id &&
          collected.envelope.occurrenceId === action.occurrence_id &&
          collected.envelope.attemptId === action.attempt_id,
      },
      outputs: collected.envelope.outputs,
      stopHookObservedAuthorizedCompletion: allowedStop,
      stopHookEvents: stopEvents,
      finalStatus: "SUCCESS",
    };
    if (!summary.exactAttemptAttribution.matchesActiveAttempt)
      throw new Error("Bridge result did not match the exact active Attempt.");
    await writeFile(
      join(root, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log("\nMCP invocation probe summary:");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeSession(herdr, session);
    herdr.disconnect();
  }
}

interface NativeMcpScreenEvidence {
  screenOpened: boolean;
  qeRendered: boolean;
  status: "connected" | "initializing" | "error" | "not_observed";
}

interface ProbeSession {
  label: string;
  root: string;
  control: ProbeControl;
  agentName: string;
  paneId: string;
  startupEvidencePath: string;
  stopEventLog: string;
  agyLog: string;
  stopHookConfigPath: string;
  stopHookSpec: AntigravityCommandHookSpec;
  hookScript: string;
  startupEvidence?: Record<string, unknown>;
  nativeMcpScreen?: NativeMcpScreenEvidence;
}

async function startInteractiveSession(input: {
  herdr: HerdrSocketClient;
  workspaceId: string;
  root: string;
  label: string;
  withStopHook: boolean;
}): Promise<ProbeSession> {
  await mkdir(input.root, { recursive: true });
  const workspace = join(input.root, "workspace");
  await mkdir(join(workspace, ".agents"), { recursive: true });
  const control = await createProbeControl(input.root, 1);
  const stopEventLog = join(input.root, "stop-events.jsonl");
  const startupEvidencePath = join(input.root, "mcp-startup.jsonl");
  const script = resolve(import.meta.path);
  const stopHookConfigPath = join(workspace, ".agents", "hooks.json");
  const stopHookSpec: AntigravityCommandHookSpec = {
    name: "qe-mcp-completion-probe",
    event: "Stop",
    command: `${process.execPath} '${script}' hook-stop`,
    timeoutSeconds: 10,
  };
  if (input.withStopHook)
    await installAntigravityCommandHook(stopHookConfigPath, stopHookSpec);
  const pane = await input.herdr.createTab({
    workspaceId: input.workspaceId,
    cwd: workspace,
    label: `Antigravity MCP ${input.label}`,
    env: {
      QE_HARNESS_CONTROL_PATH: control.descriptorPath,
      [QE_MCP_STARTUP_EVIDENCE_ENV]: startupEvidencePath,
      QE_PROBE_STOP_EVENT_LOG: stopEventLog,
    },
  });
  const agentName = `qe-agy-mcp-${input.label}-${crypto.randomUUID().slice(0, 6)}`;
  const agyLog = join(input.root, "agy.log");
  await input.herdr.startAgent({
    paneId: pane.paneId,
    name: agentName,
    integrationKind: "agy",
    args: ["--model", MODEL, "--log-file", agyLog],
    timeoutMs: 90_000,
  });
  return {
    label: input.label,
    root: input.root,
    control,
    agentName,
    paneId: pane.paneId,
    startupEvidencePath,
    stopEventLog,
    agyLog,
    stopHookConfigPath,
    stopHookSpec,
    hookScript: script,
  };
}

async function waitForCompletion(
  session: ProbeSession,
  herdr: HerdrSocketClient,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await new HarnessControlClient(
      session.control.descriptorPath,
    ).completionStatus();
    const stopEvents = await readJsonLines(session.stopEventLog);
    if (
      result.completed === true &&
      stopEvents.some(
        (event) => record(event.bridgeDecision).decision === "allow",
      )
    )
      return {
        completed: true,
        herdrState:
          (await safeAgentState(herdr, session.agentName)) ?? "closed",
      };
    const state = await safeAgentState(herdr, session.agentName);
    if (state === "blocked")
      console.log(
        `Antigravity is blocked on its native prompt. Take control of ${session.agentName} to approve only the expected QE tool.`,
      );
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for MCP completion and authorized Stop.");
}

async function recordStop(): Promise<void> {
  const inputText = await Bun.stdin.text();
  const input = JSON.parse(inputText) as Record<string, unknown>;
  const client = HarnessControlClient.fromEnvironment();
  const result = await client.nativeStop(
    String(input.terminationReason ?? "native_stop"),
    input.fullyIdle === true,
  );
  const decision = result.nativeStop;
  await appendFile(
    required("QE_PROBE_STOP_EVENT_LOG"),
    `${JSON.stringify({ input, bridgeDecision: decision, recordedAt: new Date().toISOString() })}\n`,
  );
  if (decision?.decision === "continue") {
    process.stdout.write(
      `${JSON.stringify({ decision: "continue", reason: decision.reason })}\n`,
    );
    return;
  }
  process.stdout.write("{}\n");
}

async function waitForStartupEvidence(
  path: string,
  descriptorPath: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await readJsonLines(path);
    const expected = descriptorHash(descriptorPath);
    const match = events.find(
      (event) =>
        event.kind === "qe_harness_mcp_startup" &&
        event.descriptorPathHash === expected &&
        event.bridgeAcceptedContext === true,
    );
    if (match) return match;
    await Bun.sleep(100);
  }
  throw new Error(
    "Antigravity did not start the QE MCP child with the expected session-specific bridge context.",
  );
}

function assertStaticRegistration(): void {
  const line = registrationLine();
  if (
    !/\bqe\b/.test(line) ||
    !/\bstdio\b/.test(line) ||
    !/\benabled\b/.test(line)
  )
    throw new Error(
      "The globally registered qe stdio MCP server is missing or disabled. Run the documented one-time registration command first.",
    );
  if (!line.includes(`${process.execPath} ${MCP_SERVER_ENTRYPOINT}`))
    throw new Error(
      "The qe MCP registration does not point to the installed Bun executable and generic QE MCP shim expected by this checkout.",
    );
  if (
    /QE_HARNESS_CONTROL_PATH|run[_-]?id|attempt[_-]?id|lineage[_-]?id|contextToken|nonce/i.test(
      line,
    )
  )
    throw new Error(
      "The static qe MCP registration contains execution-specific context.",
    );
}

function registrationLine(): string {
  const result = Bun.spawnSync(["agy", "mcp", "list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`agy mcp list failed: ${result.stderr.toString().trim()}`);
  const line = result.stdout
    .toString()
    .split("\n")
    .find((candidate) => /^qe\s/.test(candidate.trim()));
  if (!line)
    throw new Error("No global Antigravity MCP registration named qe exists.");
  return line.trim();
}

function sessionStages(session: ProbeSession, expectedHash: string) {
  const evidence = session.startupEvidence ?? {};
  const pid = Number(evidence.pid);
  return {
    label: session.label,
    staticRegistrationVisible: true,
    nativeMcpDiscoveryComplete: true,
    mcpChildLaunched: Number.isSafeInteger(pid) && pid > 0,
    mcpChildAlive: pidAlive(pid),
    bridgeContextObserved: evidence.descriptorPathHash === expectedHash,
    bridgeContextValid: evidence.bridgeAcceptedContext === true,
    descriptorPathHash: expectedHash,
    startupEvidence: evidence,
    nativeMcpScreen: session.nativeMcpScreen ?? null,
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function captureNativeMcpScreen(
  herdr: HerdrSocketClient,
  session: ProbeSession,
  evidencePath: string,
): Promise<NativeMcpScreenEvidence> {
  try {
    await herdr.prompt(session.agentName, "/mcp", {
      until: ["working", "blocked", "unknown"],
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes(
        "agent prompt produced no observed working or blocked state",
      )
    )
      throw error;
  }
  const started = Date.now();
  let observed = "";
  while (Date.now() - started < 3_000) {
    const screen = await paneScreen(session.paneId);
    if (screen.includes("MCP Servers")) {
      observed = screen;
      if (/\bqe\b/i.test(screen)) break;
    }
    await Bun.sleep(50);
  }
  await writeFile(
    evidencePath,
    observed || (await paneScreen(session.paneId)),
    "utf8",
  );
  if (observed)
    await commandOutput(["herdr", "pane", "send-keys", session.paneId, "esc"]);
  const qeRendered = /\bqe\b/i.test(observed);
  const status = /\bqe\b.*\bconnected\b/i.test(observed)
    ? "connected"
    : /\bqe\b.*\binitializing\b/i.test(observed)
      ? "initializing"
      : /\bqe\b.*(?:error|failed|✗)/i.test(observed)
        ? "error"
        : "not_observed";
  return { screenOpened: observed.length > 0, qeRendered, status };
}

async function closeSession(
  herdr: HerdrSocketClient,
  session: ProbeSession,
): Promise<void> {
  try {
    await commandOutput(["herdr", "pane", "send-keys", session.paneId, "esc"]);
    await commandOutput([
      "herdr",
      "pane",
      "send-text",
      session.paneId,
      "/quit",
    ]);
    await commandOutput([
      "herdr",
      "pane",
      "send-keys",
      session.paneId,
      "enter",
    ]);
    await Bun.sleep(300);
  } catch {
    try {
      await herdr.sendKeys(session.agentName, ["ctrl+c", "ctrl+c"]);
    } catch {
      // The process already exited.
    }
  } finally {
    await session.control.close();
  }
}

async function paneScreen(paneId: string): Promise<string> {
  return commandOutput([
    "herdr",
    "pane",
    "read",
    paneId,
    "--source",
    "visible",
    "--lines",
    "100",
  ]);
}

async function commandOutput(command: string[]): Promise<string> {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `Command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
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

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => record(JSON.parse(line)));
  } catch {
    return [];
  }
}

function syntheticStopPayload(): Record<string, unknown> {
  return {
    conversationId: "00000000-0000-4000-8000-000000000001",
    executionNum: 0,
    terminationReason: "qe_zero_inference_readiness",
    fullyIdle: true,
    modelName: "synthetic-no-inference",
  };
}

function hookEnvironment(
  descriptorPath: string,
  eventLog: string,
): Record<string, string | undefined> {
  return {
    ...process.env,
    QE_HARNESS_CONTROL_PATH: descriptorPath,
    QE_PROBE_STOP_EVENT_LOG: eventLog,
  };
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function descriptorHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
