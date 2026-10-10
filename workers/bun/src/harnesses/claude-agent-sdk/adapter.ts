import { createHash, randomUUID } from "node:crypto";
import type { WorkerConfig } from "../../config.ts";
import {
  type DispatchRecord,
  type HarnessLineage,
  physicalConfiguration,
} from "../../dispatch/registry.ts";
import type {
  PreparedSbxHarnessExecution,
  PreparedSbxHarnessSetup,
  SbxRunExecutionManager,
} from "../../execution-environment/sbx-run.ts";
import type { JsonValue } from "../../protocol/types.ts";
import { materializeExecutionArtifacts } from "../../workspace/execution-artifacts.ts";
import { controlDescriptorPath } from "../control/authority.ts";
import { HarnessControlClient } from "../control/client.ts";
import {
  collectStepResult,
  writeControlAtomic,
} from "../control/result-envelope.ts";
import { nativeSessionIdentity, nativeSessionRef } from "../native-session.ts";
import { harnessPromptFor } from "../prompt.ts";
import { structuredResultExists } from "../turn-lifecycle.ts";
import type {
  AgentHarness,
  AgentHarnessSetup,
  HarnessCapabilities,
  HarnessDiscovery,
  HarnessEvent,
  HarnessExecutionHandle,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
  HarnessSetupContext,
  HarnessSetupInspection,
  HarnessSetupOperation,
  HarnessSetupPrepared,
  HumanAttention,
} from "../types.ts";
import { OperationalExecutionError } from "../types.ts";
import {
  type ClaudeTransportState,
  claudeTransportBinding,
  parseClaudeTransportBinding,
} from "./binding.ts";
import {
  type ClaudeEffort,
  type ClaudeSemanticTool,
  ClaudeWrapperClient,
  type ClaudeWrapperConfiguration,
  type ClaudeWrapperEvent,
} from "./protocol.ts";

const RESULT_WAIT_MS = 30_000;
const CANCELLATION_WAIT_MS = 5_000;

interface ActiveClaudeExecution {
  prepared: PreparedSbxHarnessExecution;
  client: ClaudeWrapperClient;
  control: HarnessControlClient;
  binding: ClaudeTransportState;
  inspection: HarnessInspection;
  attention: Map<
    string,
    {
      attentionId: string;
      nativeRequestId: string;
      qeAttentionId: string;
      responseAccepted: Deferred<void>;
    }
  >;
  cancellation: Deferred<void>;
  activeDispatch: DispatchRecord | null;
  settledRecovery: boolean;
  lastUsage: string | null;
}

export interface ClaudeAgentSdkAdapterOptions {
  fake?: {
    authenticated: boolean;
    models: Array<{ id: string; effort: ClaudeEffort[] }>;
    turns: Array<Array<Record<string, JsonValue>>>;
    runtimeSha256?: string;
  };
  now?: () => Date;
}

export class ClaudeAgentSdkAdapter implements AgentHarness {
  readonly kind = "claude_agent_sdk" as const;
  readonly displayName = "Claude Agent SDK";
  readonly integrationStrategy = "structured_headless" as const;
  readonly capabilities: HarnessCapabilities = Object.freeze({
    structuredResult: true,
    continuation: true,
    retainedSessionRecovery: true,
    structuredAttention: true,
    nativeBlocking: true,
    canAttachTerminal: false,
    canSendInput: false,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: true,
    canObserveStructuredEvents: true,
    structuredConfirmation: true,
    structuredTextResponse: true,
    structuredChoiceResponse: true,
    structuredMultilineResponse: true,
    nativePromptControl: true,
    conversationalTakeover: false,
    automationResume: true,
  });
  readonly setup: AgentHarnessSetup = Object.freeze({
    kind: "provider_authentication" as const,
    prepare: (context: HarnessSetupContext) => this.prepareSetup(context),
    begin: (
      prepared: HarnessSetupPrepared,
      authorization: {
        authorizationId: string;
        kind: "human_harness_setup";
        authorizedAt: string;
      },
      onEvent: Parameters<AgentHarnessSetup["begin"]>[2],
    ) => this.beginSetup(prepared, authorization, onEvent),
    inspect: (prepared: HarnessSetupPrepared) => this.inspectSetup(prepared),
  });
  private readonly active = new Map<string, ActiveClaudeExecution>();
  private readonly now: () => Date;

