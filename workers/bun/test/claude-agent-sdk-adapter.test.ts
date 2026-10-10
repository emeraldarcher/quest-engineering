import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type { PreparedSbxHarnessExecution } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessCommand,
  StreamedProcessExit,
  StreamedProcessReconciliation,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  ClaudeAgentSdkAdapter,
  claudeAuthenticationCommand,
} from "../src/harnesses/claude-agent-sdk/adapter.ts";
import {
  type ClaudeTransportState,
  claudeRecoveryDisposition,
  claudeTransportBinding,
  parseClaudeTransportBinding,
} from "../src/harnesses/claude-agent-sdk/binding.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HarnessControlClient } from "../src/harnesses/control/client.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import { nativeSessionRef } from "../src/harnesses/native-session.ts";
import { structuredResultExists } from "../src/harnesses/turn-lifecycle.ts";
import type { HarnessEvent } from "../src/harnesses/types.ts";
import {
  type JsonValue,
  WORKER_PROTOCOL_VERSION,
} from "../src/protocol/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const wrapper = resolve(
  import.meta.dir,
  "../profiles/qe-coding-execution-v2/files/home/.qe-profile/claude-wrapper.mjs",
);

function claudeAction() {
  const base = action();
  return action({
    execution: {
      ...base.execution,
      configuration: {
        ...base.execution.configuration,
        harness_kind: "claude_agent_sdk",
        model: { provider: "anthropic", model: "claude-test-exact" },
        reasoning: "high",
        reasoning_capability: { kind: "enumerated", values: ["high"] },
      },
    },
  });
}

async function fixture(
  options: {
    turns?: Array<Array<Record<string, JsonValue>>>;
    reconciliation?: StreamedProcessReconciliation["process"];
    staged?: boolean;
    manualOwnership?: boolean;
  } = {},
) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-adapter-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const configDir = join(root, "claude-config");
  await Promise.all([mkdir(workspace), mkdir(configDir)]);
  await mkdir(join(configDir, ".tmp"));
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "claude_agent_sdk",
  );
  const authority = new HarnessControlAuthority(registry);
  const server = new HarnessControlServer(authority);
  await server.start();
  const candidate = claudeAction();
  if (options.staged) {
    candidate.operational_recovery = {
      epoch_number: 0,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "initial",
      continuation_mode: "fresh",
      retained_lineage_id: null,
      source_attempt_id: null,
      request_id: null,
    };
  }
  const accepted = registry.accept(candidate).dispatch;
  const lineageId = accepted.lineageId as string;
  if (options.manualOwnership !== false) {
    registry.occupy(lineageId, accepted.action.action_id);
    await authority.bind(accepted, registry.getLineage(lineageId));
  }
  const lineage = registry.getLineage(lineageId);
  const commands: StreamedProcessCommand[] = [];
  const environment: EnvironmentRef = {
    backendKind: "test-local-stream",
    environmentId: "environment-a",
    incarnation: "incarnation-a",
    workerId: "worker-test",
    runId: accepted.action.run_id,
    profile: {
      id: "qe-coding-execution-v2",
      digest: `sha256:${"a".repeat(64)}`,
    },
  };
  const prepared = {
    harnessKind: "claude_agent_sdk",
    lease: {
      ref: environment,
      capabilities: [{ kind: "process.streamed", mode: "attached_only" }],
      spawnStreamed: async (command: StreamedProcessCommand) => {
        commands.push(structuredClone(command));
        return localWrapperProcess(environment, command.executable);
      },
    },
    workspace: { paths: { workspace } },
    guestExecutable: "/opt/qe/claude/wrapper.mjs",
    materializedArtifacts: {},
    claude: {
      runtimeExecutable: "/opt/qe/claude-runtime",
      runtimeSha256: "b".repeat(64),
      sdkModule: "/opt/qe/sdk.mjs",
      sdkPackageJson: "/opt/qe/package.json",
      zodModule: "/opt/qe/zod.mjs",
      sdkVersion: "0.3.292",
      claudeCodeVersion: "2.1.292",
      wrapperVersion: "1.1.0",
      configDirectory: configDir,
      controlDescriptor: controlDescriptorPath(lineage),
    },
    syncControl: async () => undefined,
  } as unknown as PreparedSbxHarnessExecution;
  const manager = {
    prepare: async () => prepared,
    discoverClaude: async () => ({
      installed: true,
      authenticated: false,
      setupAvailable: true,
      models: [],
      diagnostics: ["zero-auth discovery"],
    }),
    retireStreamedProcesses: async () => undefined,
    prepareAndReconcileStreamedProcess: async (
      _dispatch: unknown,
      _lineage: unknown,
      _artifacts: unknown,
      handle: StreamedProcess["handle"],
    ) => ({
      prepared,
      reconciliation: {
        handle,
        process: options.reconciliation ?? "exited",
        streamAttachment: "unavailable",
        streamRecovery: "not_recoverable",
      } satisfies StreamedProcessReconciliation,
    }),
  };
  const config = {
    workerId: "worker-test",
    dataRoot: root,
    executorModels: [{ provider: "anthropic", model: "claude-test-exact" }],
    reasoningLevels: ["high"],
  } as unknown as WorkerConfig;
  const adapter = new ClaudeAgentSdkAdapter(config, manager as never, {
    fake: {
      authenticated: true,
      models: [{ id: "claude-test-exact", effort: ["high"] }],
      turns: options.turns ?? [
        [
          { type: "native_session", session_id: "native-session-a" },
          {
            type: "tool",
            name: "Read",
            input: { file_path: "README.md" },
          },
          {
            type: "usage",
            model_usage: {
              "claude-test-exact": {
                inputTokens: 2,
                outputTokens: 3,
                thinkingTokens: 1,
              },
            },
            result_count: 1,
          },
          { type: "complete", outputs: { change_set: { files: 1 } } },
          { type: "settle" },
        ],
      ],
      runtimeSha256: "b".repeat(64),
    },
  });
  return {
    root,
    registry,
    server,
    adapter,
    dispatch: accepted,
    lineage,
    commands,
    authority,
    environment,
    close: async () => {
      await adapter.close(registry.getLineage(lineageId));
      await server.stop();
      registry.close();
    },
  };
}

