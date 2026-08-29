import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type { ExecuteAction, JsonValue } from "../src/protocol/types.ts";
import { PiProvider } from "../src/providers/pi/provider.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";
import { HerdrSessionHost } from "../src/session-host/herdr/session-host.ts";

const id = crypto.randomUUID().slice(0, 8);
const root = resolve(".pi/tmp", `worker-herdr-pi-${id}`);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await command(["git", "init", "-b", "main", workspace]);
await command([
  "git",
  "-C",
  workspace,
  "config",
  "user.name",
  "Quest Engineering Worker Integration",
]);
await command([
  "git",
  "-C",
  workspace,
  "config",
  "user.email",
  "worker-integration@example.invalid",
]);
await Bun.write(join(workspace, "README.md"), "# Worker Herdr/Pi fixture\n");
await command(["git", "-C", workspace, "add", "README.md"]);
await command(["git", "-C", workspace, "commit", "-m", "fixture"]);

const configuredModel = process.env.QE_PI_MODEL?.trim();
if (!configuredModel)
  throw new Error(
    "QE_PI_MODEL=provider/model is required for the real Pi integration.",
  );
const model = splitModel(configuredModel);

const config: WorkerConfig = {
  controlPlaneUrl: "ws://127.0.0.1/unused",
  workerId: `worker-live-${id}`,
  workerToken: "unused",
  maxConcurrency: 1,
  tags: ["integration"],
  herdrSession: `qe-worker-${id}`,
  workspaceRoot: workspace,
  workspaceRef: "workspace:integration",
  workspaceMaxAccess: "read_write",
  executorModels: [model],
  reasoningLevels: ["low", "medium", "high"],
  dataRoot: join(root, "worker-data"),
  piModel: configuredModel,
  piThinking: "medium",
  heartbeatMs: 10_000,
  reconnectMs: 1_000,
  resultTimeoutMs: 600_000,
  provider: "pi",
  fakeOutputs: {},
  fakeDelayMs: 0,
};
const registry = new DispatchRegistry(
  join(config.dataRoot, "dispatches.sqlite"),
  config.dataRoot,
);
const host = new HerdrSessionHost(
  new LocalHerdrConnectionProvider(config.herdrSession),
);
const provider = new PiProvider(host, config);
const executor = new DispatchExecutor(registry, provider, async () => false);

const implement = makeAction({
  action_id: "action-implement",
  occurrence_id: "occurrence-implement",
  attempt_id: "attempt-implement",
  semantic_step_key: "implement",
  instruction:
    'Create qe-v07-proof.txt containing exactly the line "implemented through Herdr" followed by a newline. Produce change_set describing the file.',
  declared_outputs: ["change_set"],
});
registry.accept(implement);
await executor.start(implement.action_id);
assertCompleted(registry, implement.action_id);
const implementLineage = registry.getLineage(
  registry.get(implement.action_id).lineageId as string,
);

const repair = makeAction({
  action_id: "action-repair",
  occurrence_id: "occurrence-repair",
  attempt_id: "attempt-repair",
  semantic_step_key: "repair",
  instruction:
    'Append exactly the line "continued in the same Pi context" to qe-v07-proof.txt. Preserve the first line. Produce the updated change_set.',
  context_requirement: { selector: "continue_from", value: null },
  context_lineage_occurrence_id: implement.occurrence_id,
  inputs: {
    change_set: artifact(
      "change_set",
      implement.occurrence_id,
      registry.get(implement.action_id).outputs?.change_set ?? {},
    ),
  },
  declared_outputs: ["change_set"],
});
registry.accept(repair);
await executor.start(repair.action_id);
assertCompleted(registry, repair.action_id);
const repairLineage = registry.getLineage(
  registry.get(repair.action_id).lineageId as string,
);
if (
  repairLineage.lineageId !== implementLineage.lineageId ||
  repairLineage.resultControlPath !== implementLineage.resultControlPath ||
  repairLineage.agentName !== implementLineage.agentName
) {
  throw new Error("Repair did not preserve the implementation Pi lineage.");
}

const review = makeAction({
  action_id: "action-review",
  occurrence_id: "occurrence-review",
  attempt_id: "attempt-review",
  semantic_step_key: "review",
  instruction:
    'Independently inspect qe-v07-proof.txt. Produce verdict with status "accepted" only when it contains exactly the two requested lines in order; otherwise use status "rejected" and explain why.',
  inputs: {
    change_set: artifact(
      "change_set",
      repair.occurrence_id,
      registry.get(repair.action_id).outputs?.change_set ?? {},
    ),
  },
  declared_outputs: ["verdict"],
});
registry.accept(review);
await executor.start(review.action_id);
assertCompleted(registry, review.action_id);
const reviewLineage = registry.getLineage(
  registry.get(review.action_id).lineageId as string,
);
if (reviewLineage.lineageId === implementLineage.lineageId)
  throw new Error("Fresh Review reused the implementation context.");
