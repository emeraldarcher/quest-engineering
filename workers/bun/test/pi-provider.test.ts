import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  readControl,
  writeControlAtomic,
  writeStepResultAtomic,
} from "../src/harnesses/control/result-envelope.ts";
import {
  mappedPiTools,
  PiHarness,
  piPromptFor,
} from "../src/harnesses/pi/adapter.ts";
import { workspaceAccessAllows } from "../src/harnesses/pi/workspace-permission-extension.ts";
import type { HarnessEvent } from "../src/harnesses/types.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  SessionBackendReadiness,
  TerminalAttachmentDescriptor,
  TerminalSessionBackend,
} from "../src/session-host/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "bun-worker-provider-"));
  roots.push(root);
  await mkdir(join(root, "workspace", ".git"), { recursive: true });
  const registry = new DispatchRegistry(join(root, "state.sqlite"), root);
  const host = new FakeHost(join(root, "workspace"));
  const extension = join(
    import.meta.dir,
    "..",
    "src",
    "harnesses",
    "pi",
    "step-result-extension.ts",
  );
  const provider = new PiHarness(host, config(root), {
    integrationPath: extension,
    resultExtensionPath: extension,
  });
  return { root, registry, host, provider };
}

test("maps QE capabilities through mechanically restricted access levels", () => {
  const none = action();
  none.execution.execution_workspace.access = "none";
  none.execution.configuration.tool_policy = { kind: "exact", tools: [] };
  expect(mappedPiTools({ action: none })).toEqual([
    "qe_step_result",
    "qe_request_human_assistance",
  ]);

  const readOnly = action();
  readOnly.execution.execution_workspace.access = "read_only";
  readOnly.execution.configuration.tool_policy = {
    kind: "exact",
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  };
  expect(mappedPiTools({ action: readOnly })).toEqual([
    "qe_step_result",
    "qe_request_human_assistance",
    "read",
    "grep",
    "find",
    "ls",
  ]);

  const readWrite = action();
  readWrite.execution.configuration.tool_policy = {
    kind: "exact",
    tools: ["workspace.filesystem", "terminal.shell"],
  };
  expect(mappedPiTools({ action: readWrite })).toEqual([
    "qe_step_result",
    "qe_request_human_assistance",
    "read",
    "edit",
    "write",
    "bash",
  ]);
});

test("structured human assistance remains available at every workspace access level", () => {
  for (const access of ["none", "read_only", "read_write"])
    expect(workspaceAccessAllows(access, "qe_request_human_assistance")).toBe(
      true,
    );
  expect(workspaceAccessAllows("none", "read")).toBe(false);
  expect(workspaceAccessAllows("read_only", "write")).toBe(false);
});

test("Pi prompt assembly keeps forced takeover local to Implement", () => {
  const objective =
    "Create a harmless test file according to the instructions you receive during implementation.";
  const forcedTakeover =
    "Before making repository changes, immediately request conversational intervention and wait for explicit /qe-resume before implementing the human guidance.";
  const reviewInstruction =
    "Review the implementation against the Quest requirements. Do not deliberately invoke the takeover acceptance mechanism; request human assistance only for a genuine blocker.";

  const implementBase = action({ instruction: forcedTakeover });
  const implement = action({
    execution: {
      ...implementBase.execution,
      work: {
        ...implementBase.execution.work,
        quest_objective: objective,
        step_instruction: forcedTakeover,
      },
    },
  });
  const reviewBase = action({
    action_id: "review-action",
    occurrence_id: "review-occurrence",
    attempt_id: "review-attempt",
    semantic_step_key: "review",
    instruction: reviewInstruction,
    declared_outputs: ["verdict"],
  });
  const review = action({
    execution: {
      ...reviewBase.execution,
      performer: {
        member_key: "reviewer",
        member_name: "Reviewer",
        class_key: "reviewer",
        class_name: "Reviewer",
      },
      work: {
        quest_objective: objective,
        class_instructions: "Review independently.",
        step_instruction: reviewInstruction,
        inputs: {
          change_set: {
            id: "change-set-1",
            kind: "change_set",
            output_name: "input",
            producer_occurrence_id: implement.occurrence_id,
            value: { files: ["human-picked.txt"] },
          },
        },
        declared_outputs: [{ name: "verdict", kind: "review_verdict" }],
      },
      context: {
        mode: "fresh",
        source_occurrence_id: null,
        logical_lineage_id: "reviewer-logical-lineage",
      },
    },
  });

  const implementPrompt = piPromptFor({ action: implement });
  const reviewPrompt = piPromptFor({ action: review });

  expect(implementPrompt).toContain(`Quest objective:\n${objective}`);
  expect(implementPrompt).toContain(`Step instruction:\n${forcedTakeover}`);
  expect(reviewPrompt).toContain(`Quest objective:\n${objective}`);
  expect(reviewPrompt).toContain(`Class instructions:\nReview independently.`);
  expect(reviewPrompt).toContain(`Step instruction:\n${reviewInstruction}`);
  expect(reviewPrompt).toContain('"human-picked.txt"');
  expect(reviewPrompt).not.toContain(forcedTakeover);
  expect(implementPrompt).toContain("Do not invent material user requirements");
  expect(implementPrompt).toContain(
    "instructions or a choice will come from the human and they are absent",
  );
  expect(implementPrompt).toContain(
    "internal naming, equivalent implementation techniques, normal investigation/debugging",
  );
});

