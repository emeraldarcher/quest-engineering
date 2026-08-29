import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type { ExecuteAction } from "../src/protocol/types.ts";
import { PiProvider } from "../src/providers/pi/provider.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";
import { HerdrSessionHost } from "../src/session-host/herdr/session-host.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";

if (process.argv[2] === "--child") {
  const config = JSON.parse(process.argv[3] as string) as WorkerConfig;
  const worktrees = new RunWorktreeRegistry(config);
  const recoveredWorktree = await worktrees.verify(
    "00000000-0000-4000-8000-000000000002",
  );
  if (recoveredWorktree.state !== "ready")
    throw new Error("Child could not recover the Run worktree.");
  worktrees.close();
  const registry = new DispatchRegistry(
    join(config.dataRoot, "dispatches.sqlite"),
    config.dataRoot,
  );
  const provider = new PiProvider(
    new HerdrSessionHost(new LocalHerdrConnectionProvider(config.herdrSession)),
    config,
  );
  const executor = new DispatchExecutor(registry, provider, async () => false);
  await executor.recoverAll();
  while (
    !["completed", "failed", "uncertain"].includes(
      registry.get("restart-action").state,
    )
  )
    await Bun.sleep(100);
  process.exit(registry.get("restart-action").state === "completed" ? 0 : 1);
}

const id = crypto.randomUUID().slice(0, 8);
const root = resolve(".pi/tmp", `worker-restart-${id}`);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await command(["git", "init", "-b", "main", workspace]);
await command([
  "git",
  "-C",
  workspace,
  "config",
  "user.name",
  "Quest Engineering Restart Integration",
]);
await command([
  "git",
  "-C",
  workspace,
  "config",
  "user.email",
  "restart@example.invalid",
]);
await Bun.write(join(workspace, "README.md"), "# Worker restart fixture\n");
await command(["git", "-C", workspace, "add", "README.md"]);
await command(["git", "-C", workspace, "commit", "-m", "fixture"]);
const configuredModel = process.env.QE_PI_MODEL?.trim();
if (!configuredModel)
  throw new Error(
    "QE_PI_MODEL=provider/model is required for the restart integration.",
  );
const separator = configuredModel.indexOf("/");
if (separator < 1 || separator === configuredModel.length - 1)
  throw new Error("QE_PI_MODEL must use provider/model syntax.");
const model = {
  provider: configuredModel.slice(0, separator),
  model: configuredModel.slice(separator + 1),
};

