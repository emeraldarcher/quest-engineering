import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  AntigravityHarness,
  antigravityPromptFor,
} from "../src/harnesses/antigravity/adapter.ts";
import {
  parseAntigravityModelCatalog,
  SUPPORTED_ANTIGRAVITY_VERSION,
} from "../src/harnesses/antigravity/discovery.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HarnessControlClient } from "../src/harnesses/control/client.ts";
import {
  HARNESS_CONTROL_PATH_ENV,
  readControlDescriptor,
} from "../src/harnesses/control/descriptor.ts";
import { QE_MCP_STARTUP_EVIDENCE_ENV } from "../src/harnesses/control/mcp-server.ts";
import { writeControlAtomic } from "../src/harnesses/control/result-envelope.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import type {
  HarnessCapabilities,
  HarnessEvent,
} from "../src/harnesses/types.ts";
import type {
  HostedAgent,
  HostedAgentStatus,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  TerminalAttachmentDescriptor,
  TerminalSessionBackend,
} from "../src/session-host/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const capabilities: HarnessCapabilities = {
  structuredResult: true,
  continuation: true,
  retainedSessionRecovery: true,
  structuredAttention: false,
  nativeBlocking: true,
  canAttachTerminal: true,
  canSendInput: true,
  canInterrupt: true,
  canDetectAttention: true,
  canResume: true,
  canObserveStructuredEvents: true,
  structuredConfirmation: false,
  structuredTextResponse: false,
  structuredChoiceResponse: false,
  structuredMultilineResponse: false,
  nativePromptControl: true,
  conversationalTakeover: true,
  automationResume: true,
};

async function fixture(
  maxStopEnforcements = 2,
  selection: {
    model?: string;
    reasoning?: string | null;
    modelsOutput?: string;
  } = {},
) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "antigravity-harness-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = {
    workerId: "worker-test",
    dataRoot: root,
    resultTimeoutMs: 2_000,
  } as WorkerConfig;
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "antigravity",
    capabilities,
  );
  const execute = action();
  execute.execution.configuration = {
    harness_kind: "antigravity",
    model: {
      provider: "antigravity",
      model: selection.model ?? "gemini-test-high",
    },
    reasoning: selection.reasoning === undefined ? "high" : selection.reasoning,
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    tool_enforcement: "native_permissions",
  };
  execute.execution.execution_workspace.canonical_root = workspace;
  const dispatch = registry.accept(execute).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  registry.occupy(lineage.lineageId, execute.action_id);
  const current = registry.getLineage(lineage.lineageId);
  const authority = new HarnessControlAuthority(registry, maxStopEnforcements);
  const server = new HarnessControlServer(authority);
  await server.start();
  await authority.bind(dispatch, current);
  const host = new FakeAntigravityHost(workspace);
  const runNativeCommand = async (args: string[]) => ({
    exitCode: 0,
    stdout:
      args[0] === "--version"
        ? `${SUPPORTED_ANTIGRAVITY_VERSION}\n`
        : args[0] === "models"
          ? (selection.modelsOutput ?? "gemini-test-high\tGemini Test (High)\n")
          : `qe stdio enabled ${process.execPath} ${resolve(import.meta.dir, "..", "src", "harnesses", "control", "mcp-server.ts")}\n`,
    stderr: "",
  });
  const harness = new AntigravityHarness(host, config, { runNativeCommand });
  return {
    root,
    workspace,
    config,
    registry,
    dispatch,
    lineage: current,
    authority,
    server,
    host,
    harness,
    runNativeCommand,
    async close() {
      await server.stop();
      registry.close();
    },
  };
}

test("native model discovery distinguishes enumerated, unsupported, and conflicting effort", () => {
  expect(
    parseAntigravityModelCatalog(`Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gemini-conflict-low\tGemini Conflict (High)
`),
  ).toEqual({
    models: [
      {
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6 (Thinking)",
        reasoningCapability: { kind: "unsupported" },
      },
      {
        provider: "antigravity",
        model: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
        reasoningCapability: { kind: "enumerated", values: ["high"] },
      },
      {
        provider: "antigravity",
        model: "gemini-3.8-flash-low",
        displayName: "Gemini 3.8 Flash (Low)",
        reasoningCapability: { kind: "enumerated", values: ["low"] },
      },
      {
        provider: "antigravity",
        model: "gemini-conflict-low",
        displayName: "Gemini Conflict (High)",
        reasoningCapability: {
          kind: "unknown",
          detail: "conflicting native effort metadata",
        },
      },
    ],
    omitted: ["gemini-conflict-low"],
  });
});

