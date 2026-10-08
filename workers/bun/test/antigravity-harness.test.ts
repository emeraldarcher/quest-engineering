import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
} from "../src/dispatch/registry.ts";
import type {
  PreparedSbxHarnessExecution,
  SbxRunExecutionManager,
} from "../src/execution-environment/sbx-run.ts";
import type { HostLaunchDescriptor } from "../src/execution-environment/types.ts";
import {
  AntigravityHarness,
  antigravityPromptFor,
} from "../src/harnesses/antigravity/adapter.ts";
import {
  ANTIGRAVITY_TESTED_VERSION,
  discoverAntigravityModels,
  parseAntigravityModelCatalog,
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
import {
  nativeSessionIdentity,
  nativeSessionRef,
} from "../src/harnesses/native-session.ts";
import { terminalPreparedExecution } from "../src/harnesses/terminal-execution.ts";
import type {
  HarnessCapabilities,
  HarnessEvent,
} from "../src/harnesses/types.ts";
import { HerdrApiError } from "../src/session-host/herdr/client.ts";
import { paneProcessIdentityDigest } from "../src/session-host/pane-process-identity.ts";
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
} from "../src/session-host/types.ts";
import { action, recordTerminalExecution } from "./support.ts";

const roots: string[] = [];
const INITIAL_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const RETAINED_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const STALE_CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const EXPECTED_CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
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
    reasoning_capability:
      selection.reasoning === null
        ? { kind: "unsupported" }
        : { kind: "enumerated", values: [selection.reasoning ?? "high"] },
    tool_policy: { kind: "native_permissions" },
    tool_enforcement: "native_permissions",
    resolved_tool_profile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
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
        ? `${ANTIGRAVITY_TESTED_VERSION}\n`
        : args[0] === "--help"
          ? "--conversation --effort --log-file --model\n"
          : args[0] === "models"
            ? (selection.modelsOutput ??
              "gemini-test-high\tGemini Test (High)\n")
            : `qe stdio enabled ${process.execPath} ${resolve(import.meta.dir, "..", "src", "harnesses", "control", "mcp-server.ts")}\n`,
    stderr: "",
  });
  const installedHooks: unknown[] = [];
  const executionManager = {
    discoverAntigravity: async () =>
      discoverAntigravityModels(runNativeCommand),
    prepare: async (
      _dispatch: unknown,
      preparedLineage: typeof current,
      artifacts: PreparedSbxHarnessExecution["materializedArtifacts"],
    ) => {
      const controlRoot = dirname(preparedLineage.resultControlPath);
      const prepared = {
        lease: {
          ref: {
            workerId: "worker-test",
            runId: execute.run_id,
            environmentId: "environment-1",
            incarnation: "environment-incarnation-1",
          },
          paths: { state: join(root, "guest-state") },
        },
        workspace: {},
        harnessKind: "antigravity",
        guestExecutable: "/opt/qe/antigravity/agy",
        guestHome: join(root, "guest-home"),
        guestLogPath: join(controlRoot, "antigravity.log"),
        hostLogPath: join(controlRoot, "antigravity.log"),
        hostCwd: workspace,
        paneEnvironment: {
          [HARNESS_CONTROL_PATH_ENV]: controlDescriptorPath(preparedLineage),
          [QE_MCP_STARTUP_EVIDENCE_ENV]: join(controlRoot, "mcp-startup.jsonl"),
        },
        materializedArtifacts: artifacts,
        installAntigravityHook: async (spec: unknown) => {
          installedHooks.push(spec);
        },
        removeAntigravityHook: async () => undefined,
        proveAntigravityReadiness: async () => {
          if (!host.initialInputReady)
            throw new Error("synthetic TUI input manager is not ready");
          return {
            mcpChildReady: true as const,
            stopHookReady: true as const,
            initialInputReady: true as const,
            initialInput: readyInitialInputEvidence(
              execute.execution.configuration.model.model,
            ),
          };
        },
        syncControl: async () => undefined,
        launchDescriptor: async (args: readonly string[]) => ({
          executable: "/usr/local/bin/sbx",
          args: ["exec", "test-sandbox", "--", ...args],
          cwd: workspace,
          environment: {},
          provenance: {
            kind: "execution_environment",
            binding: {
              physicalLineageId: preparedLineage.lineageId,
              workspacePath: "/qe/workspaces/test",
              guestExecutable: "/opt/qe/antigravity/agy",
              guestCwd: "/qe/workspaces/test",
              guestArgvSha256: "test-argv",
            },
          },
        }),
        startRelay: () => undefined,
        awaitAttestation: async () => undefined,
        stopRelay: async () => undefined,
      };
      return prepared as unknown as PreparedSbxHarnessExecution;
    },
  } as unknown as SbxRunExecutionManager;
  const harness = new AntigravityHarness(host, config, {
    runNativeCommand,
    executionManager,
  });
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
    installedHooks,
    executionManager,
    async close() {
      await server.stop();
      registry.close();
    },
  };
}

test("tested Antigravity provenance is ready when its native contract passes", async () => {
  const result = await discoverAntigravityModels(
    antigravityDiscoveryRunner(ANTIGRAVITY_TESTED_VERSION),
  );
  expect(result).toMatchObject({
    installed: true,
    authenticated: true,
    compatible: true,
    version: ANTIGRAVITY_TESTED_VERSION,
    missingCapabilities: [],
  });
});

test("pre-authorization observation detects a native user turn without sending input", async () => {
  const value = await fixture();
  const logPath = join(
    value.root,
    "lineages",
    value.lineage.lineageId,
    "antigravity.log",
  );
  await appendFile(
    logPath,
    "I0918 19:06:44.382500 server.go:1786] Sending user message to conversation 1d48881c-5f10-43a0-9b87-234344a2dd8e (items=1, media=0)\n",
  );

  expect(
    await value.harness.observePreAuthorizationActivity(value.lineage),
  ).toMatchObject({
    nativeSession: nativeSessionRef(
      "antigravity",
      "id",
      "1d48881c-5f10-43a0-9b87-234344a2dd8e",
    ),
    evidence: "native_user_message",
  });
  await value.close();
});

