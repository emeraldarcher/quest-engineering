import {
  type PromptInputFenceResult,
  validatePromptInputAuthority,
  validatePromptInputFence,
} from "../prompt-input-fence.ts";
import type {
  HostedAgent,
  HostedAgentStatus,
  HostedExecutionRef,
  HostedPane,
  HostedPaneProcessInfo,
  HostedSnapshot,
  InteractivePromptAuthority,
  InteractivePromptInput,
  SessionBackendReadiness,
  TerminalAttachmentDescriptor,
  TerminalSessionBackend,
} from "../types.ts";
import { HerdrApiError, type HerdrControlClient } from "./client.ts";
import type { LocalHerdrConnectionProvider } from "./connection.ts";

/** Herdr terminal/session transport. It contains no Pi lifecycle policy. */
export class HerdrTerminalBackend implements TerminalSessionBackend {
  readonly backendKind = "herdr";
  readonly sessionName: string;
  private clients = new Set<HerdrControlClient>();
  private snapshotGeneration = 0;
  private latestSnapshot: {
    scope: string;
    generation: number;
    value: HostedSnapshot;
  } | null = null;

  constructor(
    private readonly provider: LocalHerdrConnectionProvider,
    private readonly harnessKind = "pi",
  ) {
    this.sessionName = provider.sessionName;
  }

  sessionIncarnation(): string | null {
    return this.provider.sessionIncarnation();
  }

  readiness(): Promise<SessionBackendReadiness> {
    return this.provider.readiness(this.harnessKind);
  }

