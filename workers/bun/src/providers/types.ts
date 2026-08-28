import type { DispatchRecord, ProviderLineage } from "../dispatch/registry.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
} from "../protocol/types.ts";
import type {
  AttachDescriptor,
  HostedAgent,
  HostedExecutionRef,
} from "../session-host/types.ts";

export interface ProviderPreparedExecution {
  lineage: ProviderLineage;
  ref: HostedExecutionRef;
  agent: HostedAgent;
}

export interface ProviderRecoveredExecution {
  found: boolean;
  agent?: HostedAgent;
  detail: string;
}

export interface ProviderAdoptionCandidate {
  action: ExecuteAction;
  lineage: ProviderLineage;
  state: Extract<LocalDispatchState, "accepted" | "running">;
  resultNonce: string;
  resultDirectory: string;
}

export interface AgentProvider {
  prepareFresh(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution>;
  prepareContinuation(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<ProviderPreparedExecution>;
  submitAndCollect(
    dispatch: DispatchRecord,
    execution: ProviderPreparedExecution,
    onRunning: () => void,
  ): Promise<Record<string, JsonValue>>;
  recover(lineage: ProviderLineage): Promise<ProviderRecoveredExecution>;
  waitAndCollect(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
    agent: HostedAgent,
  ): Promise<Record<string, JsonValue>>;
  clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<void>;
  discoverAdoptionCandidates(): Promise<ProviderAdoptionCandidate[]>;
  attachInfo(lineage: ProviderLineage): AttachDescriptor;
  disconnect(): void;
}