test("interactive launch pins model and effort, proves readiness, and keeps the live TUI attachable", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    expect(value.host.startRequests).toHaveLength(1);
    expect(value.host.startRequests[0]?.args.includes("--print")).toBe(false);
    expect(value.host.startRequests[0]?.args.includes("--tools")).toBe(false);
    expect(
      value.host.startRequests[0]?.args.includes(
        "--dangerously-skip-permissions",
      ),
    ).toBe(false);
    expect(value.host.startRequests[0]).toMatchObject({
      integrationKind: "agy",
      args: expect.arrayContaining([
        "--model",
        "gemini-test-high",
        "--effort",
        "high",
      ]),
    });
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    value.registry.recordHost(value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      workspaceId: execution.ref.workspaceId,
      paneId: execution.ref.paneId,
      ...(execution.ref.terminalId
        ? { terminalId: execution.ref.terminalId }
        : {}),
      agentName: execution.ref.agentName,
    });
    expect(
      value.harness.attachment(
        value.registry.getLineage(value.lineage.lineageId),
      ),
    ).toMatchObject({
      backendKind: "herdr",
      terminalTargetId: execution.ref.agentName,
      supportsObservation: true,
      supportsTakeover: true,
    });
  } finally {
    await value.close();
  }
});

test("unsupported effort model is schedulable and launch omits --effort", async () => {
  const value = await fixture(2, {
    model: "claude-sonnet-4-6",
    reasoning: null,
    modelsOutput: "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
  });
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    const args = value.host.startRequests[0]?.args ?? [];
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).not.toContain("--effort");
    expect(execution.agent.agent).toBe("agy");
  } finally {
    await value.close();
  }
});

test("effort capability rejects omitted enumerated effort and configured unsupported effort", async () => {
  const omitted = await fixture(2, { reasoning: null });
  try {
    await expect(
      omitted.harness.start(omitted.dispatch, omitted.lineage),
    ).rejects.toThrow("model/effort pair");
  } finally {
    await omitted.close();
  }

  const unsupported = await fixture(2, {
    model: "claude-sonnet-4-6",
    reasoning: "high",
    modelsOutput: "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
  });
  try {
    await expect(
      unsupported.harness.start(unsupported.dispatch, unsupported.lineage),
    ).rejects.toThrow("model/effort pair");
  } finally {
    await unsupported.close();
  }
});

test("Antigravity rejects exact enforcement and partial native profiles", async () => {
  const exact = await fixture();
  exact.dispatch.action.execution.configuration.tool_enforcement = "exact";
  try {
    await expect(
      exact.harness.start(exact.dispatch, exact.lineage),
    ).rejects.toThrow("complete native-permissions tool profile");
  } finally {
    await exact.close();
  }

  const partial = await fixture();
  partial.dispatch.action.execution.configuration.tools = [
    "workspace.filesystem",
  ];
  try {
    await expect(
      partial.harness.start(partial.dispatch, partial.lineage),
    ).rejects.toThrow("complete native-permissions tool profile");
  } finally {
    await partial.close();
  }
});

test("semantic MCP completion is authoritative even while Herdr still projects working", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    value.host.onPrompt = async () => {
      await new HarnessControlClient(
        controlDescriptorPath(value.lineage),
      ).completeStep({ change_set: { status: "ok" } });
    };
    const events: HarnessEvent[] = [];
    const outputs = await value.harness.sendInputAndCollect(
      value.dispatch,
      execution,
      (event) => events.push(event),
    );
    expect(outputs).toEqual({ change_set: { status: "ok" } });
    expect(value.host.agent.status).toBe("working");
    expect(events.some((event) => event.type === "running")).toBe(true);
    expect(
      (
        await new HarnessControlClient(
          controlDescriptorPath(value.lineage),
        ).nativeStop("NO_TOOL_CALL", true)
      ).nativeStop,
    ).toEqual({ decision: "allow" });
  } finally {
    await value.close();
  }
});

