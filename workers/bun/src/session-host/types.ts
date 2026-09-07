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
  workspaces: Array<{ workspaceId: string; label?: string }>;
  panes: HostedPane[];
  agents: HostedAgent[];
}
export interface HostedExecutionRef {
  sessionName: string;
  workspaceId: string;
  tabId?: string;
  paneId: string;
  terminalId?: string;
  agentName: string;
  nativeSession?: NativeSessionRef;
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
  startAgent(input: {
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
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
  sendKeys(target: string, keys: string[]): Promise<void>;
  attachment(ref: HostedExecutionRef): TerminalAttachmentDescriptor;
  disconnect(): void;
}