function authorize(value: Awaited<ReturnType<typeof fixture>>) {
  value.registry.authorizePrompt(value.dispatch.action.action_id);
  value.registry.markPromptIntent(value.dispatch.action.action_id);
  return value.registry.get(value.dispatch.action.action_id);
}

test("headless adapter runs the real wrapper over a streamed process and returns only authoritative completion", async () => {
  const value = await fixture();
  try {
    const prepared = await value.adapter.start(value.dispatch, value.lineage);
    expect(prepared.interactive).toBeUndefined();
    expect(prepared.handle.harnessKind).toBe("claude_agent_sdk");
    expect(value.commands).toHaveLength(1);
    expect(value.commands[0]).toMatchObject({
      executable: "/opt/qe/claude/wrapper.mjs",
      args: [],
      cwd: join(value.root, "workspace"),
      environment: {
        CLAUDE_CONFIG_DIR: join(value.root, "claude-config"),
        BROWSER: "/bin/false",
      },
    });
    expect(Object.keys(value.commands[0]?.environment ?? {})).not.toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(
      parseClaudeTransportBinding(prepared.handle.transportBinding ?? null),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });
    expect(prepared.handle.nativeSession).toBeUndefined();

    const events: HarnessEvent[] = [];
    const outputs = await value.adapter.sendInputAndCollect(
      authorize(value),
      prepared,
      (event) => events.push(event),
    );
    expect(outputs).toEqual({ change_set: { files: 1 } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "prompt_baseline",
        "prompt_accepted",
        "native_activity",
        "provider_turn_settled",
        "native_idle",
        "structured_result_received",
      ]),
    );
    const inspection = await value.adapter.inspect(value.lineage);
    expect(inspection).toMatchObject({
      state: "retained",
      interactive: null,
      nativeSession: {
        harnessKind: "claude_agent_sdk",
        payload: { identityKind: "id", opaqueId: "native-session-a" },
      },
      transportBinding: {
        harnessKind: "claude_agent_sdk",
        kind: "claude_agent_sdk_stream_v2",
      },
    });
    expect(inspection.activity.detail).toContain(
      "usage model=claude-test-exact input=2 output=3",
    );
    expect(
      parseClaudeTransportBinding(inspection.transportBinding ?? null),
    ).toMatchObject({
      query: { state: "acknowledged", invocationCount: 1 },
      submission: { state: "settled" },
    });
  } finally {
    await value.close();
  }
});