test("pre-authorization observation fences a rejected native user message", async () => {
  const value = await fixture();
  try {
    await appendFile(
      join(value.root, "lineages", value.lineage.lineageId, "antigravity.log"),
      "SendUserMessage failed: no active conversation\n",
    );
    expect(
      await value.harness.observePreAuthorizationActivity(value.lineage),
    ).toMatchObject({
      nativeSession: null,
      evidence: "native_user_message",
    });
  } finally {
    await value.close();
  }
});

test("newer Antigravity provenance remains ready when its native contract passes", async () => {
  const result = await discoverAntigravityModels(
    antigravityDiscoveryRunner("1.2.8"),
  );
  expect(result).toMatchObject({
    authenticated: true,
    compatible: true,
    version: "1.2.8",
    missingCapabilities: [],
  });
  expect(result.diagnostics).toContainEqual(
    expect.stringContaining("newer than QE's human-tested 1.2.7 provenance"),
  );
});

test("newer Antigravity provenance missing a required native capability fails specifically", async () => {
  const result = await discoverAntigravityModels(
    antigravityDiscoveryRunner("1.2.8", "--conversation"),
  );
  expect(result.compatible).toBe(false);
  expect(result.missingCapabilities).toContain("native.conversation_resume");
  expect(result.diagnostics).toContainEqual(
    expect.stringContaining("native.conversation_resume"),
  );
});

test("malformed Antigravity version provenance fails closed without inference", async () => {
  const result = await discoverAntigravityModels(
    antigravityDiscoveryRunner("not-a-version"),
  );
  expect(result).toMatchObject({
    installed: true,
    authenticated: false,
    compatible: false,
    version: "not-a-version",
    missingCapabilities: ["native.version_provenance"],
  });
});

test("malformed Antigravity model metadata fails closed without inference", async () => {
  const run = antigravityDiscoveryRunner("1.2.8");
  const result = await discoverAntigravityModels(async (args) =>
    args[0] === "models"
      ? { exitCode: 0, stdout: "not-a-model-record\n", stderr: "" }
      : run(args),
  );
  expect(result).toMatchObject({
    authenticated: false,
    compatible: false,
    missingCapabilities: ["native.model_catalog"],
  });
  expect(result.diagnostics).toContainEqual(
    expect.stringContaining("malformed or empty native model metadata"),
  );
});

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
        accountAvailability: "verified_available",
        reasoningCapability: { kind: "unsupported" },
      },
      {
        provider: "antigravity",
        model: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
        accountAvailability: "verified_available",
        reasoningCapability: { kind: "enumerated", values: ["high"] },
      },
      {
        provider: "antigravity",
        model: "gemini-3.8-flash-low",
        displayName: "Gemini 3.8 Flash (Low)",
        accountAvailability: "verified_available",
        reasoningCapability: { kind: "enumerated", values: ["low"] },
      },
      {
        provider: "antigravity",
        model: "gemini-conflict-low",
        displayName: "Gemini Conflict (High)",
        accountAvailability: "verified_available",
        reasoningCapability: {
          kind: "unknown",
          detail: "conflicting native effort metadata",
        },
      },
    ],
    omitted: ["gemini-conflict-low"],
  });
});

test("Antigravity discovery still requires Herdr native observation integration", async () => {
  const value = await fixture();
  try {
    value.host.backendReadiness = {
      ...readyBackend("antigravity"),
      status: "incompatible",
      ready: false,
      missingCapabilities: ["integration.antigravity.current"],
      diagnostics: [
        {
          code: "missing_capability",
          capability: "integration.antigravity.current",
          message:
            "Herdr integration 'antigravity_cli' is not available and current.",
        },
      ],
    };
    const discovery = await value.harness.discover();
    expect(discovery.integration.status).toBe("missing_control_bridge");
    expect(discovery.integration.detail).toContain("antigravity_cli");
    expect(discovery.capabilities.structuredResult).toBe(false);
  } finally {
    await value.close();
  }
});

