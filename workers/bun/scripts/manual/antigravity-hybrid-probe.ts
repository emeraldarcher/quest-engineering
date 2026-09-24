#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HerdrSocketClient } from "../../src/session-host/herdr/client.ts";
import {
  assessInteractivePhase,
  type InteractiveStateSample,
} from "./antigravity-hybrid-probe-state.ts";
import {
  assertInstalledAgyVersion,
  newProbeRoot,
  requireHumanProbeApproval,
} from "./antigravity-probe-control.ts";

const MODEL = "gemini-3.8-flash-low";

const recoveryEvidencePath =
  process.env.QE_HYBRID_RESUME_EVIDENCE?.trim() || null;
requireHumanProbeApproval(recoveryEvidencePath ? 2 : 3);
assertInstalledAgyVersion();
const socketPath = required("HERDR_SOCKET_PATH");
const workspaceId = required("HERDR_WORKSPACE_ID");
const root = recoveryEvidencePath
  ? dirname(resolve(recoveryEvidencePath))
  : newProbeRoot("hybrid");
const evidencePath = recoveryEvidencePath
  ? resolve(recoveryEvidencePath)
  : join(root, "evidence.json");
const recoveredEvidence = recoveryEvidencePath
  ? await readEvidence(evidencePath)
  : null;
const workspace = recoveredEvidence
  ? requiredEvidenceString(recoveredEvidence, "workspace")
  : join(root, "workspace");
await mkdir(workspace, { recursive: true });
const probeValue = recoveredEvidence
  ? requiredEvidenceString(recoveredEvidence, "probeValue")
  : `falcon-${randomDigits(6)}`;
const handoffWord = recoveredEvidence
  ? requiredEvidenceString(recoveredEvidence, "handoffWord")
  : `cedar-${crypto.randomUUID().slice(0, 6)}`;
const evidence: Record<string, unknown> = recoveredEvidence ?? {
  expectedInferenceTurns: 3,
  probeValue,
  handoffWord,
  workspace,
  herdrSession: process.env.HERDR_SESSION ?? null,
  herdrWorkspaceId: workspaceId,
  startedAt: new Date().toISOString(),
};
if (recoveredEvidence) {
  evidence.priorInteractiveAttempt = {
    interactiveResumeCommand: evidence.interactiveResumeCommand ?? null,
    herdrLaunch: evidence.herdrLaunch ?? null,
    herdrAttachCommand: evidence.herdrAttachCommand ?? null,
    herdrAttachExitCode: evidence.herdrAttachExitCode ?? null,
    herdrStateSamples: evidence.herdrStateSamples ?? null,
    interactiveHookConversationId:
      evidence.interactiveHookConversationId ?? null,
  };
  evidence.recovery = {
    reason:
      "Prior interactive attach teardown was accepted, but the requested handoff message was not sent; repeat the interactive handoff before final recall.",
    expectedAdditionalInferenceTurns: 2,
    startedAt: new Date().toISOString(),
  };
}

console.log("\nAntigravity headless → interactive → headless continuity probe");
if (recoveredEvidence) {
  console.log(
    "Recovery mode: preserve the existing headless conversation and run exactly 2 additional small model turns:",
  );
  console.log("  1. Corrected human message in the resumed interactive TUI.");
  console.log("  2. Headless recall check.");
} else {
  console.log(
    "Expected subscription-backed inference: exactly 3 small model turns:",
  );
  console.log("  1. Headless memory seed.");
  console.log("  2. One human message in the resumed interactive TUI.");
  console.log("  3. Headless recall check.");
}
console.log("No tools or repository work are requested.");
console.log(`Evidence directory: ${root}`);
console.log(`Probe value: ${probeValue}`);
console.log(`Interactive handoff word: ${handoffWord}`);
console.log("Safe abort during headless work: Ctrl+C.");
console.log("Safe abort in the Antigravity TUI: Ctrl+C twice.\n");

let conversationId: string;
if (recoveredEvidence) {
  conversationId = nativeConversationId(
    requiredEvidenceRecord(recoveredEvidence, "headlessTurn1"),
  );
  console.log(`RECOVERED HEADLESS TURN 1 conversation ID: ${conversationId}`);
} else {
  const firstPrompt =
    `Remember this value for this conversation: QE_HYBRID_PROBE=${probeValue}. ` +
    "Do not use tools or inspect files. Reply exactly QE_HYBRID_HEADLESS_1_ACK.";
  const firstCommand = [
    "agy",
    "--model",
    MODEL,
    "--output-format",
    "json",
    "--print-timeout",
    "2m",
    "--print",
    firstPrompt,
  ];
  evidence.headlessTurn1Command = firstCommand;
  console.log(
    `HEADLESS TURN 1: (cd ${workspace} && ${shellCommand(firstCommand)})`,
  );
  const first = await runJson(firstCommand, workspace);
  evidence.headlessTurn1 = first;
  await saveEvidence();
  conversationId = nativeConversationId(first);
  console.log(`Native conversation ID: ${conversationId}`);
}