test("post-query model rejection retains acknowledged query certainty", async () => {
  const value = await fixture({
    turns: [[{ type: "settle", model: "claude-wrong-model" }]],
  });
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    await expect(
      value.adapter.sendInputAndCollect(
        authorize(value),
        execution,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(
      parseClaudeTransportBinding(
        (await value.adapter.inspect(value.lineage)).transportBinding ?? null,
      ),
    ).toMatchObject({
      query: { state: "acknowledged", invocationCount: 1 },
      submission: { state: "native_accepted" },
    });
  } finally {
    await value.close();
  }
});

test("structured HumanAttention reaches the exact native callback before QE resolves it", async () => {
  const value = await fixture({
    turns: [
      [
        {
          type: "attention",
          native_request_id: "native-question-a",
          interaction: "choice",
          message: "Choose exactly one option.",
          response_schema: {
            kind: "choice_form_v1",
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Choose exactly one option.",
                multi_select: false,
                options: [
                  { label: "A", description: "First" },
                  { label: "B", description: "Second" },
                ],
              },
            ],
          },
        },
        { type: "complete", outputs: { change_set: { choice: "A" } } },
        { type: "settle" },
      ],
    ],
  });
  try {
    const prepared = await value.adapter.start(value.dispatch, value.lineage);
    const collection = value.adapter.sendInputAndCollect(
      authorize(value),
      prepared,
      () => undefined,
    );
    let attention = value.registry.getLineage(
      value.lineage.lineageId,
    ).attention;
    for (let attempt = 0; !attention && attempt < 100; attempt += 1) {
      await Bun.sleep(10);
      attention = value.registry.getLineage(value.lineage.lineageId).attention;
    }
    expect(attention).toMatchObject({
      interaction: { kind: "choice" },
      responseSchema: { kind: "choice_form_v1" },
    });
    await value.adapter.respondToAttention(
      value.registry.getLineage(value.lineage.lineageId),
      {
        attentionId: attention?.attentionId as string,
        approved: true,
        value: { answers: { Choice: "A" } },
      },
    );
    expect(
      value.registry.getLineage(value.lineage.lineageId).attention,
    ).toBeNull();
    await expect(collection).resolves.toEqual({ change_set: { choice: "A" } });
  } finally {
    await value.close();
  }
});

test("discovery is installed/setup-capable but unauthenticated and therefore not ready", async () => {
  const value = await fixture();
  try {
    expect(await value.adapter.discover()).toMatchObject({
      kind: "claude_agent_sdk",
      strategy: "structured_headless",
      integration: {
        status: "auth_required",
        installed: true,
        authenticated: false,
      },
      capabilities: { structuredResult: false, canAttachTerminal: false },
      models: [],
    });
    expect(value.commands).toHaveLength(0);
  } finally {
    await value.close();
  }
});