  constructor(
    private readonly config: WorkerConfig,
    private readonly executionManager: SbxRunExecutionManager,
    private readonly options: ClaudeAgentSdkAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async discover(): Promise<HarnessDiscovery> {
    try {
      const result = await this.executionManager.discoverClaude();
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status: result.authenticated ? "ready" : "auth_required",
          detail: result.diagnostics.join(" "),
          installed: result.installed,
          authenticated: result.authenticated,
          setupAvailable: result.setupAvailable,
        },
        models: result.models,
        capabilities: {
          ...this.capabilities,
          structuredResult: result.authenticated,
        },
      };
    } catch (error) {
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status: "unavailable",
          detail: error instanceof Error ? error.message : String(error),
          installed: false,
          authenticated: false,
        },
        models: [],
        capabilities: { ...this.capabilities, structuredResult: false },
      };
    }
  }

  async start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.assertDispatch(dispatch, lineage);
    if (this.active.has(lineage.lineageId))
      throw claudeError(
        "ownership_mismatch",
        "A Claude wrapper generation already owns this lineage.",
        "terminal_not_recoverable",
        "prepare",
        "not_submitted",
      );
    const active = await this.spawn(dispatch, lineage);
    return preparedExecution(lineage, active);
  }

  async continue(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.assertDispatch(dispatch, lineage);
    const retained = this.active.get(lineage.lineageId);
    if (retained) {
      if (retained.activeDispatch)
        throw claudeError(
          "turn_active",
          "The retained Claude conversation is already executing an Attempt.",
          "operator_recovery_required",
          "prepare",
          "native_accepted",
        );
      this.validateBindingConfiguration(retained.binding, dispatch);
      retained.prepared = await this.executionManager.prepare(
        dispatch,
        lineage,
        materializeExecutionArtifacts(this.config, dispatch),
      );
      await this.writeAndSyncControl(dispatch, lineage, retained.prepared);
      retained.control = new HarnessControlClient(
        controlDescriptorPath(lineage),
      );
      retained.binding.submission = {
        ...emptySubmission(),
        eventCursor: retained.binding.submission.eventCursor,
      };
      retained.cancellation = deferred<void>();
      retained.inspection = this.inspection(retained, "starting", "idle");
      return preparedExecution(lineage, retained);
    }
    const binding = parseClaudeTransportBinding(lineage.transportBinding);
    if (!binding || binding.submission.state !== "settled")
      throw recoveryError(binding?.submission.state ?? "missing");
    this.validatePersistedBinding(binding, lineage, dispatch);
    const replacement = await this.prepareReplacement(
      dispatch,
      lineage,
      binding,
    );
    const active = await this.spawn(dispatch, lineage, binding, replacement);
    return preparedExecution(lineage, active);
  }

  async ready(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void> {
    const active = this.required(execution.lineage.lineageId);
    if (
      active.binding.wrapperGeneration !==
      parseClaudeTransportBinding(execution.handle.transportBinding ?? null)
        ?.wrapperGeneration
    )
      throw claudeError(
        "stale_generation",
        "Claude readiness belongs to another wrapper generation.",
        "terminal_not_recoverable",
        "readiness",
        "not_submitted",
      );
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const active = this.required(execution.lineage.lineageId);
    active.activeDispatch = dispatch;
    if (active.binding.submission.state === "not_submitted") {
      const prompt = harnessPromptFor(
        dispatch,
        active.prepared.materializedArtifacts,
        {
          completionTool: "qe_complete_step",
          humanAssistanceInstruction:
            "Use the native structured HumanAttention request when confirmation or information is genuinely required. Wait for the correlated response; do not infer one.",
          recoveryContext: "retained Claude native session",
        },
      );
      const requestId = randomUUID();
      const turnId = randomUUID();
      onEvent({
        type: "prompt_baseline",
        evidence: {
          kind: "claude_stream",
          cursor: active.binding.submission.eventCursor,
          promptHash: hash(prompt),
        },
        inspection: this.inspection(active, "waiting_for_activity", "idle"),
      });
      await active.client.send({
        type: "execute_turn",
        request_id: requestId,
        turn_id: turnId,
        prompt,
        continuation: false,
      });
      active.binding.submission = {
        state: "submitted",
        requestId,
        turnId,
        continuationCount: 0,
        eventCursor: active.binding.submission.eventCursor,
      };
      active.inspection = this.inspection(
        active,
        "waiting_for_activity",
        "unknown",
      );
      onEvent({ type: "inspection", inspection: active.inspection });
    }
    return this.collect(dispatch, active, onEvent);
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    _handle: HarnessExecutionHandle,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    if (await structuredResultExists(dispatch.resultDirectory))
      return (await collectStepResult(dispatch)).envelope.outputs;
    const active = this.required(lineage.lineageId);
    active.activeDispatch = dispatch;
    return this.collect(dispatch, active, onEvent);
  }

  async respondToAttention(
    lineage: HarnessLineage,
    input: {
      attentionId: string;
      approved: boolean;
      value: JsonValue;
    },
  ): Promise<void> {
    const active = this.required(lineage.lineageId);
    const pending = [...active.attention.values()].find(
      (candidate) => candidate.qeAttentionId === input.attentionId,
    );
    if (!pending || pending.qeAttentionId !== lineage.attention?.attentionId)
      throw claudeError(
        "stale_human_attention",
        "HumanAttention response does not match the exact pending native request.",
        "operator_recovery_required",
        "execute",
        "native_accepted",
      );
    await active.client.send({
      type: "human_attention_response",
      request_id: randomUUID(),
      native_request_id: pending.nativeRequestId,
      attention_id: pending.attentionId,
      response: { approved: input.approved, value: input.value },
    });
    try {
      await withTimeout(pending.responseAccepted.promise, 30_000);
    } catch {
      throw claudeError(
        "submission_uncertain",
        "Claude HumanAttention response was written but native callback acceptance was not observed.",
        "operator_recovery_required",
        "execute",
        "native_accepted",
      );
    }
    await active.control.resolveHumanAssistance(
      pending.qeAttentionId,
      input.approved ? "completed" : "cannot_complete",
    );
    active.attention.delete(pending.nativeRequestId);
    active.inspection = this.inspection(active, "running", "active");
  }

  private async prepareSetup(
    context: HarnessSetupContext,
  ): Promise<HarnessSetupPrepared> {
    if (context.configuration.model.provider !== "anthropic")
      throw runtimeError(
        "Claude setup requires an Anthropic execution selection.",
      );
    const prepared = await this.executionManager.prepareHarnessSetup(context);
    const inspection = await inspectPreparedSetup(prepared);
    return { context, inspection, native: { prepared } };
  }

  private async inspectSetup(
    setup: HarnessSetupPrepared,
  ): Promise<HarnessSetupInspection> {
    return inspectPreparedSetup(nativePreparedSetup(setup));
  }

  private async beginSetup(
    setup: HarnessSetupPrepared,
    authorization: {
      authorizationId: string;
      kind: "human_harness_setup";
      authorizedAt: string;
    },
    onEvent: Parameters<AgentHarnessSetup["begin"]>[2],
  ): Promise<HarnessSetupOperation> {
    const authorizedAt = Date.parse(authorization.authorizedAt);
    const authorizationAge = this.now().getTime() - authorizedAt;
    if (
      authorization.kind !== "human_harness_setup" ||
      !authorization.authorizationId ||
      !Number.isFinite(authorizedAt) ||
      authorizationAge < -60_000 ||
      authorizationAge > 5 * 60_000
    )
      throw claudeError(
        "permission_denied",
        "Claude authentication setup requires explicit current human setup authorization.",
        "terminal_not_recoverable",
        "prepare",
        "not_submitted",
      );
    const prepared = nativePreparedSetup(setup);
    const process = await prepared.lease.spawnStreamed(
      claudeAuthenticationCommand(prepared),
      { bufferBytes: 256 * 1024, acknowledgementTimeoutMs: 30_000 },
    );
    const attentionId = randomUUID();
    let cancelled = false;
    onEvent({
      type: "human_interaction_required",
      attentionId,
      message:
        "Complete authentication in the official provider flow. This setup does not authorize model inference.",
    });
    const consume = async (
      stream: AsyncIterable<{ kind: string; data?: Uint8Array }>,
    ) => {
      const decoder = new TextDecoder();
      let retained = "";
      for await (const event of stream) {
        if (event.kind !== "data" || !event.data) continue;
        retained += decoder.decode(event.data, { stream: true });
        if (retained.length > 16_384) retained = retained.slice(-16_384);
        const ephemeralOutput = sanitizeSetupOutput(retained);
        if (ephemeralOutput)
          onEvent({
            type: "human_interaction_required",
            attentionId,
            message:
              "Complete authentication in the official provider flow. This setup does not authorize model inference.",
            ephemeralOutput,
          });
      }
    };
    void consume(process.stdout).catch(() => undefined);
    void consume(process.stderr).catch(() => undefined);
    const completion = process.exit.then(async (exit) => {
      if (cancelled)
        return setupInspection(
          prepared,
          "cancelled",
          false,
          "Harness setup was cancelled.",
        );
      if (exit.kind !== "exited" || exit.exitCode !== 0)
        return setupInspection(
          prepared,
          "failed",
          false,
          "Provider authentication did not complete successfully.",
        );
      return inspectPreparedSetup(prepared);
    });
    return {
      completion,
      respond: async (candidateAttentionId, value) => {
        if (candidateAttentionId !== attentionId || value.length > 8_192)
          throw new Error(
            "Harness setup response identity or size is invalid.",
          );
        await process.write(new TextEncoder().encode(`${value}\n`));
      },
      cancel: async () => {
        cancelled = true;
        await process.cancel();
      },
    };
  }

  async interrupt(lineage: HarnessLineage): Promise<void> {
    const active = this.required(lineage.lineageId);
    const turnId = active.binding.submission.turnId;
    if (!turnId) return;
    try {
      await active.client.send({
        type: "cancel_turn",
        request_id: randomUUID(),
        turn_id: turnId,
      });
      await withTimeout(active.cancellation.promise, CANCELLATION_WAIT_MS);
      return;
    } catch {
      try {
        await active.client.process.cancel();
        active.binding.submission.state = "cancelled";
        active.cancellation.resolve();
        return;
      } catch (error) {
        throw claudeError(
          "cancellation_uncertain",
          error instanceof Error
            ? error.message
            : "Claude cancellation acknowledgement is unavailable.",
          "uncertain",
          "interrupt",
          "ambiguous",
        );
      }
    }
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    const active = this.active.get(lineage.lineageId);
    if (active) return cloneInspection(active.inspection);
    const binding = parseClaudeTransportBinding(lineage.transportBinding);
    if (!binding)
      return unavailableInspection(
        lineage,
        "No Claude streamed-process binding is persisted.",
      );
    if (binding.submission.state === "settled")
      return persistedInspection(lineage, binding, "retained", "idle");
    if (["cancelled", "terminal"].includes(binding.submission.state))
      return persistedInspection(lineage, binding, "unavailable", "completed");
    return persistedInspection(lineage, binding, "recovering", "unknown");
  }

  async recover(
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): Promise<HarnessRecoveredExecution> {
    const current = this.active.get(lineage.lineageId);
    if (current)
      return {
        found: true,
        handle: executionHandle(lineage, current),
        inspection: cloneInspection(current.inspection),
        detail: "The exact Worker-attached Claude stream is still available.",
      };
    const binding = parseClaudeTransportBinding(lineage.transportBinding);
    if (!binding)
      return { found: false, detail: "No Claude transport binding exists." };
    this.validatePersistedBinding(binding, lineage, dispatch);
    if (dispatch && (await structuredResultExists(dispatch.resultDirectory)))
      return {
        found: true,
        handle: persistedExecutionHandle(lineage, binding),
        inspection: persistedInspection(
          lineage,
          binding,
          "retained",
          "completed",
        ),
        detail:
          "Authoritative QE completion exists; wrapper/provider settlement is no longer required for replay.",
      };
    if (["submitted", "native_accepted"].includes(binding.submission.state)) {
      if (dispatch) {
        const recovered =
          await this.executionManager.prepareAndReconcileStreamedProcess(
            dispatch,
            lineage,
            materializeExecutionArtifacts(this.config, dispatch),
            binding.process,
          );
        this.validatePreparedReplacement(binding, dispatch, recovered.prepared);
        if (recovered.reconciliation.process === "identity_mismatch")
          throw claudeError(
            "ownership_mismatch",
            "The persisted Claude process identity was reused by another process.",
            "terminal_not_recoverable",
            "recover",
            "ambiguous",
          );
      }
      throw claudeError(
        "submission_uncertain",
        "The Worker lost Claude stdio after submission without provider-settlement evidence; automatic replay is forbidden.",
        "operator_recovery_required",
        "recover",
        binding.submission.state === "native_accepted"
          ? "native_accepted"
          : "submitted",
      );
    }
    if (["cancelled", "terminal"].includes(binding.submission.state))
      return {
        found: false,
        detail: "Claude transport history is terminal and cannot be adopted.",
      };
    if (!dispatch)
      return {
        found: false,
        detail: "Claude recovery requires the exact persisted dispatch.",
      };
    const replacement = await this.prepareReplacement(
      dispatch,
      lineage,
      binding,
    );
    const active = await this.spawn(dispatch, lineage, binding, replacement);
    return {
      found: true,
      handle: executionHandle(lineage, active),
      inspection: cloneInspection(active.inspection),
      detail:
        binding.submission.state === "settled"
          ? "Reopened the exact settled native session; only QE-authorized corrective continuation remains eligible."
          : "Replaced an unsubmitted wrapper generation without replaying provider work.",
    };
  }

  async proveInactiveForFreshRecovery(
    lineage: HarnessLineage,
  ): Promise<boolean> {
    if (this.active.has(lineage.lineageId)) return false;
    const binding = parseClaudeTransportBinding(lineage.transportBinding);
    // A persisted attached-only process needs the exact dispatch/spec to
    // reconcile its physical identity. This side-effect-free interface lacks
    // that authority, so it must not invent absence.
    return binding === null;
  }

  async retire(lineage: HarnessLineage): Promise<void> {
    await this.close(lineage);
  }

  async close(lineage: HarnessLineage): Promise<void> {
    const active = this.active.get(lineage.lineageId);
    if (!active) return;
    try {
      await active.client.shutdown(randomUUID());
      await withTimeout(
        active.client.process.exit.then(() => undefined),
        2_000,
      );
    } catch {
      await active.client.process.cancel().catch(() => undefined);
    } finally {
      await active.client.disconnect().catch(() => undefined);
      this.active.delete(lineage.lineageId);
    }
  }

  async clearActiveMetadata(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    const active = this.active.get(lineage.lineageId);
    if (!active) return;
    active.activeDispatch = null;
    active.attention.clear();
    active.inspection = this.inspection(active, "retained", "idle");
  }

  async discoverAdoptionCandidates() {
    return [];
  }

  disconnect(): void {
    for (const active of this.active.values())
      void active.client.disconnect().catch(() => undefined);
    this.active.clear();
  }

  private async spawn(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    recoveryBinding?: ClaudeTransportState,
    preparedOverride?: PreparedSbxHarnessExecution,
  ): Promise<ActiveClaudeExecution> {
    const prepared =
      preparedOverride ??
      (await this.executionManager.prepare(
        dispatch,
        lineage,
        materializeExecutionArtifacts(this.config, dispatch),
      ));
    if (prepared.harnessKind !== this.kind || !prepared.claude)
      throw runtimeError(
        "The exact Claude Agent SDK profile artifacts are absent.",
      );
    if (
      !prepared.lease.capabilities.some(
        (capability) =>
          capability.kind === "process.streamed" &&
          capability.mode === "attached_only",
      )
    )
      throw runtimeError(
        "Attached-only process.streamed capability is required.",
      );
    await this.writeAndSyncControl(dispatch, lineage, prepared);
    const generation = randomUUID();
    const process = await prepared.lease.spawnStreamed(
      {
        executable: prepared.guestExecutable,
        args: [],
        cwd: prepared.workspace.paths.workspace,
        environment: safeEnvironment(prepared),
      },
      { bufferBytes: 2 * 1024 * 1024, acknowledgementTimeoutMs: 30_000 },
    );
    const client = new ClaudeWrapperClient(process, generation);
    const configuration = this.wrapperConfiguration(
      dispatch,
      lineage,
      prepared,
    );
    const requestId = randomUUID();
    await client.send({
      type: "initialize",
      request_id: requestId,
      configuration: configuration as unknown as JsonValue,
    });
    const ready = await client.next(60_000);
    if (ready.type === "fatal_error") throw eventError(ready, "readiness");
    if (ready.type !== "ready" || ready.request_id !== requestId)
      throw runtimeError("Claude wrapper initialization correlation failed.");
    this.validateReady(ready, prepared);
    if (ready.authentication !== "authenticated") {
      await client.shutdown(randomUUID()).catch(() => undefined);
      await process.cancel().catch(() => undefined);
      throw claudeError(
        "auth_required",
        "Claude subscription authentication is required in this Run-private SBX; use the explicit human-authorized setup action.",
        "operator_recovery_required",
        "readiness",
        "not_submitted",
      );
    }
    const binding: ClaudeTransportState = {
      wrapperGeneration: generation,
      process: process.handle,
      profileId: prepared.lease.ref.profile.id,
      profileDigest: prepared.lease.ref.profile.digest,
      workspaceIdentity: hash(prepared.workspace.paths.workspace),
      configurationIdentity: configurationIdentity(dispatch),
      wrapperExecutable: prepared.guestExecutable,
      wrapperVersion: prepared.claude.wrapperVersion,
      sdkVersion: prepared.claude.sdkVersion,
      claudeCodeVersion: prepared.claude.claudeCodeVersion,
      runtimeSha256: prepared.claude.runtimeSha256,
      model: dispatch.action.execution.configuration.model.model,
      effort: requiredEffort(dispatch),
      toolPolicyDigest: toolPolicyDigest(dispatch),
      submission:
        recoveryBinding?.submission.state === "settled"
          ? {
              state: "settled",
              requestId: null,
              turnId: null,
              continuationCount: recoveryBinding.submission.continuationCount,
              eventCursor: recoveryBinding.submission.eventCursor,
            }
          : recoveryBinding?.submission.state === "not_submitted"
            ? {
                ...emptySubmission(),
                continuationCount: recoveryBinding.submission.continuationCount,
                eventCursor: recoveryBinding.submission.eventCursor,
              }
            : emptySubmission(),
    };
    const active = {} as ActiveClaudeExecution;
    Object.assign(active, {
      prepared,
      client,
      control: new HarnessControlClient(controlDescriptorPath(lineage)),
      binding,
      inspection: {} as HarnessInspection,
      attention: new Map(),
      cancellation: deferred<void>(),
      activeDispatch: null,
      settledRecovery: recoveryBinding?.submission.state === "settled",
      lastUsage: null,
    } satisfies ActiveClaudeExecution);
    active.inspection = this.inspection(
      active,
      recoveryBinding?.submission.state === "settled"
        ? "recovering"
        : "starting",
      "idle",
    );
    this.active.set(lineage.lineageId, active);
    return active;
  }

  private async collect(
    dispatch: DispatchRecord,
    active: ActiveClaudeExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    for (;;) {
      if (active.settledRecovery) {
        active.settledRecovery = false;
        const outputs = await this.afterSettlement(dispatch, active, onEvent);
        if (outputs) return outputs;
      }
      // Provider turns have no transport lifetime deadline. Process exit,
      // cancellation, or an explicit protocol event settles this wait.
      const event = await active.client.next(null);
      active.binding.submission.eventCursor += 1;
      if (event.type === "fatal_error") throw eventError(event, "observe");
      if (event.type === "shutdown" || event.type === "ready")
        throw runtimeError(
          "Claude wrapper emitted an out-of-order lifecycle event.",
        );
      this.assertTurnCorrelation(event, active);
      if (event.type === "native_session") {
        active.inspection.nativeSession = nativeSessionRef(
          this.kind,
          "id",
          event.session_id,
        );
        active.inspection = this.inspection(active, "running", "active");
        onEvent({ type: "inspection", inspection: active.inspection });
        continue;
      }
      if (event.type === "native_activity") {
        if (event.activity === "native_accepted") {
          active.binding.submission.state = "native_accepted";
          const acceptedAt = this.now().toISOString();
          active.inspection = this.inspection(active, "running", "active");
          onEvent({
            type: "prompt_accepted",
            acceptedAt,
            inspection: active.inspection,
          });
        } else {
          active.inspection = this.inspection(active, "running", "active");
          onEvent({
            type: "native_activity",
            observedAt: this.now().toISOString(),
            inspection: active.inspection,
          });
        }
        continue;
      }
      if (event.type === "human_attention_request") {
        await this.recordAttention(active, event);
        onEvent({ type: "inspection", inspection: active.inspection });
        continue;
      }
      if (event.type === "human_attention_resolved") {
        const pending = active.attention.get(event.native_request_id);
        if (!pending || pending.attentionId !== event.attention_id)
          throw claudeError(
            "stale_human_attention",
            "Claude acknowledged a HumanAttention response for another native request.",
            "terminal_not_recoverable",
            "observe",
            "native_accepted",
          );
        pending.responseAccepted.resolve();
        continue;
      }
      if (event.type === "qe_complete_step") {
        await this.completeStep(active, event);
        active.inspection = this.inspection(active, "running", "active");
        onEvent({
          type: "structured_result_received",
          observedAt: this.now().toISOString(),
          inspection: active.inspection,
        });
        continue;
      }
      if (event.type === "usage") {
        this.assertUsage(event, active.binding.model);
        active.lastUsage = usageSummary(event);
        active.inspection = this.inspection(active, "running", "active");
        onEvent({ type: "inspection", inspection: active.inspection });
        continue;
      }
      if (event.type === "turn_settled") {
        this.assertExactExecution(event, active);
        active.binding.submission.state =
          event.outcome === "cancelled" ? "cancelled" : "settled";
        active.inspection = this.inspection(
          active,
          event.outcome === "cancelled" ? "unavailable" : "running",
          "completed",
        );
        onEvent({
          type: "provider_turn_settled",
          observedAt: this.now().toISOString(),
          inspection: active.inspection,
        });
        onEvent({
          type: "native_idle",
          observedAt: this.now().toISOString(),
          inspection: active.inspection,
        });
        if (event.outcome === "cancelled") {
          active.cancellation.resolve();
          throw claudeError(
            "execution_cancelled",
            "Claude turn was cancelled.",
            "terminal_not_recoverable",
            "observe",
            "native_accepted",
          );
        }
        const outputs = await this.afterSettlement(dispatch, active, onEvent);
        if (outputs) return outputs;
      }
    }
  }

  private async afterSettlement(
    dispatch: DispatchRecord,
    active: ActiveClaudeExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue> | null> {
    const decision = await active.control.nativeStop(
      "claude_turn_settled",
      true,
      active.binding.model,
    );
    if (decision.nativeStop?.decision === "allow") {
      await waitForResult(dispatch);
      const outputs = (await collectStepResult(dispatch)).envelope.outputs;
      active.inspection = this.inspection(active, "retained", "completed");
      onEvent({
        type: "structured_result_received",
        observedAt: this.now().toISOString(),
        inspection: active.inspection,
      });
      return outputs;
    }
    if (decision.nativeStop?.decision === "contract_violation")
      throw claudeError(
        "harness_contract_violation",
        decision.nativeStop.reason,
        "terminal_not_recoverable",
        "observe",
        "native_accepted",
      );
    if (decision.nativeStop?.decision !== "continue")
      throw runtimeError("QE native-stop authority returned no decision.");
    const count = active.binding.submission.continuationCount + 1;
    if (count > 2)
      throw claudeError(
        "harness_contract_violation",
        "Claude exceeded the bounded QE corrective-continuation contract.",
        "terminal_not_recoverable",
        "execute",
        "native_accepted",
      );
    const requestId = randomUUID();
    const turnId = randomUUID();
    await active.client.send({
      type: "execute_turn",
      request_id: requestId,
      turn_id: turnId,
      continuation: true,
      prompt: `Quest Engineering completion correction: ${decision.nativeStop.reason} Call qe_complete_step exactly once with the already-declared output keys.`,
    });
    active.binding.submission = {
      state: "submitted",
      requestId,
      turnId,
      continuationCount: count,
      eventCursor: active.binding.submission.eventCursor,
    };
    active.inspection = this.inspection(
      active,
      "waiting_for_activity",
      "unknown",
    );
    onEvent({ type: "inspection", inspection: active.inspection });
    return null;
  }

  private async completeStep(
    active: ActiveClaudeExecution,
    event: Extract<ClaudeWrapperEvent, { type: "qe_complete_step" }>,
  ): Promise<void> {
    try {
      const result = await active.control.completeStep(
        event.outputs,
        `claude:${event.tool_call_id}`,
      );
      await active.client.send({
        type: "qe_complete_step_result",
        request_id: randomUUID(),
        tool_call_id: event.tool_call_id,
        accepted: result.accepted,
        error_code: null,
      });
    } catch (error) {
      await active.client.send({
        type: "qe_complete_step_result",
        request_id: randomUUID(),
        tool_call_id: event.tool_call_id,
        accepted: false,
        error_code:
          error && typeof error === "object" && "code" in error
            ? String(error.code).slice(0, 64)
            : "completion_rejected",
      });
    }
  }

  private async recordAttention(
    active: ActiveClaudeExecution,
    event: Extract<ClaudeWrapperEvent, { type: "human_attention_request" }>,
  ): Promise<void> {
    const response = await active.control.requestHumanAssistance(
      {
        category: event.category,
        message: event.message,
        interaction: event.interaction,
        ...(event.response_schema !== undefined
          ? { responseSchema: event.response_schema }
          : {}),
      },
      `claude:${event.native_request_id}`,
    );
    if (!response.attention)
      throw runtimeError("QE HumanAttention authority returned no identity.");
    active.attention.set(event.native_request_id, {
      attentionId: event.attention_id,
      nativeRequestId: event.native_request_id,
      qeAttentionId: response.attention.attentionId,
      responseAccepted: deferred<void>(),
    });
    active.inspection = this.inspection(
      active,
      "waiting_for_human",
      "blocked",
      response.attention,
    );
  }

  private inspection(
    active: ActiveClaudeExecution,
    state: HarnessInspection["state"],
    activity: HarnessInspection["activity"]["state"],
    attention: HumanAttention | null = null,
  ): HarnessInspection {
    const detail = [
      `Claude ${active.binding.submission.state}`,
      active.lastUsage,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      state,
      activity: { state: activity, ...(detail ? { detail } : {}) },
      nativeSession: active.inspection?.nativeSession ?? null,
      health: state === "unavailable" ? "unavailable" : "healthy",
      attention,
      intervention: null,
      lastActivityAt: this.now().toISOString(),
      transportBinding: claudeTransportBinding(active.binding),
      interactive: null,
    };
  }

  private wrapperConfiguration(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    prepared: PreparedSbxHarnessExecution,
  ): ClaudeWrapperConfiguration {
    const claude = prepared.claude;
    if (!claude) throw runtimeError("Claude profile configuration is missing.");
    const configuredModels = (this.config.executorModels ?? [])
      .filter((model) => model.provider === "anthropic")
      .map((model) => ({
        id: model.model,
        effort: configuredEfforts(this.config),
      }));
    return {
      backend: this.options.fake ? "fake" : "sdk",
      wrapper_version: claude.wrapperVersion,
      sdk_version: claude.sdkVersion,
      claude_code_version: claude.claudeCodeVersion,
      runtime_sha256: this.options.fake?.runtimeSha256 ?? claude.runtimeSha256,
      claude_executable: claude.runtimeExecutable,
      sdk_module: claude.sdkModule,
      sdk_package_json: claude.sdkPackageJson,
      zod_module: claude.zodModule,
      workspace: prepared.workspace.paths.workspace,
      workspace_access: dispatch.action.execution.execution_workspace.access,
      config_dir: claude.configDirectory,
      control_descriptor: claude.controlDescriptor,
      temp_dir: `${claude.configDirectory}/.tmp`,
      model: dispatch.action.execution.configuration.model.model,
      effort: requiredEffort(dispatch),
      tools: semanticTools(dispatch),
      native_session_id: lineage.nativeSession
        ? nativeSessionIdentity(lineage.nativeSession, this.kind).opaqueId
        : null,
      runtime_models: configuredModels,
      fake: this.options.fake
        ? {
            authenticated: this.options.fake.authenticated,
            models: structuredClone(this.options.fake.models),
            turns: structuredClone(this.options.fake.turns),
          }
        : null,
    };
  }

  private validateReady(
    event: Extract<ClaudeWrapperEvent, { type: "ready" }>,
    prepared: PreparedSbxHarnessExecution,
  ): void {
    const claude = prepared.claude;
    if (
      !claude ||
      event.wrapper_version !== claude.wrapperVersion ||
      event.sdk_version !== claude.sdkVersion ||
      event.claude_code_version !== claude.claudeCodeVersion ||
      event.runtime_sha256 !==
        (this.options.fake?.runtimeSha256 ?? claude.runtimeSha256) ||
      event.streamed_process !== "attached_only"
    )
      throw runtimeError(
        "Claude wrapper/runtime provenance does not match the immutable profile.",
      );
  }

  private async prepareReplacement(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    binding: ClaudeTransportState,
  ): Promise<PreparedSbxHarnessExecution> {
    const recovered =
      await this.executionManager.prepareAndReconcileStreamedProcess(
        dispatch,
        lineage,
        materializeExecutionArtifacts(this.config, dispatch),
        binding.process,
      );
    this.validatePreparedReplacement(binding, dispatch, recovered.prepared);
    if (recovered.reconciliation.process === "identity_mismatch")
      throw claudeError(
        "ownership_mismatch",
        "The persisted Claude process identity was reused by another process.",
        "terminal_not_recoverable",
        "recover",
        "ambiguous",
      );
    if (
      recovered.reconciliation.process === "running" ||
      recovered.reconciliation.process === "unavailable"
    )
      throw claudeError(
        "stream_lost",
        "The Claude process may still be running but attached-only stdio cannot be recovered; replacement is forbidden.",
        "operator_recovery_required",
        "recover",
        binding.submission.state === "not_submitted"
          ? "not_submitted"
          : "ambiguous",
      );
    return recovered.prepared;
  }

  private validatePreparedReplacement(
    binding: ClaudeTransportState,
    dispatch: DispatchRecord,
    prepared: PreparedSbxHarnessExecution,
  ): void {
    const claude = prepared.claude;
    this.validateBindingConfiguration(binding, dispatch);
    if (
      !claude ||
      binding.profileId !== prepared.lease.ref.profile.id ||
      binding.profileDigest !== prepared.lease.ref.profile.digest ||
      binding.workspaceIdentity !== hash(prepared.workspace.paths.workspace) ||
      binding.wrapperExecutable !== prepared.guestExecutable ||
      binding.wrapperVersion !== claude.wrapperVersion ||
      binding.sdkVersion !== claude.sdkVersion ||
      binding.claudeCodeVersion !== claude.claudeCodeVersion ||
      binding.runtimeSha256 !== claude.runtimeSha256
    )
      throw claudeError(
        "ownership_mismatch",
        "Persisted Claude runtime, profile, or workspace provenance is incompatible.",
        "terminal_not_recoverable",
        "recover",
        "not_submitted",
      );
  }

  private validateBindingConfiguration(
    binding: ClaudeTransportState,
    dispatch: DispatchRecord,
  ): void {
    if (
      binding.configurationIdentity !== configurationIdentity(dispatch) ||
      binding.model !== dispatch.action.execution.configuration.model.model ||
      binding.effort !== requiredEffort(dispatch) ||
      binding.toolPolicyDigest !== toolPolicyDigest(dispatch)
    )
      throw claudeError(
        "ownership_mismatch",
        "Persisted Claude model, effort, tool policy, or workspace configuration is incompatible.",
        "terminal_not_recoverable",
        "recover",
        "not_submitted",
      );
  }

  private validatePersistedBinding(
    binding: ClaudeTransportState,
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): void {
    if (
      (binding.submission.state === "settled" && !lineage.nativeSession) ||
      binding.process.environment.workerId !== this.config.workerId ||
      binding.profileId !== binding.process.environment.profile.id ||
      binding.profileDigest !== binding.process.environment.profile.digest ||
      binding.wrapperExecutable !== binding.process.executable ||
      (dispatch &&
        (binding.process.environment.runId !== dispatch.action.run_id ||
          binding.configurationIdentity !== configurationIdentity(dispatch))) ||
      lineage.harnessKind !== this.kind
    )
      throw claudeError(
        "ownership_mismatch",
        "Persisted Claude environment, workspace, configuration, or process ownership is incompatible.",
        "terminal_not_recoverable",
        "recover",
        "not_submitted",
      );
  }

  private assertTurnCorrelation(
    event: Exclude<
      ClaudeWrapperEvent,
      { type: "ready" | "fatal_error" | "shutdown" }
    >,
    active: ActiveClaudeExecution,
  ): void {
    if (
      event.request_id !== active.binding.submission.requestId ||
      event.turn_id !== active.binding.submission.turnId
    )
      throw claudeError(
        "stale_generation",
        "Claude event belongs to another request or native turn.",
        "terminal_not_recoverable",
        "observe",
        "ambiguous",
      );
  }

  private assertExactExecution(
    event: Extract<ClaudeWrapperEvent, { type: "turn_settled" }>,
    active: ActiveClaudeExecution,
  ): void {
    if (event.observed_model !== active.binding.model)
      throw claudeError(
        "model_unavailable",
        "Claude settled on a model other than the exact scheduled model.",
        "terminal_not_recoverable",
        "observe",
        "native_accepted",
      );
    if (event.effort_attestation !== active.binding.effort)
      throw claudeError(
        "effort_unavailable",
        "Claude did not attest the exact scheduled effort.",
        "terminal_not_recoverable",
        "observe",
        "native_accepted",
      );
  }

  private assertUsage(
    event: Extract<ClaudeWrapperEvent, { type: "usage" }>,
    model: string,
  ): void {
    if (event.models.some((usage) => usage.model !== model))
      throw claudeError(
        "model_unavailable",
        "Claude usage attributed work to an unscheduled model.",
        "terminal_not_recoverable",
        "observe",
        "native_accepted",
      );
  }

  private assertDispatch(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): void {
    if (
      dispatch.action.execution.configuration.harness_kind !== this.kind ||
      lineage.harnessKind !== this.kind
    )
      throw runtimeError("Claude adapter received another harness's dispatch.");
    requiredEffort(dispatch);
    semanticTools(dispatch);
  }

  private required(lineageId: string): ActiveClaudeExecution {
    const active = this.active.get(lineageId);
    if (!active)
      throw claudeError(
        "stream_lost",
        "The exact Worker-attached Claude stream is unavailable.",
        "operator_recovery_required",
        "observe",
        "ambiguous",
      );
    return active;
  }

  private async writeAndSyncControl(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    prepared: PreparedSbxHarnessExecution,
  ): Promise<void> {
    await writeControlAtomic(lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: dispatch.action.worker_id,
      lineageId: lineage.lineageId,
      action: dispatch.action,
      nonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });
    await prepared.syncControl();
  }
}

