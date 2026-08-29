import { arch, platform } from "node:os";
import { join } from "node:path";
import {
  assertExecutionSupported,
  workerCapabilities,
} from "./capabilities.ts";
import type { WorkerConfig } from "./config.ts";
import { DispatchExecutor } from "./dispatch/executor.ts";
import { type DispatchRecord, DispatchRegistry } from "./dispatch/registry.ts";
import { decodeExecuteAction } from "./protocol/codec.ts";
import { PhoenixWorkerChannel } from "./protocol/phoenix-channel.ts";
import type {
  ReconcileDispatch,
  WorkerCapabilities,
} from "./protocol/types.ts";
import { WORKER_PROTOCOL_VERSION } from "./protocol/types.ts";
import { FakeAgentProvider } from "./providers/fake/provider.ts";
import { PiProvider } from "./providers/pi/provider.ts";
import type { AgentProvider } from "./providers/types.ts";
import { LocalHerdrConnectionProvider } from "./session-host/herdr/connection.ts";
import { HerdrSessionHost } from "./session-host/herdr/session-host.ts";

export class QuestEngineeringWorker {
  readonly registry: DispatchRegistry;
  readonly executor: DispatchExecutor;
  private readonly channel: PhoenixWorkerChannel;
  private readonly capabilities: WorkerCapabilities;
  private stopping = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: WorkerConfig) {
    this.registry = new DispatchRegistry(
      join(config.dataRoot, "dispatches.sqlite"),
      config.dataRoot,
    );
    const provider: AgentProvider =
      config.provider === "fake"
        ? new FakeAgentProvider(config.fakeOutputs, config.fakeDelayMs)
        : new PiProvider(
            new HerdrSessionHost(
              new LocalHerdrConnectionProvider(config.herdrSession),
            ),
            config,
          );
    const capabilities = workerCapabilities(config, platform(), arch());
    this.capabilities = capabilities;
    this.channel = new PhoenixWorkerChannel(
      config.controlPlaneUrl,
      config.workerId,
      config.workerToken,
      capabilities,
      {
        onProtocol: (message) => this.handleProtocol(message),
        onRegistered: () => this.onRegistered(),
        onSuperseded: () => {
          console.warn(
            "Worker connection was superseded by a newer generation; stopping this controller.",
          );
          this.stopping = true;
        },
      },
    );
    this.executor = new DispatchExecutor(
      this.registry,
      provider,
      (dispatch, type) => this.report(dispatch, type),
    );
  }

  async run(): Promise<void> {
    await this.executor.recoverAll();
    while (!this.stopping) {
      try {
        await this.channel.connect();
        while (!this.stopping && this.channel.isRegistered())
          await Bun.sleep(250);
      } catch (error) {
        if (!this.stopping)
          console.error(
            "Worker connection error",
            error instanceof Error ? error.message : String(error),
          );
      }
      if (!this.stopping) await Bun.sleep(this.config.reconnectMs);
    }
  }

  attachInfo(actionId: string) {
    return this.executor.attachInfo(actionId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel.close();
    this.executor.disconnect();
    this.registry.close();
  }

  private async handleProtocol(
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message.type === "execute_action") {
      const action = decodeExecuteAction(message, this.config.workerId);
      assertExecutionSupported(action, this.capabilities);
      const acceptance = this.executor.accept(action);
      try {
        await this.sendAcceptedOrState(acceptance.dispatch);
      } finally {
        // Durable acceptance is sufficient to begin; a lost ACK reply must not
        // strand accepted work in this still-running Worker process.
        if (acceptance.dispatch.state === "accepted")
          void this.executor.start(action.action_id);
      }
      return;
    }
    if (message.type === "reconcile_request") {
      const dispatches = this.registry.reconcilePayloads();
      const response = await this.channel.sendProtocol({
        type: "reconcile_state",
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        dispatches,
      });
      if (response.result === "reconciled") {
        for (const dispatch of this.registry.list()) {
          if (dispatch.state === "completed")
            this.registry.acknowledgeServerCompletion(
              dispatch.action.action_id,
            );
        }
      }
    }
  }

  private async onRegistered(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      void this.channel
        .sendProtocol({
          type: "worker_heartbeat",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
        })
        .catch(() => undefined);
    }, this.config.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private async sendAcceptedOrState(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.state === "accepted") {
      await this.channel.sendProtocol(
        identityMessage(this.config.workerId, dispatch, "dispatch_accepted"),
      );
      return;
    }
    if (dispatch.state === "completed") {
      await this.report(
        dispatchPayload(dispatch, "completed"),
        "step_completed",
      );
      return;
    }
    if (dispatch.state === "failed") {
      await this.report(dispatchPayload(dispatch, "failed"), "step_failed");
      return;
    }
    if (dispatch.state === "uncertain") {
      await this.report(
        dispatchPayload(dispatch, "uncertain"),
        "dispatch_state",
      );
      return;
    }
    await this.report(dispatchPayload(dispatch, "running"), "dispatch_state");
  }

  private async report(
    dispatch: ReconcileDispatch,
    type: "step_completed" | "step_failed" | "dispatch_state",
  ): Promise<boolean> {
    if (!this.channel.isRegistered()) return false;
    try {
      const message: Record<string, unknown> = {
        type,
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        action_id: dispatch.action_id,
        occurrence_id: dispatch.occurrence_id,
        attempt_id: dispatch.attempt_id,
        ...(type === "dispatch_state" ? { state: dispatch.state } : {}),
        ...(type === "step_completed"
          ? { outputs: dispatch.outputs ?? {} }
          : {}),
        ...(type === "step_failed"
          ? { failure: dispatch.failure ?? { reason: "execution_failed" } }
          : {}),
      };
      const response = await this.channel.sendProtocol(message);
      return (
        type !== "step_completed" || response.result === "completion_applied"
      );
    } catch (error) {
      console.warn(
        `Could not report ${type} for ${dispatch.action_id}`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}

function identityMessage(
  workerId: string,
  dispatch: DispatchRecord,
  type: string,
): Record<string, unknown> {
  return {
    type,
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: workerId,
    action_id: dispatch.action.action_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
  };
}
function dispatchPayload(
  dispatch: DispatchRecord,
  state: "running" | "completed" | "failed" | "uncertain",
): ReconcileDispatch {
  return {
    action_id: dispatch.action.action_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
    state,
    ...(state === "completed" && dispatch.outputs
      ? { outputs: dispatch.outputs }
      : {}),
    ...(state === "failed" || state === "uncertain"
      ? { failure: dispatch.failure ?? { reason: "execution_uncertain" } }
      : {}),
  };
}