test("normal staged Claude flow reaches needs_confirmation with zero query then executes exactly one authorized query", async () => {
  const value = await fixture({ staged: true, manualOwnership: false });
  const executor = new DispatchExecutor(
    value.registry,
    value.adapter,
    async () => true,
    async () => true,
    value.authority,
  );
  try {
    await executor.start(value.dispatch.action.action_id);
    const staged = value.registry.get(value.dispatch.action.action_id);
    const stagedLineage = value.registry.getLineage(staged.lineageId as string);
    expect(staged).toMatchObject({
      state: "accepted",
      promptAuthorizedAt: null,
      promptIntentAt: null,
      promptAcceptedAt: null,
      nativeActivityAt: null,
    });
    expect(stagedLineage).toMatchObject({
      sessionState: "waiting_for_human",
      attention: { category: "needs_confirmation" },
      nativeSession: null,
    });
    expect(
      parseClaudeTransportBinding(stagedLineage.transportBinding),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });

    await executor.authorizePrompt(value.dispatch.action.action_id);
    const completed = value.registry.get(value.dispatch.action.action_id);
    const completedLineage = value.registry.getLineage(
      completed.lineageId as string,
    );
    expect(completed).toMatchObject({
      state: "completed",
      promptAuthorizedAt: expect.any(String),
      promptIntentAt: expect.any(String),
      promptAcceptedAt: expect.any(String),
      nativeActivityAt: expect.any(String),
    });
    expect(
      parseClaudeTransportBinding(completedLineage.transportBinding),
    ).toMatchObject({
      query: { state: "acknowledged", invocationCount: 1 },
      submission: { state: "settled" },
    });
    expect(completedLineage.nativeSession).toEqual(
      nativeSessionRef("claude_agent_sdk", "id", "native-session-a"),
    );
  } finally {
    await value.close();
  }
});

test("prepared Claude cancellation before authorization retires with zero query or provider activity", async () => {
  const value = await fixture({ staged: true, manualOwnership: false });
  const executor = new DispatchExecutor(
    value.registry,
    value.adapter,
    async () => true,
    async () => true,
    value.authority,
  );
  try {
    await executor.start(value.dispatch.action.action_id);
    await executor.cancel({
      type: "cancel_dispatch",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: value.dispatch.action.worker_id,
      connection_generation: 1,
      action_id: value.dispatch.action.action_id,
      run_id: value.dispatch.action.run_id,
      occurrence_id: value.dispatch.action.occurrence_id,
      attempt_id: value.dispatch.action.attempt_id,
      cancellation: {
        request_id: "cancel-claude-pre-query",
        origin: "product_operator",
        reason: "Zero-query cancellation regression.",
        requested_at: new Date().toISOString(),
      },
    });
    const cancelled = value.registry.get(value.dispatch.action.action_id);
    const cancelledLineage = value.registry.getLineage(
      cancelled.lineageId as string,
    );
    expect(cancelled).toMatchObject({
      state: "failed",
      promptAuthorizedAt: null,
      promptIntentAt: null,
      promptAcceptedAt: null,
      nativeActivityAt: null,
      failure: { code: "execution_cancelled" },
    });
    expect(
      parseClaudeTransportBinding(cancelledLineage.transportBinding),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });
  } finally {
    await value.close();
  }
});