function nativePreparedSetup(
  setup: HarnessSetupPrepared,
): PreparedSbxHarnessSetup {
  const candidate = (setup.native as { prepared?: PreparedSbxHarnessSetup })
    .prepared;
  if (!candidate?.claude || !candidate.lease || !candidate.workspace)
    throw runtimeError("Claude setup preparation handle is unavailable.");
  return candidate;
}

async function inspectPreparedSetup(
  prepared: PreparedSbxHarnessSetup,
): Promise<HarnessSetupInspection> {
  const result = await prepared.lease.exec({
    executable: prepared.claude.runtimeExecutable,
    args: ["auth", "status"],
    cwd: prepared.workspace.paths.workspace,
    environment: safeEnvironment(prepared),
    timeoutMs: 30_000,
  });
  let authMethod = "none";
  if (result.exitCode === 0) {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      if (typeof value.authMethod === "string") authMethod = value.authMethod;
    } catch {
      return setupInspection(
        prepared,
        "failed",
        false,
        "Claude authentication status was malformed.",
      );
    }
  }
  if (authMethod === "claude.ai")
    return setupInspection(
      prepared,
      "ready",
      true,
      "Run-bound Claude subscription authentication is ready.",
    );
  if (authMethod !== "none")
    return setupInspection(
      prepared,
      "failed",
      false,
      "Claude selected a forbidden non-subscription authentication method.",
    );
  return setupInspection(
    prepared,
    "preparing",
    false,
    "Claude subscription authentication is required for this Run-bound context.",
  );
}