test("Antigravity discovery rejects missing explicit launch before SBX discovery", async () => {
  const value = await fixture();
  let sbxDiscoveries = 0;
  const discoverAntigravity = value.executionManager.discoverAntigravity.bind(
    value.executionManager,
  );
  value.executionManager.discoverAntigravity = async () => {
    sbxDiscoveries += 1;
    return discoverAntigravity();
  };
  try {
    value.host.backendReadiness = {
      ...readyBackend("antigravity"),
      status: "incompatible",
      ready: false,
      missingCapabilities: ["agent.explicit_launch"],
      diagnostics: [
        {
          code: "missing_capability",
          capability: "agent.explicit_launch",
          message:
            "Herdr cannot prove generic exact managed launch support in both live capabilities and agent.start schema metadata.",
        },
      ],
    };
    const discovery = await value.harness.discover();
    expect(discovery).toMatchObject({
      integration: {
        status: "incompatible_version",
        authenticated: false,
      },
      models: [],
      capabilities: { structuredResult: false },
    });
    expect(discovery.integration.detail).toContain(
      "generic exact managed launch support",
    );
    expect(sbxDiscoveries).toBe(0);
    expect(value.host.startRequests).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("Antigravity has no host-native execution fallback", async () => {
  const value = await fixture();
  try {
    const withoutBoundary = new AntigravityHarness(value.host, value.config, {
      runNativeCommand: value.runNativeCommand,
    });
    await expect(
      withoutBoundary.start(value.dispatch, value.lineage),
    ).rejects.toThrow("immutable mixed SBX profile");
    expect(value.host.startRequests).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("interactive launch pins model and effort, proves readiness, and keeps the live TUI attachable", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    expect(value.host.startRequests).toHaveLength(1);
    expect(Object.keys(value.host.agent.tokens ?? {})).toHaveLength(16);
    expect(value.host.agent.tokens?.qe_environment_hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(value.host.agent.tokens?.qe_agent_name).toBe(
      execution.ref.agentName,
    );
    expect(value.host.agent.tokens?.qe_action_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(value.host.agent.tokens?.qe_occurrence_hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(value.host.agent.tokens?.qe_attempt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(value.host.startRequests[0]?.args.includes("--print")).toBe(false);
    expect(value.host.startRequests[0]?.args.includes("--tools")).toBe(false);
    expect(value.host.startRequests[0]?.args.includes("--sandbox")).toBe(false);
    expect(
      value.host.startRequests[0]?.args.includes(
        "--dangerously-skip-permissions",
      ),
    ).toBe(true);
    expect(value.host.startRequests[0]).toMatchObject({
      integrationKind: "agy",
      command: {
        executable: "/usr/local/bin/sbx",
        provenance: {
          binding: {
            guestExecutable: "/opt/qe/antigravity/agy",
          },
        },
      },
      args: expect.arrayContaining([
        "--model",
        "gemini-test-high",
        "--effort",
        "high",
      ]),
    });
    expect(
      await Bun.file(join(value.workspace, ".agents", "hooks.json")).exists(),
    ).toBe(false);
    expect(value.installedHooks).toContainEqual(
      expect.objectContaining({
        name: "qe-worker-stop-v1",
        event: "Stop",
        command: expect.stringContaining("hook stop"),
      }),
    );
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    recordTerminalExecution(value.registry, value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      herdrSessionIncarnation: execution.ref.sessionIncarnation as string,
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
      paneId: execution.ref.paneId,
      supportsObservation: true,
      supportsTakeover: true,
    });
  } finally {
    await value.close();
  }
});

test("inference authorization keeps the prepared MCP child across descriptor rotation", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    const descriptorPath = controlDescriptorPath(value.lineage);
    const before = await readControlDescriptor(descriptorPath);
    value.registry.updateSession(value.lineage.lineageId, "waiting_for_human", {
      attentionId: "authorize-inference",
      category: "needs_confirmation",
      message: "Authorize Builder inference.",
      requestedAt: new Date().toISOString(),
    });

    value.registry.updateSession(value.lineage.lineageId, "starting", null);
    await value.authority.bind(value.dispatch, value.lineage);
    const after = await readControlDescriptor(descriptorPath);
    expect(after.contextToken).not.toBe(before.contextToken);

    const evidencePath = value.host.environment[QE_MCP_STARTUP_EVIDENCE_ENV];
    if (!evidencePath)
      throw new Error("fixture has no MCP startup evidence path");
    const startup = JSON.parse(
      (await Bun.file(evidencePath).text()).trim(),
    ) as Record<string, unknown>;
    await writeFile(
      evidencePath,
      `${JSON.stringify({ ...startup, recordedAt: "2000-01-01T00:00:00.000Z" })}\n`,
    );

    await value.harness.ready(value.dispatch, execution);
    expect(value.host.startRequests).toHaveLength(1);
    value.host.onPrompt = async () => {
      await new HarnessControlClient(descriptorPath).completeStep({
        change_set: { status: "authorized" },
      });
    };
    const authorized = authorizePrompt(value);
    expect(
      await value.harness.sendInputAndCollect(
        authorized,
        execution,
        () => undefined,
      ),
    ).toEqual({ change_set: { status: "authorized" } });
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.promptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("fresh lineage submits through the existing TUI and captures its native identity", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    expect(execution.agent.nativeSession).toBeUndefined();
    await value.harness.ready(value.dispatch, execution);
    const readiness = JSON.parse(
      await Bun.file(
        join(
          value.root,
          "lineages",
          value.lineage.lineageId,
          "pre-inference-readiness.json",
        ),
      ).text(),
    );
    expect(readiness).toMatchObject({
      conversationState: "none",
      initialInputReady: true,
      initialInputTransport: "herdr_pane_bracketed_paste",
      mcpChildReady: true,
      stopHookReady: true,
    });
    await value.authority.bind(value.dispatch, value.lineage);
    value.host.onPrompt = async () => {
      await new HarnessControlClient(
        controlDescriptorPath(value.lineage),
      ).completeStep({ change_set: { status: "initial" } });
    };
    const events: HarnessEvent[] = [];
    const authorized = authorizePrompt(value);
    const outputs = await value.harness.sendInputAndCollect(
      authorized,
      execution,
      (event) => events.push(event),
    );
    expect(outputs).toEqual({ change_set: { status: "initial" } });
    expect(value.host.startRequests).toHaveLength(1);
    expect(Object.keys(value.host.agent.tokens ?? {})).toHaveLength(16);
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.promptCalls).toBe(0);
    expect(
      events.find((event) => event.type === "prompt_baseline")?.evidence.cursor,
    ).toBeGreaterThan(0);
    const staged = value.host.stagedPromptInputs[0]?.text;
    expect(staged).toContain(antigravityPromptFor(value.dispatch));
    expect(staged?.startsWith("\u001b[200~")).toBe(true);
    expect(staged?.endsWith("\u001b[201~")).toBe(true);
    expect(
      events.find((event) => event.type === "prompt_accepted")?.inspection
        .nativeSession,
    ).toEqual(nativeSessionRef("antigravity", "id", INITIAL_CONVERSATION_ID));
  } finally {
    await value.close();
  }
});

test("uncertain submit acknowledgement reconciles native acceptance without resubmission", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    value.host.submitError = new HerdrApiError(
      "timeout",
      "synthetic submit acknowledgement loss",
    );
    value.host.onPrompt = async () => {
      await new HarnessControlClient(
        controlDescriptorPath(value.lineage),
      ).completeStep({ change_set: { status: "reconciled" } });
    };
    expect(
      await value.harness.sendInputAndCollect(
        authorizePrompt(value),
        execution,
        () => undefined,
      ),
    ).toEqual({ change_set: { status: "reconciled" } });
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.promptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("retained conversation selects exact continuation prompt transport", async () => {
  const value = await fixture();
  try {
    const started = await value.harness.start(value.dispatch, value.lineage);
    value.host.establishConversation(RETAINED_CONVERSATION_ID);
    const nativeSession = value.host.agent.nativeSession;
    if (!nativeSession) throw new Error("fixture conversation was not created");
    const lineage = { ...started.lineage, nativeSession };
    const execution = terminalPreparedExecution(
      lineage,
      value.host.backendKind,
      { ...started.ref, nativeSession },
      value.host.agent,
      value.harness.capabilities,
    );
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, lineage);
    value.host.onPrompt = async () => {
      await new HarnessControlClient(
        controlDescriptorPath(lineage),
      ).completeStep({
        change_set: { status: "continued" },
      });
    };
    expect(
      await value.harness.sendInputAndCollect(
        authorizePrompt(value),
        execution,
        () => undefined,
      ),
    ).toEqual({ change_set: { status: "continued" } });
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.promptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("interactive first-message rejection records no native acceptance or provider cycle", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    value.host.autoNativeAcceptance = false;
    value.host.onPrompt = () =>
      value.host.appendNativeRejection("no active conversation");
    const events: HarnessEvent[] = [];
    await expect(
      value.harness.sendInputAndCollect(
        authorizePrompt(value),
        execution,
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      code: "antigravity_initial_dispatch_failed",
      evidence: { provider_cycles: 0 },
    });
    expect(events.map((event) => event.type)).toEqual(["prompt_baseline"]);
    expect(value.host.promptCalls).toBe(0);
    expect(value.host.agent.nativeSession).toBeUndefined();
  } finally {
    await value.close();
  }
});

test("post-intent recovery keeps native interactive rejection explicit", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    value.registry.recordPromptEvidence(value.dispatch.action.action_id, {
      kind: "antigravity_log",
      cursor: 0,
      promptHash: createHash("sha256")
        .update(antigravityPromptFor(value.dispatch))
        .digest("hex"),
    });
    value.registry.markPromptIntent(value.dispatch.action.action_id);
    await value.host.appendNativeRejection("no active conversation");
    await expect(
      value.harness.waitAndCollect(
        value.registry.get(value.dispatch.action.action_id),
        execution.lineage,
        execution.handle,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "antigravity_initial_dispatch_failed",
      evidence: { provider_cycles: 0 },
    });
  } finally {
    await value.close();
  }
});

test("retained conversation identity fails closed when stale or from another PhysicalLineage", async () => {
  const stale = await fixture();
  try {
    const started = await stale.harness.start(stale.dispatch, stale.lineage);
    stale.host.establishConversation(STALE_CONVERSATION_ID);
    const lineage = {
      ...started.lineage,
      nativeSession: nativeSessionRef(
        "antigravity",
        "id",
        EXPECTED_CONVERSATION_ID,
      ),
    };
    await expect(
      stale.harness.ready(
        stale.dispatch,
        terminalPreparedExecution(
          lineage,
          stale.host.backendKind,
          started.ref,
          stale.host.agent,
          stale.harness.capabilities,
        ),
      ),
    ).rejects.toMatchObject({
      code: "antigravity_conversation_identity_mismatch",
    });

    stale.host.establishConversation(EXPECTED_CONVERSATION_ID);
    stale.host.agent.tokens = {
      ...stale.host.agent.tokens,
      qe_lineage_id: "another-physical-lineage",
    };
    await expect(
      stale.harness.continue(stale.dispatch, lineage),
    ).rejects.toThrow("missing or has incompatible provenance");
  } finally {
    await stale.close();
  }
});

test("cancellation before first message leaves fresh readiness conversation-free", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await value.harness.close(execution.lineage);
    expect(value.host.stagedPromptCalls).toBe(0);
    expect(value.host.submitPromptCalls).toBe(0);
    expect(value.host.promptCalls).toBe(0);
    expect(value.host.agent.nativeSession).toBeUndefined();
  } finally {
    await value.close();
  }
});

test("preauthorization interactive prompt input is structurally rejected", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await expect(
      value.harness.sendInputAndCollect(
        value.dispatch,
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "antigravity_prompt_not_authorized" });
    expect(value.host.stagedPromptCalls).toBe(0);
    expect(value.host.submitPromptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("input readiness is independent from a live TUI and fails before authorization", async () => {
  const value = await fixture();
  try {
    value.host.initialInputReady = false;
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await expect(
      value.harness.ready(value.dispatch, execution),
    ).rejects.toThrow("input manager is not ready");
    expect(value.host.stagedPromptCalls).toBe(0);
    expect(value.host.submitPromptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("stale pane, process, and endpoint generation fail before literal input", async () => {
  const stalePane = await fixture();
  try {
    const execution = await stalePane.harness.start(
      stalePane.dispatch,
      stalePane.lineage,
    );
    await stalePane.harness.ready(stalePane.dispatch, execution);
    await expect(
      stalePane.harness.sendInputAndCollect(
        authorizePrompt(stalePane),
        terminalPreparedExecution(
          execution.lineage,
          stalePane.host.backendKind,
          { ...execution.ref, paneId: "stale-pane" },
          { ...execution.agent, paneId: "stale-pane" },
          stalePane.harness.capabilities,
        ),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "antigravity_prompt_input_fence_failed" });
    expect(stalePane.host.stagedPromptCalls).toBe(0);
  } finally {
    await stalePane.close();
  }

  const staleGeneration = await fixture();
  try {
    const execution = await staleGeneration.harness.start(
      staleGeneration.dispatch,
      staleGeneration.lineage,
    );
    await staleGeneration.harness.ready(staleGeneration.dispatch, execution);
    staleGeneration.host.backendReadiness = {
      ...staleGeneration.host.backendReadiness,
      provenance: {
        ...staleGeneration.host.backendReadiness.provenance,
        endpointGeneration: 2,
      },
    };
    await expect(
      staleGeneration.harness.sendInputAndCollect(
        authorizePrompt(staleGeneration),
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "antigravity_prompt_input_fence_failed" });
    expect(staleGeneration.host.stagedPromptCalls).toBe(0);
    expect(staleGeneration.host.submitPromptCalls).toBe(0);
  } finally {
    await staleGeneration.close();
  }

  const staleProcess = await fixture();
  try {
    const execution = await staleProcess.harness.start(
      staleProcess.dispatch,
      staleProcess.lineage,
    );
    await staleProcess.harness.ready(staleProcess.dispatch, execution);
    staleProcess.host.foregroundProcessGroupId = 5252;
    await expect(
      staleProcess.harness.sendInputAndCollect(
        authorizePrompt(staleProcess),
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "antigravity_prompt_input_fence_failed" });
    expect(staleProcess.host.stagedPromptCalls).toBe(0);
    expect(staleProcess.host.submitPromptCalls).toBe(0);
  } finally {
    await staleProcess.close();
  }
});

test("authorization transition records a deterministic pre-write fence rejection", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    value.host.stageAuthorityError = new HerdrApiError(
      "input_authority_mismatch",
      "Synthetic secret-safe prompt-input fence rejection.",
      "terminal.authorized_prompt_input",
      {
        mismatchFields: ["result_nonce"],
        sideEffect: "none",
      },
    );

    const error = await value.harness
      .sendInputAndCollect(authorizePrompt(value), execution, () => undefined)
      .catch((caught) => caught);
    expect(error).toMatchObject({
      code: "antigravity_prompt_input_fence_failed",
      evidence: {
        provider_cycles: 0,
        input_fence_mismatch_fields: ["result_nonce"],
        input_side_effect: "none",
      },
    });
    const submission = JSON.parse(
      await readFile(
        join(
          dirname(execution.lineage.resultControlPath),
          "interactive-prompt-submission.json",
        ),
        "utf8",
      ),
    );
    expect(submission).toMatchObject({
      phase: "text_stage_rejected",
      fenceMismatchFields: ["result_nonce"],
    });
    expect(submission.textStageRequestedAt).toBeString();
    expect(submission.textStageRejectedAt).toBeString();
    expect(submission.textStagedAt).toBeUndefined();
    expect(value.host.stagedPromptCalls).toBe(0);
    expect(value.host.submitPromptCalls).toBe(0);
    expect(value.host.promptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("process replacement after text staging prevents the separate Enter action", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    value.host.onStage = () => {
      value.host.foregroundProcessGroupId = 5252;
    };
    await expect(
      value.harness.sendInputAndCollect(
        authorizePrompt(value),
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "agent_prompt_uncertain" });
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(0);
  } finally {
    await value.close();
  }
});

test("duplicate prompt submit is rejected and the same TUI process remains", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    const processBefore = await value.host.inspectPaneProcess(
      execution.ref.paneId,
    );
    value.host.onPrompt = async () => {
      await new HarnessControlClient(
        controlDescriptorPath(value.lineage),
      ).completeStep({ change_set: { status: "once" } });
    };
    const authorized = authorizePrompt(value);
    expect(
      await value.harness.sendInputAndCollect(
        authorized,
        execution,
        () => undefined,
      ),
    ).toEqual({ change_set: { status: "once" } });
    await expect(
      value.harness.sendInputAndCollect(authorized, execution, () => undefined),
    ).rejects.toMatchObject({ code: "antigravity_duplicate_prompt_rejected" });
    const processAfter = await value.host.inspectPaneProcess(
      execution.ref.paneId,
    );
    expect(value.host.startRequests).toHaveLength(1);
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(processAfter.foregroundProcessGroupId).toBe(
      processBefore.foregroundProcessGroupId,
    );
  } finally {
    await value.close();
  }
});

test("prepared pre-prompt Antigravity adoption requires exact idle conversation-free provenance", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    delete value.host.agent.nativeSession;
    value.host.agent.cwd = value.workspace;
    recordTerminalExecution(value.registry, value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      herdrSessionIncarnation: execution.ref.sessionIncarnation as string,
      workspaceId: execution.ref.workspaceId,
      ...(execution.ref.tabId ? { tabId: execution.ref.tabId } : {}),
      paneId: execution.ref.paneId,
      ...(execution.ref.terminalId
        ? { terminalId: execution.ref.terminalId }
        : {}),
      agentName: execution.ref.agentName,
    });
    value.registry.occupy(
      value.lineage.lineageId,
      value.dispatch.action.action_id,
    );
    const source = value.registry.fail(value.dispatch.action.action_id, {
      code: "execution_control_readiness_failed",
      classification: "operator_recovery_required",
    });
    const targetAction = action({
      action_id: "prepared-target",
      attempt_id: "prepared-attempt-4",
      operational_recovery: {
        epoch_number: 3,
        attempt_in_epoch: 1,
        attempt_allowance: 2,
        authorization_kind: "human",
        continuation_mode: "retained",
        retained_lineage_id: value.lineage.lineageId,
        source_attempt_id: source.action.attempt_id,
        request_id: "prepared-adoption-request",
      },
    });
    targetAction.execution.configuration = {
      ...source.action.execution.configuration,
    };
    targetAction.execution.execution_workspace = {
      ...source.action.execution.execution_workspace,
    };
    targetAction.execution.logical_workspace = {
      ...source.action.execution.logical_workspace,
    };
    targetAction.execution.context.logical_lineage_id =
      source.action.execution.context.logical_lineage_id;
    const target = value.registry.accept(targetAction).dispatch;
    value.registry.occupy(value.lineage.lineageId, target.action.action_id);
    const retained = value.registry.getLineage(value.lineage.lineageId);
    await value.authority.bind(target, retained);

    await value.harness.provePreparedProcessAdoption(source, target, retained);

    const readinessPath = join(
      value.root,
      "lineages",
      value.lineage.lineageId,
      "pre-inference-readiness.json",
    );
    const readiness = await Bun.file(readinessPath).text();
    const legacy = JSON.parse(readiness) as {
      version: number;
      nativeInputReadiness: { version: number };
    };
    legacy.version = 3;
    legacy.nativeInputReadiness.version = 1;
    await Bun.write(readinessPath, `${JSON.stringify(legacy)}\n`);
    await expect(
      value.harness.provePreparedProcessAdoption(source, target, retained),
    ).rejects.toMatchObject({ code: "prepared_process_adoption_rejected" });
    await Bun.write(readinessPath, "{}\n");
    await expect(
      value.harness.provePreparedProcessAdoption(source, target, retained),
    ).rejects.toMatchObject({ code: "prepared_process_adoption_rejected" });
    await Bun.write(readinessPath, readiness);

    value.host.agent.status = "working";
    await expect(
      value.harness.provePreparedProcessAdoption(source, target, retained),
    ).rejects.toMatchObject({ code: "prepared_process_adoption_rejected" });
  } finally {
    await value.close();
  }
});

test("fresh retained-work recovery uses the same generic launch contract as a normal Attempt", async () => {
  const normal = await fixture();
  const recovery = await fixture();
  recovery.dispatch.action.operational_recovery = {
    epoch_number: 1,
    attempt_in_epoch: 1,
    attempt_allowance: 2,
    authorization_kind: "human",
    continuation_mode: "fresh",
    retained_lineage_id: null,
    source_attempt_id: "attempt-1",
    request_id: "recovery-request",
  };
  try {
    await normal.harness.start(normal.dispatch, normal.lineage);
    await recovery.harness.start(recovery.dispatch, recovery.lineage);
    const normalizeArgs = (args: string[]) =>
      args.map((value, index) =>
        args[index - 1] === "--log-file" ? "<lineage-log>" : value,
      );
    expect(normalizeArgs(normal.host.startRequests[0]?.args ?? [])).toEqual(
      normalizeArgs(recovery.host.startRequests[0]?.args ?? []),
    );
    expect(Object.keys(normal.host.environment).sort()).toEqual(
      Object.keys(recovery.host.environment).sort(),
    );
    expect(recovery.installedHooks).toHaveLength(1);
    expect(normal.installedHooks).toHaveLength(1);
    expect(recovery.installedHooks[0]).toMatchObject({
      name: "qe-worker-stop-v1",
      event: "Stop",
      command: expect.stringContaining("antigravity-control/bridge-cli.mjs"),
    });
  } finally {
    await Promise.all([normal.close(), recovery.close()]);
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

test("Antigravity accepts only resolved native-permissions policy", async () => {
  const exact = await fixture();
  exact.dispatch.action.execution.configuration.tool_enforcement = "exact";
  try {
    await expect(
      exact.harness.start(exact.dispatch, exact.lineage),
    ).rejects.toThrow("native-permissions policy");
  } finally {
    await exact.close();
  }

  const partial = await fixture();
  partial.dispatch.action.execution.configuration.tool_policy = {
    kind: "exact",
    tools: ["workspace.filesystem"],
  };
  try {
    await expect(
      partial.harness.start(partial.dispatch, partial.lineage),
    ).rejects.toThrow("native-permissions policy");
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
      authorizePrompt(value),
      execution,
      (event) => events.push(event),
    );
    expect(outputs).toEqual({ change_set: { status: "ok" } });
    expect(value.host.agent.status).toBe("working");
    expect(events.some((event) => event.type === "prompt_accepted")).toBe(true);
    expect(
      events.some((event) => event.type === "structured_result_received"),
    ).toBe(true);
    expect(value.host.promptOptions).toBeUndefined();
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

test("accepted native prompt waits for structured completion without resubmission", async () => {
  const value = await fixture();
  try {
    value.config.promptActivityStallMs = 5;
    const execution = await value.harness.start(value.dispatch, value.lineage);
    await value.harness.ready(value.dispatch, execution);
    await value.authority.bind(value.dispatch, value.lineage);
    let nativeTurn: Promise<void> | null = null;
    value.host.onPrompt = async () => {
      nativeTurn = (async () => {
        await Bun.sleep(150);
        await new HarnessControlClient(
          controlDescriptorPath(value.lineage),
        ).completeStep({ change_set: { status: "delayed" } });
      })();
    };
    const events: HarnessEvent[] = [];
    const outputs = await value.harness.sendInputAndCollect(
      authorizePrompt(value),
      execution,
      (event) => events.push(event),
    );
    await nativeTurn;

    expect(outputs).toEqual({ change_set: { status: "delayed" } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "prompt_accepted",
        "native_activity",
        "structured_result_received",
      ]),
    );
    expect(events.some((event) => event.type === "stalled")).toBe(false);
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.promptCalls).toBe(0);
    expect(value.host.promptOptions).toBeUndefined();
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
        authorizePrompt(value),
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "harness_contract_violation" });
    expect(value.host.startRequests).toHaveLength(1);
    expect(value.host.stagedPromptCalls).toBe(1);
    expect(value.host.submitPromptCalls).toBe(1);
    expect(value.host.foregroundProcessGroupId).toBe(4242);
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
    recordTerminalExecution(value.registry, value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      herdrSessionIncarnation: execution.ref.sessionIncarnation as string,
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

test("recovery adopts only the exact surviving SBX TUI and never host-relaunches it", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    recordTerminalExecution(value.registry, value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      herdrSessionIncarnation: execution.ref.sessionIncarnation as string,
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
      executionManager: value.executionManager,
    });
    expect(
      await restartedHarness.recover(persisted, value.dispatch),
    ).toMatchObject({
      found: true,
      handle: {
        harnessKind: "antigravity",
        transportBinding: {
          kind: "terminal",
          payload: { ref: { agentName: execution.ref.agentName } },
        },
      },
      inspection: {
        activity: { state: "idle" },
        interactive: { kind: "terminal", processIdentity: "verified" },
      },
    });
    value.host.sessionIncarnationId = "replacement-session-incarnation";
    value.host.removeAgentOnSnapshot = true;
    const launches = value.host.startRequests.length;
    const relaunched = await value.harness.recover(persisted, value.dispatch);
    expect(relaunched).toMatchObject({
      found: false,
      detail: expect.stringContaining("another Herdr session incarnation"),
    });
    expect(value.host.startRequests).toHaveLength(launches);
  } finally {
    await value.close();
  }
});

test("post-intent recovery reconstructs native conversation identity from the append-only log", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    recordTerminalExecution(value.registry, value.lineage.lineageId, {
      herdrSession: execution.ref.sessionName,
      herdrSessionIncarnation: execution.ref.sessionIncarnation as string,
      workspaceId: execution.ref.workspaceId,
      paneId: execution.ref.paneId,
      ...(execution.ref.terminalId
        ? { terminalId: execution.ref.terminalId }
        : {}),
      agentName: execution.ref.agentName,
    });
    value.host.establishConversation(INITIAL_CONVERSATION_ID);
    await value.host.appendNativeAcceptance(INITIAL_CONVERSATION_ID);
    delete value.host.agent.nativeSession;
    const persisted = value.registry.getLineage(value.lineage.lineageId);
    const recovered = await value.harness.recover(persisted, {
      ...value.dispatch,
      promptIntentAt: new Date().toISOString(),
    });
    expect(recovered).toMatchObject({
      found: true,
      handle: {
        harnessKind: "antigravity",
        nativeSession: nativeSessionRef(
          "antigravity",
          "id",
          INITIAL_CONVERSATION_ID,
        ),
      },
      inspection: {
        nativeSession: nativeSessionRef(
          "antigravity",
          "id",
          INITIAL_CONVERSATION_ID,
        ),
        interactive: { kind: "terminal", processIdentity: "verified" },
      },
    });
  } finally {
    await value.close();
  }
});

test("a Worker restart can adopt exact active Antigravity terminal provenance", async () => {
  const value = await fixture();
  try {
    await value.harness.start(value.dispatch, value.lineage);
    value.host.establishConversation(INITIAL_CONVERSATION_ID);
    await value.host.appendNativeAcceptance(INITIAL_CONVERSATION_ID);
    delete value.host.agent.nativeSession;
    await writeControlAtomic(value.lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: value.dispatch.action.worker_id,
      lineageId: value.lineage.lineageId,
      action: value.dispatch.action,
      nonce: value.dispatch.resultNonce,
      resultDirectory: value.dispatch.resultDirectory,
    });
    delete value.host.agent.name;
    delete value.host.agent.tokens?.qe_action_hash;
    const candidates = await value.harness.discoverAdoptionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      action: { action_id: value.dispatch.action.action_id },
      lineage: {
        harnessKind: "antigravity",
        nativeSession: nativeSessionRef(
          "antigravity",
          "id",
          INITIAL_CONVERSATION_ID,
        ),
      },
    });
  } finally {
    await value.close();
  }
});