test("stale authorization, setup, wrapper generation, and replacement environment cannot start a query", async () => {
  {
    const value = await fixture();
    try {
      const execution = await value.adapter.start(
        value.dispatch,
        value.lineage,
      );
      await expect(
        value.adapter.sendInputAndCollect(
          value.dispatch,
          execution,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(
        parseClaudeTransportBinding(
          (await value.adapter.inspect(value.lineage)).transportBinding ?? null,
        ),
      ).toMatchObject({ query: { state: "not_invoked", invocationCount: 0 } });
    } finally {
      await value.close();
    }
  }

  {
    const value = await fixture();
    try {
      const execution = await value.adapter.start(
        value.dispatch,
        value.lineage,
      );
      const stale = parseClaudeTransportBinding(
        execution.handle.transportBinding ?? null,
      ) as ClaudeTransportState;
      stale.wrapperGeneration = "stale-wrapper-generation";
      await expect(
        value.adapter.sendInputAndCollect(
          authorize(value),
          {
            ...execution,
            handle: {
              ...execution.handle,
              transportBinding: claudeTransportBinding(stale),
            },
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "stale_generation" });
      expect(
        parseClaudeTransportBinding(
          (await value.adapter.inspect(value.lineage)).transportBinding ?? null,
        ),
      ).toMatchObject({ query: { state: "not_invoked", invocationCount: 0 } });
    } finally {
      await value.close();
    }
  }

  {
    const value = await fixture();
    try {
      const execution = await value.adapter.start(
        value.dispatch,
        value.lineage,
      );
      const staleSetup = authorize(value);
      staleSetup.action.harness_setup = {
        setup_id: "stale-setup",
        setup_generation: 99,
        physical_lineage_id: value.lineage.lineageId,
        environment: {
          environment_id: value.environment.environmentId,
          incarnation: value.environment.incarnation,
          profile: structuredClone(value.environment.profile),
        },
        config_identity: "stale-setup-configuration",
      };
      await expect(
        value.adapter.sendInputAndCollect(
          staleSetup,
          execution,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "stale_generation" });
      expect(
        parseClaudeTransportBinding(
          (await value.adapter.inspect(value.lineage)).transportBinding ?? null,
        ),
      ).toMatchObject({ query: { state: "not_invoked", invocationCount: 0 } });
    } finally {
      await value.close();
    }
  }

  {
    const value = await fixture();
    try {
      const execution = await value.adapter.start(
        value.dispatch,
        value.lineage,
      );
      value.environment.environmentId = "replacement-environment";
      await expect(
        value.adapter.sendInputAndCollect(
          authorize(value),
          execution,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "stale_generation" });
      expect(
        parseClaudeTransportBinding(
          (await value.adapter.inspect(value.lineage)).transportBinding ?? null,
        ),
      ).toMatchObject({ query: { state: "not_invoked", invocationCount: 0 } });
    } finally {
      await value.close();
    }
  }
});

test("authentication plumbing exposes only pinned unmodified claude auth login and Run-private state", async () => {
  const value = await fixture();
  try {
    const prepared = await (
      value.adapter as unknown as {
        executionManager: {
          prepare(): Promise<PreparedSbxHarnessExecution>;
        };
      }
    ).executionManager.prepare();
    expect(claudeAuthenticationCommand(prepared)).toEqual({
      executable: "/opt/qe/claude-runtime",
      args: ["auth", "login"],
      cwd: join(value.root, "workspace"),
      environment: expect.objectContaining({
        HOME: join(value.root, "claude-config"),
        CLAUDE_CONFIG_DIR: join(value.root, "claude-config"),
        BROWSER: "/bin/false",
      }),
    });
    expect(value.commands).toHaveLength(0);
    expect(
      Object.keys(claudeAuthenticationCommand(prepared).environment),
    ).not.toContain("ANTHROPIC_API_KEY");
  } finally {
    await value.close();
  }
});

test("recovery replaces only a proven-unsubmitted exited wrapper", async () => {
  const value = await fixture();
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    value.registry.recordExecution(
      value.lineage.lineageId,
      execution.handle,
      null,
    );
    value.adapter.disconnect();
    const recovered = await value.adapter.recover(
      value.registry.getLineage(value.lineage.lineageId),
      value.dispatch,
    );
    expect(recovered).toMatchObject({
      found: true,
      inspection: { state: "starting", interactive: null },
    });
    expect(recovered.detail).toContain("without replaying provider work");
    if (!recovered.found)
      throw new Error("Expected proven-unsubmitted Claude recovery.");
    expect(
      parseClaudeTransportBinding(recovered.handle.transportBinding ?? null),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });
    expect(recovered.handle.nativeSession).toBeUndefined();
  } finally {
    await value.close();
  }
});

test("pre-query retained continuation recovery reopens locally without replaying the prior query", async () => {
  const value = await fixture({ reconciliation: "exited" });
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    const persisted = parseClaudeTransportBinding(
      execution.handle.transportBinding ?? null,
    ) as ClaudeTransportState;
    persisted.query = {
      state: "acknowledged",
      requestId: "prior-settled-query",
      invocationCount: 1,
    };
    value.registry.recordExecution(
      value.lineage.lineageId,
      {
        ...execution.handle,
        transportBinding: claudeTransportBinding(persisted),
      },
      null,
    );
    value.registry.recordNativeSession(
      value.lineage.lineageId,
      nativeSessionRef("claude_agent_sdk", "id", "retained-session"),
    );
    value.adapter.disconnect();
    const recovered = await value.adapter.recover(
      value.registry.getLineage(value.lineage.lineageId),
      value.dispatch,
    );
    expect(recovered.detail).toContain("without replaying provider work");
    if (!recovered.found)
      throw new Error("Expected retained pre-query Claude recovery.");
    expect(
      parseClaudeTransportBinding(recovered.handle.transportBinding ?? null),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });
    const continued = await value.adapter.continue(
      value.dispatch,
      value.registry.getLineage(value.lineage.lineageId),
    );
    expect(
      parseClaudeTransportBinding(continued.handle.transportBinding ?? null),
    ).toMatchObject({
      query: { state: "not_invoked", invocationCount: 0 },
      submission: { state: "not_submitted" },
    });
    expect(value.commands).toHaveLength(2);
  } finally {
    await value.close();
  }
});

