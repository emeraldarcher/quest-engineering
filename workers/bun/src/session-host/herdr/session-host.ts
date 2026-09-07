import type {
  HostedAgent,
  HostedAgentStatus,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  TerminalAttachmentDescriptor,
  TerminalSessionBackend,
} from "../types.ts";
import type { HerdrControlClient } from "./client.ts";
import type { LocalHerdrConnectionProvider } from "./connection.ts";

/** Herdr terminal/session transport. It contains no Pi lifecycle policy. */
export class HerdrTerminalBackend implements TerminalSessionBackend {
  readonly backendKind = "herdr";
  readonly sessionName: string;
  private clients = new Set<HerdrControlClient>();

  constructor(private readonly provider: LocalHerdrConnectionProvider) {
    this.sessionName = provider.sessionName;
  }

  async snapshot(): Promise<HostedSnapshot> {
    const client = await this.client();
    try {
      return await client.snapshot();
    } finally {
      this.clients.delete(client);
    }
  }

  async createWorkspace(input: {
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane> {
    const client = await this.client();
    try {
      const pane = await client.createWorkspace({
        cwd: input.cwd,
        label: input.label,
        env: input.environment,
      });
      await client.renameTab({ tabId: pane.tabId, label: "Worker" });
      return pane;
    } finally {
      this.clients.delete(client);
    }
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane> {
    const client = await this.client();
    try {
      return await client.createTab({
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        label: input.label,
        env: input.environment,
      });
    } finally {
      this.clients.delete(client);
    }
  }

  async reportMetadata(input: {
    paneId: string;
    title: string;
    tokens: Record<string, string>;
  }): Promise<void> {
    const client = await this.client();
    try {
      await client.reportPaneMetadata({
        paneId: input.paneId,
        title: input.title,
        displayAgent: input.title,
        tokens: input.tokens,
      });
    } finally {
      this.clients.delete(client);
    }
  }

  async startAgent(input: {
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
  }): Promise<HostedAgent> {
    const client = await this.client();
    try {
      return await client.startAgent({ ...input, timeoutMs: 90_000 });
    } finally {
      this.clients.delete(client);
    }
  }

  async prompt(
    target: string,
    text: string,
    options: { until?: HostedAgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HostedAgent> {
    const client = await this.client();
    try {
      return await client.prompt(target, text, options);
    } finally {
      this.clients.delete(client);
    }
  }

  async observeAgentState(
    target: string,
    options: { until?: HostedAgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HostedAgent> {
    const client = await this.client();
    try {
      // Herdr's agent.wait result is the terminal-agent state authority.
      return await client.wait(target, options);
    } finally {
      this.clients.delete(client);
    }
  }

  async inspectAgentState(target: string): Promise<HostedAgent> {
    const client = await this.client();
    try {
      // Herdr's agent.get result is the point-in-time state authority.
      return await client.getAgent(target);
    } finally {
      this.clients.delete(client);
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    const client = await this.client();
    try {
      await client.sendKeys(target, keys);
    } finally {
      this.clients.delete(client);
    }
  }

  attachment(ref: HostedExecutionRef): TerminalAttachmentDescriptor {
    return {
      mode: "local_native_terminal",
      backendKind: "herdr",
      terminalSessionId: ref.sessionName,
      terminalTargetId: ref.agentName,
      ...(ref.terminalId ? { terminalId: ref.terminalId } : {}),
      supportsObservation: true,
      supportsTakeover: true,
    };
  }

  disconnect(): void {
    for (const client of this.clients) client.disconnect();
    this.clients.clear();
  }

  private async client(): Promise<HerdrControlClient> {
    const connection = await this.provider.connect();
    this.clients.add(connection.client);
    return connection.client;
  }
}