const herdr = new HerdrSocketClient(socketPath);
const pane = await herdr.createTab({
  workspaceId,
  cwd: workspace,
  label: "Antigravity hybrid continuity probe",
});
const agentName = `qe-agy-hybrid-${crypto.randomUUID().slice(0, 8)}`;
const interactiveLog = join(root, "interactive-agy.log");
const interactiveArgs = [
  "--conversation",
  conversationId,
  "--model",
  MODEL,
  "--log-file",
  interactiveLog,
];
evidence.interactiveLog = interactiveLog;
evidence.interactiveResumeCommand = [
  "herdr",
  "agent",
  "start",
  agentName,
  "--kind",
  "agy",
  "--pane",
  pane.paneId,
  "--",
  ...interactiveArgs,
];
console.log("\nINTERACTIVE RESUME:");
console.log(shellCommand(evidence.interactiveResumeCommand as string[]));
const launched = await herdr.startAgent({
  paneId: pane.paneId,
  name: agentName,
  integrationKind: "agy",
  args: interactiveArgs,
  expectedTokens: manualProbeOwnership(agentName),
  timeoutMs: 90_000,
});
evidence.herdrLaunch = launched;
await saveEvidence();
console.log(`Herdr agent: ${agentName}`);
console.log(`Herdr pane: ${pane.paneId}`);
console.log(`Initial Herdr state: ${launched.status}`);
console.log("Herdr attach/observe succeeded.");
const interactivePrompt =
  `Also remember that the handoff word is ${handoffWord}. ` +
  "Do not use tools or inspect files. Reply exactly QE_HYBRID_INTERACTIVE_ACK.";
evidence.expectedInteractivePrompt = interactivePrompt;
console.log(
  "\nIn the attached TUI, paste exactly the line between the markers:",
);
console.log("--- BEGIN INTERACTIVE MESSAGE ---");
console.log(interactivePrompt);
console.log("--- END INTERACTIVE MESSAGE ---");
console.log(
  `Before submitting, verify that the editor contains the fresh handoff word ${handoffWord}, not QE_HYBRID_HEADLESS_1_ACK.`,
);
console.log("Wait until the reply QE_HYBRID_INTERACTIVE_ACK is complete.");
console.log(
  "Then detach from Herdr direct-attach with Ctrl+B, then Q. Do not exit Antigravity yourself; the probe will send its native /quit command after detach.",
);
console.log(
  `Emergency abort only: herdr agent send-keys '${agentName}' ctrl+c ctrl+c`,
);