test("retained human recovery receives a minimal continuation prompt", () => {
  const base = action();
  const recovered = action({
    execution: {
      ...base.execution,
      identity: {
        ...base.execution.identity,
        action_id: "recovered-action",
        attempt_id: "recovered-attempt",
      },
    },
    operational_recovery: {
      epoch_number: 1,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "human",
      continuation_mode: "retained",
      retained_lineage_id: "retained-lineage",
      source_attempt_id: base.attempt_id,
      request_id: "request-1",
    },
  });
  const prompt = piPromptFor({ action: recovered });
  expect(prompt).toContain(
    "Resume the same semantic Step from this retained session state",
  );
  expect(prompt).toContain("new QE Attempt in recovery epoch 1");
  expect(prompt).not.toContain(base.execution.work.quest_objective);
  expect(prompt).not.toContain("Quest objective:");
});

test("fresh retained-work recovery receives the full Step plus preservation instructions", () => {
  const base = action();
  const recovered = action({
    execution: {
      ...base.execution,
      identity: {
        ...base.execution.identity,
        action_id: "fresh-recovery-action",
        attempt_id: "fresh-recovery-attempt",
      },
    },
    operational_recovery: {
      epoch_number: 1,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "human",
      continuation_mode: "fresh",
      retained_lineage_id: null,
      source_attempt_id: base.attempt_id,
      request_id: "request-fresh",
    },
  });
  const prompt = piPromptFor({ action: recovered });
  expect(prompt).toContain("retained-work recovery");
  expect(prompt).toContain(
    "no native coding-agent conversation is being continued",
  );
  expect(prompt).toContain(
    "inspect the current Git status, diff, and relevant files",
  );
  expect(prompt).toContain("Do not reset, clean, overwrite");
  expect(prompt).toContain(
    `Quest objective:\n${base.execution.work.quest_objective}`,
  );
  expect(prompt).toContain(
    "produce the declared outputs through the normal completion tool",
  );
});

test("Pi discovery fails only its harness when the Herdr Pi integration is unavailable", async () => {
  const { registry, host, provider } = await fixture();
  host.backendReadiness = {
    ...readyBackend("pi"),
    status: "incompatible",
    ready: false,
    missingCapabilities: ["integration.pi.current"],
    diagnostics: [
      {
        code: "missing_capability",
        capability: "integration.pi.current",
        message: "Herdr integration 'pi' is not available and current.",
      },
    ],
  };

  const discovery = await provider.discover();
  expect(discovery.integration).toMatchObject({
    status: "missing_control_bridge",
    installed: true,
    authenticated: false,
  });
  expect(discovery.integration.detail).toContain("integration 'pi'");
  expect(discovery.capabilities.structuredResult).toBe(false);
  registry.close();
});

test("access-none stays Run-pinned but uses an isolated non-repository CWD", async () => {
  const { root, registry, host, provider } = await fixture();
  const none = action();
  none.execution.execution_workspace.access = "none";
  none.execution.execution_workspace.canonical_root = join(root, "workspace");
  none.execution.configuration.tool_policy = { kind: "exact", tools: [] };
  const accepted = registry.accept(none).dispatch;
  const lineage = registry.getLineage(accepted.lineageId as string);

  await provider.start(accepted, lineage);

  expect(host.createdCwds).toHaveLength(1);
  expect(host.createdCwds[0]).toContain(join(root, "isolated"));
  expect(host.createdCwds[0]).not.toBe(
    none.execution.execution_workspace.canonical_root,
  );
  expect(lineage.logicalLineageId).toBe(
    none.execution.context.logical_lineage_id,
  );
  registry.close();
});