test("settled recovery reopens the exact native session for one bounded correction", async () => {
  const value = await fixture({
    turns: [
      [
        { type: "complete", outputs: { change_set: { corrected: true } } },
        { type: "settle" },
      ],
    ],
  });
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    const persisted = parseClaudeTransportBinding(
      execution.handle.transportBinding ?? null,
    ) as ClaudeTransportState;
    persisted.query = {
      state: "acknowledged",
      requestId: "request-settled",
      invocationCount: 1,
    };
    persisted.submission = {
      state: "settled",
      requestId: "request-settled",
      turnId: "turn-settled",
      continuationCount: 1,
      eventCursor: 7,
    };
    value.registry.recordExecution(
      value.lineage.lineageId,
      {
        ...execution.handle,
        nativeSession: nativeSessionRef(
          "claude_agent_sdk",
          "id",
          "native-session-settled",
        ),
        transportBinding: claudeTransportBinding(persisted),
      },
      null,
    );
    value.adapter.disconnect();
    const lineage = value.registry.getLineage(value.lineage.lineageId);
    const authorized = authorize(value);
    const recovered = await value.adapter.recover(lineage, authorized);
    expect(recovered.detail).toContain("exact settled native session");
    if (!recovered.found)
      throw new Error("Expected the settled Claude session to reopen.");
    const outputs = await value.adapter.waitAndCollect(
      authorized,
      value.registry.getLineage(value.lineage.lineageId),
      recovered.handle,
      () => undefined,
    );
    expect(outputs).toEqual({ change_set: { corrected: true } });
    const final = parseClaudeTransportBinding(
      (await value.adapter.inspect(lineage)).transportBinding ?? null,
    );
    expect(final?.submission.continuationCount).toBe(2);
    expect(final?.submission.eventCursor).toBeGreaterThan(7);
  } finally {
    await value.close();
  }
});

test("authoritative QE result recovery does not require provider settlement", async () => {
  const value = await fixture();
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    const control = new HarnessControlClient(
      controlDescriptorPath(value.lineage),
    );
    expect(
      await control.completeStep(
        { change_set: { recovered: true } },
        "authoritative-result-recovery",
      ),
    ).toMatchObject({ accepted: true });
    for (
      let attempt = 0;
      !(await structuredResultExists(value.dispatch.resultDirectory)) &&
      attempt < 100;
      attempt += 1
    )
      await Bun.sleep(10);
    expect(await structuredResultExists(value.dispatch.resultDirectory)).toBe(
      true,
    );
    const persisted = parseClaudeTransportBinding(
      execution.handle.transportBinding ?? null,
    ) as ClaudeTransportState;
    persisted.query = {
      state: "acknowledged",
      requestId: "request-result",
      invocationCount: 1,
    };
    persisted.submission = {
      state: "native_accepted",
      requestId: "request-result",
      turnId: "turn-result",
      continuationCount: 0,
      eventCursor: 3,
    };
    value.registry.recordExecution(
      value.lineage.lineageId,
      {
        ...execution.handle,
        transportBinding: claudeTransportBinding(persisted),
      },
      null,
    );
    value.adapter.disconnect();
    const recovered = await value.adapter.recover(
      value.registry.getLineage(value.lineage.lineageId),
      value.dispatch,
    );
    expect(recovered).toMatchObject({
      found: true,
      inspection: { state: "retained", activity: { state: "completed" } },
    });
    expect(recovered.detail).toContain("Authoritative QE completion exists");
  } finally {
    await value.close();
  }
});

