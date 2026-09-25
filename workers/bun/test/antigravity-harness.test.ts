import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type {
  PreparedSbxPiExecution,
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
import type {
  HarnessCapabilities,
  HarnessEvent,
} from "../src/harnesses/types.ts";
import { HerdrApiError } from "../src/session-host/herdr/client.ts";
import type {
  HostedAgent,
  HostedAgentStatus,
  HostedExecutionRef,
  HostedPane,
  HostedSnapshot,
  SessionBackendReadiness,
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
          ? "--conversation --effort --log-file --model --prompt-interactive\n"
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
      artifacts: PreparedSbxPiExecution["materializedArtifacts"],
    ) => {
      const controlRoot = dirname(preparedLineage.resultControlPath);
      const prepared = {
        lease: { paths: { state: join(root, "guest-state") } },
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
        proveAntigravityReadiness: async () => undefined,
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
      return prepared as unknown as PreparedSbxPiExecution;
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
    nativeSession: {
      source: "antigravity",
      agent: "agy",
      kind: "id",
      value: "1d48881c-5f10-43a0-9b87-234344a2dd8e",
    },
    evidence: "native_user_message",
  });
  await value.close();
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
    expect(Object.keys(value.host.agent.tokens ?? {})).toHaveLength(14);
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
    value.registry.recordHost(value.lineage.lineageId, {
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
    expect(
      await value.harness.sendInputAndCollect(
        value.dispatch,
        execution,
        () => undefined,
      ),
    ).toEqual({ change_set: { status: "authorized" } });
    expect(value.host.promptCalls).toBe(1);
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
    value.registry.recordHost(value.lineage.lineageId, {
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
      value.dispatch,
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

test("accepted prompt can become stalled and later work without uncertainty or resubmission", async () => {
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
        await appendFile(
          join(
            value.root,
            "lineages",
            value.lineage.lineageId,
            "antigravity.log",
          ),
          "Sending user message to conversation 22222222-2222-4222-8222-222222222222 (items=1, media=0)\n",
        );
        await Bun.sleep(150);
        await new HarnessControlClient(
          controlDescriptorPath(value.lineage),
        ).completeStep({ change_set: { status: "delayed" } });
      })();
    };
    const events: HarnessEvent[] = [];
    const outputs = await value.harness.sendInputAndCollect(
      value.dispatch,
      execution,
      (event) => events.push(event),
    );
    await nativeTurn;

    expect(outputs).toEqual({ change_set: { status: "delayed" } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "prompt_accepted",
        "stalled",
        "native_activity",
        "structured_result_received",
      ]),
    );
    expect(value.host.promptCalls).toBe(1);
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
    value.registry.recordHost(value.lineage.lineageId, {
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
      agent: { name: execution.ref.agentName },
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
    delete value.host.agent.name;
    delete value.host.agent.tokens?.qe_action_hash;
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

function antigravityDiscoveryRunner(version: string, omittedHelpFlag?: string) {
  return async (args: string[]) => ({
    exitCode: 0,
    stdout:
      args[0] === "--version"
        ? `${version}\n`
        : args[0] === "--help"
          ? [
              "--conversation",
              "--effort",
              "--log-file",
              "--model",
              "--prompt-interactive",
            ]
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
  promptOptions:
    | { until?: HostedAgentStatus[]; timeoutMs?: number }
    | undefined;
  promptCalls = 0;
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
    this.promptCalls += 1;
    this.promptOptions = _options;
    this.agent.status = "working";
    await this.onPrompt?.();
    return this.agent;
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

function readyBackend(harnessKind: string): SessionBackendReadiness {
  return {
    backendKind: "herdr",
    harnessKind,
    status: "ready",
    ready: true,
    capabilities: [],
    missingCapabilities: [],
    diagnostics: [],
    provenance: {
      version: "test",
      protocol: 999,
      testedProtocol: 22,
      endpointGeneration: 1,
      serverGeneration: "test-generation",
    },
  };
}