  async snapshot(): Promise<HostedSnapshot> {
    const scope = this.provider.sessionIncarnation() ?? "unowned";
    const generation = ++this.snapshotGeneration;
    let client: HerdrControlClient | null = null;
    try {
      client = await this.client();
      const value = await client.snapshot();
      if (
        this.latestSnapshot?.scope !== scope ||
        this.latestSnapshot.generation <= generation
      )
        this.latestSnapshot = { scope, generation, value };
      return value;
    } catch (error) {
      const newer =
        this.latestSnapshot?.scope === scope &&
        this.latestSnapshot.generation > generation
          ? this.latestSnapshot.value
          : null;
      if (newer) return newer;
      throw error;
    } finally {
      if (client) this.clients.delete(client);
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

  async reportAgentState(input: {
    paneId: string;
    agent: "pi" | "agy";
    source: "quest-engineering:sbx-pi" | "quest-engineering:sbx-antigravity";
    state: "idle" | "working" | "blocked";
    sequence: number;
    nativeSession?: import("../types.ts").NativeSessionRef;
  }): Promise<void> {
    const client = await this.client();
    try {
      await client.reportAgentState(input);
    } finally {
      this.clients.delete(client);
    }
  }

  async startAgent(input: {
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
    command?: import("../../execution-environment/types.ts").HostLaunchDescriptor;
    expectedTokens: Record<string, string>;
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

  async inspectPaneProcess(paneId: string): Promise<HostedPaneProcessInfo> {
    const client = await this.client();
    try {
      return await client.getPaneProcess(paneId);
    } finally {
      this.clients.delete(client);
    }
  }

  async stageInteractivePrompt(input: InteractivePromptInput): Promise<void> {
    const client = await this.client().catch(() => {
      throw observationError(
        "herdr_connection",
        "Automated pane input cannot establish its current Herdr connection.",
      );
    });
    try {
      await this.assertInteractivePromptAuthority(client, input.authority);
      await client.sendPaneText(input.authority.paneId, input.text);
    } finally {
      this.clients.delete(client);
    }
  }

  async submitInteractivePrompt(
    authority: InteractivePromptAuthority,
  ): Promise<void> {
    const client = await this.client();
    try {
      await this.assertInteractivePromptAuthority(client, authority);
      await client.sendPaneKeys(authority.paneId, ["enter"]);
    } finally {
      this.clients.delete(client);
    }
  }

  async closePane(paneId: string): Promise<void> {
    const client = await this.client();
    try {
      await client.closePane(paneId);
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
      localContextId: this.provider.localContextId(),
      // Pane identity survives Herdr 0.9 persistence even when its optional
      // custom agent name is no longer projected.
      paneId: ref.paneId,
      ...(ref.terminalId ? { terminalId: ref.terminalId } : {}),
      supportsObservation: true,
      supportsTakeover: true,
    };
  }

  disconnect(): void {
    for (const client of this.clients) client.disconnect();
    this.clients.clear();
    this.latestSnapshot = null;
  }

  private async assertInteractivePromptAuthority(
    client: HerdrControlClient,
    authority: InteractivePromptAuthority,
  ): Promise<void> {
    const authorityResult = validatePromptInputAuthority(authority);
    if (!authorityResult.ok)
      throw fenceError(
        "input_authority_invalid",
        "Automated pane input lacks complete Product authorization authority.",
        authorityResult,
      );
    const sessionIncarnation = this.sessionIncarnation();
    const staleSessionFields = [
      ...(authority.sessionName === this.sessionName
        ? []
        : ["herdr_session_name"]),
      ...(authority.sessionIncarnation === sessionIncarnation
        ? []
        : ["herdr_session_incarnation"]),
    ];
    if (staleSessionFields.length > 0)
      throw new HerdrApiError(
        "input_authority_stale",
        `Automated pane input targets a stale Herdr session incarnation (mismatch fields: ${staleSessionFields.join(", ")}).`,
        "terminal.authorized_prompt_input",
        { mismatchFields: staleSessionFields, sideEffect: "none" },
      );
    const readiness = await this.provider
      .readiness(this.harnessKind)
      .catch(() => {
        throw observationError(
          "herdr_readiness_observation",
          "Automated pane input cannot observe current Herdr readiness.",
        );
      });
    const staleFields = [
      ...(readiness.ready ? [] : ["herdr_backend_ready"]),
      ...(readiness.provenance.endpointGeneration ===
      authority.herdrEndpointGeneration
        ? []
        : ["herdr_endpoint_generation"]),
      ...(readiness.provenance.serverGeneration ===
      authority.herdrServerGeneration
        ? []
        : ["herdr_server_generation"]),
      ...(readiness.provenance.sessionIncarnation ===
      authority.sessionIncarnation
        ? []
        : ["herdr_readiness_session_incarnation"]),
    ];
    if (staleFields.length > 0)
      throw new HerdrApiError(
        "input_authority_stale",
        `Automated pane input targets another Herdr endpoint authority (mismatch fields: ${staleFields.join(", ")}).`,
        "terminal.authorized_prompt_input",
        { mismatchFields: staleFields, sideEffect: "none" },
      );

    // Name-targeted lookup proves the deterministic managed-agent binding even
    // when Herdr 0.9 omits its optional presentation name from the projection.
    const agentLookupTarget = authority.agentName;
    const agent = await client.getAgent(agentLookupTarget).catch(() => {
      throw observationError(
        "managed_agent_lookup_target",
        "Automated pane input cannot resolve the exact managed Antigravity agent.",
      );
    });
    const process = await client.getPaneProcess(authority.paneId).catch(() => {
      throw observationError(
        "pane_process_observation",
        "Automated pane input cannot inspect the exact managed Antigravity process.",
      );
    });
    const fence = validatePromptInputFence(authority, {
      sessionName: this.sessionName,
      sessionIncarnation,
      readiness,
      agentLookupTarget,
      agent,
      process,
    });
    if (!fence.ok)
      throw fenceError(
        "input_authority_mismatch",
        "Automated pane input does not match the exact managed Antigravity execution.",
        fence,
      );
  }

  private async client(): Promise<HerdrControlClient> {
    const connection = await this.provider.connect(this.harnessKind);
    this.clients.add(connection.client);
    return connection.client;
  }
}

function observationError(field: string, message: string): HerdrApiError {
  return new HerdrApiError(
    "input_authority_mismatch",
    `${message} Mismatch fields: ${field}.`,
    "terminal.authorized_prompt_input",
    { mismatchFields: [field], sideEffect: "none" },
  );
}

function fenceError(
  code: string,
  message: string,
  result: PromptInputFenceResult,
): HerdrApiError {
  return new HerdrApiError(
    code,
    `${message} Mismatch fields: ${result.mismatchFields.join(", ")}.`,
    "terminal.authorized_prompt_input",
    { mismatchFields: result.mismatchFields, sideEffect: "none" },
  );
}