function setupInspection(
  prepared: PreparedSbxHarnessSetup,
  state: HarnessSetupInspection["state"],
  authenticated: boolean,
  detail: string,
): HarnessSetupInspection {
  return {
    state,
    authenticated,
    detail,
    environment: {
      environmentId: prepared.lease.ref.environmentId,
      incarnation: prepared.lease.ref.incarnation,
      profile: { ...prepared.lease.ref.profile },
    },
    configIdentity: prepared.configIdentity,
  };
}

function sanitizeSetupOutput(value: string): string {
  // biome-ignore lint/complexity/useRegexLiterals: A literal ESC byte is intentionally avoided.
  const ansiControlSequence = new RegExp("\\x1b\\[[0-9;?]*[ -/]*[@-~]", "g");
  return value
    .replace(ansiControlSequence, "")
    .replace(/[^\n\r\t\x20-\x7e]/g, "")
    .slice(-16_384);
}

export function claudeAuthenticationCommand(
  prepared: PreparedSbxHarnessExecution | PreparedSbxHarnessSetup,
) {
  const claude = prepared.claude;
  if (!claude) throw runtimeError("Claude setup artifacts are absent.");
  return {
    executable: claude.runtimeExecutable,
    args: ["auth", "login"] as const,
    cwd: prepared.workspace.paths.workspace,
    environment: safeEnvironment(prepared),
  };
}