test("recovery never replays ambiguous submission and detects PID identity reuse", async () => {
  for (const [process, expectedCode] of [
    ["exited", "submission_uncertain"],
    ["identity_mismatch", "ownership_mismatch"],
  ] as const) {
    const value = await fixture({ reconciliation: process });
    try {
      const execution = await value.adapter.start(
        value.dispatch,
        value.lineage,
      );
      const persisted = parseClaudeTransportBinding(
        execution.handle.transportBinding ?? null,
      ) as ClaudeTransportState;
      persisted.query = {
        state: "acknowledged",
        requestId: "request-recovery",
        invocationCount: 1,
      };
      persisted.submission = {
        state: "native_accepted",
        requestId: "request-recovery",
        turnId: "turn-recovery",
        continuationCount: 0,
        eventCursor: 2,
      };
      value.registry.recordExecution(
        value.lineage.lineageId,
        {
          ...execution.handle,
          transportBinding: claudeTransportBinding(persisted),
        },
        null,
      );
      value.adapter.disconnect();
      await expect(
        value.adapter.recover(
          value.registry.getLineage(value.lineage.lineageId),
          value.dispatch,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
    } finally {
      await value.close();
    }
  }
});

test("ambiguous query-start intent is never replayed during recovery", async () => {
  const value = await fixture({ reconciliation: "exited" });
  try {
    const execution = await value.adapter.start(value.dispatch, value.lineage);
    const persisted = parseClaudeTransportBinding(
      execution.handle.transportBinding ?? null,
    ) as ClaudeTransportState;
    persisted.query = {
      state: "requested",
      requestId: "query-request-ambiguous",
      invocationCount: 0,
    };
    persisted.submission = {
      state: "submitted",
      requestId: "query-request-ambiguous",
      turnId: "turn-query-ambiguous",
      continuationCount: 0,
      eventCursor: 0,
    };
    value.registry.recordExecution(
      value.lineage.lineageId,
      {
        ...execution.handle,
        transportBinding: claudeTransportBinding(persisted),
      },
      null,
    );
    value.adapter.disconnect();
    await expect(
      value.adapter.recover(
        value.registry.getLineage(value.lineage.lineageId),
        value.dispatch,
      ),
    ).rejects.toMatchObject({ code: "query_start_uncertain" });
    expect(value.commands).toHaveLength(1);
  } finally {
    await value.close();
  }
});

test("Claude transport binding classifies recovery states without interactive attachment", () => {
  const base = bindingState();
  const matrix = {
    not_submitted: "replace_without_submission",
    submitted: "submission_uncertain",
    native_accepted: "submission_uncertain",
    settled: "reopen_settled_session",
    cancelled: "terminal_history",
    terminal: "terminal_history",
  } as const;
  for (const [state, disposition] of Object.entries(matrix)) {
    const typedState = state as keyof typeof matrix;
    const queryState =
      typedState === "submitted"
        ? "requested"
        : ["native_accepted", "settled"].includes(typedState)
          ? "acknowledged"
          : "not_invoked";
    const binding = claudeTransportBinding({
      ...base,
      query:
        queryState === "not_invoked"
          ? { state: queryState, requestId: null, invocationCount: 0 }
          : {
              state: queryState,
              requestId: "query-request",
              invocationCount: queryState === "acknowledged" ? 1 : 0,
            },
      submission: { ...base.submission, state: typedState },
    });
    expect(parseClaudeTransportBinding(binding)?.submission.state).toBe(
      typedState,
    );
    expect(claudeRecoveryDisposition(typedState, queryState)).toBe(disposition);
  }
  expect(claudeRecoveryDisposition("not_submitted", "acknowledged", true)).toBe(
    "replace_without_submission",
  );
  expect(
    claudeRecoveryDisposition("not_submitted", "acknowledged", false),
  ).toBe("submission_uncertain");
  const malformed = claudeTransportBinding(base);
  malformed.payload.runtimeSha256 = "wrong";
  expect(() => parseClaudeTransportBinding(malformed)).toThrow(
    "payload is invalid",
  );
});

function bindingState(): ClaudeTransportState {
  const environment: EnvironmentRef = {
    backendKind: "sbx",
    environmentId: "environment-a",
    incarnation: "incarnation-a",
    workerId: "worker-test",
    runId: "run-1",
    profile: {
      id: "qe-coding-execution-v2",
      digest: `sha256:${"a".repeat(64)}`,
    },
  };
  return {
    wrapperGeneration: "generation-a",
    process: {
      contractVersion: 1,
      backendKind: "sbx",
      environment,
      backendProcessId: "101",
      processStartIdentity: "start-a",
      processGeneration: "process-generation-a",
      executable: "/opt/qe/claude/wrapper.mjs",
    },
    profileId: environment.profile.id,
    profileDigest: environment.profile.digest,
    workspaceIdentity: "workspace-a",
    configurationIdentity: "configuration-a",
    wrapperExecutable: "/opt/qe/claude/wrapper.mjs",
    wrapperVersion: "1.1.0",
    sdkVersion: "0.3.292",
    claudeCodeVersion: "2.1.292",
    runtimeSha256: "b".repeat(64),
    model: "claude-test-exact",
    effort: "high",
    toolPolicyDigest: "tool-policy-a",
    query: {
      state: "not_invoked",
      requestId: null,
      invocationCount: 0,
    },
    submission: {
      state: "not_submitted",
      requestId: null,
      turnId: null,
      continuationCount: 0,
      eventCursor: 0,
    },
  };
}

function localWrapperProcess(
  environment: EnvironmentRef,
  executable: string,
): StreamedProcess {
  const child = Bun.spawn(["node", wrapper], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
    },
  });
  const handle = {
    contractVersion: 1 as const,
    backendKind: environment.backendKind,
    environment: structuredClone(environment),
    backendProcessId: String(child.pid),
    processStartIdentity: `pid-${child.pid}`,
    processGeneration: crypto.randomUUID(),
    executable,
    observedExecutable: executable,
  };
  const exit: Promise<StreamedProcessExit> = child.exited.then((exitCode) =>
    exitCode === 0
      ? { kind: "exited", exitCode: 0 }
      : { kind: "exited_nonzero", exitCode },
  );
  return {
    handle,
    stdout: stream(child.stdout),
    stderr: stream(child.stderr),
    exit,
    write: async (data) => {
      child.stdin.write(data);
      child.stdin.flush();
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: data.byteLength,
      };
    },
    closeStdin: async () => {
      child.stdin.end();
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: 0,
      };
    },
    cancel: async () => {
      child.kill();
      return {
        certainty: "acknowledged",
        cancellationId: crypto.randomUUID(),
      };
    },
    inspect: async () => ({
      handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    disconnect: async () => {
      if (!child.killed) child.kill();
    },
  };
}

async function* stream(
  readable: ReadableStream<Uint8Array>,
): AsyncIterable<StreamedProcessStreamEvent> {
  let sequence = 0;
  const reader = readable.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    sequence += 1;
    yield { kind: "data", sequence, data: next.value };
  }
  sequence += 1;
  yield { kind: "eof", sequence };
}
