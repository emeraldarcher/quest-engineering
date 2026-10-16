import {
  constants,
  createCipheriv,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type {
  ProviderAccountEnvironmentManager,
  ProviderAccountSetupRuntimeIdentity,
} from "./execution-environment/provider-account.ts";
import type {
  StreamedProcess,
  StreamedProcessReconciliation,
  StreamedProcessStreamEvent,
} from "./execution-environment/types.ts";
import { EnvironmentBackendError } from "./execution-environment/types.ts";
import type {
  CancelProviderAccountSetupCommand,
  ProviderAccountAuthenticationInspection,
  ProviderAccountSetupCommand,
  RespondProviderAccountSetupCommand,
} from "./protocol/types.ts";
import type {
  ProviderAccountSetupRecord,
  ProviderAccountSetupStore,
} from "./provider-account-setup-store.ts";
import {
  CLAUDE_SUBSCRIPTION_CONFIGURATION,
  isProviderAuthenticationReady,
  type ProviderAuthenticationInspection,
} from "./provider-auth.ts";

const INTERACTION_LIMIT_BYTES = 16_384;
const DEFAULT_INTERACTION_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_HUMAN_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 30_000;
export const CLAUDE_LOGIN_INTERACTION_IDENTITY =
  "claude-code-2.1.292-auth-login-stdout-v1";

export interface ProviderAccountSetupCoordinatorOptions {
  interactionDiscoveryTimeoutMs?: number;
  humanCompletionTimeoutMs?: number;
  cancellationSettlementTimeoutMs?: number;
}

export interface SealedProviderAccountSetupOutput {
  version: "rsa-oaep-sha256-aes-256-gcm-v1";
  encrypted_key: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface ProviderAccountSetupReport {
  setup_attempt_id: string;
  provider_account_id: string;
  setup_generation: number;
  credential_generation: number;
  environment_generation: number;
  worker_generation: number;
  environment_operation_id: string;
  backend_kind: string;
  environment_id: string;
  environment_incarnation: string;
  state: ProviderAccountSetupRecord["state"];
  invocation_state: ProviderAccountSetupRecord["invocationState"];
  process: {
    backend_process_id: string;
    process_start_identity: string;
    process_generation: string;
    executable: string;
  } | null;
  attention: {
    attention_id: string;
    kind: "provider_authentication";
    message: string;
  } | null;
  preflight: ProviderAccountAuthenticationInspection | null;
  validation: ProviderAccountAuthenticationInspection | null;
  failure_code: string | null;
  observed_at: string;
  ephemeral_output: SealedProviderAccountSetupOutput | null;
}

interface ActiveProcess {
  process: StreamedProcess;
  output: Promise<void>;
  monitor: Promise<void>;
  interaction: string | null;
  discoveryTimer: ReturnType<typeof setTimeout> | null;
  humanTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Provider-neutral account setup coordinator. Login is reached only through an
 * exactly authorized, freshly re-inspected ProviderAccount environment.
 */
export class ProviderAccountSetupCoordinator {
  private readonly active = new Map<string, ActiveProcess>();
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly desiredAttemptIds = new Set<string>();
  private closed = false;

  constructor(
    private readonly store: ProviderAccountSetupStore,
    private readonly environments: ProviderAccountEnvironmentManager,
    private readonly report: (
      report: ProviderAccountSetupReport,
    ) => Promise<void>,
    private readonly reportInputDelivery: (delivery: {
      setup_attempt_id: string;
      setup_generation: number;
      attention_id: string;
      process_generation: string;
      delivery_attempt_id: string;
      state: "delivery_acknowledged" | "delivery_uncertain";
      observed_at: string;
    }) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
    private readonly options: ProviderAccountSetupCoordinatorOptions = {},
  ) {}

  async prepare(command: ProviderAccountSetupCommand): Promise<void> {
    if (this.closed)
      throw new Error("ProviderAccount setup coordinator is closed.");
    this.desiredAttemptIds.add(command.setup.setup_attempt_id);
    await this.withAccount(command.setup.provider_account_id, async () => {
      let record = this.store.accept(command);
      if (
        command.setup.state === "cancellation_requested" &&
        !isTerminal(record.state) &&
        record.state !== "cancellation_requested"
      )
        record = this.store.transition(
          record.setupAttemptId,
          {
            state: "cancellation_requested",
            cancellationRequestId: command.setup.cancellation_request_id,
            cancellationInvocationState:
              record.cancellationInvocationState === "not_requested"
                ? "intent_recorded"
                : record.cancellationInvocationState,
          },
          "cancellation_reconciled",
        );
      if (record.state === "cancellation_requested") {
        await this.cancelRecord(record);
        return;
      }
      if (isTerminal(record.state)) {
        await this.publish(record);
        return;
      }
      if (record.invocationState !== "not_requested") {
        await this.reconcileRecord(record);
        return;
      }

      record = this.store.transition(
        record.setupAttemptId,
        { state: "preparing" },
        "setup_preparing",
      );
      await this.publish(record);

      let process: StreamedProcess;
      let intentCommitted = false;
      try {
        const beginning = await this.environments.beginSetupProcess(
          runtimeIdentity(record),
          async (inspection, eligible) => {
            const preflight = authenticationPayload(inspection);
            if (eligible) {
              // Exact fresh preflight and durable intent are committed while the
              // account lock is held, immediately before physical spawn.
              record = this.store.transition(
                record.setupAttemptId,
                {
                  state: "invocation_requested",
                  invocationState: "requested",
                  invocationWorkerGeneration:
                    record.command.setup.worker_generation,
                  invocationEnvironmentOperationId:
                    record.command.setup.environment_operation_id,
                  preflight,
                },
                "login_invocation_requested",
              );
              intentCommitted = true;
            } else {
              record = this.store.transition(
                record.setupAttemptId,
                {
                  state: "failed",
                  invocationState: "not_requested",
                  preflight,
                  failureCode: preflightFailureCode(inspection),
                },
                "login_preflight_rejected",
              );
            }
            await this.publish(record);
          },
        );
        if (!beginning.process) return;
        process = beginning.process;
      } catch (error) {
        const ambiguous =
          intentCommitted &&
          error instanceof EnvironmentBackendError &&
          error.sideEffectCertainty === "ambiguous";
        record = this.store.transition(
          record.setupAttemptId,
          {
            state: ambiguous ? "uncertain" : "failed",
            invocationState: ambiguous
              ? "uncertain"
              : intentCommitted
                ? "requested"
                : "not_requested",
            failureCode: ambiguous
              ? "setup_invocation_uncertain"
              : intentCommitted
                ? "setup_spawn_failed"
                : "setup_authentication_preflight_unavailable",
          },
          ambiguous
            ? "login_invocation_uncertain"
            : intentCommitted
              ? "login_invocation_rejected"
              : "login_preflight_unavailable",
        );
        await this.publish(record);
        return;
      }

      record = this.store.transition(
        record.setupAttemptId,
        {
          state: "invocation_acknowledged",
          invocationState: "acknowledged",
          process: process.handle,
        },
        "login_invocation_acknowledged",
      );

      // Register supervision before crossing the fallible control-plane report
      // boundary. A rejected acknowledgement must never orphan the process in
      // this still-running Worker generation.
      const prompt = deferred<string>();
      const output = collectInteraction(
        process.stdout,
        prompt,
        interactionRecognizer(record),
      );
      const diagnostics = discard(process.stderr);
      const active: ActiveProcess = {
        process,
        output: Promise.all([output, diagnostics]).then(() => undefined),
        monitor: Promise.resolve(),
        interaction: null,
        discoveryTimer: null,
        humanTimer: null,
      };
      this.active.set(record.setupAttemptId, active);
      active.monitor = this.monitor(record.setupAttemptId, process).catch(
        () => undefined,
      );
      void prompt.promise.then(
        (interaction) => {
          active.interaction = interaction;
        },
        () => undefined,
      );
      const discoveryDeadline = deferred<void>();
      active.discoveryTimer = this.deadline(
        this.interactionDiscoveryTimeoutMs(),
        () => {
          discoveryDeadline.resolve();
          void this.withAccount(record.command.setup.provider_account_id, () =>
            this.requestSupervisionTermination(
              record.setupAttemptId,
              "setup_interaction_discovery_timed_out",
            ),
          ).catch(() => undefined);
        },
      );

      await this.publish(record);

      let ephemeral: string;
      try {
        ephemeral = await Promise.race([
          prompt.promise,
          process.exit.then(() => {
            throw new ProcessExitedBeforeInteractionError();
          }),
          discoveryDeadline.promise.then(() => {
            throw new InteractionDiscoveryTimeoutError();
          }),
        ]);
      } catch (error) {
        if (error instanceof InteractionDiscoveryTimeoutError)
          await this.requestSupervisionTermination(
            record.setupAttemptId,
            "setup_interaction_discovery_timed_out",
          );
        else if (!(error instanceof ProcessExitedBeforeInteractionError))
          await this.requestSupervisionTermination(
            record.setupAttemptId,
            "setup_interaction_incompatible",
          );
        return;
      }
      this.clearDiscoveryTimer(active);
      const current = this.store.get(record.setupAttemptId);
      if (!current || current.state !== "invocation_acknowledged") return;
      const attentionId = randomUUID();
      const waiting = this.store.transition(
        current.setupAttemptId,
        {
          state: "human_interaction_required",
          attentionId,
        },
        "human_interaction_required",
      );
      this.startHumanCompletionTimer(waiting, active);
      await this.publish(waiting, ephemeral);
    });
  }

  async respond(command: RespondProviderAccountSetupCommand): Promise<void> {
    const existing = this.store.get(command.setup_attempt_id);
    if (!existing)
      throw new Error(
        "ProviderAccount setup response targets an unknown attempt.",
      );
    await this.withAccount(
      existing.command.setup.provider_account_id,
      async () => {
        let record = this.required(command.setup_attempt_id);
        const active = this.active.get(record.setupAttemptId);
        if (
          record.command.connection_generation !==
            command.connection_generation ||
          record.command.setup.setup_generation !== command.setup_generation ||
          record.state !== "human_interaction_required" ||
          record.cancellationInvocationState !== "not_requested" ||
          record.attentionId !== command.attention_id ||
          record.process?.processGeneration !== command.process_generation ||
          !active ||
          active.process.handle.processGeneration !== command.process_generation
        )
          throw new Error("ProviderAccount setup response is stale.");

        validateInteractionResponse(record, command.value);
        record = this.store.requestInputDelivery({
          setupAttemptId: record.setupAttemptId,
          attentionId: command.attention_id,
          requestGeneration: command.request_generation,
          deliveryAttemptId: command.delivery_attempt_id,
        });
        if (record.inputDelivery?.state === "delivery_acknowledged") {
          await this.publishInputDelivery(record);
          return;
        }
        if (record.inputDelivery?.state === "delivery_uncertain") {
          await this.publishInputDelivery(record);
          return;
        }

        try {
          await active.process.write(
            new TextEncoder().encode(`${command.value}\n`),
          );
          record = this.store.settleInputDelivery(
            record.setupAttemptId,
            "delivery_acknowledged",
          );
          await this.publishInputDelivery(record);
        } catch {
          record = this.store.settleInputDelivery(
            record.setupAttemptId,
            "delivery_uncertain",
          );
          await this.publishInputDelivery(record);
          record = this.store.transition(
            record.setupAttemptId,
            {
              failureCode: "input_delivery_uncertain",
              supervisionFailureCode: "input_delivery_uncertain",
              cancellationInvocationState: "intent_recorded",
            },
            "setup_input_uncertain_termination_requested",
          );
          await this.cancelRecord(record);
        }
      },
    );
  }

  async cancel(command: CancelProviderAccountSetupCommand): Promise<void> {
    const existing = this.store.get(command.setup_attempt_id);
    if (!existing)
      throw new Error(
        "ProviderAccount setup cancellation targets an unknown attempt.",
      );
    await this.withAccount(
      existing.command.setup.provider_account_id,
      async () => {
        let record = this.required(command.setup_attempt_id);
        if (
          record.command.connection_generation !==
            command.connection_generation ||
          record.command.setup.setup_generation !== command.setup_generation ||
          (command.process_generation !== null &&
            record.process?.processGeneration !== command.process_generation)
        )
          throw new Error("ProviderAccount setup cancellation is stale.");
        if (record.state === "cancelled") {
          if (record.cancellationRequestId !== command.request_id)
            throw new Error("ProviderAccount setup cancellation conflicts.");
          await this.publish(record);
          return;
        }
        if (record.state === "cancellation_requested") {
          if (record.cancellationRequestId !== command.request_id)
            throw new Error("ProviderAccount setup cancellation conflicts.");
          await this.cancelRecord(record);
          return;
        }
        if (isTerminal(record.state))
          throw new Error("ProviderAccount setup is already terminal.");
        if (
          record.cancellationRequestId &&
          record.cancellationRequestId !== command.request_id
        )
          throw new Error("ProviderAccount setup cancellation conflicts.");
        record = this.store.transition(
          record.setupAttemptId,
          {
            state: "cancellation_requested",
            cancellationRequestId: command.request_id,
            cancellationInvocationState:
              record.cancellationInvocationState === "not_requested"
                ? "intent_recorded"
                : record.cancellationInvocationState,
          },
          "cancellation_requested",
        );
        let reportError: unknown = null;
        try {
          await this.publish(record);
        } catch (error) {
          reportError = error;
        }
        await this.cancelRecord(record);
        if (reportError) throw reportError;
      },
    );
  }

  async reconcile(
    commands: readonly ProviderAccountSetupCommand[],
  ): Promise<void> {
    const desiredIds = new Set(
      commands.map((command) => command.setup.setup_attempt_id),
    );
    this.desiredAttemptIds.clear();
    for (const id of desiredIds) this.desiredAttemptIds.add(id);
    for (const command of commands) await this.prepare(command);
    for (const record of this.store.list()) {
      if (!isTerminal(record.state) && !desiredIds.has(record.setupAttemptId))
        await this.withAccount(record.command.setup.provider_account_id, () =>
          this.requestSupervisionTermination(
            record.setupAttemptId,
            "stale_setup_command",
          ),
        );
    }
  }

  resetConnectionAuthority(): void {
    this.desiredAttemptIds.clear();
  }

  reports(): ProviderAccountSetupReport[] {
    return this.store
      .list()
      .filter((record) => this.desiredAttemptIds.has(record.setupAttemptId))
      .map((record) =>
        this.payload(
          record,
          this.active.get(record.setupAttemptId)?.interaction ?? null,
        ),
      );
  }

  authenticated(
    providerAccountId: string,
    credentialGeneration: number,
    environmentGeneration: number,
  ): boolean {
    const setupInProgress = this.store
      .list()
      .some(
        (record) =>
          this.desiredAttemptIds.has(record.setupAttemptId) &&
          record.command.setup.provider_account_id === providerAccountId &&
          (!isTerminal(record.state) || record.state === "uncertain"),
      );
    if (setupInProgress) return false;
    const generations = this.store
      .list()
      .filter(
        (record) =>
          record.command.setup.provider_account_id === providerAccountId &&
          record.command.setup.environment_generation ===
            environmentGeneration &&
          record.state === "succeeded" &&
          record.validation?.state === "authenticated" &&
          record.validation.method === "provider_account" &&
          record.validation.configuration_identity ===
            record.command.setup.authorized_authentication
              .configuration_identity &&
          record.validation.environment_policy ===
            record.command.setup.authorized_authentication.environment_policy,
      )
      .map((record) => record.command.setup.credential_generation + 1);
    return (
      generations.length > 0 &&
      Math.max(...generations) === credentialGeneration
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.active.keys()]
      .map((id) => this.store.get(id))
      .filter(
        (record): record is ProviderAccountSetupRecord => record !== null,
      );
    for (const record of records)
      await this.withAccount(record.command.setup.provider_account_id, () =>
        this.requestSupervisionTermination(
          record.setupAttemptId,
          "setup_worker_shutdown",
        ),
      ).catch(() => undefined);
    const supervised = [...this.active.values()];
    for (const entry of supervised) this.clearTimers(entry);
    await Promise.all(
      supervised.map((entry) => this.waitForMonitor(entry.monitor)),
    );
    const remaining = [...this.active.values()];
    await Promise.all(
      remaining.map((entry) =>
        entry.process.disconnect().catch(() => undefined),
      ),
    );
    await Promise.all(remaining.map((entry) => entry.monitor));
    this.active.clear();
    this.store.close();
  }

  private async reconcileRecord(
    record: ProviderAccountSetupRecord,
  ): Promise<void> {
    if (record.invocationState !== "not_requested" && !record.process) {
      const acknowledged = ["acknowledged", "settled"].includes(
        record.invocationState,
      );
      const uncertain = this.store.transition(
        record.setupAttemptId,
        {
          state: "uncertain",
          invocationState: "uncertain",
          failureCode: acknowledged
            ? "setup_process_lost"
            : "setup_invocation_uncertain",
        },
        acknowledged
          ? "restart_process_identity_missing"
          : "restart_invocation_uncertain",
      );
      await this.environments.retireSetupProcesses(runtimeIdentity(record));
      await this.publish(uncertain);
      return;
    }
    if (!record.process) {
      await this.publish(record);
      return;
    }
    let inspection: StreamedProcessReconciliation;
    try {
      inspection = await this.environments.reconcileSetupProcess(
        runtimeIdentity(record),
        record.process,
      );
    } catch {
      const uncertain = this.store.transition(
        record.setupAttemptId,
        {
          state: "uncertain",
          invocationState: "uncertain",
          failureCode: "setup_process_lost",
        },
        "restart_process_inspection_failed",
      );
      await this.environments.retireSetupProcesses(runtimeIdentity(record));
      await this.publish(uncertain);
      return;
    }
    if (inspection.process === "running") {
      const active = this.active.get(record.setupAttemptId);
      if (inspection.streamAttachment === "attached" && active) {
        if (
          record.state === "invocation_acknowledged" &&
          active.interaction !== null
        ) {
          this.clearDiscoveryTimer(active);
          record = this.store.transition(
            record.setupAttemptId,
            {
              state: "human_interaction_required",
              attentionId: record.attentionId ?? randomUUID(),
            },
            "human_interaction_reconciled",
          );
          this.startHumanCompletionTimer(record, active);
        }
        await this.publish(record, active.interaction);
        return;
      }
      const terminating = this.store.transition(
        record.setupAttemptId,
        {
          supervisionFailureCode: "setup_process_lost",
          cancellationInvocationState: "intent_recorded",
        },
        "restart_process_unattached_termination_requested",
      );
      await this.cancelRecord(terminating);
      return;
    }
    await this.settleAfterLostProcess(record);
  }

  private async settleAfterLostProcess(
    record: ProviderAccountSetupRecord,
  ): Promise<void> {
    let validation: ProviderAuthenticationInspection;
    try {
      validation = await this.environments.validateSetup(
        runtimeIdentity(record),
      );
    } catch {
      const uncertain = this.store.transition(
        record.setupAttemptId,
        {
          state: "uncertain",
          invocationState: "uncertain",
          failureCode: "setup_process_lost",
        },
        "restart_validation_unavailable",
      );
      await this.publish(uncertain);
      return;
    }
    if (validAuthenticatedInspection(record, validation)) {
      const succeeded = this.store.transition(
        record.setupAttemptId,
        {
          state: "succeeded",
          invocationState: "settled",
          validation: authenticationPayload(validation),
        },
        "restart_validation_succeeded",
      );
      await this.publish(succeeded);
      return;
    }
    const failed = this.store.transition(
      record.setupAttemptId,
      {
        state: "failed",
        invocationState: "settled",
        validation: authenticationPayload(validation),
        failureCode: "setup_process_lost",
      },
      "restart_validation_failed",
    );
    await this.publish(failed);
  }

  private async monitor(id: string, process: StreamedProcess): Promise<void> {
    const exit = await process.exit;
    const active = this.active.get(id);
    await active?.output.catch(() => undefined);
    if (active) this.clearTimers(active);
    this.active.delete(id);
    const existing = this.store.get(id);
    if (!existing || isTerminal(existing.state)) return;
    await this.withAccount(
      existing.command.setup.provider_account_id,
      async () => {
        let record = this.required(id);
        if (isTerminal(record.state)) return;
        if (
          record.state === "cancellation_requested" ||
          record.supervisionFailureCode
        ) {
          if (!physicalExitObserved(exit)) {
            record = this.store.transition(
              id,
              {
                state: "uncertain",
                invocationState: "uncertain",
                cancellationInvocationState: "uncertain",
                cancellationObservation: "unavailable",
                failureCode: "setup_cancellation_uncertain",
              },
              "setup_cancellation_observation_uncertain",
            );
          } else if (record.state === "cancellation_requested") {
            record = this.store.transition(
              id,
              {
                state: "cancelled",
                invocationState: "settled",
                cancellationInvocationState: "settled",
                cancellationObservation: "exited",
              },
              "setup_cancelled",
            );
          } else {
            const semanticallyUncertain =
              record.supervisionFailureCode === "input_delivery_uncertain";
            record = this.store.transition(
              id,
              {
                state: semanticallyUncertain ? "uncertain" : "failed",
                invocationState: semanticallyUncertain
                  ? "uncertain"
                  : "settled",
                cancellationInvocationState: "settled",
                cancellationObservation: "exited",
                failureCode: record.supervisionFailureCode,
              },
              semanticallyUncertain
                ? "setup_supervision_settled_uncertain"
                : "setup_supervision_failed",
            );
          }
          await this.publish(record);
          return;
        }
        if (exit.kind !== "exited" || exit.exitCode !== 0) {
          record = this.store.transition(
            id,
            {
              state: "failed",
              invocationState: "settled",
              failureCode: "setup_process_failed",
            },
            "setup_process_failed",
          );
          await this.publish(record);
          return;
        }
        record = this.store.transition(
          id,
          { state: "validating", invocationState: "settled" },
          "post_login_validation_requested",
        );
        await this.publish(record);
        const validation = await this.environments
          .validateSetup(runtimeIdentity(record))
          .catch(() => null);
        if (validation && validAuthenticatedInspection(record, validation)) {
          record = this.store.transition(
            id,
            {
              state: "succeeded",
              validation: authenticationPayload(validation),
            },
            "post_login_validation_succeeded",
          );
        } else {
          record = this.store.transition(
            id,
            {
              state: "failed",
              validation: validation ? authenticationPayload(validation) : null,
              failureCode: "setup_validation_failed",
            },
            "post_login_validation_failed",
          );
        }
        await this.publish(record);
      },
    );
  }

  private async cancelRecord(
    initial: ProviderAccountSetupRecord,
  ): Promise<void> {
    let record = this.required(initial.setupAttemptId);
    const active = this.active.get(record.setupAttemptId);
    if (active) this.clearTimers(active);

    if (!record.process) {
      if (record.invocationState !== "not_requested") {
        await this.markCancellationUncertain(
          record,
          "cancellation_process_identity_missing",
          "identity_mismatch",
        );
        return;
      }
      await this.settleCancellation(record, "gone");
      return;
    }
    const processHandle = record.process;

    const inspection = await this.environments
      .reconcileSetupProcess(runtimeIdentity(record), processHandle)
      .catch(() => null);
    if (!inspection) {
      await this.markCancellationUncertain(
        record,
        "cancellation_process_inspection_failed",
        "unavailable",
      );
      return;
    }
    if (inspection.process !== "running") {
      if (inspection.process === "exited" || inspection.process === "gone") {
        await this.settleCancellation(record, inspection.process);
      } else {
        await this.markCancellationUncertain(
          record,
          "cancellation_process_identity_unavailable",
          inspection.process === "identity_mismatch"
            ? "identity_mismatch"
            : "unavailable",
        );
      }
      return;
    }

    record = this.store.transition(
      record.setupAttemptId,
      { cancellationObservation: "running" },
      "cancellation_process_revalidated",
    );

    if (
      record.cancellationInvocationState === "requested" ||
      record.cancellationInvocationState === "uncertain"
    ) {
      // The one destructive boundary may already have been crossed. Never
      // replay it; continue only read-only physical observation.
      record = this.store.transition(
        record.setupAttemptId,
        {
          cancellationInvocationState: "uncertain",
          cancellationObservation: "running",
        },
        "cancellation_invocation_reconciliation_uncertain",
      );
      await this.publish(record);
      if (!active) await this.observeDetachedCancellation(record);
      return;
    }
    if (record.cancellationInvocationState === "acknowledged") {
      if (!active) await this.observeDetachedCancellation(record);
      return;
    }
    if (record.cancellationInvocationState === "settled") return;

    const operationId = record.cancellationOperationId ?? randomUUID();
    record = this.store.transition(
      record.setupAttemptId,
      {
        cancellationOperationId: operationId,
        cancellationInvocationState: "requested",
      },
      "cancellation_invocation_requested",
    );
    try {
      if (active) await active.process.cancel(operationId);
      else
        await this.environments.cancelSetupProcess(
          runtimeIdentity(record),
          processHandle,
          operationId,
        );
    } catch {
      const observed = await this.environments
        .reconcileSetupProcess(runtimeIdentity(record), processHandle)
        .catch(() => null);
      if (observed?.process === "gone" || observed?.process === "exited") {
        await this.settleCancellation(record, observed.process);
        return;
      }
      if (observed?.process === "running") {
        record = this.store.transition(
          record.setupAttemptId,
          {
            cancellationInvocationState: "uncertain",
            cancellationObservation: "running",
          },
          "setup_cancellation_uncertain",
        );
        await this.publish(record);
        if (!active) await this.observeDetachedCancellation(record);
        return;
      }
      await this.markCancellationUncertain(
        record,
        "setup_cancellation_uncertain",
        observed?.process === "identity_mismatch"
          ? "identity_mismatch"
          : "unavailable",
      );
      return;
    }

    record = this.store.transition(
      record.setupAttemptId,
      { cancellationInvocationState: "acknowledged" },
      "cancellation_invocation_acknowledged",
    );
    let reportError: unknown = null;
    try {
      await this.publish(record);
    } catch (error) {
      reportError = error;
    }
    if (!active) await this.observeDetachedCancellation(record);
    if (reportError) throw reportError;
  }

  private async observeDetachedCancellation(
    initial: ProviderAccountSetupRecord,
  ): Promise<void> {
    const deadline = Date.now() + this.cancellationSettlementTimeoutMs();
    let record = initial;
    const processHandle = initial.process;
    if (!processHandle) {
      await this.markCancellationUncertain(
        record,
        "cancellation_process_identity_missing",
        "identity_mismatch",
      );
      return;
    }
    for (;;) {
      const inspection = await this.environments
        .reconcileSetupProcess(runtimeIdentity(record), processHandle)
        .catch(() => null);
      if (inspection?.process === "gone" || inspection?.process === "exited") {
        await this.settleCancellation(record, inspection.process);
        return;
      }
      if (!inspection || inspection.process === "unavailable") {
        await this.markCancellationUncertain(
          record,
          "cancellation_settlement_unavailable",
          "unavailable",
        );
        return;
      }
      if (inspection.process === "identity_mismatch") {
        await this.markCancellationUncertain(
          record,
          "cancellation_settlement_identity_mismatch",
          "identity_mismatch",
        );
        return;
      }
      record = this.required(record.setupAttemptId);
      if (Date.now() >= deadline) break;
      await Bun.sleep(25);
    }
    const waiting = this.store.transition(
      record.setupAttemptId,
      { cancellationObservation: "running" },
      "cancellation_settlement_pending",
    );
    await this.publish(waiting);
  }

  private async settleCancellation(
    record: ProviderAccountSetupRecord,
    observation: "exited" | "gone",
  ): Promise<void> {
    const external = record.state === "cancellation_requested";
    const semanticallyUncertain =
      record.supervisionFailureCode === "input_delivery_uncertain";
    const settled = this.store.transition(
      record.setupAttemptId,
      {
        state: external
          ? "cancelled"
          : semanticallyUncertain
            ? "uncertain"
            : "failed",
        invocationState:
          record.invocationState === "not_requested"
            ? "not_requested"
            : semanticallyUncertain
              ? "uncertain"
              : "settled",
        cancellationInvocationState: "settled",
        cancellationObservation: observation,
        failureCode: external
          ? record.failureCode
          : (record.supervisionFailureCode ?? "setup_process_failed"),
      },
      external
        ? "setup_cancelled"
        : semanticallyUncertain
          ? "setup_supervision_settled_uncertain"
          : "setup_supervision_failed",
    );
    await this.publish(settled);
  }

  private async markCancellationUncertain(
    record: ProviderAccountSetupRecord,
    eventType: string,
    observation: ProviderAccountSetupRecord["cancellationObservation"],
  ): Promise<void> {
    const uncertain = this.store.transition(
      record.setupAttemptId,
      {
        state: "uncertain",
        invocationState: "uncertain",
        cancellationInvocationState: "uncertain",
        cancellationObservation: observation,
        failureCode: "setup_cancellation_uncertain",
      },
      eventType,
    );
    await this.publish(uncertain);
  }

  private async requestSupervisionTermination(
    id: string,
    failureCode: string,
  ): Promise<void> {
    const current = this.store.get(id);
    if (
      !current ||
      isTerminal(current.state) ||
      current.cancellationInvocationState !== "not_requested"
    )
      return;
    const record = this.store.transition(
      id,
      {
        supervisionFailureCode: failureCode,
        cancellationInvocationState: "intent_recorded",
      },
      failureCode,
    );
    await this.cancelRecord(record);
  }

  private startHumanCompletionTimer(
    record: ProviderAccountSetupRecord,
    active: ActiveProcess,
  ): void {
    if (active.humanTimer) return;
    active.humanTimer = this.deadline(this.humanCompletionTimeoutMs(), () => {
      void this.withAccount(record.command.setup.provider_account_id, () =>
        this.requestSupervisionTermination(
          record.setupAttemptId,
          "setup_human_completion_timed_out",
        ),
      ).catch(() => undefined);
    });
  }

  private deadline(milliseconds: number, callback: () => void) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  }

  private waitForMonitor(monitor: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.deadline(
        this.cancellationSettlementTimeoutMs(),
        resolve,
      );
      void monitor.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private clearDiscoveryTimer(active: ActiveProcess): void {
    if (active.discoveryTimer) clearTimeout(active.discoveryTimer);
    active.discoveryTimer = null;
  }

  private clearTimers(active: ActiveProcess): void {
    this.clearDiscoveryTimer(active);
    if (active.humanTimer) clearTimeout(active.humanTimer);
    active.humanTimer = null;
  }

  private interactionDiscoveryTimeoutMs(): number {
    return positiveTimeout(
      this.options.interactionDiscoveryTimeoutMs,
      DEFAULT_INTERACTION_DISCOVERY_TIMEOUT_MS,
    );
  }

  private humanCompletionTimeoutMs(): number {
    return positiveTimeout(
      this.options.humanCompletionTimeoutMs,
      DEFAULT_HUMAN_COMPLETION_TIMEOUT_MS,
    );
  }

  private cancellationSettlementTimeoutMs(): number {
    return positiveTimeout(
      this.options.cancellationSettlementTimeoutMs,
      DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
    );
  }

  private required(id: string): ProviderAccountSetupRecord {
    const record = this.store.get(id);
    if (!record) throw new Error(`ProviderAccount setup ${id} is missing.`);
    return record;
  }

  private publish(
    record: ProviderAccountSetupRecord,
    ephemeralOutput: string | null = null,
  ): Promise<void> {
    return this.report(this.payload(record, ephemeralOutput));
  }

  private payload(
    record: ProviderAccountSetupRecord,
    ephemeralOutput: string | null,
  ): ProviderAccountSetupReport {
    const setup = record.command.setup;
    return {
      setup_attempt_id: setup.setup_attempt_id,
      provider_account_id: setup.provider_account_id,
      setup_generation: setup.setup_generation,
      credential_generation: setup.credential_generation,
      environment_generation: setup.environment_generation,
      worker_generation: setup.worker_generation,
      environment_operation_id: setup.environment_operation_id,
      backend_kind: setup.environment.backend_kind,
      environment_id: setup.environment.environment_id,
      environment_incarnation: setup.environment.incarnation,
      state: record.state,
      invocation_state: record.invocationState,
      process: record.process
        ? {
            backend_process_id: record.process.backendProcessId,
            process_start_identity: record.process.processStartIdentity,
            process_generation: record.process.processGeneration,
            executable: record.process.executable,
          }
        : null,
      attention:
        record.state === "human_interaction_required" && record.attentionId
          ? {
              attention_id: record.attentionId,
              kind: "provider_authentication",
              message:
                "Open the provider sign-in link for this setup. If prompted after browser authorization, paste the one-time code. This does not authorize model inference.",
            }
          : null,
      preflight: record.preflight ? { ...record.preflight } : null,
      validation: record.validation ? { ...record.validation } : null,
      failure_code: record.failureCode,
      observed_at: this.clock().toISOString(),
      ephemeral_output:
        ephemeralOutput === null ||
        record.state !== "human_interaction_required"
          ? null
          : sealOutput(ephemeralOutput, setup.interaction_public_key),
    };
  }

  private publishInputDelivery(
    record: ProviderAccountSetupRecord,
  ): Promise<void> {
    const delivery = record.inputDelivery;
    if (!delivery || delivery.state === "delivery_requested")
      throw new Error("ProviderAccount setup input delivery is not settled.");
    const processGeneration = record.process?.processGeneration;
    if (!processGeneration)
      throw new Error("ProviderAccount setup delivery has no process fence.");
    return this.reportInputDelivery({
      setup_attempt_id: record.setupAttemptId,
      setup_generation: record.command.setup.setup_generation,
      attention_id: delivery.attentionId,
      process_generation: processGeneration,
      delivery_attempt_id: delivery.deliveryAttemptId,
      state: delivery.state,
      observed_at: delivery.observedAt ?? this.clock().toISOString(),
    });
  }

  private async withAccount<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.accountTails.get(accountId);
    const result = previous ? previous.then(operation) : operation();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.accountTails.set(accountId, tail);
    try {
      return await result;
    } finally {
      if (this.accountTails.get(accountId) === tail)
        this.accountTails.delete(accountId);
    }
  }
}

function runtimeIdentity(
  record: ProviderAccountSetupRecord,
): ProviderAccountSetupRuntimeIdentity {
  const setup = record.command.setup;
  return {
    setupAttemptId: setup.setup_attempt_id,
    setupGeneration: setup.setup_generation,
    authorizationId: setup.authorization_id,
    providerAccountId: setup.provider_account_id,
    providerKey: setup.provider_key,
    credentialGeneration: setup.credential_generation,
    environmentGeneration: setup.environment_generation,
    environmentOperationId:
      record.invocationEnvironmentOperationId ?? setup.environment_operation_id,
    workerGeneration:
      record.invocationWorkerGeneration ?? setup.worker_generation,
    backendKind: setup.environment.backend_kind,
    environmentId: setup.environment.environment_id,
    environmentIncarnation: setup.environment.incarnation,
    expectedAuthentication: {
      state: setup.authorized_authentication.state,
      method: setup.authorized_authentication.method,
      configurationIdentity:
        setup.authorized_authentication.configuration_identity,
      environmentPolicy: setup.authorized_authentication.environment_policy,
      evidenceIdentity: setup.authorized_authentication.evidence_identity,
    },
  };
}

function authenticationPayload(
  inspection: ProviderAuthenticationInspection,
): ProviderAccountAuthenticationInspection {
  return {
    state: inspection.state,
    method: inspection.method,
    configuration_identity: inspection.configuration.identity,
    environment_policy: inspection.configuration.environmentPolicy,
    evidence_identity: inspection.evidenceIdentity,
    inspected_at: inspection.inspectedAt,
  };
}

function validAuthenticatedInspection(
  record: ProviderAccountSetupRecord,
  inspection: ProviderAuthenticationInspection,
): boolean {
  const authorized = record.command.setup.authorized_authentication;
  return (
    isProviderAuthenticationReady(inspection) &&
    inspection.configuration.identity === authorized.configuration_identity &&
    inspection.configuration.environmentPolicy === authorized.environment_policy
  );
}

function preflightFailureCode(
  inspection: ProviderAuthenticationInspection,
): string {
  switch (inspection.state) {
    case "authenticated":
      return "setup_authentication_already_authenticated";
    case "forbidden_auth_method":
      return "setup_authentication_method_forbidden";
    case "inspection_unavailable":
      return "setup_authentication_preflight_unavailable";
    case "incompatible_status":
      return "setup_authentication_status_incompatible";
    case "authentication_required":
      return "setup_authentication_preflight_mismatch";
  }
}

function isTerminal(state: ProviderAccountSetupRecord["state"]): boolean {
  return [
    "succeeded",
    "failed",
    "uncertain",
    "cancelled",
    "invalidated",
  ].includes(state);
}

type InteractionRecognizer = (value: string) => string | null;

function interactionRecognizer(
  record: ProviderAccountSetupRecord,
): InteractionRecognizer {
  const setup = record.command.setup;
  if (
    setup.provider_key === "anthropic" &&
    setup.authorized_authentication.configuration_identity ===
      CLAUDE_SUBSCRIPTION_CONFIGURATION.identity
  )
    return recognizeClaudeLoginInteraction;
  if (setup.environment.backend_kind === "fake-account")
    return recognizeFakeLoginInteraction;
  throw new Error(
    "ProviderAccount setup has no versioned interaction recognizer.",
  );
}

async function collectInteraction(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
  first: Deferred<string>,
  recognize: InteractionRecognizer,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let bytes = 0;
  let discovered = false;
  try {
    for await (const event of stream) {
      if (event.kind === "transport_error")
        throw new Error("ProviderAccount setup stream is unavailable.");
      if (event.kind !== "data") continue;
      if (!discovered) {
        if (bytes + event.data.byteLength > INTERACTION_LIMIT_BYTES)
          throw new Error(
            "ProviderAccount setup interaction exceeded its bound.",
          );
        bytes += event.data.byteLength;
        buffered += decoder.decode(event.data, { stream: true });
        const interaction = recognize(buffered);
        if (interaction !== null) {
          discovered = true;
          first.resolve(interaction);
          buffered = "";
        }
      }
    }
    if (!discovered) {
      buffered += decoder.decode();
      const interaction = recognize(buffered);
      if (interaction !== null) first.resolve(interaction);
      else
        first.reject(
          new Error(
            "ProviderAccount setup produced no recognized interaction.",
          ),
        );
    }
  } catch (error) {
    first.reject(error);
    throw error;
  }
}

export function recognizeClaudeLoginInteraction(value: string): string | null {
  const prefix =
    "Opening browser to sign in…\nIf the browser didn't open, visit: ";
  const suffix = "\nPaste code here if prompted > ";
  if (value.length <= prefix.length && prefix.startsWith(value)) return null;
  if (!value.startsWith(prefix))
    throw new Error(
      `${CLAUDE_LOGIN_INTERACTION_IDENTITY} output prefix was incompatible.`,
    );
  const end = value.indexOf(suffix, prefix.length);
  if (end === -1) return null;
  const rawUrl = value.slice(prefix.length, end);
  if (!validClaudeManualAuthorizationUrl(rawUrl))
    throw new Error(
      `${CLAUDE_LOGIN_INTERACTION_IDENTITY} authorization URL was incompatible.`,
    );
  return value.slice(0, end + suffix.length);
}

function validClaudeManualAuthorizationUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    const allowed = new Set([
      "code",
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "state",
      "orgUUID",
      "login_hint",
      "login_method",
    ]);
    const singleton = (name: string) =>
      url.searchParams.getAll(name).length === 1;
    const scope = url.searchParams.get("scope")?.split(" ") ?? [];
    return (
      url.origin === "https://claude.com" &&
      url.pathname === "/cai/oauth/authorize" &&
      url.hash === "" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      [...url.searchParams.keys()].every((name) => allowed.has(name)) &&
      [...allowed].every((name) => url.searchParams.getAll(name).length <= 1) &&
      [
        "code",
        "client_id",
        "response_type",
        "redirect_uri",
        "scope",
        "code_challenge",
        "code_challenge_method",
        "state",
      ].every(singleton) &&
      url.searchParams.get("code") === "true" &&
      url.searchParams.get("response_type") === "code" &&
      url.searchParams.get("redirect_uri") ===
        "https://platform.claude.com/oauth/code/callback" &&
      url.searchParams.get("code_challenge_method") === "S256" &&
      Boolean(url.searchParams.get("client_id")) &&
      scope.includes("user:inference") &&
      Boolean(url.searchParams.get("code_challenge")) &&
      Boolean(url.searchParams.get("state"))
    );
  } catch {
    return false;
  }
}

