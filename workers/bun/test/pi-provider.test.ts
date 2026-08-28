import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { PiProvider } from "../src/providers/pi/provider.ts";
import { writeControlAtomic } from "../src/providers/pi/result-envelope.ts";
import type {
  AttachDescriptor,
  HostedAgent,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  SessionHost,
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
    process.cwd(),
    "src",
    "providers",
    "pi",
    "step-result-extension.ts",
  );
  const provider = new PiProvider(host, config(root), {
    integrationPath: extension,
    resultExtensionPath: extension,
  });
  return { root, registry, host, provider };
}

test("adopts safe Herdr provenance when a local dispatch row is missing", async () => {
  const { root, registry, provider } = await fixture();
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await provider.prepareFresh(dispatch, lineage);
  registry.recordHost(lineage.lineageId, {
    herdrSession: prepared.ref.sessionName,
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

test("fresh Actions create distinct Pi agents while continuation reuses the original", async () => {
  const { registry, host, provider } = await fixture();
  const first = registry.accept(action()).dispatch;
  const firstLineage = registry.getLineage(first.lineageId as string);
  const started = await provider.prepareFresh(first, firstLineage);
  registry.recordHost(firstLineage.lineageId, {
    herdrSession: started.ref.sessionName,
    workspaceId: started.ref.workspaceId,
    ...(started.ref.tabId ? { tabId: started.ref.tabId } : {}),
    paneId: started.ref.paneId,
    ...(started.ref.terminalId ? { terminalId: started.ref.terminalId } : {}),
    agentName: started.ref.agentName,
  });
  registry.complete(first.action.action_id, { change_set: {} });
  expect(
    provider.attachInfo(registry.getLineage(firstLineage.lineageId)).command,
  ).toContain("agent attach");

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
  await provider.prepareFresh(
    review,
    registry.getLineage(review.lineageId as string),
  );

  const repair = registry.accept(
    action({
      action_id: "repair",
      occurrence_id: "repair-occurrence",
      attempt_id: "repair-attempt",
      semantic_step_key: "repair",
      instruction: "Repair findings.",
      context_requirement: { selector: "continue_from", value: "implement" },
      context_lineage_occurrence_id: first.action.occurrence_id,
    }),
  ).dispatch;
  const source = registry.resolveContinuation(first.action.occurrence_id);
  registry.assignLineage(repair.action.action_id, source.lineageId);
  const repairedDispatch = registry.get(repair.action.action_id);
  const repairedLineage = registry.getLineage(source.lineageId);
  await provider.prepareContinuation(repairedDispatch, repairedLineage);
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

class FakeHost implements SessionHost {
  readonly sessionName = "test-herdr";
  readonly startedNames: string[] = [];
  readonly metadata: Array<{ paneId: string; tokens: Record<string, string> }> =
    [];
  private workspaceCreated = false;
  private panes: HostedPane[] = [];
  private agents: HostedAgent[] = [];
  constructor(private readonly cwd: string) {}
  async snapshot(): Promise<HostedSnapshot> {
    return {
      workspaces: this.workspaceCreated ? [{ workspaceId: "workspace" }] : [],
      panes: this.panes,
      agents: this.agents,
    };
  }
  async createWorkspace(): Promise<HostedPane> {
    this.workspaceCreated = true;
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
  async prompt(): Promise<HostedAgent> {
    throw new Error("not used");
  }
  async wait(): Promise<HostedAgent> {
    throw new Error("not used");
  }
  async getAgent(target: string): Promise<HostedAgent> {
    return this.agents.find(
      (item) => item.name === target || item.paneId === target,
    ) as HostedAgent;
  }
  attachInfo(ref: HostedExecutionRef): AttachDescriptor {
    return {
      kind: "herdr_cli",
      sessionName: this.sessionName,
      agentName: ref.agentName,
      command: `herdr --session ${this.sessionName} agent attach ${ref.agentName}`,
    };
  }
  disconnect(): void {}
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

function config(root: string): WorkerConfig {
  return {
    controlPlaneUrl: "ws://localhost/worker/websocket",
    workerId: "worker-test",
    workerToken: "token",
    maxConcurrency: 1,
    tags: [],
    herdrSession: "test-herdr",
    workspaceRoot: join(root, "workspace"),
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
