import { createHash } from "node:crypto";
import { paneProcessIdentityDigest } from "../pane-process-identity.ts";
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
    const client = await this.client();
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
    const requiredStrings: Array<keyof InteractivePromptAuthority> = [
      "workerId",
      "questLaunchId",
      "runId",
      "actionId",
      "occurrenceId",
      "attemptId",
      "physicalLineageId",
      "environmentId",
      "environmentIncarnation",
      "herdrServerGeneration",
      "sessionName",
      "sessionIncarnation",
      "workspaceId",
      "tabId",
      "paneId",
      "terminalId",
      "agentName",
      "paneProcessIdentityDigest",
      "ownershipToken",
      "resultNonce",
      "promptAuthorizedAt",
      "promptIntentAt",
    ];
    if (
      requiredStrings.some(
        (key) =>
          typeof authority[key] !== "string" ||
          (authority[key] as string).length === 0,
      ) ||
      !Number.isSafeInteger(authority.herdrEndpointGeneration) ||
      authority.herdrEndpointGeneration < 1 ||
      !Number.isSafeInteger(authority.paneShellPid) ||
      authority.paneShellPid < 1 ||
      !Number.isSafeInteger(authority.paneForegroundProcessGroupId) ||
      authority.paneForegroundProcessGroupId < 1 ||
      !Number.isFinite(Date.parse(authority.promptAuthorizedAt)) ||
      !Number.isFinite(Date.parse(authority.promptIntentAt)) ||
      Date.parse(authority.promptIntentAt) <
        Date.parse(authority.promptAuthorizedAt)
    )
      throw new HerdrApiError(
        "input_authority_invalid",
        "Automated pane input lacks complete Product authorization authority.",
        "terminal.authorized_prompt_input",
      );
    if (
      authority.sessionName !== this.sessionName ||
      authority.sessionIncarnation !== this.sessionIncarnation()
    )
      throw new HerdrApiError(
        "input_authority_stale",
        "Automated pane input targets a stale Herdr session incarnation.",
        "terminal.authorized_prompt_input",
      );
    const readiness = await this.provider.readiness(this.harnessKind);
    if (
      !readiness.ready ||
      readiness.provenance.endpointGeneration !==
        authority.herdrEndpointGeneration ||
      readiness.provenance.serverGeneration !==
        authority.herdrServerGeneration ||
      readiness.provenance.sessionIncarnation !== authority.sessionIncarnation
    )
      throw new HerdrApiError(
        "input_authority_stale",
        "Automated pane input targets another Herdr endpoint generation.",
        "terminal.authorized_prompt_input",
      );
    const agent = await client.getAgent(authority.paneId);
    const tokens = agent.tokens ?? {};
    const expectedTokens: Record<string, string> = {
      qe_owner: "quest-engineering-worker/v1",
      qe_worker_id: authority.workerId,
      qe_launch_id: authority.questLaunchId,
      qe_run_id: authority.runId,
      qe_lineage_id: authority.physicalLineageId,
      qe_harness_kind: "antigravity",
      qe_agent_name: authority.agentName,
      qe_ownership_token: authority.ownershipToken,
      qe_session_incarnation: authority.sessionIncarnation,
      qe_environment_hash: identityHash(
        `${authority.environmentId}\0${authority.environmentIncarnation}`,
      ),
      qe_active_state: "active",
      qe_active_action_id: authority.actionId,
      qe_action_hash: identityHash(authority.actionId),
      qe_occurrence_hash: identityHash(authority.occurrenceId),
      qe_attempt_hash: identityHash(authority.attemptId),
      qe_result_nonce: authority.resultNonce,
    };
    if (
      agent.agent !== "agy" ||
      agent.name !== authority.agentName ||
      agent.status !== "idle" ||
      agent.interactiveReady !== true ||
      agent.launchPending === true ||
      agent.nativeMaterialized !== true ||
      agent.workspaceId !== authority.workspaceId ||
      agent.tabId !== authority.tabId ||
      agent.paneId !== authority.paneId ||
      agent.terminalId !== authority.terminalId ||
      Object.entries(expectedTokens).some(
        ([key, value]) => tokens[key] !== value,
      )
    )
      throw new HerdrApiError(
        "input_authority_mismatch",
        "Automated pane input does not match the exact managed Antigravity execution.",
        "terminal.authorized_prompt_input",
      );
    const process = await client.getPaneProcess(authority.paneId);
    if (
      process.shellPid !== authority.paneShellPid ||
      process.foregroundProcessGroupId !==
        authority.paneForegroundProcessGroupId ||
      paneProcessIdentityDigest(process) !== authority.paneProcessIdentityDigest
    )
      throw new HerdrApiError(
        "input_authority_mismatch",
        "Automated pane input does not match the preauthorized Antigravity process identity.",
        "terminal.authorized_prompt_input",
      );
  }

  private async client(): Promise<HerdrControlClient> {
    const connection = await this.provider.connect(this.harnessKind);
    this.clients.add(connection.client);
    return connection.client;
  }
}

function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
