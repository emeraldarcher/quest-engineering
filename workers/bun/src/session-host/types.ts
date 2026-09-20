export type HostedAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";
export interface NativeSessionRef {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}
export interface HostedAgent {
  name?: string;
  agent: string;
  status: HostedAgentStatus;
  paneId: string;
  terminalId?: string;
  workspaceId: string;
  tabId?: string;
  cwd?: string;
  foregroundCwd?: string;
  interactiveReady?: boolean;
  /** Herdr accepted launch, but the native agent is not yet materialized. */
  launchPending?: boolean;
  /** The native integration kind came from Herdr, rather than QE inference. */
  nativeMaterialized?: boolean;
  nativeSession?: NativeSessionRef;
  statusSource?: string;
  message?: string;
  tokens?: Record<string, string>;
}
export interface HostedPane {
  paneId: string;
  terminalId?: string;
  workspaceId: string;
  tabId: string;
  cwd?: string;
  foregroundCwd?: string;
}
export interface HostedSnapshot {
  workspaces: Array<{
    workspaceId: string;
    label?: string;
    tokens?: Record<string, string>;
  }>;
  panes: HostedPane[];
  agents: HostedAgent[];
}
export interface HostedExecutionRef {
  sessionName: string;
  /** QE physical identity; distinct from the Herdr socket/server generation. */
  sessionIncarnation?: string;
  workspaceId: string;
  tabId?: string;
  paneId: string;
  terminalId?: string;
  agentName: string;
  nativeSession?: NativeSessionRef;
}

export type SessionBackendReadinessStatus =
  | "ready"
  | "unavailable"
  | "incompatible";

export interface SessionBackendDiagnostic {
  code:
    | "backend_unavailable"
    | "wire_incompatible"
    | "endpoint_generation_unsupported"
    | "missing_capability"
    | "malformed_contract"
    | "ownership_conflict"
    | "newer_than_tested_but_compatible";
  message: string;
  capability?: string;
}

export interface SessionBackendReadiness {
  backendKind: string;
  harnessKind: string;
  status: SessionBackendReadinessStatus;
  ready: boolean;
  capabilities: string[];
  missingCapabilities: string[];
  diagnostics: SessionBackendDiagnostic[];
  provenance: {
    version?: string;
    protocol?: number;
    testedProtocol?: number;
    endpointGeneration?: number;
    serverGeneration?: string;
    sessionIncarnation?: string;
  };
}

/** Transport-neutral descriptor persisted/projected by the Worker. */
export interface TerminalAttachmentDescriptor {
  mode: "local_native_terminal";
  backendKind: "herdr" | (string & {});
  terminalSessionId: string;
  terminalTargetId: string;
  terminalId?: string;
  supportsObservation: boolean;
  supportsTakeover: boolean;
}

/**
 * Terminal/session transport contract. Implementations know terminal topology,
 * persistence and transport lifecycle, but not Pi prompts or QE semantics.
 */
export interface TerminalSessionBackend {
  readonly backendKind: string;
  readonly sessionName: string;
  /** Current QE physical session identity, or null before infrastructure ensure. */
  sessionIncarnation(): string | null;
  /** Side-effect-free readiness for the backend contract used by this harness. */
  readiness(): Promise<SessionBackendReadiness>;
  snapshot(): Promise<HostedSnapshot>;
  createWorkspace(input: {
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane>;
  createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane>;
  reportMetadata(input: {
    paneId: string;
    title: string;
    tokens: Record<string, string>;
  }): Promise<void>;
  /** Report guest-native Pi lifecycle through the host-owned Herdr socket. */
  reportAgentState?(input: {
    paneId: string;
    state: "idle" | "working" | "blocked";
    sequence: number;
    nativeSession?: NativeSessionRef;
  }): Promise<void>;
  startAgent(input: {
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
    expectedTokens: Record<string, string>;
  }): Promise<HostedAgent>;
  prompt(
    target: string,
    text: string,
    options?: { until?: HostedAgentStatus[]; timeoutMs?: number },
  ): Promise<HostedAgent>;
  /** Observe an actual terminal-agent state transition from the backend. */
  observeAgentState(
    target: string,
    options?: { until?: HostedAgentStatus[]; timeoutMs?: number },
  ): Promise<HostedAgent>;
  /** Inspect the backend's current authoritative terminal-agent state. */
  inspectAgentState(target: string): Promise<HostedAgent>;
  /** Close exactly one owned pane, terminating its child process without terminal input. */
  closePane(paneId: string): Promise<void>;
  sendKeys(target: string, keys: string[]): Promise<void>;
  attachment(ref: HostedExecutionRef): TerminalAttachmentDescriptor;
  disconnect(): void;
}
