import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
  type ProviderLineage,
} from "../src/dispatch/registry.ts";
import type { JsonValue, ReconcileDispatch } from "../src/protocol/types.ts";
import type {
  AgentProvider,
  ProviderPreparedExecution,
} from "../src/providers/types.ts";
import type { HostedAgent } from "../src/session-host/types.ts";
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
  const root = await mkdtemp(join(parent, "bun-worker-executor-"));
  roots.push(root);
  return { root, database: join(root, "state.sqlite") };
}

test("acceptance and completion are durable before external side effects and reporting", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const provider = new InspectingProvider(registry);
  let completionReported = false;
  const executor = new DispatchExecutor(
    registry,
    provider,
    async (payload, type) => {
      if (type === "step_completed") {
        completionReported = true;
        const persisted = registry.get(payload.action_id);
        expect(persisted.state).toBe("completed");
        expect(persisted.serverAcknowledgedAt).toBeNull();
        expect(
          registry.getLineage(persisted.lineageId as string).activeActionId,
        ).toBeNull();
      }
      return false;
    },
  );
  const accepted = executor.accept(action());
  await Promise.all([
    executor.start(accepted.dispatch.action.action_id),
    executor.start(accepted.dispatch.action.action_id),
  ]);
  expect(provider.starts).toBe(1);
  expect(provider.sawDurableAcceptance).toBe(true);
  expect(completionReported).toBe(true);
  expect(registry.get("action-1").serverAcknowledgedAt).toBeNull();
  registry.close();

  const restarted = new DispatchRegistry(database, root);
  let resent: ReconcileDispatch | null = null;
  const recovery = new DispatchExecutor(
    restarted,
    new InspectingProvider(restarted),
    async (payload, type) => {
      if (type === "step_completed") resent = payload;
      return true;
    },
  );
  await recovery.start("action-1");
  expect(resent).toMatchObject({
    action_id: "action-1",
    outputs: { change_set: { version: 1 } },
  });
  expect(restarted.get("action-1").serverAcknowledgedAt).not.toBeNull();
  restarted.close();
});

class InspectingProvider implements AgentProvider {
  starts = 0;
  sawDurableAcceptance = false;
  constructor(private readonly registry: DispatchRegistry) {}
  async prepareFresh(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution> {
    this.starts += 1;
    this.sawDurableAcceptance =
      this.registry.get(dispatch.action.action_id).state === "accepted";
    return prepared(lineage);
  }
  async prepareContinuation(
    _dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution> {
    return prepared(lineage);
  }
  async submitAndCollect(
    _dispatch: DispatchRecord,
    _execution: ProviderPreparedExecution,
    onRunning: () => void,
  ): Promise<Record<string, JsonValue>> {
    onRunning();
    return { change_set: { version: 1 } };
  }
  async recover() {
    return { found: false, detail: "not used" };
  }
  async waitAndCollect() {
    return { change_set: { version: 1 } };
  }
  async clearActiveMetadata() {}
  async discoverAdoptionCandidates() {
    return [];
  }
  attachInfo(lineage: ProviderLineage) {
    return {
      kind: "herdr_cli" as const,
      sessionName: "fake",
      agentName: lineage.lineageId,
      command: "attach",
    };
  }
  disconnect() {}
}
function prepared(lineage: ProviderLineage): ProviderPreparedExecution {
  const agent: HostedAgent = {
    name: lineage.lineageId,
    agent: "pi",
    status: "idle",
    paneId: "pane",
    terminalId: "terminal",
    workspaceId: "workspace",
    tabId: "tab",
  };
  return {
    lineage,
    ref: {
      sessionName: "fake",
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      agentName: lineage.lineageId,
    },
    agent,
  };
}