const verdict = registry.get(review.action_id).outputs?.verdict;
if (!isRecord(verdict) || verdict.status !== "accepted")
  throw new Error(`Review rejected the proof: ${JSON.stringify(verdict)}`);
const content = await Bun.file(join(workspace, "qe-v07-proof.txt")).text();
if (content !== "implemented through Herdr\ncontinued in the same Pi context\n")
  throw new Error(`Unexpected proof content: ${JSON.stringify(content)}`);

const proof = {
  ok: true,
  root,
  workspace,
  herdrSession: config.herdrSession,
  implement: summary(registry, implement.action_id),
  repair: summary(registry, repair.action_id),
  review: summary(registry, review.action_id),
  continuation: {
    sameLineage: true,
    sameAgent: true,
    sameResultControlPath: true,
  },
  freshReview: { independentLineage: true },
  attach: {
    implement: host.attachInfo({
      sessionName: config.herdrSession,
      workspaceId: implementLineage.workspaceId as string,
      paneId: implementLineage.paneId as string,
      agentName: implementLineage.agentName as string,
    }),
    review: host.attachInfo({
      sessionName: config.herdrSession,
      workspaceId: reviewLineage.workspaceId as string,
      paneId: reviewLineage.paneId as string,
      agentName: reviewLineage.agentName as string,
    }),
  },
};
await Bun.write(
  join(root, "proof.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
);
console.log(JSON.stringify(proof, null, 2));
registry.close();
provider.disconnect();
process.exit(0);

function makeAction(overrides: Partial<ExecuteAction>): ExecuteAction {
  const actionId = overrides.action_id ?? "action";
  const occurrenceId = overrides.occurrence_id ?? "occurrence";
  const attemptId = overrides.attempt_id ?? "attempt";
  const semanticStepKey = overrides.semantic_step_key ?? "step";
  const instruction = overrides.instruction ?? "Execute the step.";
  const contextMode = overrides.context_requirement?.selector ?? "fresh";
  const source = overrides.context_lineage_occurrence_id ?? null;
  const logicalLineageId =
    contextMode === "continue_from"
      ? "logical-action-implement"
      : `logical-${actionId}`;
  return {
    type: "execute_action",
    protocol_version: 3,
    worker_id: config.workerId,
    execution: {
      identity: {
        launch_id: "integration-launch",
        action_id: actionId,
        run_id: overrides.run_id ?? "run-live",
        occurrence_id: occurrenceId,
        attempt_id: attemptId,
        semantic_step_key: semanticStepKey,
      },
      performer: {
        member_key: "integration-member",
        member_name: "Integration Member",
        class_key: "integration",
        class_name: "Integration",
      },
      work: {
        quest_objective: "Verify real Herdr/Pi product execution binding.",
        class_instructions: "Perform the assigned integration work carefully.",
        step_instruction: instruction,
        inputs: overrides.inputs ?? {},
        declared_outputs: overrides.declared_outputs ?? [],
      },
      configuration: {
        model,
        reasoning: "medium",
        tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        workspace: {
          ref: "workspace:integration",
          root: workspace,
          access: "read_write",
        },
      },
      context: {
        mode: contextMode,
        source_occurrence_id: source,
        logical_lineage_id: logicalLineageId,
      },
    },
    action_id: actionId,
    run_id: overrides.run_id ?? "run-live",
    occurrence_id: occurrenceId,
    attempt_id: attemptId,
    semantic_step_key: semanticStepKey,
    instruction,
    inputs: overrides.inputs ?? {},
    declared_outputs: overrides.declared_outputs ?? [],
    context_requirement: { selector: contextMode, value: null },
    context_lineage_occurrence_id: source,
  };
}

function splitModel(value: string) {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1)
    throw new Error("QE_PI_MODEL must use provider/model syntax.");
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}
function artifact(type: string, occurrence: string, value: JsonValue) {
  return {
    id: `${occurrence}/artifact/${type}`,
    type,
    producer_occurrence_id: occurrence,
    value,
  };
}
function assertCompleted(subject: DispatchRegistry, actionId: string): void {
  const dispatch = subject.get(actionId);
  if (dispatch.state !== "completed")
    throw new Error(
      `${actionId} ended ${dispatch.state}: ${JSON.stringify(dispatch.failure)}`,
    );
}
function summary(subject: DispatchRegistry, actionId: string) {
  const dispatch = subject.get(actionId);
  const lineage = subject.getLineage(dispatch.lineageId as string);
  return {
    actionId,
    state: dispatch.state,
    outputs: dispatch.outputs,
    lineageId: lineage.lineageId,
    agentName: lineage.agentName,
    paneId: lineage.paneId,
    resultControlPath: lineage.resultControlPath,
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv.join(" ")} failed: ${stderr || stdout}`);
}
