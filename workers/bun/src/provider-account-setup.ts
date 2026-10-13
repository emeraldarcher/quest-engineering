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
  ProviderAccountSetupCommand,
  RespondProviderAccountSetupCommand,
} from "./protocol/types.ts";
import type {
  ProviderAccountSetupRecord,
  ProviderAccountSetupStore,
} from "./provider-account-setup-store.ts";

const INTERACTION_LIMIT_BYTES = 16_384;

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
  validation: { state: string; identity: string | null } | null;
  failure_code: string | null;
  observed_at: string;
  ephemeral_output: SealedProviderAccountSetupOutput | null;
}

interface ActiveProcess {
  process: StreamedProcess;
  output: Promise<void>;
  monitor: Promise<void>;
}

/**
 * Provider-neutral account setup coordinator. The only production login target
 * in Phase B is the deterministic fake process supplied by the account runtime.
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

      // Durable intent is committed before crossing the physical spawn boundary.
      record = this.store.transition(
        record.setupAttemptId,
        { state: "invocation_requested", invocationState: "requested" },
        "login_invocation_requested",
      );
      await this.publish(record);

      let process: StreamedProcess;
      try {
        process = await this.environments.spawnSetupProcess(
          runtimeIdentity(record),
        );
      } catch (error) {
        const ambiguous =
          error instanceof EnvironmentBackendError &&
          error.sideEffectCertainty === "ambiguous";
        record = this.store.transition(
          record.setupAttemptId,
          {
            state: ambiguous ? "uncertain" : "failed",
            invocationState: ambiguous ? "uncertain" : "requested",
            failureCode: ambiguous
              ? "setup_invocation_uncertain"
              : "setup_spawn_failed",
          },
          ambiguous
            ? "login_invocation_uncertain"
            : "login_invocation_rejected",
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
      await this.publish(record);

      const prompt = deferred<string>();
      const output = collectInteraction(process.stdout, prompt);
      const diagnostics = discard(process.stderr);
      const active: ActiveProcess = {
        process,
        output: Promise.all([output, diagnostics]).then(() => undefined),
        monitor: Promise.resolve(),
      };
      this.active.set(record.setupAttemptId, active);
      active.monitor = this.monitor(record.setupAttemptId, process).catch(
        () => undefined,
      );

      let ephemeral: string;
      try {
        ephemeral = await Promise.race([
          prompt.promise,
          process.exit.then(() => {
            throw new Error(
              "Setup process exited before requesting interaction.",
            );
          }),
        ]);
      } catch {
        return;
      }
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
          record.attentionId !== command.attention_id ||
          record.process?.processGeneration !== command.process_generation ||
          !active ||
          active.process.handle.processGeneration !== command.process_generation
        )
          throw new Error("ProviderAccount setup response is stale.");

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
          const uncertain = this.store.transition(
            record.setupAttemptId,
            {
              state: "uncertain",
              invocationState: "uncertain",
              failureCode: "input_delivery_uncertain",
            },
            "setup_input_uncertain",
          );
          await this.publish(uncertain);
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
          },
          "cancellation_requested",
        );
        await this.publish(record);
        await this.cancelRecord(record);
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
      if (!isTerminal(record.state) && !desiredIds.has(record.setupAttemptId)) {
        const active = this.active.get(record.setupAttemptId);
        if (active) await active.process.cancel().catch(() => undefined);
        this.store.transition(
          record.setupAttemptId,
          {
            state: "invalidated",
            failureCode: "stale_setup_command",
          },
          "setup_invalidated",
        );
      }
    }
  }

  resetConnectionAuthority(): void {
    this.desiredAttemptIds.clear();
  }

  reports(): ProviderAccountSetupReport[] {
    return this.store
      .list()
      .filter((record) => this.desiredAttemptIds.has(record.setupAttemptId))
      .map((record) => this.payload(record, null));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.active.values()];
    await Promise.all(
      active.map((entry) => entry.process.disconnect().catch(() => undefined)),
    );
    await Promise.all(active.map((entry) => entry.monitor));
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
      await this.publish(uncertain);
      return;
    }
    if (inspection.process === "running") {
      if (
        inspection.streamAttachment === "attached" &&
        this.active.has(record.setupAttemptId)
      ) {
        await this.publish(record);
        return;
      }
      const uncertain = this.store.transition(
        record.setupAttemptId,
        {
          state: "uncertain",
          invocationState: "uncertain",
          failureCode: "setup_process_lost",
        },
        "restart_process_unattached",
      );
      await this.publish(uncertain);
      return;
    }
    await this.settleAfterLostProcess(record);
  }

  private async settleAfterLostProcess(
    record: ProviderAccountSetupRecord,
  ): Promise<void> {
    let validation: { authenticated: boolean; identity: string | null };
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
    if (validation.authenticated && validation.identity) {
      const succeeded = this.store.transition(
        record.setupAttemptId,
        {
          state: "succeeded",
          invocationState: "settled",
          validation: { state: "authenticated", identity: validation.identity },
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
        validation: { state: "authentication_required", identity: null },
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
    this.active.delete(id);
    const existing = this.store.get(id);
    if (!existing || isTerminal(existing.state)) return;
    await this.withAccount(
      existing.command.setup.provider_account_id,
      async () => {
        let record = this.required(id);
        if (record.state === "cancellation_requested") {
          record = this.store.transition(
            id,
            { state: "cancelled", invocationState: "settled" },
            "setup_cancelled",
          );
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
        if (validation?.authenticated && validation.identity) {
          record = this.store.transition(
            id,
            {
              state: "succeeded",
              validation: {
                state: "authenticated",
                identity: validation.identity,
              },
            },
            "post_login_validation_succeeded",
          );
        } else {
          record = this.store.transition(
            id,
            {
              state: "failed",
              validation: {
                state: validation
                  ? "authentication_required"
                  : "inspection_unavailable",
                identity: null,
              },
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
    record: ProviderAccountSetupRecord,
  ): Promise<void> {
    const active = this.active.get(record.setupAttemptId);
    if (!active) {
      if (!record.process && record.invocationState !== "not_requested") {
        const uncertain = this.store.transition(
          record.setupAttemptId,
          {
            state: "uncertain",
            invocationState: "uncertain",
            failureCode: "setup_process_lost",
          },
          "cancellation_process_identity_missing",
        );
        await this.publish(uncertain);
        return;
      }
      if (record.process) {
        const inspection = await this.environments
          .reconcileSetupProcess(runtimeIdentity(record), record.process)
          .catch(() => null);
        if (inspection?.process === "running") {
          const uncertain = this.store.transition(
            record.setupAttemptId,
            {
              state: "uncertain",
              invocationState: "uncertain",
              failureCode: "setup_process_lost",
            },
            "cancellation_process_unattached",
          );
          await this.publish(uncertain);
          return;
        }
      }
      const cancelled = this.store.transition(
        record.setupAttemptId,
        {
          state: "cancelled",
          invocationState:
            record.invocationState === "not_requested"
              ? "not_requested"
              : "settled",
        },
        "setup_cancelled",
      );
      await this.publish(cancelled);
      return;
    }
    try {
      await active.process.cancel();
    } catch {
      const uncertain = this.store.transition(
        record.setupAttemptId,
        {
          state: "uncertain",
          invocationState: "uncertain",
          failureCode: "setup_invocation_uncertain",
        },
        "setup_cancellation_uncertain",
      );
      await this.publish(uncertain);
    }
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
                "Complete the deterministic provider sign-in flow. This does not authorize model inference.",
            }
          : null,
      validation: record.validation
        ? {
            state: record.validation.state,
            identity: record.validation.identity,
          }
        : null,
      failure_code: record.failureCode,
      observed_at: this.clock().toISOString(),
      ephemeral_output:
        ephemeralOutput === null
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
    providerAccountId: setup.provider_account_id,
    environmentGeneration: setup.environment_generation,
    backendKind: setup.environment.backend_kind,
    environmentId: setup.environment.environment_id,
    environmentIncarnation: setup.environment.incarnation,
  };
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

async function collectInteraction(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
  first: Deferred<string>,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const event of stream) {
      if (event.kind === "transport_error")
        throw new Error("ProviderAccount setup stream is unavailable.");
      if (event.kind !== "data") continue;
      if (bytes + event.data.byteLength > INTERACTION_LIMIT_BYTES)
        throw new Error(
          "ProviderAccount setup interaction exceeded its bound.",
        );
      chunks.push(new Uint8Array(event.data));
      bytes += event.data.byteLength;
      first.resolve(decodeChunks(chunks, bytes));
    }
  } catch (error) {
    first.reject(error);
    throw error;
  }
  first.reject(new Error("ProviderAccount setup produced no interaction."));
}

async function discard(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
): Promise<void> {
  for await (const _event of stream) {
    // Deliberately drain without logging, persisting, or relaying diagnostics.
  }
}

function decodeChunks(chunks: Uint8Array[], length: number): string {
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(value);
}

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
