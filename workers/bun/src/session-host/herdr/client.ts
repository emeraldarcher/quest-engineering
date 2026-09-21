import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { HostLaunchDescriptor } from "../../execution-environment/types.ts";
import type {
  HostedAgent,
  HostedAgentStatus,
  HostedPane,
  HostedSnapshot,
  NativeSessionRef,
} from "../types.ts";
import type { HerdrIntegrationEvidence } from "./compatibility.ts";

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly capability?: string,
  ) {
    super(message);
  }
}

export interface HerdrPing {
  version: string;
  protocol: number;
  endpointGeneration: number;
  agentExplicitLaunch?: boolean;
}

export interface AgentLaunchInput {
  paneId: string;
  name: string;
  integrationKind: string;
  args: string[];
  /** Exact host process transport. Herdr must not resolve this through PATH. */
  command?: HostLaunchDescriptor;
  /** Stable QE ownership fields expected on the materialized native agent. */
  expectedTokens: Record<string, string>;
  timeoutMs?: number;
}

export interface HerdrControlClient {
  ping(): Promise<HerdrPing>;
  integrations(): Promise<HerdrIntegrationEvidence[]>;
  snapshot(): Promise<HostedSnapshot>;
  reportWorkspaceMetadata(input: {
    workspaceId: string;
    source: string;
    tokens: Record<string, string>;
  }): Promise<void>;
  createWorkspace(input: {
    cwd: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<HostedPane>;
  createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<HostedPane>;
  renameTab(input: { tabId: string; label: string }): Promise<void>;
  reportPaneMetadata(input: {
    paneId: string;
    title?: string;
    displayAgent?: string;
    tokens?: Record<string, string>;
  }): Promise<void>;
  reportAgentState(input: {
    paneId: string;
    state: "idle" | "working" | "blocked";
    sequence: number;
    nativeSession?: NativeSessionRef;
  }): Promise<void>;
  startAgent(input: AgentLaunchInput): Promise<HostedAgent>;
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
  closePane(paneId: string): Promise<void>;
  sendKeys(target: string, keys: string[]): Promise<void>;
  disconnect(): void;
}

interface Message {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

type AgentLaunchObservation =
  | { state: "absent" }
  | { state: "ambiguous" }
  | { state: "pending"; agent: HostedAgent }
  | { state: "materialized"; agent: HostedAgent };

export class HerdrSocketClient implements HerdrControlClient {
  private readonly sockets = new Set<Socket>();
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 30_000,
    private readonly onUnavailable: () => void = () => undefined,
  ) {}

  disconnect(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async ping(): Promise<HerdrPing> {
    const result = await this.request("ping");
    const capabilities = object(
      result.capabilities,
      "ping.capabilities",
      "backend.health",
    );
    return {
      version: string(
        result.version,
        "ping.version",
        "backend.server_identity",
      ),
      protocol: integer(
        result.protocol,
        "ping.protocol",
        "backend.server_identity",
      ),
      endpointGeneration: integer(
        capabilities.endpoint_protocol_generation,
        "ping.capabilities.endpoint_protocol_generation",
        "backend.endpoint_generation_1",
      ),
      agentExplicitLaunch: capabilities.agent_explicit_launch === true,
    };
  }

  async integrations(): Promise<HerdrIntegrationEvidence[]> {
    const result = await this.request("integration.list");
    return integrationArray(result.integrations).flatMap((item) => {
      if (typeof item.target !== "string" || !item.target) return [];
      const relevant = ["pi", "antigravity_cli"].includes(item.target);
      const malformed =
        typeof item.available !== "boolean" || typeof item.state !== "string";
      return [
        {
          target: item.target,
          ...(typeof item.available === "boolean"
            ? { available: item.available }
            : {}),
          ...(typeof item.state === "string" ? { state: item.state } : {}),
          ...(relevant && malformed ? { malformed: true } : {}),
        },
      ];
    });
  }

  async snapshot(): Promise<HostedSnapshot> {
    const result = await this.request("session.snapshot");
    const snapshot = object(
      result.snapshot ?? result,
      "snapshot",
      "session.snapshot_decoding",
    );
    return {
      workspaces: strictArray(snapshot.workspaces, "snapshot.workspaces").map(
        (item) => {
          const label = optionalString(item.label, "workspace.label");
          const tokens =
            item.tokens === undefined || item.tokens === null
              ? undefined
              : stringRecord(
                  object(
                    item.tokens,
                    "workspace.tokens",
                    "session.snapshot_decoding",
                  ),
                  "session.snapshot_decoding",
                );
          return {
            workspaceId: string(
              item.workspace_id,
              "workspace_id",
              "session.snapshot_decoding",
            ),
            ...(label ? { label } : {}),
            ...(tokens ? { tokens } : {}),
          };
        },
      ),
      panes: strictArray(snapshot.panes, "snapshot.panes").map(mapPane),
      agents: strictArray(snapshot.agents, "snapshot.agents").map(
        mapSnapshotAgent,
      ),
    };
  }

  async reportWorkspaceMetadata(input: {
    workspaceId: string;
    source: string;
    tokens: Record<string, string>;
  }): Promise<void> {
    await this.request("workspace.report_metadata", {
      workspace_id: input.workspaceId,
      source: input.source,
      tokens: input.tokens,
    });
  }

  async createWorkspace(input: {
    cwd: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<HostedPane> {
    const result = await this.request("workspace.create", {
      cwd: input.cwd,
      label: input.label,
      focus: false,
      env: input.env ?? {},
    });
    const workspace = object(
      result.workspace,
      "workspace",
      "terminal.topology",
    );
    const tab = object(result.tab, "tab", "terminal.topology");
    const pane = object(result.root_pane, "root_pane", "terminal.topology");
    const terminalId = optionalString(
      pane.terminal_id,
      "root_pane.terminal_id",
      "terminal.topology",
    );
    return {
      workspaceId: string(
        workspace.workspace_id,
        "workspace_id",
        "terminal.topology",
      ),
      tabId: string(tab.tab_id, "tab_id", "terminal.topology"),
      paneId: string(pane.pane_id, "pane_id", "terminal.topology"),
      ...(terminalId ? { terminalId } : {}),
      cwd: input.cwd,
    };
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<HostedPane> {
    const result = await this.request("tab.create", {
      workspace_id: input.workspaceId,
      cwd: input.cwd,
      label: input.label,
      focus: false,
      env: input.env ?? {},
    });
    const tab = object(result.tab, "tab", "terminal.topology");
    const pane = object(result.root_pane, "root_pane", "terminal.topology");
    const terminalId = optionalString(
      pane.terminal_id,
      "root_pane.terminal_id",
      "terminal.topology",
    );
    return {
      workspaceId: input.workspaceId,
      tabId: string(tab.tab_id, "tab_id", "terminal.topology"),
      paneId: string(pane.pane_id, "pane_id", "terminal.topology"),
      ...(terminalId ? { terminalId } : {}),
      cwd: input.cwd,
    };
  }

  async renameTab(input: { tabId: string; label: string }): Promise<void> {
    await this.request("tab.rename", {
      tab_id: input.tabId,
      label: input.label,
    });
  }

  async reportPaneMetadata(input: {
    paneId: string;
    title?: string;
    displayAgent?: string;
    tokens?: Record<string, string>;
  }): Promise<void> {
    await this.request("pane.report_metadata", {
      pane_id: input.paneId,
      source: "quest-engineering-worker",
      ...(input.title ? { title: input.title } : {}),
      ...(input.displayAgent ? { display_agent: input.displayAgent } : {}),
      ...(input.tokens ? { tokens: input.tokens } : {}),
    });
  }

  async reportAgentState(input: {
    paneId: string;
    state: "idle" | "working" | "blocked";
    sequence: number;
    nativeSession?: NativeSessionRef;
  }): Promise<void> {
    const session = input.nativeSession;
    if (session)
      await this.request("pane.report_agent_session", {
        pane_id: input.paneId,
        source: "quest-engineering:sbx-pi",
        agent: "pi",
        seq: input.sequence * 2,
        ...(session.kind === "path"
          ? { agent_session_path: session.value }
          : { agent_session_id: session.value }),
      });
    await this.request("pane.report_agent", {
      pane_id: input.paneId,
      source: "quest-engineering:sbx-pi",
      agent: "pi",
      state: input.state,
      seq: input.sequence * 2 + 1,
      ...(session?.kind === "path"
        ? { agent_session_path: session.value }
        : session
          ? { agent_session_id: session.value }
          : {}),
    });
  }

  async startAgent(input: AgentLaunchInput): Promise<HostedAgent> {
    assertLaunchOwnership(input);
    if (input.command) assertExplicitCommand(input.command);
    const deadline = Date.now() + (input.timeoutMs ?? 90_000);

    // A prior caller may have lost the launch response after Herdr accepted the
    // side effect. Resolve the deterministic name before issuing another start.
    const existing = await this.observeAgentLaunch(input);
    if (existing.state === "materialized") return existing.agent;
    if (existing.state === "pending") {
      const reconciled = await this.reconcileAgentLaunch(input, deadline);
      if (reconciled.state === "materialized") return reconciled.agent;
      if (reconciled.state !== "absent")
        throw uncertainLaunch(input.name, "the existing launch stayed pending");
    }

    await this.waitForAvailableShell(input.paneId, deadline);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 3_000)
        throw uncertainLaunch(
          input.name,
          "the launch deadline expired before absence could be established",
        );

      let result: Record<string, unknown> | null = null;
      try {
        result = await this.request(
          "agent.start",
          {
            pane_id: input.paneId,
            name: input.name,
            kind: input.integrationKind,
            args: input.command ? [] : input.args,
            ...(input.command
              ? {
                  command: {
                    executable: input.command.executable,
                    args: [...input.command.args],
                    cwd: input.command.cwd,
                    env: { ...input.command.environment },
                  },
                }
              : {}),
            timeout_ms: remainingMs,
          },
          remainingMs + 5_000,
        );
      } catch (error) {
        if (!ambiguousLaunchError(error) && !paneBusy(error)) throw error;
        // The request may have crossed the side-effect boundary. Never issue a
        // second start until exact inventory and shell state prove absence.
      }

      if (result && record(result.agent)) {
        try {
          const acknowledged = decodeLaunchProjection(
            result.agent,
            input,
            true,
          );
          if (acknowledged.state === "materialized") return acknowledged.agent;
        } catch (error) {
          if (launchConflict(error)) throw error;
          // A malformed acknowledgement is ambiguous until native inventory
          // proves either the exact launch or authoritative absence.
        }
      }

      const reconciled = await this.reconcileAgentLaunch(input, deadline);
      if (reconciled.state === "materialized") return reconciled.agent;
      if (reconciled.state === "absent" && attempt === 0) {
        await this.waitForAvailableShell(input.paneId, deadline);
        continue;
      }
      if (reconciled.state === "absent")
        throw incompatibleLaunch(
          input.name,
          "bounded launch retry ended with authoritative agent absence",
        );
      throw uncertainLaunch(
        input.name,
        "native inventory could not resolve the accepted launch",
      );
    }
    throw uncertainLaunch(input.name, "launch reconciliation was exhausted");
  }

  private async observeAgentLaunch(
    input: AgentLaunchInput,
    onRequestedPane = false,
  ): Promise<AgentLaunchObservation> {
    let result: Record<string, unknown>;
    try {
      result = await this.request("agent.get", {
        target: onRequestedPane ? input.paneId : input.name,
      });
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "agent_not_found")
        return this.observeOwnedAgentInSnapshot(input);
      throw error;
    }
    if (!record(result.agent))
      throw uncertainLaunch(
        input.name,
        "agent.get returned success without an agent projection",
      );
    return decodeLaunchProjection(result.agent, input, onRequestedPane);
  }

  private async observeOwnedAgentInSnapshot(
    input: AgentLaunchInput,
  ): Promise<AgentLaunchObservation> {
    const snapshot = await this.snapshot();
    const expectedOwnership = launchOwnershipEntries(input);
    const exact = snapshot.agents.filter(
      (agent) =>
        agent.tokens !== undefined &&
        expectedOwnership.every(
          ([key, expected]) => agent.tokens?.[key] === expected,
        ),
    );
    if (exact.length > 1)
      throw launchConflictError(
        input.name,
        "multiple agents carry the exact QE launch provenance",
      );
    const sameName = snapshot.agents.filter(
      (agent) => agent.name === input.name && !exact.includes(agent),
    );
    if (sameName.length > 0)
      throw launchConflictError(
        input.name,
        "a same-name agent has foreign QE ownership provenance",
      );
    const agent = exact[0];
    if (!agent) return { state: "absent" };
    if (agent.name !== undefined && agent.name !== input.name)
      throw launchConflictError(
        input.name,
        `exact QE provenance is attached to differently named agent '${agent.name}'`,
      );
    if (agent.nativeMaterialized && agent.agent !== input.integrationKind)
      throw launchConflictError(
        input.name,
        `exact QE provenance resolved native kind '${agent.agent}'`,
      );
    const resolved = { ...agent, name: input.name };
    if (
      agent.nativeMaterialized &&
      agent.agent === input.integrationKind &&
      agent.launchPending !== true &&
      agent.interactiveReady !== false
    )
      return {
        state: "materialized",
        agent: {
          ...resolved,
          interactiveReady: true,
          launchPending: false,
        },
      };
    return { state: "pending", agent: resolved };
  }

  private async reconcileAgentLaunch(
    input: AgentLaunchInput,
    deadline: number,
  ): Promise<AgentLaunchObservation> {
    const startedAt = Date.now();
    let consecutiveSettledAbsences = 0;
    let lastPending: HostedAgent | null = null;
    while (Date.now() < deadline - 3_000) {
      let observation: AgentLaunchObservation;
      try {
        observation = await this.observeAgentLaunch(input, true);
      } catch (error) {
        if (launchConflict(error)) throw error;
        throw uncertainLaunch(
          input.name,
          `native inventory became unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (observation.state === "materialized") return observation;
      if (observation.state === "pending") {
        lastPending = observation.agent;
        consecutiveSettledAbsences = 0;
      } else if (observation.state === "absent") {
        let shellAvailable: boolean;
        try {
          shellAvailable = await this.shellIsAvailable(input.paneId, deadline);
        } catch (error) {
          throw uncertainLaunch(
            input.name,
            `shell state became unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (
          shellAvailable &&
          Date.now() - startedAt >= 750 &&
          ++consecutiveSettledAbsences >= 2
        )
          return { state: "absent" };
        if (!shellAvailable) consecutiveSettledAbsences = 0;
      }
      await Bun.sleep(50);
    }
    return lastPending
      ? { state: "pending", agent: lastPending }
      : { state: "ambiguous" };
  }

  private async shellIsAvailable(
    paneId: string,
    deadline: number,
  ): Promise<boolean> {
    const result = await this.request(
      "pane.process_info",
      { pane_id: paneId },
      Math.max(1, Math.min(this.timeoutMs, deadline - Date.now())),
    );
    const info = object(
      result.process_info,
      "process_info",
      "terminal.shell_readiness",
    );
    const shellPid = optionalInteger(
      info.shell_pid,
      "process_info.shell_pid",
      "terminal.shell_readiness",
    );
    const foregroundProcessGroupId = optionalInteger(
      info.foreground_process_group_id,
      "process_info.foreground_process_group_id",
      "terminal.shell_readiness",
    );
    return Boolean(
      shellPid &&
        foregroundProcessGroupId &&
        shellPid === foregroundProcessGroupId,
    );
  }

  async prompt(
    target: string,
    text: string,
    options: { until?: HostedAgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HostedAgent> {
    const wait =
      options.until || options.timeoutMs
        ? {
            until: options.until ?? ["idle", "done", "blocked"],
            timeout_ms: options.timeoutMs ?? 120_000,
          }
        : undefined;
    const result = await this.request(
      "agent.prompt",
      { target, text, ...(wait ? { wait } : {}) },
      (options.timeoutMs ?? this.timeoutMs) + 5_000,
    );
    return mapAgent(
      object(result.agent, "agent", "agent.prompt"),
      undefined,
      "agent.prompt",
    );
  }

  async wait(
    target: string,
    options: { until?: HostedAgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HostedAgent> {
    const result = await this.request(
      "agent.wait",
      {
        target,
        until: options.until ?? ["idle", "done", "blocked"],
        ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {}),
      },
      (options.timeoutMs ?? this.timeoutMs) + 5_000,
    );
    return mapAgent(
      object(result.agent, "agent", "agent.state_observation"),
      undefined,
      "agent.state_observation",
    );
  }

  async getAgent(target: string): Promise<HostedAgent> {
    const result = await this.request("agent.get", { target });
    return mapAgent(
      object(result.agent, "agent", "agent.inspect"),
      undefined,
      "agent.inspect",
    );
  }

  async closePane(paneId: string): Promise<void> {
    await this.request("pane.close", { pane_id: paneId });
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    await this.request("agent.send_keys", { target, keys });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    const id = `qe-worker-${process.pid}-${crypto.randomUUID()}`;
    const message = await new Promise<Message>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const socket = createConnection(this.socketPath);
      this.sockets.add(socket);
      const timer = setTimeout(
        () =>
          finish(
            new HerdrApiError(
              "timeout",
              `Herdr request timed out: ${method}`,
              capabilityForMethod(method),
            ),
          ),
        timeoutMs,
      );
      const finish = (error?: Error, value?: Message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.destroy();
        if (error) reject(error);
        else resolve(value ?? {});
      };
      socket.on("error", (error) => {
        this.onUnavailable();
        finish(new HerdrApiError("backend_unavailable", error.message));
      });
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ id, method, params })}\n`),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(buffer.slice(0, newline)) as Message;
          if (value.id === id) finish(undefined, value);
        } catch {
          finish(
            new HerdrApiError(
              "backend_incompatible",
              "Herdr returned malformed JSON.",
              "backend.response_decoding",
            ),
          );
        }
      });
      socket.on("close", () => {
        if (!settled) {
          this.onUnavailable();
          finish(
            new HerdrApiError(
              "backend_unavailable",
              "Herdr socket closed before responding.",
            ),
          );
        }
      });
    });
    if (message.error) {
      const code = message.error.code ?? "herdr_error";
      if (
        [
          "endpoint_incompatible",
          "invalid_params",
          "method_not_found",
          "protocol_mismatch",
          "unknown_method",
          "unsupported_method",
        ].includes(code)
      )
        throw new HerdrApiError(
          "backend_incompatible",
          message.error.message ?? `Herdr cannot execute ${method}.`,
          capabilityForMethod(method),
        );
      throw new HerdrApiError(
        code,
        message.error.message ?? "Herdr request failed",
      );
    }
    return message.result ?? {};
  }

  private async waitForAvailableShell(
    paneId: string,
    deadline: number,
  ): Promise<void> {
    while (Date.now() < deadline - 3_000) {
      const result = await this.request(
        "pane.process_info",
        { pane_id: paneId },
        Math.min(this.timeoutMs, deadline - Date.now()),
      );
      const info = object(
        result.process_info,
        "process_info",
        "terminal.shell_readiness",
      );
      const shellPid = optionalInteger(
        info.shell_pid,
        "process_info.shell_pid",
        "terminal.shell_readiness",
      );
      const foregroundProcessGroupId = optionalInteger(
        info.foreground_process_group_id,
        "process_info.foreground_process_group_id",
        "terminal.shell_readiness",
      );
      if (shellPid !== undefined && shellPid === foregroundProcessGroupId)
        return;
      await Bun.sleep(100);
    }
    throw new HerdrApiError(
      "shell_not_ready",
      `Pane ${paneId} did not reach an interactive shell.`,
    );
  }
}

export function findAgent(
  snapshot: HostedSnapshot,
  ref: { paneId?: string; terminalId?: string; agentName?: string },
): HostedAgent | null {
  const byTerminal = ref.terminalId
    ? snapshot.agents.filter((agent) => agent.terminalId === ref.terminalId)
    : [];
  if (byTerminal.length === 1) return byTerminal[0] ?? null;
  const byPane = ref.paneId
    ? snapshot.agents.filter((agent) => agent.paneId === ref.paneId)
    : [];
  if (byPane.length === 1) return byPane[0] ?? null;
  const byName = ref.agentName
    ? snapshot.agents.filter((agent) => agent.name === ref.agentName)
    : [];
  return byName.length === 1 ? (byName[0] ?? null) : null;
}

const REQUIRED_LAUNCH_OWNERSHIP_TOKEN_KEYS = [
  "qe_owner",
  "qe_worker_id",
  "qe_lineage_id",
  "qe_ownership_token",
  "qe_session_incarnation",
] as const;
const LAUNCH_OWNERSHIP_TOKEN_KEYS = [
  "qe_owner",
  "qe_worker_id",
  "qe_lineage_id",
  "qe_ownership_token",
  "qe_session_incarnation",
  "qe_run_id",
  "qe_action_hash",
  "qe_occurrence_hash",
  "qe_attempt_hash",
  "qe_result_nonce",
  "qe_agent_name",
  "qe_harness_kind",
  "qe_provider",
] as const;

function assertExplicitCommand(command: HostLaunchDescriptor): void {
  if (
    !isAbsolute(command.executable) ||
    !isAbsolute(command.cwd) ||
    command.io !== "pty"
  )
    throw new HerdrApiError(
      "environment_launch_mismatch",
      "Explicit managed launch requires an absolute executable, absolute cwd, and PTY transport.",
      "agent.explicit_launch",
    );
  if (
    [command.executable, command.cwd, ...command.args].some((value) =>
      value.includes("\0"),
    ) ||
    Object.entries(command.environment).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"),
    )
  )
    throw new HerdrApiError(
      "environment_launch_mismatch",
      "Explicit managed launch contains an invalid argv or environment value.",
      "agent.explicit_launch",
    );
}

function assertLaunchOwnership(input: AgentLaunchInput): void {
  const missing = REQUIRED_LAUNCH_OWNERSHIP_TOKEN_KEYS.filter(
    (key) => !input.expectedTokens[key],
  );
  if (missing.length > 0)
    throw new HerdrApiError(
      "backend_incompatible",
      `Agent launch omitted QE ownership tokens: ${missing.join(", ")}.`,
      "agent.interactive_launch",
    );
}

function decodeLaunchProjection(
  value: Record<string, unknown>,
  input: AgentLaunchInput,
  acknowledgedOnRequestedPane: boolean,
): AgentLaunchObservation {
  const agent = mapAgent(
    value,
    input.integrationKind,
    "agent.interactive_launch",
  );
  const nativeKind = optionalString(
    value.agent,
    "agent.agent",
    "agent.interactive_launch",
  );
  if (nativeKind && nativeKind !== input.integrationKind)
    throw launchConflictError(
      input.name,
      `Herdr resolved native kind '${nativeKind}', not '${input.integrationKind}'.`,
    );

  const expectedOwnership = launchOwnershipEntries(input);
  const ownershipVerified =
    expectedOwnership.length === 0 ||
    (agent.tokens !== undefined &&
      expectedOwnership.every(
        ([key, expected]) => agent.tokens?.[key] === expected,
      ));
  if (
    agent.tokens &&
    expectedOwnership.some(
      ([key, expected]) => agent.tokens?.[key] !== expected,
    )
  )
    throw launchConflictError(
      input.name,
      "Herdr found a same-name agent with foreign QE ownership provenance.",
    );
  if (!agent.name && !ownershipVerified)
    throw uncertainLaunch(
      input.name,
      "Herdr projected neither deterministic name nor exact QE ownership",
    );
  if (agent.name !== undefined && agent.name !== input.name)
    throw launchConflictError(
      input.name,
      `Herdr resolved same-target launch as '${agent.name}'.`,
    );
  if (
    agent.paneId !== input.paneId &&
    (!ownershipVerified || expectedOwnership.length === 0)
  )
    throw launchConflictError(
      input.name,
      `Herdr found an unverifiable same-name agent on pane '${agent.paneId}'.`,
    );
  const resolvedAgent = agent.name ? agent : { ...agent, name: input.name };

  const launchPending = optionalBoolean(
    value.launch_pending,
    "agent.launch_pending",
    "agent.interactive_launch",
  );
  const interactiveReady = optionalBoolean(
    value.interactive_ready,
    "agent.interactive_ready",
    "agent.interactive_launch",
  );
  if (acknowledgedOnRequestedPane && agent.paneId !== input.paneId)
    throw launchConflictError(
      input.name,
      `Herdr acknowledged launch on unexpected pane '${agent.paneId}'.`,
    );

  const materialized =
    nativeKind === input.integrationKind &&
    ownershipVerified &&
    launchPending !== true &&
    interactiveReady !== false;
  if (materialized)
    return {
      state: "materialized",
      agent: {
        ...resolvedAgent,
        interactiveReady: true,
        launchPending: false,
      },
    };

  return {
    state: "pending",
    agent: { ...resolvedAgent, launchPending: launchPending ?? true },
  };
}

function launchOwnershipEntries(
  input: AgentLaunchInput,
): Array<[string, string]> {
  return Object.entries(input.expectedTokens).filter(([key]) =>
    LAUNCH_OWNERSHIP_TOKEN_KEYS.includes(
      key as (typeof LAUNCH_OWNERSHIP_TOKEN_KEYS)[number],
    ),
  );
}

function ambiguousLaunchError(error: unknown): boolean {
  return (
    error instanceof HerdrApiError &&
    [
      "agent_not_ready",
      "backend_unavailable",
      "controller_disconnected",
      "timeout",
    ].includes(error.code)
  );
}

function paneBusy(error: unknown): boolean {
  return error instanceof HerdrApiError && error.code === "agent_pane_busy";
}

function launchConflict(error: unknown): boolean {
  return (
    error instanceof HerdrApiError && error.code === "agent_launch_conflict"
  );
}

function launchConflictError(name: string, detail: string): HerdrApiError {
  return new HerdrApiError(
    "agent_launch_conflict",
    `Cannot adopt Herdr agent '${name}': ${detail}`,
    "agent.interactive_launch",
  );
}

function incompatibleLaunch(name: string, detail: string): HerdrApiError {
  return new HerdrApiError(
    "backend_incompatible",
    `Herdr agent launch '${name}' violated the interactive-launch contract: ${detail}.`,
    "agent.interactive_launch",
  );
}

function uncertainLaunch(name: string, detail: string): HerdrApiError {
  return new HerdrApiError(
    "agent_launch_uncertain",
    `Herdr agent launch '${name}' is uncertain: ${detail}.`,
    "agent.interactive_launch",
  );
}

function mapSnapshotAgent(value: Record<string, unknown>): HostedAgent {
  const rawTokens = record(value.tokens) ? value.tokens : null;
  const expectedAgent =
    rawTokens?.qe_provider === "pi"
      ? "pi"
      : rawTokens?.qe_harness_kind === "antigravity"
        ? "agy"
        : "unknown";
  return mapAgent(value, expectedAgent, "session.snapshot_decoding");
}

function mapPane(value: Record<string, unknown>): HostedPane {
  const capability = "session.snapshot_decoding";
  const terminalId = optionalString(
    value.terminal_id,
    "pane.terminal_id",
    capability,
  );
  const cwd = optionalString(value.cwd, "pane.cwd", capability);
  const foregroundCwd = optionalString(
    value.foreground_cwd,
    "pane.foreground_cwd",
    capability,
  );
  return {
    paneId: string(value.pane_id, "pane_id", capability),
    workspaceId: string(value.workspace_id, "workspace_id", capability),
    tabId: string(value.tab_id, "tab_id", capability),
    ...(terminalId ? { terminalId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(foregroundCwd ? { foregroundCwd } : {}),
  };
}
function mapAgent(
  value: Record<string, unknown>,
  expectedAgent?: string,
  capability = "agent.lifecycle_decoding",
): HostedAgent {
  const rawStatus = value.status ?? value.agent_status;
  if (typeof rawStatus !== "string" || !rawStatus)
    throw contractError(capability, "Herdr response omitted agent.status.");
  const status: HostedAgentStatus = [
    "idle",
    "working",
    "blocked",
    "done",
    "unknown",
  ].includes(rawStatus)
    ? (rawStatus as HostedAgentStatus)
    : "unknown";
  const session =
    value.agent_session === undefined || value.agent_session === null
      ? undefined
      : nativeSession(
          object(
            value.agent_session,
            "agent.agent_session",
            "agent.native_session",
          ),
        );
  const name = optionalString(value.name, "agent.name", capability);
  const tabId = optionalString(value.tab_id, "agent.tab_id", capability);
  const terminalId = optionalString(
    value.terminal_id,
    "agent.terminal_id",
    capability,
  );
  const cwd = optionalString(value.cwd, "agent.cwd", capability);
  const foregroundCwd = optionalString(
    value.foreground_cwd,
    "agent.foreground_cwd",
    capability,
  );
  const statusSource = optionalString(
    value.agent_status_source ?? value.status_source,
    "agent.status_source",
    capability,
  );
  const message = optionalString(
    value.message ?? value.agent_message,
    "agent.message",
    capability,
  );
  const interactiveReady = optionalBoolean(
    value.interactive_ready,
    "agent.interactive_ready",
    capability,
  );
  const launchPending = optionalBoolean(
    value.launch_pending,
    "agent.launch_pending",
    capability,
  );
  const nativeAgent = optionalString(value.agent, "agent.agent", capability);
  return {
    ...(name ? { name } : {}),
    agent:
      nativeAgent ?? expectedAgent ?? string(value.agent, "agent", capability),
    status,
    paneId: string(value.pane_id, "pane_id", capability),
    workspaceId: string(value.workspace_id, "workspace_id", capability),
    ...(tabId ? { tabId } : {}),
    ...(terminalId ? { terminalId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(foregroundCwd ? { foregroundCwd } : {}),
    ...(interactiveReady !== undefined ? { interactiveReady } : {}),
    ...(launchPending !== undefined ? { launchPending } : {}),
    nativeMaterialized: nativeAgent !== undefined,
    ...(session ? { nativeSession: session } : {}),
    ...(statusSource ? { statusSource } : {}),
    ...(message ? { message } : {}),
    ...(value.tokens === undefined || value.tokens === null
      ? {}
      : {
          tokens: stringRecord(
            object(value.tokens, "agent.tokens", capability),
            capability,
          ),
        }),
  };
}
function nativeSession(
  value: Record<string, unknown>,
  capability = "agent.native_session",
): NativeSessionRef {
  if (
    typeof value.source !== "string" ||
    typeof value.agent !== "string" ||
    (value.kind !== "id" && value.kind !== "path") ||
    typeof value.value !== "string"
  )
    throw contractError(
      capability,
      "Herdr returned malformed native agent-session identity.",
    );
  return {
    source: value.source,
    agent: value.agent,
    kind: value.kind,
    value: value.value,
  };
}
function stringRecord(
  value: Record<string, unknown>,
  capability = "terminal.metadata",
): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== "string"))
    throw contractError(
      capability,
      "Herdr returned malformed string metadata tokens.",
    );
  return Object.fromEntries(entries) as Record<string, string>;
}
function integrationArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw contractError(
      "integration.discovery",
      "Herdr response omitted or malformed integrations.",
    );
  // Unrelated future integration entries do not affect Pi or Antigravity.
  // Relevant malformed entries are retained and diagnosed per harness above.
  return value.filter(record);
}
function strictArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !record(item)))
    throw contractError(
      label.startsWith("snapshot")
        ? "session.snapshot_decoding"
        : "integration.discovery",
      `Herdr response omitted or malformed ${label}.`,
    );
  return value as Record<string, unknown>[];
}
function object(
  value: unknown,
  label: string,
  capability = label.startsWith("snapshot")
    ? "session.snapshot_decoding"
    : label,
): Record<string, unknown> {
  if (!record(value))
    throw contractError(capability, `Herdr response omitted ${label}.`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown, label: string, capability = label): string {
  if (typeof value !== "string" || !value)
    throw contractError(capability, `Herdr response omitted ${label}.`);
  return value;
}
function integer(value: unknown, label: string, capability = label): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw contractError(capability, `Herdr response omitted ${label}.`);
  return value;
}
function optionalInteger(
  value: unknown,
  label: string,
  capability = label,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw contractError(capability, `Herdr response malformed ${label}.`);
  return value;
}
function optionalString(
  value: unknown,
  label: string,
  capability = label,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string")
    throw contractError(capability, `Herdr response malformed ${label}.`);
  return value;
}
function optionalBoolean(
  value: unknown,
  label: string,
  capability = label,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean")
    throw contractError(capability, `Herdr response malformed ${label}.`);
  return value;
}
function capabilityForMethod(method: string): string {
  if (method === "ping") return "backend.health";
  if (method === "session.snapshot") return "session.inventory";
  if (method === "workspace.report_metadata")
    return "session.ownership_metadata";
  if (["workspace.create", "tab.create", "tab.rename"].includes(method))
    return "terminal.topology";
  if (method === "pane.report_metadata") return "terminal.metadata";
  if (method === "pane.process_info") return "terminal.shell_readiness";
  if (method === "pane.close") return "terminal.process_retirement";
  if (method === "agent.start") return "agent.interactive_launch";
  if (method === "agent.prompt") return "agent.prompt";
  if (method === "agent.wait") return "agent.state_observation";
  if (method === "agent.get") return "agent.inspect";
  if (method === "agent.send_keys") return "agent.send_input";
  if (method === "integration.list") return "integration.discovery";
  return "backend.contract";
}
function contractError(capability: string, message: string): HerdrApiError {
  return new HerdrApiError("backend_incompatible", message, capability);
}