function persistedExecutionHandle(
  lineage: HarnessLineage,
  binding: ClaudeTransportState,
): HarnessExecutionHandle {
  return {
    schemaVersion: 1,
    harnessKind: "claude_agent_sdk",
    executionId: lineage.lineageId,
    ...(lineage.nativeSession ? { nativeSession: lineage.nativeSession } : {}),
    transportBinding: claudeTransportBinding(binding),
  };
}

function preparedExecution(
  lineage: HarnessLineage,
  active: ActiveClaudeExecution,
): HarnessPreparedExecution {
  return { lineage, handle: executionHandle(lineage, active) };
}
function executionHandle(
  lineage: HarnessLineage,
  active: ActiveClaudeExecution,
): HarnessExecutionHandle {
  return {
    schemaVersion: 1,
    harnessKind: "claude_agent_sdk",
    executionId: lineage.lineageId,
    ...(active.inspection.nativeSession
      ? { nativeSession: active.inspection.nativeSession }
      : {}),
    transportBinding: claudeTransportBinding(active.binding),
  };
}
function safeEnvironment(
  prepared: PreparedSbxHarnessExecution | PreparedSbxHarnessSetup,
): Record<string, string> {
  const claude = prepared.claude;
  if (!claude) throw runtimeError("Claude profile environment is missing.");
  return {
    HOME: claude.configDirectory,
    CLAUDE_CONFIG_DIR: claude.configDirectory,
    TMPDIR: `${claude.configDirectory}/.tmp`,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    BROWSER: "/bin/false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}
function requiredEffort(dispatch: DispatchRecord): ClaudeEffort {
  const value = dispatch.action.execution.configuration.reasoning;
  if (!["low", "medium", "high", "xhigh", "max"].includes(String(value)))
    throw claudeError(
      "effort_unavailable",
      "Claude Agent SDK requires one exact supported effort level.",
      "terminal_not_recoverable",
      "prepare",
      "not_submitted",
    );
  return value as ClaudeEffort;
}
function configuredEfforts(config: WorkerConfig): ClaudeEffort[] {
  return (config.reasoningLevels ?? ["low", "medium", "high"]).filter(
    (value): value is ClaudeEffort =>
      ["low", "medium", "high", "xhigh", "max"].includes(value),
  );
}
function semanticTools(dispatch: DispatchRecord): ClaudeSemanticTool[] {
  const supported = new Set<ClaudeSemanticTool>([
    "workspace.filesystem",
    "workspace.search",
    "terminal.shell",
  ]);
  const tools =
    dispatch.action.execution.configuration.resolved_tool_profile.tools;
  if (tools.some((tool) => !supported.has(tool as ClaudeSemanticTool)))
    throw claudeError(
      "tool_policy_violation",
      "Claude resolved tool policy contains an unsupported semantic capability.",
      "terminal_not_recoverable",
      "prepare",
      "not_submitted",
    );
  return [...new Set(tools as ClaudeSemanticTool[])].sort();
}
function toolPolicyDigest(dispatch: DispatchRecord): string {
  return hash(JSON.stringify(semanticTools(dispatch)));
}
function configurationIdentity(dispatch: DispatchRecord): string {
  return hash(physicalConfiguration(dispatch.action));
}
function emptySubmission(): ClaudeTransportState["submission"] {
  return {
    state: "not_submitted",
    requestId: null,
    turnId: null,
    continuationCount: 0,
    eventCursor: 0,
  };
}
function usageSummary(
  event: Extract<ClaudeWrapperEvent, { type: "usage" }>,
): string {
  const totals = event.models.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input_tokens,
      output: sum.output + usage.output_tokens,
      cacheRead: sum.cacheRead + usage.cache_read_tokens,
      cacheWrite: sum.cacheWrite + usage.cache_write_tokens,
      reasoning: sum.reasoning + usage.reasoning_tokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  );
  return `usage model=${event.models.map((usage) => usage.model).join(",") || "none"} input=${totals.input} output=${totals.output} cache_read=${totals.cacheRead} cache_write=${totals.cacheWrite} reasoning=${totals.reasoning} results=${event.result_count} cost=${event.estimated_cost_usd ?? "unavailable"}`;
}
async function waitForResult(dispatch: DispatchRecord): Promise<void> {
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await structuredResultExists(dispatch.resultDirectory)) return;
    await Bun.sleep(25);
  }
  throw claudeError(
    "completion_export_timeout",
    "QE accepted Claude completion but physical result export did not finish.",
    "operator_recovery_required",
    "observe",
    "native_accepted",
  );
}
function persistedInspection(
  lineage: HarnessLineage,
  binding: ClaudeTransportState,
  state: HarnessInspection["state"],
  activity: HarnessInspection["activity"]["state"],
): HarnessInspection {
  return {
    state,
    activity: { state: activity, detail: `Claude ${binding.submission.state}` },
    nativeSession: lineage.nativeSession,
    health: state === "unavailable" ? "unavailable" : "unknown",
    attention: lineage.attention,
    intervention: null,
    lastActivityAt: lineage.lastActivityAt,
    transportBinding: claudeTransportBinding(binding),
    interactive: null,
  };
}
function unavailableInspection(
  lineage: HarnessLineage,
  detail: string,
): HarnessInspection {
  return {
    state: "unavailable",
    activity: { state: "unknown", detail },
    nativeSession: lineage.nativeSession,
    health: "unavailable",
    attention: lineage.attention,
    intervention: null,
    lastActivityAt: lineage.lastActivityAt,
    interactive: null,
  };
}
function cloneInspection(value: HarnessInspection): HarnessInspection {
  return structuredClone(value);
}
function eventError(
  event: Extract<ClaudeWrapperEvent, { type: "fatal_error" }>,
  phase: "readiness" | "observe",
): OperationalExecutionError {
  const terminal = [
    "model_unavailable",
    "effort_unavailable",
    "tool_policy_violation",
    "runtime_incompatible",
    "permission_denied",
    "stale_generation",
    "malformed_frame",
    "oversized_frame",
  ].includes(event.code);
  const classification =
    event.code === "provider_unavailable"
      ? "auto_retryable"
      : event.code === "submission_uncertain" ||
          event.side_effect_certainty === "ambiguous"
        ? "uncertain"
        : terminal
          ? "terminal_not_recoverable"
          : "operator_recovery_required";
  return claudeError(
    event.code,
    event.message,
    classification,
    phase,
    event.side_effect_certainty,
  );
}
function recoveryError(state: string): OperationalExecutionError {
  return claudeError(
    "submission_uncertain",
    `Claude continuation cannot replace persisted transport state ${state}.`,
    "operator_recovery_required",
    "recover",
    state === "native_accepted"
      ? "native_accepted"
      : state === "submitted"
        ? "submitted"
        : "ambiguous",
  );
}
function runtimeError(message: string): OperationalExecutionError {
  return claudeError(
    "runtime_incompatible",
    message,
    "terminal_not_recoverable",
    "prepare",
    "not_submitted",
  );
}
function claudeError(
  code: string,
  message: string,
  classification:
    | "auto_retryable"
    | "operator_recovery_required"
    | "terminal_not_recoverable"
    | "uncertain",
  phase:
    | "discovery"
    | "prepare"
    | "readiness"
    | "execute"
    | "observe"
    | "recover"
    | "interrupt"
    | "retire",
  sideEffectCertainty:
    | "not_submitted"
    | "submitted"
    | "native_accepted"
    | "ambiguous",
): OperationalExecutionError {
  return new OperationalExecutionError(
    message,
    classification,
    code,
    undefined,
    { phase, sideEffectCertainty, capability: "process.streamed" },
  );
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("operation timed out")), timeoutMs),
    ),
  ]);
}
