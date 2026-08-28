import type {
  DispatchRecord,
  ProviderLineage,
} from "../../dispatch/registry.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type { HostedAgent } from "../../session-host/types.ts";
import type {
  AgentProvider,
  ProviderPreparedExecution,
  ProviderRecoveredExecution,
} from "../types.ts";

/** Deterministic protocol-test provider. Never enabled without QE_ENABLE_TEST_PROVIDER=1. */
export class FakeAgentProvider implements AgentProvider {
  private readonly outputs: Record<string, JsonValue>;
  private readonly delayMs: number;

  constructor(outputs: Record<string, JsonValue> = {}, delayMs = 0) {
    this.outputs = outputs;
    this.delayMs = delayMs;
  }

  async prepareFresh(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution> {
    return prepared(dispatch, lineage);
  }

  async prepareContinuation(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution> {
    return prepared(dispatch, lineage);
  }

  async submitAndCollect(
    dispatch: DispatchRecord,
    _execution: ProviderPreparedExecution,
    onRunning: () => void,
  ): Promise<Record<string, JsonValue>> {
    onRunning();
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return Object.fromEntries(
      dispatch.action.declared_outputs.map((key) => [
        key,
        this.outputs[key] ?? {},
      ]),
    );
  }

  async recover(
    _lineage: ProviderLineage,
  ): Promise<ProviderRecoveredExecution> {
    return {
      found: true,
      agent: fakeAgent(),
      detail: "Fake provider execution recovered.",
    };
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    _lineage: ProviderLineage,
    _agent: HostedAgent,
  ): Promise<Record<string, JsonValue>> {
    return Object.fromEntries(
      dispatch.action.declared_outputs.map((key) => [
        key,
        this.outputs[key] ?? {},
      ]),
    );
  }

  async clearActiveMetadata(): Promise<void> {}
  async discoverAdoptionCandidates() {
    return [];
  }
  attachInfo(lineage: ProviderLineage) {
    return {
      kind: "herdr_cli" as const,
      sessionName: "fake",
      agentName: `fake-${lineage.lineageId}`,
      command: "fake attach",
    };
  }
  disconnect(): void {}
}

function prepared(
  _dispatch: DispatchRecord,
  lineage: ProviderLineage,
): ProviderPreparedExecution {
  const agent = fakeAgent(lineage.lineageId);
  return {
    lineage,
    ref: {
      sessionName: "fake",
      workspaceId: "fake-workspace",
      tabId: `fake-tab-${lineage.lineageId}`,
      paneId: agent.paneId,
      ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
      agentName: agent.name as string,
    },
    agent,
  };
}
function fakeAgent(lineageId = "recovered"): HostedAgent {
  return {
    name: `fake-${lineageId}`,
    agent: "pi",
    status: "done",
    paneId: `fake-pane-${lineageId}`,
    terminalId: `fake-terminal-${lineageId}`,
    workspaceId: "fake-workspace",
    tabId: `fake-tab-${lineageId}`,
    interactiveReady: true,
  };
}