const config: WorkerConfig = {
  controlPlaneUrl: "ws://127.0.0.1/unused",
  workerId: `worker-restart-${id}`,
  workerToken: "unused",
  maxConcurrency: 1,
  tags: ["integration"],
  herdrSession: `qe-restart-${id}`,
  allowedRoots: [
    {
      key: "integration",
      path: root,
      max_access: "read_write",
      discover_depth: 2,
      allow_unconfined_shell: true,
    },
  ],
  workspaceBindings: [
    {
      binding_id: "00000000-0000-4000-8000-000000000003",
      workspace_id: "00000000-0000-4000-8000-000000000001",
      authorized_root_key: "integration",
      source_repository_root: workspace,
      max_access: "read_write",
      allow_unconfined_shell: true,
    },
  ],
  worktreeRoot: join(root, "worktrees"),
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
await mkdir(config.worktreeRoot, { recursive: true });
const worktrees = new RunWorktreeRegistry(config);
const runWorktree = await worktrees.provision({
  worktree_id: "00000000-0000-4000-8000-000000000002",
  run_id: "restart-run",
  workspace_id: "00000000-0000-4000-8000-000000000001",
  workspace_binding_id: "00000000-0000-4000-8000-000000000003",
  base: { kind: "binding_head_v1" },
  branch_name: "qe/run/00000000000040008000000000000002",
  identity_hash: "restart-run-worktree-v1",
});
if (runWorktree.state !== "ready")
  throw new Error(
    `Run worktree provisioning failed: ${runWorktree.failureCode}`,
  );
const executionRoot = runWorktree.canonicalRoot;
worktrees.close();

const instruction =
  'Use bash to run "sleep 20" first. After it finishes, create restart-proof.txt containing exactly "same Pi survived Worker restart" followed by a newline. Produce change_set describing the file.';
const action: ExecuteAction = {
  type: "execute_action",
  protocol_version: 4,
  worker_id: config.workerId,
  execution: {
    identity: {
      launch_id: "restart-launch",
      action_id: "restart-action",
      run_id: "restart-run",
      occurrence_id: "restart-occurrence",
      attempt_id: "restart-attempt",
      semantic_step_key: "implement",
    },
    performer: {
      member_key: "restart-member",
      member_name: "Restart Member",
      class_key: "integration",
      class_name: "Integration",
    },
    work: {
      quest_objective: "Prove one Pi survives Worker restart.",
      class_instructions: "Perform the restart proof safely.",
      step_instruction: instruction,
      inputs: {},
      declared_outputs: ["change_set"],
    },
    configuration: {
      model,
      reasoning: "medium",
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    logical_workspace: {
      workspace_id: "00000000-0000-4000-8000-000000000001",
      workspace_key: "restart",
    },
    execution_workspace: {
      worktree_id: "00000000-0000-4000-8000-000000000002",
      workspace_binding_id: "00000000-0000-4000-8000-000000000003",
      canonical_root: executionRoot,
      access: "read_write",
    },
    context: {
      mode: "fresh",
      source_occurrence_id: null,
      logical_lineage_id: "restart-logical-lineage",
    },
  },
  action_id: "restart-action",
  run_id: "restart-run",
  occurrence_id: "restart-occurrence",
  attempt_id: "restart-attempt",
  semantic_step_key: "implement",
  instruction,
  context_requirement: { selector: "fresh", value: null },
  context_lineage_occurrence_id: null,
  inputs: {},
  declared_outputs: ["change_set"],
};
let registry = new DispatchRegistry(
  join(config.dataRoot, "dispatches.sqlite"),
  config.dataRoot,
);
registry.accept(action);
registry.close();
const child = Bun.spawn(
  [process.execPath, import.meta.path, "--child", JSON.stringify(config)],
  { stdout: "pipe", stderr: "pipe" },
);
await waitForState(config, "running", 180_000);
registry = new DispatchRegistry(
  join(config.dataRoot, "dispatches.sqlite"),
  config.dataRoot,
);
const before = registry.get("restart-action");
const lineageBefore = registry.getLineage(before.lineageId as string);
registry.close();
const inspectionHost = new HerdrSessionHost(
  new LocalHerdrConnectionProvider(config.herdrSession),
);
const agentsBefore = (await inspectionHost.snapshot()).agents.filter(
  (agent) => agent.tokens?.qe_lineage_id === lineageBefore.lineageId,
);
if (agentsBefore.length !== 1 || agentsBefore[0]?.status !== "working")
  throw new Error("Pi was not working under Herdr before Worker termination.");
child.kill("SIGKILL");
await child.exited;

registry = new DispatchRegistry(
  join(config.dataRoot, "dispatches.sqlite"),
  config.dataRoot,
);
const provider = new PiProvider(inspectionHost, config);
const restarted = new DispatchExecutor(registry, provider, async () => false);
await restarted.recoverAll();
await waitRegistry(registry, "completed", 600_000);
const completed = registry.get("restart-action");
const lineageAfter = registry.getLineage(completed.lineageId as string);
const agentsAfter = (await inspectionHost.snapshot()).agents.filter(
  (agent) => agent.tokens?.qe_lineage_id === lineageBefore.lineageId,
);
if (agentsAfter.length !== 1)
  throw new Error(
    `Worker restart produced ${agentsAfter.length} Pi agents for one Action.`,
  );
if (
  lineageAfter.agentName !== lineageBefore.agentName ||
  lineageAfter.paneId !== lineageBefore.paneId
)
  throw new Error(
    "Worker restart did not preserve the exact Herdr/Pi execution.",
  );
if (
  (await Bun.file(join(executionRoot, "restart-proof.txt")).text()) !==
  "same Pi survived Worker restart\n"
)
  throw new Error("Recovered Pi did not finish the expected work.");
const proof = {
  ok: true,
  root,
  herdrSession: config.herdrSession,
  actionId: action.action_id,
  state: completed.state,
  sameLineage: lineageAfter.lineageId === lineageBefore.lineageId,
  sameAgent: lineageAfter.agentName === lineageBefore.agentName,
  samePane: lineageAfter.paneId === lineageBefore.paneId,
  agentsBefore: agentsBefore.length,
  agentsAfter: agentsAfter.length,
  outputs: completed.outputs,
  runWorkspace: executionRoot,
  baseRevision: runWorktree.baseRevision,
  branchName: runWorktree.branchName,
};
await Bun.write(
  join(root, "proof.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
);
console.log(JSON.stringify(proof, null, 2));
registry.close();
provider.disconnect();
process.exit(0);

async function waitForState(
  subject: WorkerConfig,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = new DispatchRegistry(
      join(subject.dataRoot, "dispatches.sqlite"),
      subject.dataRoot,
    );
    const state = current.get("restart-action").state;
    current.close();
    if (state === expected) return;
    if (["failed", "uncertain"].includes(state))
      throw new Error(`Initial Worker ended ${state}.`);
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${expected}.`);
}
async function waitRegistry(
  subject: DispatchRegistry,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = subject.get("restart-action").state;
    if (state === expected) return;
    if (["failed", "uncertain"].includes(state))
      throw new Error(
        `Restarted Worker ended ${state}: ${JSON.stringify(subject.get("restart-action").failure)}`,
      );
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${expected}.`);
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