test("ordinary Pi prose is never classified as human attention", async () => {
  const { registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  host.setAgentState("working", "I need to inspect this file.");

  const inspection = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(inspection.state).toBe("running");
  expect(inspection.attention).toBeNull();
  registry.close();
});

test("Herdr-only blocked creates one safe provider-neutral attention", async () => {
  const { registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  host.setAgentState("blocked", "Secret terminal prompt text");

  const first = await provider.inspect(registry.getLineage(lineage.lineageId));
  expect(first).toMatchObject({
    state: "waiting_for_human",
    attention: {
      category: "interactive_prompt",
      message: "Pi is waiting for input",
    },
  });
  expect(first.attention?.message).not.toContain("Secret");
  registry.updateSession(
    lineage.lineageId,
    first.state,
    first.attention,
    first.lastActivityAt,
  );
  const repeated = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(repeated.attention?.attentionId).toBe(first.attention?.attentionId);
  registry.close();
});

test("only actual Herdr blocked state creates generic attention", async () => {
  const { registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });

  for (const expected of [
    ["working", "running"],
    ["idle", "retained"],
    ["unknown", "recovering"],
  ] as const) {
    host.setAgentState(expected[0], "quiet for a long time");
    const inspection = await provider.inspect(
      registry.getLineage(lineage.lineageId),
    );
    expect(inspection.state).toBe(expected[1]);
    expect(inspection.attention).toBeNull();
  }
  registry.close();
});

test("Herdr blocked to working clears a terminal-derived attention", async () => {
  const { registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  host.setAgentState("blocked");
  const blocked = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  registry.updateSession(
    lineage.lineageId,
    blocked.state,
    blocked.attention,
    blocked.lastActivityAt,
  );

  host.setAgentState("unknown");
  const uncertain = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(uncertain.attention?.attentionId).toBe(blocked.attention?.attentionId);

  host.setAgentState("working");
  const resumed = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(resumed.state).toBe("running");
  expect(resumed.attention).toBeNull();
  registry.close();
});

test("structured assistance enriches and deduplicates the current Herdr blocked episode", async () => {
  const { root, registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  host.setAgentState("blocked");
  const generic = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  registry.updateSession(
    lineage.lineageId,
    generic.state,
    generic.attention,
    generic.lastActivityAt,
  );

  await mkdir(join(root, "lineages", lineage.lineageId), { recursive: true });
  await Bun.write(
    join(root, "lineages", lineage.lineageId, "attention-control.json"),
    JSON.stringify({
      version: 1,
      attentionId: "attention-explicit-different-id",
      category: "needs_confirmation",
      message: "Choose which migration strategy to use",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  if (!generic.attention) throw new Error("Expected generic attention");
  const enriched = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(enriched.attention).toEqual({
    attentionId: generic.attention.attentionId,
    category: "needs_confirmation",
    message: "Choose which migration strategy to use",
    requestedAt: generic.attention.requestedAt,
  });
  registry.close();
});

test("structured assistance can lead Herdr blocked without creating another episode", async () => {
  const { root, registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  await mkdir(join(root, "lineages", lineage.lineageId), { recursive: true });
  await Bun.write(
    join(root, "lineages", lineage.lineageId, "attention-control.json"),
    JSON.stringify({
      version: 1,
      attentionId: "attention-structured-first",
      category: "needs_input",
      message: "Provide the release value",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  host.setAgentState("working");
  const structured = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(structured.attention?.attentionId).toBe("attention-structured-first");

  host.setAgentState("blocked");
  const blocked = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(blocked.attention).toEqual(structured.attention);
  registry.close();
});

test("Pi inspection reads explicit structured attention and clears on resolution", async () => {
  const { root, registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  const controlPath = join(
    root,
    "lineages",
    lineage.lineageId,
    "attention-control.json",
  );
  await mkdir(join(root, "lineages", lineage.lineageId), { recursive: true });
  await Bun.write(
    controlPath,
    JSON.stringify({
      version: 1,
      attentionId: "attention-explicit",
      category: "needs_confirmation",
      message: "Confirm the operation.",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  host.setAgentState("blocked", "provider display text");

  expect(
    (await provider.inspect(registry.getLineage(lineage.lineageId))).attention,
  ).toMatchObject({
    attentionId: "attention-explicit",
    category: "needs_confirmation",
    message: "Confirm the operation.",
  });

  await Bun.write(
    controlPath,
    JSON.stringify({ version: 1, state: "resolved" }),
  );
  host.setAgentState("working");
  expect(
    (await provider.inspect(registry.getLineage(lineage.lineageId))).attention,
  ).toBeNull();
  registry.close();
});

test("conversational checkpoint survives restart and resolves only after explicit resume", async () => {
  const { root, registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  registry.occupy(lineage.lineageId, dispatch.action.action_id);
  const controlPath = join(
    root,
    "lineages",
    lineage.lineageId,
    "attention-control.json",
  );
  await mkdir(join(root, "lineages", lineage.lineageId), { recursive: true });
  await Bun.write(
    controlPath,
    JSON.stringify({
      version: 2,
      attentionId: "attention-conversation",
      category: "needs_input",
      message: "Choose a filename.",
      interaction: "conversational_intervention",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  host.setAgentState("blocked");
  const pending = await provider.inspect(
    registry.getLineage(lineage.lineageId),
  );
  expect(pending).toMatchObject({
    state: "waiting_for_human",
    attention: {
      attentionId: "attention-conversation",
      interaction: {
        kind: "conversational_intervention",
        controlState: "intervention_pending",
        resumeCommand: "/qe-resume",
      },
    },
    intervention: {
      attentionId: "attention-conversation",
      state: "intervention_pending",
    },
  });
  registry.updateSession(
    lineage.lineageId,
    pending.state,
    pending.attention,
    pending.lastActivityAt,
    pending.intervention,
  );
  registry.close();

  const restarted = new DispatchRegistry(join(root, "state.sqlite"), root);
  const recovered = restarted.getLineage(lineage.lineageId);
  expect(recovered.activeActionId).toBe(dispatch.action.action_id);
  expect(recovered.intervention?.state).toBe("intervention_pending");
  expect(recovered.attention?.attentionId).toBe("attention-conversation");

  await Bun.write(
    controlPath,
    JSON.stringify({
      version: 2,
      attentionId: "attention-conversation",
      category: "needs_input",
      message: "Choose a filename.",
      interaction: "conversational_intervention",
      state: "resolved",
      requestedAt: "2026-09-06T00:00:00.000Z",
      handedBackAt: "2026-09-06T00:05:00.000Z",
      automationResumedAt: "2026-09-06T00:05:01.000Z",
    }),
  );
  host.setAgentState("working");
  const resumed = await provider.inspect(recovered);
  expect(resumed.attention).toBeNull();
  expect(resumed.intervention).toMatchObject({
    state: "resumed",
    handedBackAt: "2026-09-06T00:05:00.000Z",
    automationResumedAt: "2026-09-06T00:05:01.000Z",
  });
  restarted.close();
});

test("agent settlement while intervention is pending does not collect or release execution", async () => {
  const { root, registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  registry.occupy(lineage.lineageId, dispatch.action.action_id);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  const controlPath = join(
    root,
    "lineages",
    lineage.lineageId,
    "attention-control.json",
  );
  await Bun.write(
    controlPath,
    JSON.stringify({
      version: 2,
      attentionId: "attention-yielded",
      category: "needs_input",
      message: "Talk with Pi.",
      interaction: "conversational_intervention",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  host.setAgentState("blocked");
  const events: HarnessEvent[] = [];
  let collected = false;
  const operation = provider
    .sendInputAndCollect(
      dispatch,
      { ...prepared, lineage: registry.getLineage(lineage.lineageId) },
      (event) => events.push(event),
    )
    .then((outputs) => {
      collected = true;
      return outputs;
    });
  await Bun.sleep(10);
  expect(collected).toBe(false);
  expect(registry.getLineage(lineage.lineageId).activeActionId).toBe(
    dispatch.action.action_id,
  );
  expect(
    events.some(
      (event) =>
        event.inspection.intervention?.state === "intervention_pending",
    ),
  ).toBe(true);

  await Bun.write(
    controlPath,
    JSON.stringify({
      version: 2,
      attentionId: "attention-yielded",
      category: "needs_input",
      message: "Talk with Pi.",
      interaction: "conversational_intervention",
      state: "resolved",
      requestedAt: "2026-09-06T00:00:00.000Z",
      handedBackAt: "2026-09-06T00:01:00.000Z",
      automationResumedAt: "2026-09-06T00:01:01.000Z",
    }),
  );
  await writeStepResultAtomic(dispatch.resultDirectory, "tool-result", {
    protocolVersion: 1,
    kind: "quest_engineering_step_result",
    workerId: dispatch.action.worker_id,
    actionId: dispatch.action.action_id,
    runId: dispatch.action.run_id,
    occurrenceId: dispatch.action.occurrence_id,
    attemptId: dispatch.action.attempt_id,
    nonce: dispatch.resultNonce,
    createdAt: new Date().toISOString(),
    outputs: { change_set: { version: 1 } },
  });
  host.queueAgentState("working");
  host.queueAgentState("idle");
  expect(await operation).toEqual({ change_set: { version: 1 } });
  expect(host.promptOptions).toBeUndefined();
  registry.close();
});

test("Worker restart restores Herdr-only blocked attention from recovered state", async () => {
  const { root, registry, host } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const extension = join(
    import.meta.dir,
    "..",
    "src",
    "harnesses",
    "pi",
    "step-result-extension.ts",
  );
  const initialProvider = new PiHarness(host, config(root), {
    integrationPath: extension,
    resultExtensionPath: extension,
  });
  const prepared = await initialProvider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  host.setAgentState("blocked");
  registry.close();

  const restartedRegistry = new DispatchRegistry(
    join(root, "state.sqlite"),
    root,
  );
  const recoveredLineage = restartedRegistry.getLineage(lineage.lineageId);
  const restartedProvider = new PiHarness(host, config(root), {
    integrationPath: extension,
    resultExtensionPath: extension,
  });
  expect(await restartedProvider.recover(recoveredLineage)).toMatchObject({
    found: true,
    agent: { status: "blocked" },
  });
  expect(await restartedProvider.inspect(recoveredLineage)).toMatchObject({
    state: "waiting_for_human",
    attention: {
      category: "interactive_prompt",
      message: "Pi is waiting for input",
    },
  });
  restartedRegistry.close();
});

test("Pi never adopts an execution from a deleted Herdr session incarnation", async () => {
  const { registry, host, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });

  host.sessionIncarnationId = "replacement-session-incarnation";
  expect(
    await provider.recover(registry.getLineage(lineage.lineageId)),
  ).toMatchObject({
    found: false,
    detail: expect.stringContaining("another Herdr session incarnation"),
  });
  registry.close();
});

test("two Herdr sessions keep terminal state and attention independent", async () => {
  const { root, registry, host, provider } = await fixture();
  const first = registry.accept(action()).dispatch;
  const second = registry.accept(
    action({
      action_id: "action-independent",
      run_id: "run-independent",
      occurrence_id: "occurrence-independent",
      attempt_id: "attempt-independent",
    }),
  ).dispatch;
  const firstLineage = registry.getLineage(first.lineageId as string);
  const secondLineage = registry.getLineage(second.lineageId as string);
  const firstPrepared = await provider.start(first, firstLineage);
  const secondPrepared = await provider.start(second, secondLineage);
  for (const [lineage, prepared] of [
    [firstLineage, firstPrepared],
    [secondLineage, secondPrepared],
  ] as const)
    registry.recordHost(lineage.lineageId, {
      herdrSession: prepared.ref.sessionName,
      herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
      workspaceId: prepared.ref.workspaceId,
      paneId: prepared.ref.paneId,
      agentName: prepared.ref.agentName,
    });

  await Bun.write(
    join(root, "lineages", firstLineage.lineageId, "attention-control.json"),
    JSON.stringify({
      version: 2,
      attentionId: "attention-session-a",
      category: "needs_input",
      message: "Session A needs conversation.",
      interaction: "conversational_intervention",
      state: "requested",
      requestedAt: "2026-09-06T00:00:00.000Z",
    }),
  );
  host.setAgentStateFor(firstPrepared.ref.agentName, "blocked");
  host.setAgentStateFor(secondPrepared.ref.agentName, "working");
  expect(
    (await provider.inspect(registry.getLineage(firstLineage.lineageId)))
      .attention,
  ).not.toBeNull();
  expect(
    await provider.inspect(registry.getLineage(secondLineage.lineageId)),
  ).toMatchObject({
    state: "running",
    attention: null,
    intervention: null,
  });
  registry.close();
});

test("adopts safe legacy Herdr provenance with truncated IDs and omitted persisted name", async () => {
  const { root, registry, provider, host } = await fixture();
  const longPrefix = `quest-launch-${"a".repeat(36)}/occurrence/0/implement-review/`;
  const dispatch = registry.accept(
    action({
      run_id: `quest-launch-${"a".repeat(36)}`,
      occurrence_id: longPrefix,
      attempt_id: `${longPrefix}attempt/1`,
      action_id: `${longPrefix}attempt/1/action/execute-step`,
    }),
  ).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  expect(Object.keys(host.metadata.at(-1)?.tokens ?? {})).toHaveLength(15);
  const launchTokens = host.metadata.at(-1)?.tokens as Record<string, string>;
  expect(launchTokens.qe_agent_name).toBe(prepared.ref.agentName);
  expect(launchTokens.qe_action_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(launchTokens.qe_occurrence_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(launchTokens.qe_attempt_hash).toMatch(/^[a-f0-9]{64}$/);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
    herdrSessionIncarnation: prepared.ref.sessionIncarnation as string,
    workspaceId: prepared.ref.workspaceId,
    ...(prepared.ref.tabId ? { tabId: prepared.ref.tabId } : {}),
    paneId: prepared.ref.paneId,
    ...(prepared.ref.terminalId ? { terminalId: prepared.ref.terminalId } : {}),
    agentName: prepared.ref.agentName,
  });
  await writeControlAtomic(lineage.resultControlPath, {
    protocolVersion: 1,
    workerId: dispatch.action.worker_id,
    lineageId: lineage.lineageId,
    action: dispatch.action,
    nonce: dispatch.resultNonce,
    resultDirectory: dispatch.resultDirectory,
  });
  const persistedAgent = (await host.snapshot()).agents[0] as HostedAgent;
  delete persistedAgent.name;
  delete persistedAgent.tokens?.qe_action_hash;
  if (persistedAgent.tokens?.qe_active_action_id)
    persistedAgent.tokens.qe_active_action_id = dispatch.action.action_id.slice(
      0,
      80,
    );
  const legacyTokens = persistedAgent.tokens as Record<string, string>;
  expect(legacyTokens.qe_run_id).toBe(dispatch.action.run_id);
  expect(
    dispatch.action.action_id.startsWith(
      legacyTokens.qe_active_action_id as string,
    ),
  ).toBe(true);
  const persistedControl = await readControl(lineage.resultControlPath);
  expect(persistedControl.nonce).toBe(dispatch.resultNonce);
  expect(persistedControl.workerId).toBe("worker-test");
  expect(legacyTokens.qe_occurrence_hash).toBe(
    createHash("sha256")
      .update(persistedControl.action.occurrence_id)
      .digest("hex"),
  );
  expect(legacyTokens.qe_attempt_hash).toBe(
    createHash("sha256")
      .update(persistedControl.action.attempt_id)
      .digest("hex"),
  );
  expect(legacyTokens).toMatchObject({
    qe_worker_id: "worker-test",
    qe_lineage_id: lineage.lineageId,
    qe_result_nonce: dispatch.resultNonce,
    qe_agent_name: prepared.ref.agentName,
    qe_active_state: "active",
  });
  registry.close();
  const raw = new Database(join(root, "state.sqlite"));
  raw
    .query("DELETE FROM dispatches WHERE action_id=?")
    .run(dispatch.action.action_id);
  raw.close();

  const restarted = new DispatchRegistry(join(root, "state.sqlite"), root);
  const candidates = await provider.discoverAdoptionCandidates();
  expect(candidates).toHaveLength(1);
  expect(
    restarted.adopt(candidates[0] as (typeof candidates)[number]),
  ).toMatchObject({
    action: { action_id: dispatch.action.action_id },
    lineageId: lineage.lineageId,
  });
  restarted.close();
});

test("known failed dispatch recovers exact pre-prompt orphan without a result control file", async () => {
  const { registry, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.start(dispatch, lineage);
  await rm(lineage.resultControlPath);
  registry.fail(dispatch.action.action_id, {
    code: "backend_incompatible",
    message: "Herdr response omitted agent.",
  });

  const candidates = await provider.discoverAdoptionCandidates([
    { dispatch: registry.get(dispatch.action.action_id), lineage },
  ]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    action: { action_id: dispatch.action.action_id },
    lineage: {
      lineageId: lineage.lineageId,
      herdrSessionIncarnation: prepared.ref.sessionIncarnation,
      paneId: prepared.ref.paneId,
      agentName: prepared.ref.agentName,
    },
  });
  expect(
    registry.adopt(candidates[0] as (typeof candidates)[number]),
  ).toMatchObject({ state: "failed" });
  expect(registry.getLineage(lineage.lineageId)).toMatchObject({
    herdrSessionIncarnation: prepared.ref.sessionIncarnation,
    paneId: prepared.ref.paneId,
    agentName: prepared.ref.agentName,
  });
  registry.close();
});

test("fresh Actions create distinct Pi agents while continuation reuses the original", async () => {
  const { registry, host, provider } = await fixture();
  const first = registry.accept(action()).dispatch;
  const firstLineage = registry.getLineage(first.lineageId as string);
  const started = await provider.start(first, firstLineage);
  registry.recordHost(firstLineage.lineageId, {
    herdrSession: started.ref.sessionName,
    herdrSessionIncarnation: started.ref.sessionIncarnation as string,
    workspaceId: started.ref.workspaceId,
    ...(started.ref.tabId ? { tabId: started.ref.tabId } : {}),
    paneId: started.ref.paneId,
    ...(started.ref.terminalId ? { terminalId: started.ref.terminalId } : {}),
    agentName: started.ref.agentName,
  });
  registry.complete(first.action.action_id, { change_set: {} });
  expect(
    provider.attachment(registry.getLineage(firstLineage.lineageId)),
  ).toMatchObject({
    mode: "local_native_terminal",
    backendKind: "herdr",
    terminalSessionId: "test-herdr",
  });

  const review = registry.accept(
    action({
      action_id: "review",
      occurrence_id: "review-occurrence",
      attempt_id: "review-attempt",
      semantic_step_key: "review",
      instruction: "Review independently.",
      declared_outputs: ["verdict"],
    }),
  ).dispatch;
  await provider.start(review, registry.getLineage(review.lineageId as string));

  const repair = registry.accept(
    action({
      action_id: "repair",
      occurrence_id: "repair-occurrence",
      attempt_id: "repair-attempt",
      semantic_step_key: "repair",
      instruction: "Repair findings.",
      context_requirement: { selector: "continue_from", value: null },
      context_lineage_occurrence_id: first.action.occurrence_id,
    }),
  ).dispatch;
  const source = registry.resolveContinuation(first.action);
  registry.assignLineage(repair.action.action_id, source.lineageId);
  const repairedDispatch = registry.get(repair.action.action_id);
  const repairedLineage = registry.getLineage(source.lineageId);
  await provider.continue(repairedDispatch, repairedLineage);
  await provider.clearActiveMetadata(repairedDispatch, repairedLineage);

  expect(host.startedNames).toHaveLength(2);
  expect(host.metadata.at(-1)?.tokens).toMatchObject({
    qe_lineage_id: firstLineage.lineageId,
    qe_active_state: "inactive",
    qe_active_action_id: "",
  });
  expect(registry.getLineage(source.lineageId).resultControlPath).toBe(
    firstLineage.resultControlPath,
  );
  registry.close();
});

class FakeHost implements TerminalSessionBackend {
  readonly backendKind = "herdr";
  readonly sessionName = "test-herdr";
  sessionIncarnationId = "test-session-incarnation";
  sessionIncarnation() {
    return this.sessionIncarnationId;
  }
  readonly startedNames: string[] = [];
  readonly createdCwds: string[] = [];
  readonly metadata: Array<{ paneId: string; tokens: Record<string, string> }> =
    [];
  private workspaceCreated = false;
  private panes: HostedPane[] = [];
  private agents: HostedAgent[] = [];
  promptOptions:
    | { until?: HostedAgent["status"][]; timeoutMs?: number }
    | undefined;
  private observedStates: HostedAgent["status"][] = [];
  private observedWaiter: (() => void) | null = null;
  backendReadiness = readyBackend("pi");
  constructor(private cwd: string) {}
  async readiness(): Promise<SessionBackendReadiness> {
    return this.backendReadiness;
  }
  async snapshot(): Promise<HostedSnapshot> {
    return {
      workspaces: this.workspaceCreated ? [{ workspaceId: "workspace" }] : [],
      panes: this.panes,
      agents: this.agents,
    };
  }
  async createWorkspace(input: { cwd: string }): Promise<HostedPane> {
    this.workspaceCreated = true;
    this.cwd = input.cwd;
    this.createdCwds.push(input.cwd);
    const pane = this.pane("pane-1", "tab-1");
    this.panes.push(pane);
    return pane;
  }
  async createTab(): Promise<HostedPane> {
    const pane = this.pane(
      `pane-${this.panes.length + 1}`,
      `tab-${this.panes.length + 1}`,
    );
    this.panes.push(pane);
    return pane;
  }
  async reportMetadata(input: {
    paneId: string;
    title: string;
    tokens: Record<string, string>;
  }): Promise<void> {
    this.metadata.push({ paneId: input.paneId, tokens: input.tokens });
    const agent = this.agents.find((item) => item.paneId === input.paneId);
    if (agent) agent.tokens = input.tokens;
  }
  async startAgent(input: {
    paneId: string;
    name: string;
  }): Promise<HostedAgent> {
    this.startedNames.push(input.name);
    const pane = this.panes.find(
      (item) => item.paneId === input.paneId,
    ) as HostedPane;
    const tokens = this.metadata.findLast(
      (item) => item.paneId === input.paneId,
    )?.tokens;
    const agent: HostedAgent = {
      name: input.name,
      agent: "pi",
      status: "idle",
      paneId: pane.paneId,
      ...(pane.terminalId ? { terminalId: pane.terminalId } : {}),
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      cwd: this.cwd,
      interactiveReady: true,
      ...(tokens ? { tokens } : {}),
    };
    this.agents.push(agent);
    return agent;
  }
  setAgentState(status: HostedAgent["status"], message?: string): void {
    for (const agent of this.agents)
      this.updateAgentState(agent, status, message);
  }
  setAgentStateFor(
    target: string,
    status: HostedAgent["status"],
    message?: string,
  ): void {
    const agent = this.agents.find(
      (candidate) => candidate.name === target || candidate.paneId === target,
    );
    if (!agent) throw new Error(`Unknown fake Herdr agent: ${target}`);
    this.updateAgentState(agent, status, message);
  }
  async prompt(
    _target: string,
    _text: string,
    options?: { until?: HostedAgent["status"][]; timeoutMs?: number },
  ): Promise<HostedAgent> {
    this.promptOptions = options;
    return this.agents[0] as HostedAgent;
  }
  async observeAgentState(): Promise<HostedAgent> {
    while (this.observedStates.length === 0)
      await new Promise<void>((resolve) => {
        this.observedWaiter = resolve;
      });
    const status = this.observedStates.shift() as HostedAgent["status"];
    const agent = this.agents[0] as HostedAgent;
    this.updateAgentState(agent, status);
    return agent;
  }
  queueAgentState(status: HostedAgent["status"]): void {
    this.observedStates.push(status);
    this.observedWaiter?.();
    this.observedWaiter = null;
  }
  async inspectAgentState(target: string): Promise<HostedAgent> {
    return this.agents.find(
      (item) => item.name === target || item.paneId === target,
    ) as HostedAgent;
  }
  async closePane(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  attachment(ref: HostedExecutionRef): TerminalAttachmentDescriptor {
    return {
      mode: "local_native_terminal",
      backendKind: "herdr",
      terminalSessionId: this.sessionName,
      terminalTargetId: ref.agentName,
      supportsObservation: true,
      supportsTakeover: true,
    };
  }
  disconnect(): void {}
  private updateAgentState(
    agent: HostedAgent,
    status: HostedAgent["status"],
    message?: string,
  ): void {
    agent.status = status;
    if (message) agent.message = message;
    else delete agent.message;
  }
  private pane(paneId: string, tabId: string): HostedPane {
    return {
      paneId,
      tabId,
      terminalId: `terminal-${paneId}`,
      workspaceId: "workspace",
      cwd: this.cwd,
    };
  }
}

function readyBackend(harnessKind: string): SessionBackendReadiness {
  return {
    backendKind: "herdr",
    harnessKind,
    status: "ready",
    ready: true,
    capabilities: [],
    missingCapabilities: [],
    diagnostics: [],
    provenance: {
      version: "test",
      protocol: 999,
      testedProtocol: 22,
      endpointGeneration: 1,
      serverGeneration: "test-generation",
    },
  };
}

function config(root: string): WorkerConfig {
  return {
    controlPlaneUrl: "ws://localhost/worker/websocket",
    workerId: "worker-test",
    workerToken: "token",
    maxConcurrency: 1,
    tags: [],
    herdrSession: "test-herdr",
    allowedRoots: [],
    workspaceBindings: [],
    worktreeRoot: join(root, "worktrees"),
    dataRoot: root,
    piThinking: "minimal",
    heartbeatMs: 1000,
    reconnectMs: 1000,
    resultTimeoutMs: 1000,
    provider: "pi",
    fakeOutputs: {},
    fakeDelayMs: 0,
  };
}