test("missing result becomes a bounded harness_contract_violation", async () => {
  const value = await fixture(1);
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    value.host.onPrompt = async () => {
      const client = new HarnessControlClient(
        controlDescriptorPath(value.lineage),
      );
      expect(
        (await client.nativeStop("NO_TOOL_CALL", true)).nativeStop,
      ).toMatchObject({
        decision: "continue",
        enforcementAttempt: 1,
      });
      expect(
        (await client.nativeStop("NO_TOOL_CALL", true)).nativeStop,
      ).toMatchObject({
        decision: "contract_violation",
        enforcementAttempt: 2,
      });
    };
    await expect(
      value.harness.sendInputAndCollect(
        value.dispatch,
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "harness_contract_violation" });
  } finally {
    await value.close();
  }
});

test("unsupported model or effort fails before interactive launch", async () => {
  const value = await fixture();
  try {
    value.dispatch.action.execution.configuration.reasoning = "low";
    await expect(
      value.harness.start(value.dispatch, value.lineage),
    ).rejects.toThrow("fallback is forbidden");
    expect(value.host.startRequests).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("native blocked state projects stable HumanAttention and takeover identity", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    value.registry.recordHost(value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      workspaceId: execution.ref.workspaceId,
      paneId: execution.ref.paneId,
      ...(execution.ref.terminalId
        ? { terminalId: execution.ref.terminalId }
        : {}),
      agentName: execution.ref.agentName,
      ...(value.host.agent.nativeSession
        ? { nativeSession: value.host.agent.nativeSession }
        : {}),
    });
    value.host.agent.status = "blocked";
    value.host.agent.message = "Approve native file edit?";
    const first = await value.harness.inspect(
      value.registry.getLineage(value.lineage.lineageId),
    );
    const second = await value.harness.inspect(
      value.registry.getLineage(value.lineage.lineageId),
    );
    expect(first).toMatchObject({
      state: "waiting_for_human",
      attention: {
        category: "unknown_interactive_block",
        message: "Approve native file edit?",
      },
    });
    expect(second.attention?.attentionId).toBe(first.attention?.attentionId);
  } finally {
    await value.close();
  }
});

test("recovery adopts only the exact surviving TUI and verified native conversation", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    value.registry.recordHost(value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      workspaceId: execution.ref.workspaceId,
      paneId: execution.ref.paneId,
      ...(execution.ref.terminalId
        ? { terminalId: execution.ref.terminalId }
        : {}),
      agentName: execution.ref.agentName,
      ...(value.host.agent.nativeSession
        ? { nativeSession: value.host.agent.nativeSession }
        : {}),
    });
    const persisted = value.registry.getLineage(value.lineage.lineageId);
    const restartedHarness = new AntigravityHarness(value.host, value.config, {
      runNativeCommand: value.runNativeCommand,
    });
    expect(await restartedHarness.recover(persisted)).toMatchObject({
      found: true,
      agent: { name: execution.ref.agentName },
    });
    value.host.agent.tokens = {
      ...value.host.agent.tokens,
      qe_ownership_token: "wrong",
    };
    value.host.removeAgentOnSnapshot = true;
    const relaunched = await value.harness.recover(persisted);
    expect(relaunched).toMatchObject({
      found: true,
      ref: { agentName: expect.stringContaining("qe-agy-") },
      agent: {
        nativeSession: { value: "conversation-1" },
      },
    });
    expect(value.host.startRequests.at(-1)?.args).toEqual(
      expect.arrayContaining(["--conversation", "conversation-1"]),
    );
  } finally {
    await value.close();
  }
});

test("a Worker restart can adopt exact active Antigravity terminal provenance", async () => {
  const value = await fixture();
  try {
    await value.harness.start(value.dispatch, value.lineage);
    await writeControlAtomic(value.lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: value.dispatch.action.worker_id,
      lineageId: value.lineage.lineageId,
      action: value.dispatch.action,
      nonce: value.dispatch.resultNonce,
      resultDirectory: value.dispatch.resultDirectory,
    });
    const candidates = await value.harness.discoverAdoptionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      action: { action_id: value.dispatch.action.action_id },
      lineage: {
        harnessKind: "antigravity",
        nativeSession: { value: "conversation-1" },
      },
    });
  } finally {
    await value.close();
  }
});

