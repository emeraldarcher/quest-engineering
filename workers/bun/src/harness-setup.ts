import type { DispatchRegistry } from "./dispatch/registry.ts";
import type {
  HarnessSetupRecord,
  HarnessSetupStore,
} from "./harness-setup-store.ts";
import type { HarnessRegistry } from "./harnesses/registry.ts";
import type {
  HarnessSetupContext,
  HarnessSetupEvent,
  HarnessSetupOperation,
  HarnessSetupPrepared,
} from "./harnesses/types.ts";
import { OperationalExecutionError } from "./harnesses/types.ts";
import type {
  CancelHarnessSetupCommand,
  PrepareHarnessSetupCommand,
  RespondHarnessSetupCommand,
} from "./protocol/types.ts";

export type HarnessSetupReporter = (
  record: HarnessSetupRecord,
  ephemeralOutput?: string,
) => Promise<void>;

interface ActiveSetup {
  prepared: HarnessSetupPrepared;
  operation: HarnessSetupOperation;
  cancellation: Promise<void> | null;
}

export class HarnessSetupCoordinator {
  private readonly active = new Map<string, ActiveSetup>();
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    readonly store: HarnessSetupStore,
    private readonly registry: DispatchRegistry,
    private readonly harnesses: HarnessRegistry,
    private readonly report: HarnessSetupReporter,
  ) {}

  prepare(command: PrepareHarnessSetupCommand): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Harness setup coordinator is closed."));
    const existing = this.operations.get(command.setup.setup_id);
    if (existing) return existing;
    const record = this.store.accept(command);
    const active = this.active.get(command.setup.setup_id);
    if (active) return this.report(record);
    if (record.state === "ready") {
      const operation = this.revalidateReady(record).finally(() =>
        this.operations.delete(command.setup.setup_id),
      );
      this.operations.set(command.setup.setup_id, operation);
      return operation;
    }
    if (
      [
        "failed",
        "uncertain",
        "cancelled",
        "invalidated",
        "cancellation_requested",
      ].includes(record.state)
    )
      return this.report(record);
    const operation = this.prepareOnce(command).finally(() =>
      this.operations.delete(command.setup.setup_id),
    );
    this.operations.set(command.setup.setup_id, operation);
    return operation;
  }

  async reconcile(): Promise<void> {
    for (const record of this.store.list()) {
      if (this.active.has(record.setupId)) {
        await this.report(record);
        continue;
      }
      if (
        ["failed", "uncertain", "cancelled", "invalidated"].includes(
          record.state,
        )
      )
        continue;
      await this.prepare(record.command);
    }
  }

  async invalidateRun(runId: string): Promise<void> {
    for (const record of this.store
      .list()
      .filter((candidate) => candidate.command.setup.run_id === runId)) {
      if (record.state !== "invalidated")
        this.store.transition(
          record.setupId,
          record.setupGeneration,
          "invalidated",
          {
            attentionId: null,
            failure: {
              code: "run_cleanup_requested",
              message: "Run cleanup invalidated this harness setup context.",
            },
          },
        );
      const pending = this.operations.get(record.setupId);
      if (pending) await pending.catch(() => undefined);
      const active = this.active.get(record.setupId);
      if (active) await this.cancelActive(active).catch(() => undefined);
      this.active.delete(record.setupId);
      this.registry.retireUnclaimedSetupLineage(
        record.command.setup.physical_lineage_id,
      );
    }
  }

  async respond(command: RespondHarnessSetupCommand): Promise<void> {
    const record = this.store.get(command.setup_id);
    if (record.setupGeneration !== command.setup_generation)
      throw new Error("Harness setup response identity is stale.");
    if (
      this.store.responseClaimed(
        command.setup_id,
        command.setup_generation,
        command.request_id,
        command.attention_id,
      )
    ) {
      await this.report(record);
      return;
    }
    if (
      record.state !== "human_interaction_required" ||
      record.attentionId !== command.attention_id
    )
      throw new Error("Harness setup response identity is stale.");
    const active = this.active.get(command.setup_id);
    if (!active)
      throw new Error("Harness setup interaction process is unavailable.");
    const claimed = this.store.claimResponse(
      command.setup_id,
      command.setup_generation,
      command.request_id,
      command.attention_id,
    );
    if (!claimed) {
      await this.report(record);
      return;
    }
    try {
      await active.operation.respond(command.attention_id, command.value);
    } catch (error) {
      const uncertain = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "uncertain",
        {
          invocationState: "uncertain",
          attentionId: null,
          failure: {
            code: "setup_response_outcome_uncertain",
            message:
              "The provider setup response outcome is uncertain; no response content was retained.",
          },
        },
      );
      await this.report(uncertain);
      throw error;
    }
  }

  assertExecutionBinding(command: {
    action_id: string;
    run_id: string;
    occurrence_id: string;
    execution: {
      context: {
        mode: "fresh" | "continue_from";
        source_occurrence_id: string | null;
        logical_lineage_id: string;
      };
    };
    harness_setup?: {
      setup_id: string;
      setup_generation: number;
      physical_lineage_id: string;
      environment: {
        environment_id: string;
        incarnation: string;
        profile: { id: string; digest: string };
      };
      config_identity: string;
    };
  }): void {
    const binding = command.harness_setup;
    if (!binding)
      throw new Error("Context-bound harness setup evidence is required.");
    const record = this.store.get(binding.setup_id);
    const inspection = record.inspection;
    const direct =
      record.command.setup.action_id === command.action_id &&
      record.command.setup.occurrence_id === command.occurrence_id;
    const continuation =
      command.execution.context.mode === "continue_from" &&
      command.execution.context.source_occurrence_id ===
        record.command.setup.occurrence_id &&
      command.execution.context.logical_lineage_id ===
        record.command.setup.logical_lineage_id;
    if (
      record.state !== "ready" ||
      record.setupGeneration !== binding.setup_generation ||
      (!direct && !continuation) ||
      record.command.setup.run_id !== command.run_id ||
      record.command.setup.physical_lineage_id !==
        binding.physical_lineage_id ||
      !inspection?.authenticated ||
      inspection.state !== "ready" ||
      inspection.environment?.environmentId !==
        binding.environment.environment_id ||
      inspection.environment?.incarnation !== binding.environment.incarnation ||
      inspection.environment?.profile.id !== binding.environment.profile.id ||
      inspection.environment?.profile.digest !==
        binding.environment.profile.digest ||
      inspection.configIdentity !== binding.config_identity
    )
      throw new Error("Harness setup binding is stale or incompatible.");
  }

  async cancel(command: CancelHarnessSetupCommand): Promise<void> {
    const record = this.store.get(command.setup_id);
    if (record.setupGeneration !== command.setup_generation)
      throw new Error("Harness setup cancellation generation is stale.");
    if (["cancelled", "invalidated"].includes(record.state)) {
      await this.report(record);
      return;
    }
    if (["ready", "failed"].includes(record.state)) {
      const cancelled = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "cancelled",
        { invocationState: record.invocationState, attentionId: null },
      );
      await this.report(cancelled);
      return;
    }
    const requested = this.store.transition(
      record.setupId,
      record.setupGeneration,
      "cancellation_requested",
      { invocationState: record.invocationState, attentionId: null },
    );
    await this.report(requested);
    const active = this.active.get(record.setupId);
    const pending = this.operations.get(record.setupId);
    if (!active && pending) {
      await pending.catch(() => undefined);
      const settled = this.store.get(record.setupId);
      if (["cancelled", "uncertain"].includes(settled.state)) {
        await this.report(settled);
        return;
      }
      return this.cancel(command);
    }
    if (!active && requested.invocationState !== "not_requested") {
      await this.report(
        this.store.transition(
          record.setupId,
          record.setupGeneration,
          "uncertain",
          {
            invocationState: "uncertain",
            failure: {
              code: "setup_cancellation_uncertain",
              message:
                "The provider setup invocation cannot be proven stopped after controller loss.",
            },
          },
        ),
      );
      return;
    }
    if (active) {
      try {
        await this.cancelActive(active);
      } catch (error) {
        await this.cancellationUncertain(record, error);
        throw error;
      } finally {
        this.active.delete(record.setupId);
      }
    }
    const current = this.store.get(record.setupId);
    const cancelled =
      current.state === "cancelled"
        ? current
        : this.store.transition(
            record.setupId,
            record.setupGeneration,
            "cancelled",
            { invocationState: current.invocationState, attentionId: null },
          );
    await this.report(cancelled);
  }

  close(): void {
    this.closed = true;
    this.active.clear();
    this.store.close();
  }

  private async revalidateReady(record: HarnessSetupRecord): Promise<void> {
    const harness = this.harnesses.get(record.command.setup.harness_kind);
    if (!harness.setup)
      throw new Error(`Harness ${harness.kind} has no setup capability.`);
    const context = setupContext(record.command);
    this.registry.reserveSetupLineage(context);
    let inspected: HarnessSetupPrepared["inspection"];
    try {
      const prepared = await harness.setup.prepare(context);
      inspected = await harness.setup.inspect(prepared);
    } catch {
      if (this.isInvalidated(record.setupId)) return;
      await this.report(
        this.store.transition(
          record.setupId,
          record.setupGeneration,
          "failed",
          {
            invocationState: "settled",
            attentionId: null,
            failure: {
              code: "setup_readiness_revalidation_failed",
              message:
                "Run-bound harness readiness could not be revalidated without replay.",
            },
          },
        ),
      );
      return;
    }
    if (this.isInvalidated(record.setupId)) return;
    const previous = record.inspection;
    const exact =
      previous?.environment?.environmentId ===
        inspected.environment?.environmentId &&
      previous?.environment?.incarnation ===
        inspected.environment?.incarnation &&
      previous?.environment?.profile.id === inspected.environment?.profile.id &&
      previous?.environment?.profile.digest ===
        inspected.environment?.profile.digest &&
      previous?.configIdentity === inspected.configIdentity;
    if (exact && inspected.state === "ready" && inspected.authenticated) {
      await this.report(
        this.store.transition(record.setupId, record.setupGeneration, "ready", {
          invocationState: "settled",
          inspection: inspected,
          attentionId: null,
          failure: null,
        }),
      );
      return;
    }
    await this.report(
      this.store.transition(record.setupId, record.setupGeneration, "failed", {
        invocationState: "settled",
        inspection: inspected,
        attentionId: null,
        failure: {
          code: "setup_readiness_lost",
          message:
            "Run-bound harness authentication or physical identity is no longer ready.",
        },
      }),
    );
  }

  private async prepareOnce(
    command: PrepareHarnessSetupCommand,
  ): Promise<void> {
    let record = this.store.accept(command);
    const harness = this.harnesses.get(command.setup.harness_kind);
    if (!harness.setup)
      throw new Error(`Harness ${harness.kind} has no setup capability.`);
    const context = setupContext(command);
    this.registry.reserveSetupLineage(context);

    const invocationMayHaveStarted = record.invocationState !== "not_requested";
    record = this.store.transition(
      record.setupId,
      record.setupGeneration,
      "preparing",
    );
    await this.report(record);
    if (this.isInvalidated(record.setupId)) return;
    if (
      ["cancellation_requested", "cancelled"].includes(
        this.store.get(record.setupId).state,
      )
    ) {
      await this.finishCancellation(
        record,
        invocationMayHaveStarted ? "unknown" : "not_invoked",
      );
      return;
    }
    let prepared: HarnessSetupPrepared;
    let inspected: HarnessSetupPrepared["inspection"];
    try {
      prepared = await harness.setup.prepare(context);
      inspected = await harness.setup.inspect(prepared);
    } catch {
      if (this.isInvalidated(record.setupId)) return;
      if (
        ["cancellation_requested", "cancelled"].includes(
          this.store.get(record.setupId).state,
        )
      ) {
        await this.finishCancellation(
          record,
          invocationMayHaveStarted ? "unknown" : "not_invoked",
        );
        return;
      }
      const failed = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "failed",
        {
          invocationState: "not_requested",
          attentionId: null,
          failure: {
            code: "setup_preparation_failed",
            message:
              "Harness setup preparation failed before the provider login invocation.",
          },
        },
      );
      await this.report(failed);
      return;
    }

    record = this.store.get(record.setupId);
    if (record.state === "invalidated") return;
    if (["cancellation_requested", "cancelled"].includes(record.state)) {
      await this.finishCancellation(
        record,
        invocationMayHaveStarted ? "unknown" : "not_invoked",
      );
      return;
    }

    if (inspected.state === "ready" && inspected.authenticated) {
      const ready = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "ready",
        {
          invocationState: "settled",
          inspection: inspected,
          attentionId: null,
          failure: null,
        },
      );
      await this.report(ready);
      return;
    }

    if (record.invocationState !== "not_requested") {
      const uncertain = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "uncertain",
        {
          invocationState: "uncertain",
          inspection: inspected,
          attentionId: null,
          failure: {
            code: "setup_invocation_outcome_uncertain",
            message:
              "The prior provider setup invocation is not safely replayable after controller loss.",
          },
        },
      );
      await this.report(uncertain);
      return;
    }

    record = this.store.transition(
      record.setupId,
      record.setupGeneration,
      "invocation_requested",
      { invocationState: "requested", inspection: inspected },
    );
    await this.report(record);
    if (this.isInvalidated(record.setupId)) return;
    if (
      ["cancellation_requested", "cancelled"].includes(
        this.store.get(record.setupId).state,
      )
    ) {
      await this.finishCancellation(record, "not_invoked");
      return;
    }

    try {
      const pendingEvents: HarnessSetupEvent[] = [];
      let eventDeliveryReady = false;
      const operation = await harness.setup.begin(
        prepared,
        {
          authorizationId: command.setup.authorization_id,
          kind: "human_harness_setup",
          authorizedAt: command.setup.authorized_at,
        },
        (event) => {
          if (eventDeliveryReady)
            void this.handleEvent(
              record.setupId,
              record.setupGeneration,
              event,
            ).catch(() => undefined);
          else pendingEvents.push(event);
        },
      );
      const active = { prepared, operation, cancellation: null };
      this.active.set(record.setupId, active);
      if (this.isInvalidated(record.setupId)) {
        await this.cancelActive(active).catch(() => undefined);
        this.active.delete(record.setupId);
        return;
      }
      if (
        ["cancellation_requested", "cancelled"].includes(
          this.store.get(record.setupId).state,
        )
      ) {
        try {
          await this.cancelActive(active);
        } catch (error) {
          await this.cancellationUncertain(record, error).catch(
            () => undefined,
          );
          this.active.delete(record.setupId);
          return;
        }
        await this.finishCancellation(record, "invoked_and_stopped").catch(
          () => undefined,
        );
        this.active.delete(record.setupId);
        return;
      }
      const acknowledged = this.store.transition(
        record.setupId,
        record.setupGeneration,
        "invocation_acknowledged",
        { invocationState: "acknowledged" },
      );
      eventDeliveryReady = true;
      void operation.completion.then(
        (inspection) =>
          this.complete(
            record.setupId,
            record.setupGeneration,
            inspection,
          ).catch(() => undefined),
        () =>
          this.fail(
            record.setupId,
            record.setupGeneration,
            "setup_process_failed",
            "The provider setup process failed before readiness could be proven.",
          ).catch(() => undefined),
      );
      await this.report(acknowledged).catch(() => undefined);
      for (const event of pendingEvents)
        await this.handleEvent(
          record.setupId,
          record.setupGeneration,
          event,
        ).catch(() => undefined);
    } catch (error) {
      if (this.isInvalidated(record.setupId)) return;
      const knownNotSubmitted =
        error instanceof OperationalExecutionError &&
        error.sideEffectCertainty === "not_submitted";
      if (
        ["cancellation_requested", "cancelled"].includes(
          this.store.get(record.setupId).state,
        )
      ) {
        if (knownNotSubmitted)
          await this.finishCancellation(record, "not_invoked");
        else await this.cancellationUncertain(record, error);
        return;
      }
      const outcome = this.store.transition(
        record.setupId,
        record.setupGeneration,
        knownNotSubmitted ? "failed" : "uncertain",
        {
          invocationState: knownNotSubmitted ? "not_requested" : "uncertain",
          failure: {
            code: knownNotSubmitted
              ? "setup_invocation_not_started"
              : "setup_invocation_outcome_uncertain",
            message: knownNotSubmitted
              ? "The provider setup invocation was durably proven not submitted."
              : "The provider setup invocation outcome is uncertain and will not be replayed.",
          },
        },
      );
      await this.report(outcome);
    }
  }

  private isInvalidated(setupId: string): boolean {
    return this.store.get(setupId).state === "invalidated";
  }

  private cancelActive(active: ActiveSetup): Promise<void> {
    if (!active.cancellation) active.cancellation = active.operation.cancel();
    return active.cancellation;
  }

  private async finishCancellation(
    record: HarnessSetupRecord,
    outcome: "not_invoked" | "invoked_and_stopped" | "unknown",
  ): Promise<void> {
    const current = this.store.get(record.setupId);
    if (current.state === "cancelled") {
      await this.report(current);
      return;
    }
    if (outcome === "unknown") {
      await this.cancellationUncertain(
        record,
        new Error(
          "The provider setup invocation cannot be proven stopped after controller loss.",
        ),
      );
      return;
    }
    await this.report(
      this.store.transition(
        record.setupId,
        record.setupGeneration,
        "cancelled",
        {
          invocationState:
            outcome === "not_invoked"
              ? "not_requested"
              : current.invocationState,
          attentionId: null,
        },
      ),
    );
  }

  private async cancellationUncertain(
    record: HarnessSetupRecord,
    _error: unknown,
  ): Promise<void> {
    await this.report(
      this.store.transition(
        record.setupId,
        record.setupGeneration,
        "uncertain",
        {
          invocationState: "uncertain",
          attentionId: null,
          failure: {
            code: "setup_cancellation_uncertain",
            message:
              "Harness setup cancellation is uncertain; no provider output was retained.",
          },
        },
      ),
    );
  }

  private async handleEvent(
    setupId: string,
    generation: number,
    event: HarnessSetupEvent,
  ): Promise<void> {
    if (this.closed) return;
    const current = this.store.get(setupId);
    if (
      current.setupGeneration !== generation ||
      ["ready", "failed", "uncertain", "cancelled", "invalidated"].includes(
        current.state,
      ) ||
      (current.state === "cancellation_requested" && event.type !== "cancelled")
    )
      return;
    if (event.type === "human_interaction_required") {
      const waiting = this.store.transition(
        setupId,
        generation,
        "human_interaction_required",
        { attentionId: event.attentionId },
      );
      await this.report(waiting, event.ephemeralOutput);
    } else if (event.type === "ready") {
      await this.complete(setupId, generation, event.inspection);
    } else if (event.type === "failed") {
      await this.fail(setupId, generation, event.code, event.message);
    } else if (event.type === "uncertain") {
      const uncertain = this.store.transition(
        setupId,
        generation,
        "uncertain",
        {
          invocationState: "uncertain",
          attentionId: null,
          failure: { code: event.code, message: event.message },
        },
      );
      await this.report(uncertain);
    } else if (event.type === "cancelled") {
      const cancelled = this.store.transition(
        setupId,
        generation,
        "cancelled",
        {
          attentionId: null,
        },
      );
      await this.report(cancelled);
    }
  }

  private async complete(
    setupId: string,
    generation: number,
    inspection: HarnessSetupPrepared["inspection"],
  ): Promise<void> {
    if (this.closed) return;
    const current = this.store.get(setupId);
    if (
      current.setupGeneration !== generation ||
      [
        "cancellation_requested",
        "cancelled",
        "failed",
        "uncertain",
        "invalidated",
      ].includes(current.state)
    )
      return;
    const state =
      inspection.state === "cancelled"
        ? "cancelled"
        : inspection.authenticated && inspection.state === "ready"
          ? "ready"
          : "failed";
    const updated = this.store.transition(setupId, generation, state, {
      invocationState: "settled",
      inspection,
      attentionId: null,
      failure:
        state === "failed"
          ? { code: "authentication_not_ready", message: inspection.detail }
          : null,
    });
    this.active.delete(setupId);
    await this.report(updated);
  }

  private async fail(
    setupId: string,
    generation: number,
    code: string,
    message: string,
  ): Promise<void> {
    if (this.closed) return;
    const current = this.store.get(setupId);
    if (
      current.setupGeneration !== generation ||
      [
        "cancellation_requested",
        "cancelled",
        "failed",
        "uncertain",
        "invalidated",
      ].includes(current.state)
    )
      return;
    const failed = this.store.transition(setupId, generation, "failed", {
      invocationState: "settled",
      attentionId: null,
      failure: { code, message },
    });
    this.active.delete(setupId);
    await this.report(failed);
  }
}

function setupContext(
  command: PrepareHarnessSetupCommand,
): HarnessSetupContext {
  const setup = command.setup;
  return {
    setupId: setup.setup_id,
    setupGeneration: setup.setup_generation,
    actionId: setup.action_id,
    runId: setup.run_id,
    occurrenceId: setup.occurrence_id,
    memberKey: setup.member_key,
    harnessKind: setup.harness_kind,
    physicalLineageId: setup.physical_lineage_id,
    logicalLineageId: setup.logical_lineage_id,
    workspaceId: setup.workspace_id,
    worktreeId: setup.worktree_id,
    workspaceBindingId: setup.workspace_binding_id,
    canonicalRoot: setup.canonical_root,
    workspaceAccess: setup.workspace_access,
    profile: setup.profile,
    configuration: {
      model: setup.configuration.model,
      reasoning: setup.configuration.reasoning,
      reasoningCapability: setup.configuration.reasoning_capability,
      toolPolicy: setup.configuration.tool_policy,
      toolEnforcement: setup.configuration.tool_enforcement,
      resolvedToolProfile: setup.configuration.resolved_tool_profile,
    },
  };
}