test("fresh recovery requires authoritative native-process absence", async () => {
  const value = await fixture();
  try {
    const execution = await value.harness.start(value.dispatch, value.lineage);
    const sourceLineage = {
      ...execution.lineage,
      agentName: execution.ref.agentName,
      paneId: execution.ref.paneId,
      terminalId: execution.ref.terminalId ?? null,
      workspaceId: execution.ref.workspaceId,
      tabId: execution.ref.tabId ?? null,
    };
    expect(
      await value.harness.proveInactiveForFreshRecovery(sourceLineage),
    ).toBe(false);

    value.host.inspectError = new HerdrApiError(
      "agent_not_found",
      "The source agent exited.",
    );
    expect(
      await value.harness.proveInactiveForFreshRecovery(sourceLineage),
    ).toBe(true);

    value.host.inspectError = new HerdrApiError(
      "backend_unavailable",
      "Herdr is unavailable.",
    );
    await expect(
      value.harness.proveInactiveForFreshRecovery(sourceLineage),
    ).rejects.toThrow("Herdr is unavailable");
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

test("fresh retained-work recovery tells Antigravity to preserve the diff and complete normally", async () => {
  const value = await fixture();
  try {
    const prompt = antigravityPromptFor({
      action: {
        ...value.dispatch.action,
        operational_recovery: {
          epoch_number: 1,
          attempt_in_epoch: 1,
          attempt_allowance: 2,
          authorization_kind: "human",
          continuation_mode: "fresh",
          retained_lineage_id: null,
          source_attempt_id: value.dispatch.action.attempt_id,
          request_id: "fresh-recovery-request",
        },
      },
    });
    expect(prompt).toContain("retained-work recovery");
    expect(prompt).toContain(
      "no native coding-agent conversation is being continued",
    );
    expect(prompt).toContain("Do not reset, clean, overwrite");
    expect(prompt).toContain("qe_complete_step exactly once");
  } finally {
    await value.close();
  }
});

function authorizePrompt(value: {
  registry: DispatchRegistry;
  dispatch: DispatchRecord;
}): DispatchRecord {
  value.registry.authorizePrompt(value.dispatch.action.action_id);
  value.registry.markPromptIntent(value.dispatch.action.action_id);
  return value.registry.get(value.dispatch.action.action_id);
}

function readyInitialInputEvidence(model: string) {
  return {
    kind: "antigravity_initial_input_readiness" as const,
    version: 2 as const,
    tuiInputReady: true,
    freshConversationReady: true,
    ready: true,
    nativeConversationBootstrap: "ready_without_conversation" as const,
    conversationState: "none" as const,
    model,
    signals: {
      cli_input_loop: 1,
      empty_conversation_render: 2,
      authentication: 3,
      cli_startup: 4,
      code_assist: 5,
      model_catalog: 6,
      model_resolution: 7,
      post_login_experiments: 8,
      post_login_code_assist: 9,
      post_login_model_resolution: 10,
      post_model_experiments: 11,
      customization_reload: 12,
    },
    missingSignals: [],
    missingFreshConversationRequirements: [],
    nativeState: {
      project: {
        ready: true,
        resolvedProjectId: "default-cli-project",
        defaultProject: true,
        cacheWritable: true,
        configPresent: true,
        configWritable: true,
        conversationStoreWritable: true,
        workspaceResolved: true,
      },
      prompt: {
        focusReady: true,
        editorMode: "default" as const,
        enterBinding: "prompt.submit" as const,
        customKeybindingsPresent: false,
      },
    },
  };
}

function antigravityDiscoveryRunner(version: string, omittedHelpFlag?: string) {
  return async (args: string[]) => ({
    exitCode: 0,
    stdout:
      args[0] === "--version"
        ? `${version}\n`
        : args[0] === "--help"
          ? ["--conversation", "--effort", "--log-file", "--model"]
              .filter((flag) => flag !== omittedHelpFlag)
              .join(" ")
          : "gemini-test-high\tGemini Test (High)\n",
    stderr: "",
  });
}

class FakeAntigravityHost implements TerminalSessionBackend {
  readonly backendKind = "herdr";
  readonly sessionName = "test-herdr";
  sessionIncarnationId = "test-session-incarnation";
  sessionIncarnation() {
    return this.sessionIncarnationId;
  }
  readonly startRequests: Array<{
    paneId: string;
    name: string;
    integrationKind: string;
    args: string[];
    command?: HostLaunchDescriptor;
  }> = [];
  readonly panes: HostedPane[];
  agent: HostedAgent;
  onPrompt: (() => Promise<void>) | null = null;
  onStage: (() => Promise<void> | void) | null = null;
  promptOptions:
    | { until?: HostedAgentStatus[]; timeoutMs?: number }
    | undefined;
  promptCalls = 0;
  prompts: string[] = [];
  stagedPromptCalls = 0;
  stagedPromptInputs: InteractivePromptInput[] = [];
  submitPromptCalls = 0;
  submittedAuthorities: InteractivePromptAuthority[] = [];
  autoNativeAcceptance = true;
  initialInputReady = true;
  stageAuthorityError: HerdrApiError | null = null;
  stageError: Error | null = null;
  submitError: Error | null = null;
  foregroundProcessGroupId = 4242;
  private logPath: string | null = null;
  removeAgentOnSnapshot = false;
  inspectError: Error | null = null;
  backendReadiness = readyBackend("antigravity");
  environment: Record<string, string> = {};
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

  async readiness(): Promise<SessionBackendReadiness> {
    return this.backendReadiness;
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
    command?: HostLaunchDescriptor;
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
          recordedAt: new Date().toISOString(),
        })}\n`,
      );
    }
    this.logPath = input.args[input.args.indexOf("--log-file") + 1] as string;
    await writeFile(
      this.logPath,
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
    this.promptCalls += 1;
    this.prompts.push(_text);
    this.promptOptions = _options;
    return this.agent;
  }
  async inspectPaneProcess(paneId: string): Promise<HostedPaneProcessInfo> {
    return {
      paneId,
      shellPid: 100,
      foregroundProcessGroupId: this.foregroundProcessGroupId,
      tty: "/dev/ttys001",
      foregroundProcesses: [
        {
          pid: 101,
          name: "agy",
          argv: ["/opt/qe/antigravity/agy"],
          cwd: this.cwd,
        },
      ],
    };
  }
  async stageInteractivePrompt(input: InteractivePromptInput): Promise<void> {
    if (this.stageAuthorityError) throw this.stageAuthorityError;
    if (
      input.authority.herdrEndpointGeneration !==
        this.backendReadiness.provenance.endpointGeneration ||
      input.authority.herdrServerGeneration !==
        this.backendReadiness.provenance.serverGeneration
    )
      throw new HerdrApiError(
        "input_authority_stale",
        "synthetic endpoint generation mismatch",
      );
    const process = await this.inspectPaneProcess(input.authority.paneId);
    if (
      input.authority.paneShellPid !== process.shellPid ||
      input.authority.paneForegroundProcessGroupId !==
        process.foregroundProcessGroupId ||
      input.authority.paneProcessIdentityDigest !==
        paneProcessIdentityDigest(process)
    )
      throw new HerdrApiError(
        "input_authority_mismatch",
        "synthetic pane process identity mismatch",
      );
    this.stagedPromptCalls += 1;
    this.stagedPromptInputs.push(input);
    if (this.stageError) throw this.stageError;
    await this.onStage?.();
  }
  async submitInteractivePrompt(
    authority: InteractivePromptAuthority,
  ): Promise<void> {
    const process = await this.inspectPaneProcess(authority.paneId);
    if (
      authority.paneShellPid !== process.shellPid ||
      authority.paneForegroundProcessGroupId !==
        process.foregroundProcessGroupId ||
      authority.paneProcessIdentityDigest !== paneProcessIdentityDigest(process)
    )
      throw new HerdrApiError(
        "input_authority_mismatch",
        "synthetic pane process identity mismatch",
      );
    this.submitPromptCalls += 1;
    this.submittedAuthorities.push(authority);
    this.agent.status = "working";
    if (this.agent.nativeSession)
      await this.appendNativeAcceptance(
        nativeSessionIdentity(this.agent.nativeSession, "antigravity").opaqueId,
      );
    else if (this.autoNativeAcceptance) {
      this.establishConversation(INITIAL_CONVERSATION_ID);
      await this.appendNativeAcceptance(INITIAL_CONVERSATION_ID);
    }
    await this.onPrompt?.();
    if (this.submitError) throw this.submitError;
  }
  establishConversation(id: string): void {
    this.agent.nativeSession = nativeSessionRef("antigravity", "id", id);
  }
  async appendNativeAcceptance(id: string): Promise<void> {
    if (!this.logPath) throw new Error("fake Antigravity log is unavailable");
    await appendFile(
      this.logPath,
      `Sending user message to conversation ${id} (items=1, media=0)\n`,
    );
  }
  async appendNativeRejection(message: string): Promise<void> {
    if (!this.logPath) throw new Error("fake Antigravity log is unavailable");
    await appendFile(this.logPath, `SendUserMessage failed: ${message}\n`);
  }
  async observeAgentState(): Promise<HostedAgent> {
    return this.agent;
  }
  async inspectAgentState(): Promise<HostedAgent> {
    if (this.inspectError) throw this.inspectError;
    return this.agent;
  }
  async closePane(paneId: string): Promise<void> {
    if (this.agent.paneId === paneId) this.agent.status = "done";
  }
  async sendKeys(_target: string, _keys: string[]): Promise<void> {}
  attachment(ref: HostedExecutionRef): TerminalAttachmentDescriptor {
    return {
      mode: "local_native_terminal",
      backendKind: "herdr",
      terminalSessionId: ref.sessionName,
      localContextId: `sha256:${"0".repeat(64)}`,
      paneId: ref.paneId,
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
      launchPending: false,
      nativeMaterialized: true,
      tokens: {},
    };
  }
}

function readyBackend(harnessKind: string): SessionBackendReadiness {
  return {
    backendKind: "herdr",
    harnessKind,
    status: "ready",
    ready: true,
    capabilities: ["terminal.literal_input", "terminal.submit_input"],
    missingCapabilities: [],
    diagnostics: [],
    provenance: {
      version: "test",
      protocol: 999,
      testedProtocol: 22,
      endpointGeneration: 1,
      serverGeneration: "test-generation",
      sessionIncarnation: "test-session-incarnation",
    },
  };
}