test("prompt keeps Class behavior separate and names only the semantic completion tool", async () => {
  const value = await fixture();
  try {
    const prompt = antigravityPromptFor(value.dispatch);
    expect(prompt).toContain("Class instructions:\nBuild carefully.");
    expect(prompt).toContain("qe_complete_step exactly once");
    expect(prompt).not.toContain("attempt-1");
    expect(prompt).not.toContain(HARNESS_CONTROL_PATH_ENV);
  } finally {
    await value.close();
  }
});

class FakeAntigravityHost implements TerminalSessionBackend {
  readonly backendKind = "herdr";
  readonly sessionName = "test-herdr";
  readonly startRequests: Array<{
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
  }> = [];
  readonly panes: HostedPane[];
  agent: HostedAgent;
  onPrompt: (() => Promise<void>) | null = null;
  removeAgentOnSnapshot = false;
  private environment: Record<string, string> = {};
  private pendingTokens: Record<string, string> = {};

  constructor(private readonly cwd: string) {
    this.panes = [
      {
        workspaceId: "workspace-1",
        tabId: "tab-1",
        paneId: "pane-1",
        terminalId: "terminal-1",
        cwd,
      },
    ];
    this.agent = this.newAgent("not-started", "pane-1", "terminal-1");
  }

  async snapshot(): Promise<HostedSnapshot> {
    return {
      workspaces: [{ workspaceId: "workspace-1" }],
      panes: [...this.panes],
      agents:
        this.startRequests.length > 0 && !this.removeAgentOnSnapshot
          ? [this.agent]
          : [],
    };
  }
  async createWorkspace(input: {
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane> {
    this.environment = input.environment;
    return this.panes[0] as HostedPane;
  }
  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    environment: Record<string, string>;
  }): Promise<HostedPane> {
    this.environment = input.environment;
    const pane = {
      workspaceId: input.workspaceId,
      tabId: `tab-${this.panes.length + 1}`,
      paneId: `pane-${this.panes.length + 1}`,
      terminalId: `terminal-${this.panes.length + 1}`,
      cwd: input.cwd,
    };
    this.panes.push(pane);
    return pane;
  }
  async reportMetadata(input: {
    paneId: string;
    title: string;
    tokens: Record<string, string>;
  }): Promise<void> {
    if (this.agent.paneId === input.paneId) this.agent.tokens = input.tokens;
    else this.pendingTokens = input.tokens;
  }
  async startAgent(input: {
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
  }): Promise<HostedAgent> {
    this.startRequests.push(input);
    const pane = this.panes.find(
      (item) => item.paneId === input.paneId,
    ) as HostedPane;
    this.agent = this.newAgent(
      input.name,
      pane.paneId,
      pane.terminalId as string,
    );
    this.agent.tokens = { ...this.pendingTokens };
    const descriptorPath = this.environment[HARNESS_CONTROL_PATH_ENV];
    const evidencePath = this.environment[QE_MCP_STARTUP_EVIDENCE_ENV];
    if (descriptorPath && evidencePath) {
      await readControlDescriptor(descriptorPath);
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          kind: "qe_harness_mcp_startup",
          pid: process.pid,
          descriptorPathHash: createHash("sha256")
            .update(descriptorPath)
            .digest("hex"),
          bridgeAcceptedContext: true,
        })}\n`,
      );
    }
    await writeFile(
      input.args[input.args.indexOf("--log-file") + 1] as string,
      "hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)\n",
    );
    this.removeAgentOnSnapshot = false;
    return this.agent;
  }
  async prompt(
    _target: string,
    _text: string,
    _options?: { until?: HostedAgentStatus[]; timeoutMs?: number },
  ): Promise<HostedAgent> {
    this.agent.status = "working";
    await this.onPrompt?.();
    return this.agent;
  }
  async observeAgentState(): Promise<HostedAgent> {
    return this.agent;
  }
  async inspectAgentState(): Promise<HostedAgent> {
    return this.agent;
  }
  async sendKeys(_target: string, _keys: string[]): Promise<void> {}
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
  disconnect(): void {}

  private newAgent(
    name: string,
    paneId: string,
    terminalId: string,
  ): HostedAgent {
    return {
      name,
      agent: "agy",
      status: "idle",
      paneId,
      terminalId,
      workspaceId: "workspace-1",
      tabId: "tab-1",
      interactiveReady: true,
      nativeSession: {
        source: "antigravity",
        agent: "agy",
        kind: "id",
        value: "conversation-1",
      },
      tokens: {},
    };
  }
}