const attachCommand = ["herdr", "agent", "attach", agentName, "--takeover"];
evidence.herdrAttachCommand = attachCommand;
const attach = Bun.spawn(attachCommand, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "pipe",
});
const attachStderrPromise = new Response(attach.stderr).text();
const states: InteractiveStateSample[] = [];
let interactiveConversationId: string | null = null;
while (attach.exitCode === null) {
  try {
    const current = await herdr.getAgent(agentName);
    const nativeId = nativeSessionId(current.nativeSession);
    if (nativeId) interactiveConversationId = nativeId;
    appendState(states, {
      at: new Date().toISOString(),
      state: current.status,
      nativeConversationId: nativeId,
    });
  } catch (error) {
    appendState(states, {
      at: new Date().toISOString(),
      state: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  await Bun.sleep(250);
}
const attachExitCode = await attach.exited;
const attachStderr = await attachStderrPromise;
if (attachStderr) process.stderr.write(attachStderr);
const interactiveAssessment = assessInteractivePhase({
  expectedConversationId: conversationId,
  states,
  attachExitCode,
  attachStderr,
});
evidence.herdrAttachExitCode = attachExitCode;
evidence.herdrAttachStderr = attachStderr;
evidence.herdrStateSamples = states;
evidence.interactiveHookConversationId = interactiveConversationId;
evidence.interactiveAssessment = interactiveAssessment;
await saveEvidence();
if (!interactiveAssessment.canAttemptFinalHeadlessResume)
  throw new Error(
    `Interactive phase did not establish a completed turn under the expected native conversation: ${JSON.stringify(interactiveAssessment)}. The final headless turn was not started.`,
  );

if (attachExitCode === 0) {
  evidence.interactiveExitRequest =
    "native_/quit_after_supported_attach_detach";
  await commandOutput(["herdr", "pane", "send-text", pane.paneId, "/quit"]);
  await commandOutput(["herdr", "pane", "send-keys", pane.paneId, "enter"]);
  evidence.interactiveExitObserved = await waitForAgentExit(
    herdr,
    agentName,
    15_000,
  );
  if (!evidence.interactiveExitObserved) {
    evidence.interactiveExitFallback = "ctrl+c_twice_after_attach_detach";
    await herdr.sendKeys(agentName, ["ctrl+c", "ctrl+c"]);
    evidence.interactiveExitObserved = await waitForAgentExit(
      herdr,
      agentName,
      15_000,
    );
  }
  await saveEvidence();
  if (!evidence.interactiveExitObserved)
    throw new Error(
      "Antigravity remained active after native /quit and the bounded interrupt fallback. The final headless turn was not started.",
    );
}
console.log(
  `Interactive teardown classification: ${interactiveAssessment.teardownKind}.`,
);
console.log(
  "A disappeared Herdr terminal after the completed matching turn is teardown evidence, not conversation deletion; the final native resume is the authority.",
);

const secondPrompt =
  "Without using tools or inspecting files, state the exact QE_HYBRID_PROBE value and the exact handoff word that were provided earlier in this same conversation.";
const secondCommand = [
  "agy",
  "--conversation",
  conversationId,
  "--model",
  MODEL,
  "--output-format",
  "json",
  "--print-timeout",
  "2m",
  "--print",
  secondPrompt,
];
evidence.headlessTurn2Command = secondCommand;
console.log(
  `\nHEADLESS TURN 2: (cd ${workspace} && ${shellCommand(secondCommand)})`,
);
let second: Record<string, unknown>;
try {
  second = await runJson(secondCommand, workspace);
} catch (error) {
  evidence.headlessTurn2Error =
    error instanceof Error ? error.message : String(error);
  evidence.finishedAt = new Date().toISOString();
  await saveEvidence();
  throw error;
}
evidence.headlessTurn2 = second;
const finalConversationId = nativeConversationId(second);
const response = String(second.response ?? "");
const summary = {
  headlessTurn1ConversationId: conversationId,
  interactiveHookConversationId: interactiveConversationId,
  headlessTurn2ConversationId: finalConversationId,
  allConversationIdsMatch:
    conversationId === interactiveConversationId &&
    conversationId === finalConversationId,
  probeValue,
  handoffWord,
  recalledProbeValue: response.includes(probeValue),
  recalledHandoffWord: response.includes(handoffWord),
  contextContinuityProven:
    conversationId === interactiveConversationId &&
    conversationId === finalConversationId &&
    response.includes(probeValue) &&
    response.includes(handoffWord),
  finalStatus: second.status ?? null,
  finalResponse: response,
  herdrStateSamples: states,
  interactiveAssessment,
};
evidence.summary = summary;
evidence.finishedAt = new Date().toISOString();
await saveEvidence();
console.log("\nHybrid probe summary (copy this block):");
console.log(JSON.stringify(summary, null, 2));
console.log(`Full evidence: ${evidencePath}`);
herdr.disconnect();

async function saveEvidence(): Promise<void> {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function runJson(
  command: string[],
  cwd: string,
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Command failed (${exitCode}): ${shellCommand(command)}\n${stderr.trim()}`,
    );
  const value = JSON.parse(stdout) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Antigravity did not return a JSON result object.");
  return value as Record<string, unknown>;
}

function nativeConversationId(result: Record<string, unknown>): string {
  const value = result.conversation_id;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Antigravity result has no valid native conversation_id.");
  return value;
}

function appendState(
  states: InteractiveStateSample[],
  sample: InteractiveStateSample,
): void {
  const previous = states.at(-1);
  if (
    !previous ||
    previous.state !== sample.state ||
    previous.nativeConversationId !== sample.nativeConversationId ||
    previous.detail !== sample.detail
  )
    states.push(sample);
}

async function waitForAgentExit(
  herdr: HerdrSocketClient,
  agentName: string,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await herdr.getAgent(agentName);
    } catch {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `Command failed (${result.exitCode}): ${shellCommand(command)}\n${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

function nativeSessionId(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "id" &&
    typeof (value as Record<string, unknown>).value === "string"
  )
    return String((value as Record<string, unknown>).value);
  return null;
}

async function readEvidence(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Hybrid evidence is not a JSON object: ${path}`);
  return value as Record<string, unknown>;
}

function requiredEvidenceString(
  evidence: Record<string, unknown>,
  field: string,
): string {
  const value = evidence[field];
  if (typeof value !== "string" || !value)
    throw new Error(`Hybrid recovery evidence has no valid ${field}.`);
  return value;
}

function requiredEvidenceRecord(
  evidence: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = evidence[field];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Hybrid recovery evidence has no valid ${field}.`);
  return value as Record<string, unknown>;
}

function randomDigits(length: number): string {
  return String(Math.floor(Math.random() * 10 ** length)).padStart(length, "0");
}

function manualProbeOwnership(agentName: string): Record<string, string> {
  return {
    qe_owner: "quest-engineering-worker",
    qe_worker_id: "manual-antigravity-probe",
    qe_lineage_id: agentName,
    qe_ownership_token: "quest-engineering-worker/v1",
    qe_session_incarnation: `manual-probe:${agentName}`,
  };
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
