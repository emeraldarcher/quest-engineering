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
export interface AttachDescriptor {
  kind: "herdr_cli";
  sessionName: string;
  agentName: string;
  command: string;
}
export interface SessionHost {
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
    kind: "pi";
    args: string[];
  }): Promise<HostedAgent>;
  prompt(
    target: string,
    text: string,
    options?: { until?: HostedAgentStatus[]; timeoutMs?: number },
  ): Promise<HostedAgent>;
  wait(
    target: string,
    options?: { until?: HostedAgentStatus[]; timeoutMs?: number },
  ): Promise<HostedAgent>;
  getAgent(target: string): Promise<HostedAgent>;
  attachInfo(ref: HostedExecutionRef): AttachDescriptor;
  disconnect(): void;
}
