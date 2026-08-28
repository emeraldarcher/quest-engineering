import type {
  AttachDescriptor,
  HostedAgent,
  HostedAgentStatus,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  SessionHost,
} from "../types.ts";
import type { HerdrControlClient } from "./client.ts";
import type { LocalHerdrConnectionProvider } from "./connection.ts";

export class HerdrSessionHost implements SessionHost {
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
    kind: "pi";
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

  async wait(
    target: string,
    options: { until?: HostedAgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HostedAgent> {
    const client = await this.client();
    try {
      return await client.wait(target, options);
    } finally {
      this.clients.delete(client);
    }
  }

  async getAgent(target: string): Promise<HostedAgent> {
    const client = await this.client();
    try {
      return await client.getAgent(target);
    } finally {
      this.clients.delete(client);
    }
  }

  attachInfo(ref: HostedExecutionRef): AttachDescriptor {
    return {
      kind: "herdr_cli",
      sessionName: ref.sessionName,
      agentName: ref.agentName,
      command: `herdr --session ${shellQuote(ref.sessionName)} agent attach ${shellQuote(ref.agentName)}`,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
