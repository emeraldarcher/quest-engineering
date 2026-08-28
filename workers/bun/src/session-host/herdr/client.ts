import { createConnection, type Socket } from "node:net";
import type {
  HostedAgent,
  HostedAgentStatus,
  HostedPane,
  HostedSnapshot,
  NativeSessionRef,
} from "../types.ts";

export const HERDR_SUPPORTED_PROTOCOLS = new Set([19, 20]);

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HerdrControlClient {
  snapshot(): Promise<HostedSnapshot>;
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
  startAgent(input: {
    paneId: string;
    name: string;
    kind: "pi";
    args: string[];
    timeoutMs?: number;
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
  disconnect(): void;
}

interface Message {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export class HerdrSocketClient implements HerdrControlClient {
  private readonly sockets = new Set<Socket>();
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 30_000,
  ) {}

  disconnect(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async snapshot(): Promise<HostedSnapshot> {
    const result = await this.request("session.snapshot");
    const snapshot = object(result.snapshot ?? result, "snapshot");
    return {
      workspaces: array(snapshot.workspaces).map((item) => {
        const label = optionalString(item.label);
        return {
          workspaceId: string(item.workspace_id, "workspace_id"),
          ...(label ? { label } : {}),
        };
      }),
      panes: array(snapshot.panes).map(mapPane),
      agents: array(snapshot.agents).map((item) => mapAgent(item)),
    };
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
    const workspace = object(result.workspace, "workspace");
    const tab = object(result.tab, "tab");
    const pane = object(result.root_pane, "root_pane");
    const terminalId = optionalString(pane.terminal_id);
    return {
      workspaceId: string(workspace.workspace_id, "workspace_id"),
      tabId: string(tab.tab_id, "tab_id"),
      paneId: string(pane.pane_id, "pane_id"),
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
    const tab = object(result.tab, "tab");
    const pane = object(result.root_pane, "root_pane");
    const terminalId = optionalString(pane.terminal_id);
    return {
      workspaceId: input.workspaceId,
      tabId: string(tab.tab_id, "tab_id"),
      paneId: string(pane.pane_id, "pane_id"),
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

  async startAgent(input: {
    paneId: string;
    name: string;
    kind: "pi";
    args: string[];
    timeoutMs?: number;
  }): Promise<HostedAgent> {
    const timeoutMs = input.timeoutMs ?? 90_000;
    const deadline = Date.now() + timeoutMs;
    await this.waitForAvailableShell(input.paneId, deadline);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 3_000)
      throw new HerdrApiError(
        "shell_not_ready",
        `Pane ${input.paneId} did not reach an interactive shell.`,
      );
    const result = await this.request(
      "agent.start",
      {
        pane_id: input.paneId,
        name: input.name,
        kind: input.kind,
        args: input.args,
        timeout_ms: remainingMs,
      },
      remainingMs + 5_000,
    );

    // Herdr may accept launch before its response projection includes the agent.
    // Discover that exact launch rather than issuing a duplicate start request.
    const launched = record(result.agent)
      ? mapAgent(result.agent, input.kind)
      : undefined;
    if (
      launched?.interactiveReady &&
      launched.name === input.name &&
      launched.agent === input.kind
    )
      return launched;
    while (Date.now() < deadline) {
      try {
        const current = await this.getAgent(input.paneId);
        if (
          current.interactiveReady &&
          current.name === input.name &&
          current.agent === input.kind
        )
          return current;
      } catch {
        // Launch projection is still pending.
      }
      await Bun.sleep(100);
    }
    throw new HerdrApiError(
      "agent_not_ready",
      `Herdr did not mark ${input.name} ready.`,
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
    return mapAgent(object(result.agent, "agent"));
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
    return mapAgent(object(result.agent, "agent"));
  }

  async getAgent(target: string): Promise<HostedAgent> {
    const result = await this.request("agent.get", { target });
    return mapAgent(object(result.agent, "agent"));
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
            new HerdrApiError("timeout", `Herdr request timed out: ${method}`),
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
      socket.on("error", (error) =>
        finish(new HerdrApiError("backend_unavailable", error.message)),
      );
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
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("close", () => {
        if (!settled)
          finish(
            new HerdrApiError(
              "backend_unavailable",
              "Herdr socket closed before responding.",
            ),
          );
      });
    });
    if (message.error)
      throw new HerdrApiError(
        message.error.code ?? "herdr_error",
        message.error.message ?? "Herdr request failed",
      );
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
      const info = object(result.process_info, "process_info");
      if (
        typeof info.shell_pid === "number" &&
        info.shell_pid === info.foreground_process_group_id
      )
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

function mapPane(value: Record<string, unknown>): HostedPane {
  const terminalId = optionalString(value.terminal_id);
  const cwd = optionalString(value.cwd);
  const foregroundCwd = optionalString(value.foreground_cwd);
  return {
    paneId: string(value.pane_id, "pane_id"),
    workspaceId: string(value.workspace_id, "workspace_id"),
    tabId: string(value.tab_id, "tab_id"),
    ...(terminalId ? { terminalId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(foregroundCwd ? { foregroundCwd } : {}),
  };
}
function mapAgent(
  value: Record<string, unknown>,
  expectedAgent?: string,
): HostedAgent {
  const status = value.status ?? value.agent_status;
  if (
    !["idle", "working", "blocked", "done", "unknown"].includes(String(status))
  )
    throw new Error(`Invalid Herdr agent status: ${String(status)}`);
  const session = record(value.agent_session)
    ? nativeSession(value.agent_session)
    : undefined;
  const name = optionalString(value.name);
  const tabId = optionalString(value.tab_id);
  const terminalId = optionalString(value.terminal_id);
  const cwd = optionalString(value.cwd);
  const foregroundCwd = optionalString(value.foreground_cwd);
  const statusSource = optionalString(
    value.agent_status_source ?? value.status_source,
  );
  const message = optionalString(value.message ?? value.agent_message);
  return {
    ...(name ? { name } : {}),
    agent:
      optionalString(value.agent) ??
      expectedAgent ??
      string(value.agent, "agent"),
    status: status as HostedAgentStatus,
    paneId: string(value.pane_id, "pane_id"),
    workspaceId: string(value.workspace_id, "workspace_id"),
    ...(tabId ? { tabId } : {}),
    ...(terminalId ? { terminalId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(foregroundCwd ? { foregroundCwd } : {}),
    ...(typeof value.interactive_ready === "boolean"
      ? { interactiveReady: value.interactive_ready }
      : {}),
    ...(session ? { nativeSession: session } : {}),
    ...(statusSource ? { statusSource } : {}),
    ...(message ? { message } : {}),
    ...(record(value.tokens) ? { tokens: stringRecord(value.tokens) } : {}),
  };
}
function nativeSession(
  value: Record<string, unknown>,
): NativeSessionRef | undefined {
  if (
    typeof value.source !== "string" ||
    typeof value.agent !== "string" ||
    (value.kind !== "id" && value.kind !== "path") ||
    typeof value.value !== "string"
  )
    return undefined;
  return {
    source: value.source,
    agent: value.agent,
    kind: value.kind,
    value: value.value,
  };
}
function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`Herdr response omitted ${label}.`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Herdr response omitted ${label}.`);
  return value;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