function recognizeFakeLoginInteraction(value: string): string | null {
  const end = value.indexOf("\n");
  if (end === -1) return null;
  const line = value.slice(0, end);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (
    Object.keys(parsed).sort().join(",") !== "code,kind,url" ||
    parsed.kind !== "fake_provider_login" ||
    typeof parsed.code !== "string" ||
    typeof parsed.url !== "string" ||
    !parsed.url.startsWith("https://fake-provider.invalid/")
  )
    throw new Error("Fake ProviderAccount interaction was incompatible.");
  return `${line}\n`;
}

function validateInteractionResponse(
  record: ProviderAccountSetupRecord,
  value: string,
): void {
  if (record.command.setup.provider_key !== "anthropic") return;
  if (!/^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(value))
    throw new Error(
      "ProviderAccount setup response has invalid OAuth code framing.",
    );
}

async function discard(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
): Promise<void> {
  for await (const _event of stream) {
    // Deliberately drain without logging, persisting, or relaying diagnostics.
  }
}

function physicalExitObserved(exit: Awaited<StreamedProcess["exit"]>): boolean {
  return ["exited", "exited_nonzero", "signaled"].includes(exit.kind);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(
      "ProviderAccount setup timeout must be a positive integer.",
    );
  return value;
}

class InteractionDiscoveryTimeoutError extends Error {}
class ProcessExitedBeforeInteractionError extends Error {}

function sealOutput(
  output: string,
  interactionPublicKey: string,
): SealedProviderAccountSetupOutput {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(output, "utf8"),
    cipher.final(),
  ]);

  return {
    version: "rsa-oaep-sha256-aes-256-gcm-v1",
    encrypted_key: publicEncrypt(
      {
        key: interactionPublicKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      key,
    ).toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
