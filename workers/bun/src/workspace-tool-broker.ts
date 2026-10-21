import { createHash, randomUUID } from "node:crypto";
import type { ProviderAccountRuntimeAuthority } from "./execution-environment/provider-account.ts";
import type {
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessHandle,
  StreamedProcessStreamEvent,
} from "./execution-environment/types.ts";
import { EnvironmentBackendError } from "./execution-environment/types.ts";
import {
  decodeWorkspaceToolRequest,
  isMutatingWorkspaceTool,
  MAX_BROKER_FRAME_BYTES,
  MAX_BROKER_METADATA_BYTES,
  MAX_BROKER_STDIO_BYTES,
  requiredSemanticTool,
  WORKSPACE_TOOL_BROKER_PROTOCOL,
  type WorkspaceToolRequest,
  type WorkspaceToolResponse,
} from "./workspace-tool-broker-protocol.ts";
import type {
  WorkspaceToolBrokerBinding,
  WorkspaceToolBrokerSessionRecord,
  WorkspaceToolBrokerStore,
} from "./workspace-tool-broker-store.ts";

export const MAX_ACTIVE_BROKER_REQUESTS = 8;

export interface WorkspaceToolBrokerPreparation {
  authorizationId: string;
  providerAccountId: string;
  /** Current semantic authentication epoch admitted by Product. */
  credentialGeneration: number;
  /** Immutable physical owner/provisioning epoch, not credential freshness. */
  accountEnvironmentGeneration: number;
  accountEnvironment: {
    backendKind: string;
    environmentId: string;
    incarnation: string;
  };
  runId: string;
  actionId: string;
  occurrenceId: string;
  attemptId: string;
  operationalEpoch: number;
  operationalAttempt: number;
  workspaceId: string;
  worktreeId: string;
  workspaceBindingId: string;
  workspaceAccess: "none" | "read_only" | "read_write";
  resolvedToolProfile: { tools: string[] };
  workerId: string;
  workerGeneration: number;
}

export interface WorkspaceToolAccountAuthority {
  ref: EnvironmentRef;
  spawnClient(
    sessionId: string,
    brokerGeneration: number,
  ): Promise<StreamedProcess>;
  assertCurrent(): void;
}

export interface WorkspaceToolRunAuthority {
  ref: EnvironmentRef;
  physicalLineageId: string;
  workspaceId: string;
  worktreeId: string;
  workspaceBindingId: string;
  workspaceAccess: "none" | "read_only" | "read_write";
  resolvedToolProfile: { tools: string[] };
  spawn(request: WorkspaceToolRequest): Promise<{
    process: StreamedProcess;
    input: Uint8Array;
  }>;
  assertCurrent(): void;
}

export interface WorkspaceToolBrokerAuthorityResolver {
  account(
    input: WorkspaceToolBrokerPreparation,
  ): Promise<WorkspaceToolAccountAuthority>;
  run(
    input: WorkspaceToolBrokerPreparation,
  ): Promise<WorkspaceToolRunAuthority>;
}

export interface WorkspaceToolBrokerActivity {
  session_id: string;
  broker_generation: number;
  authorization_id: string;
  action_id: string;
  attempt_id: string;
  operation: string | null;
  request_id: string | null;
  state: string;
  certainty: string | null;
  request_bytes: number | null;
  result_bytes: number | null;
  duration_ms: number | null;
  error_code: string | null;
  observed_at: string;
}

export interface BoundWorkspaceToolClient {
  readonly sessionId: string;
  readonly brokerGeneration: number;
  request(value: unknown): Promise<WorkspaceToolResponse>;
  close(): Promise<void>;
}

interface LiveSession {
  record: WorkspaceToolBrokerSessionRecord;
  account: WorkspaceToolAccountAuthority;
  run: WorkspaceToolRunAuthority;
  client: StreamedProcess | null;
  transport: "streamed_account_client" | "worker_account_relay";
  output: Promise<void>;
  monitor: Promise<void>;
  pending: Map<
    string,
    {
      resolve: (response: WorkspaceToolResponse) => void;
      reject: (error: Error) => void;
      response: WorkspaceToolResponse | null;
    }
  >;
  active: Map<string, StreamedProcess>;
  completed: Map<string, WorkspaceToolResponse>;
  activeCount: number;
  mutationTail: Promise<void>;
  closing: boolean;
  capability: object;
}

/**
 * Worker-owned account→Run broker. Product authorizes semantic execution;
 * physical account/client and Run/lineage authority are resolved locally.
 */
export class WorkspaceToolBroker {
  private readonly live = new Map<string, LiveSession>();
  private readonly maxActiveRequests: number;

  constructor(
    private readonly store: WorkspaceToolBrokerStore,
    private readonly authority: WorkspaceToolBrokerAuthorityResolver,
    private readonly report: (
      activity: WorkspaceToolBrokerActivity,
    ) => Promise<void>,
    options: { maxActiveRequests?: number; clock?: () => Date } = {},
  ) {
    this.maxActiveRequests = Math.max(
      1,
      Math.min(
        options.maxActiveRequests ?? MAX_ACTIVE_BROKER_REQUESTS,
        MAX_ACTIVE_BROKER_REQUESTS,
      ),
    );
    this.clock = options.clock ?? (() => new Date());
  }

  private readonly clock: () => Date;

  async prepare(
    input: WorkspaceToolBrokerPreparation,
  ): Promise<WorkspaceToolBrokerSessionRecord> {
    validatePreparation(input);
    const account = await this.authority.account(input);
    const run = await this.authority.run(input);
    assertAccountRef(input, account.ref);
    assertRunAuthority(input, run);
    account.assertCurrent();
    run.assertCurrent();
    const binding: WorkspaceToolBrokerBinding = {
      authorizationId: input.authorizationId,
      providerAccountId: input.providerAccountId,
      credentialGeneration: input.credentialGeneration,
      accountEnvironmentGeneration: input.accountEnvironmentGeneration,
      accountEnvironment: {
        backendKind: account.ref.backendKind,
        environmentId: account.ref.environmentId,
        incarnation: account.ref.incarnation,
      },
      runId: input.runId,
      actionId: input.actionId,
      occurrenceId: input.occurrenceId,
      attemptId: input.attemptId,
      operationalEpoch: input.operationalEpoch,
      operationalAttempt: input.operationalAttempt,
      physicalLineageId: run.physicalLineageId,
      runEnvironment: {
        backendKind: run.ref.backendKind,
        environmentId: run.ref.environmentId,
        incarnation: run.ref.incarnation,
      },
      workspaceId: run.workspaceId,
      worktreeId: run.worktreeId,
      workspaceBindingId: run.workspaceBindingId,
      workspaceAccess: run.workspaceAccess,
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      resolvedToolProfile: structuredClone(run.resolvedToolProfile),
      resolvedToolProfileId: toolProfileIdentity(
        run.resolvedToolProfile,
        run.workspaceAccess,
      ),
    };
    const existing = this.store
      .sessions()
      .find(
        (session) =>
          session.state !== "closed" &&
          session.binding.providerAccountId === input.providerAccountId &&
          session.binding.actionId === input.actionId,
      );
    if (existing) {
      if (JSON.stringify(existing.binding) === JSON.stringify(binding))
        return existing;
      await this.closeSession(existing.sessionId, "broker_authority_replaced");
    }
    const record = this.store.createSession({
      sessionId: randomUUID(),
      brokerGeneration: this.store.generation(
        input.providerAccountId,
        input.actionId,
      ),
      binding,
    });
    await this.safeReport(
      record,
      null,
      null,
      "prepared",
      null,
      null,
      null,
      null,
    );
    return record;
  }

  async admitAuthorization(
    authorizationId: string,
  ): Promise<BoundWorkspaceToolClient> {
    const session = this.preparedAuthorization(authorizationId);
    if (session.state === "admitted") {
      const live = this.requiredLive(session.sessionId);
      return this.boundClient(live, live.capability);
    }
    return this.admit(session.sessionId);
  }

  async admitLocalAuthorization(
    authorizationId: string,
  ): Promise<BoundWorkspaceToolClient> {
    const session = this.preparedAuthorization(authorizationId);
    if (session.state === "admitted") {
      const live = this.requiredLive(session.sessionId);
      if (live.transport !== "worker_account_relay")
        throw new Error("Workspace tool broker transport mode conflicts.");
      return this.boundClient(live, live.capability);
    }
    return this.admitLocal(session.sessionId);
  }

  private preparedAuthorization(
    authorizationId: string,
  ): WorkspaceToolBrokerSessionRecord {
    const session = this.store
      .sessions()
      .find(
        (candidate) =>
          ["prepared", "admitted"].includes(candidate.state) &&
          candidate.binding.authorizationId === authorizationId,
      );
    if (!session)
      throw new Error("Workspace tool broker authorization is not prepared.");
    return session;
  }

  async admit(sessionId: string): Promise<BoundWorkspaceToolClient> {
    const prepared = this.store.session(sessionId);
    if (!prepared || prepared.state !== "prepared")
      throw new Error("Workspace tool broker session is not prepared.");
    const input = preparationFromBinding(prepared.binding);
    const account = await this.authority.account(input);
    const run = await this.authority.run(input);
    assertAccountRef(input, account.ref);
    assertRunAuthority(input, run);
    account.assertCurrent();
    run.assertCurrent();
    const client = await account.spawnClient(
      sessionId,
      prepared.brokerGeneration,
    );
    const record = this.store.admit(sessionId, client.handle);
    const capability = {};
    const live = {} as LiveSession;
    Object.assign(live, {
      record,
      account,
      run,
      client,
      transport: "streamed_account_client",
      output: Promise.resolve(),
      monitor: Promise.resolve(),
      pending: new Map(),
      active: new Map(),
      completed: new Map(),
      activeCount: 0,
      mutationTail: Promise.resolve(),
      closing: false,
      capability,
    } satisfies LiveSession);
    this.live.set(sessionId, live);
    live.output = this.consumeClient(live);
    live.monitor = this.monitorClient(live);
    await this.safeReport(
      record,
      null,
      null,
      "admitted",
      null,
      null,
      null,
      null,
    );
    return this.boundClient(live, capability);
  }

  async admitLocal(sessionId: string): Promise<BoundWorkspaceToolClient> {
    const prepared = this.store.session(sessionId);
    if (!prepared || prepared.state !== "prepared")
      throw new Error("Workspace tool broker session is not prepared.");
    const input = preparationFromBinding(prepared.binding);
    const account = await this.authority.account(input);
    const run = await this.authority.run(input);
    assertAccountRef(input, account.ref);
    assertRunAuthority(input, run);
    account.assertCurrent();
    run.assertCurrent();
    const record = this.store.admit(sessionId, null);
    const capability = {};
    const live: LiveSession = {
      record,
      account,
      run,
      client: null,
      transport: "worker_account_relay",
      output: Promise.resolve(),
      monitor: Promise.resolve(),
      pending: new Map(),
      active: new Map(),
      completed: new Map(),
      activeCount: 0,
      mutationTail: Promise.resolve(),
      closing: false,
      capability,
    };
    this.live.set(sessionId, live);
    await this.safeReport(
      record,
      null,
      null,
      "admitted",
      null,
      null,
      null,
      null,
    );
    return this.boundClient(live, capability);
  }

  boundClientForAction(actionId: string): {
    binding: WorkspaceToolBrokerBinding;
    client: BoundWorkspaceToolClient;
    accountAuthority: ProviderAccountRuntimeAuthority;
  } {
    const live = [...this.live.values()].find(
      (candidate) =>
        !candidate.closing &&
        candidate.transport === "worker_account_relay" &&
        candidate.record.binding.actionId === actionId,
    );
    if (!live)
      throw new Error(
        "No admitted local WorkspaceToolBroker authority exists for the Action.",
      );
    const assertCurrent = () => {
      const current = this.store.session(live.record.sessionId);
      if (
        this.live.get(live.record.sessionId) !== live ||
        live.closing ||
        current?.state !== "admitted" ||
        current.brokerGeneration !== live.record.brokerGeneration
      )
        throw brokerFailure(
          "broker_session_not_admitted",
          "ProviderAccount runtime admission is stale.",
        );
      live.account.assertCurrent();
      live.run.assertCurrent();
    };
    assertCurrent();
    return {
      binding: structuredClone(live.record.binding),
      client: this.boundClient(live, live.capability),
      accountAuthority: {
        providerAccountId: live.record.binding.providerAccountId,
        credentialGeneration: live.record.binding.credentialGeneration,
        ref: structuredClone(live.account.ref),
        assertCurrent,
      },
    };
  }

  async cancel(
    sessionId: string,
    requestId: string,
  ): Promise<WorkspaceToolResponse> {
    const live = this.requiredLive(sessionId);
    const record = this.store.request(sessionId, requestId);
    if (!record)
      return rejected(
        requestId,
        "broker_request_not_found",
        "Broker request does not exist.",
      );
    if (
      ["completed", "rejected", "uncertain", "cancelled"].includes(record.state)
    )
      return this.responseForSettled(
        live,
        record.requestId,
        record.state,
        record.errorCode,
      );
    const process = live.active.get(requestId);
    if (!process) {
      this.store.cancelled(sessionId, requestId);
      return cancelled(requestId);
    }
    try {
      await process.cancel();
      this.store.cancelled(sessionId, requestId);
      return cancelled(requestId);
    } catch (_error) {
      this.store.uncertain(
        sessionId,
        requestId,
        "broker_cancellation_uncertain",
      );
      return uncertain(
        requestId,
        "broker_cancellation_uncertain",
        "Broker request cancellation outcome is uncertain.",
      );
    }
  }

  async retireAuthorization(
    authorizationId: string,
    reason: string,
  ): Promise<void> {
    const sessions = this.store
      .sessions()
      .filter(
        (candidate) =>
          candidate.state !== "closed" &&
          candidate.binding.authorizationId === authorizationId,
      );
    await Promise.all(
      sessions.map((session) => this.closeSession(session.sessionId, reason)),
    );
  }

  async closeSession(
    sessionId: string,
    reason = "broker_session_closed",
  ): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) {
      const record = this.store.session(sessionId);
      if (record && record.state !== "closed")
        this.store.closeSession(sessionId, reason);
      return;
    }
    if (live.closing) return;
    live.closing = true;
    const cancellations = [...live.active.entries()].map(
      async ([requestId, process]) => {
        try {
          await process.cancel();
          const request = this.store.request(sessionId, requestId);
          if (request && ["not_submitted", "submitted"].includes(request.state))
            this.store.cancelled(sessionId, requestId, reason);
        } catch {
          const request = this.store.request(sessionId, requestId);
          if (request?.state === "submitted" && request.mutating)
            this.store.uncertain(
              sessionId,
              requestId,
              "broker_cancellation_uncertain",
            );
        }
      },
    );
    await Promise.allSettled(cancellations);
    await live.client?.cancel().catch(() => undefined);
    await live.client?.disconnect().catch(() => undefined);
    this.store.closeSession(sessionId, reason);
    for (const waiter of live.pending.values())
      waiter.reject(new Error("Workspace tool broker session closed."));
    live.pending.clear();
    this.live.delete(sessionId);
    await this.safeReport(
      live.record,
      null,
      null,
      "closed",
      null,
      null,
      null,
      reason,
    );
  }

  async closeByExecution(actionId: string, reason: string): Promise<void> {
    await this.closeMatching(
      (session) => session.binding.actionId === actionId,
      reason,
    );
  }

  async closeByRun(runId: string, reason: string): Promise<void> {
    await this.closeMatching(
      (session) => session.binding.runId === runId,
      reason,
    );
  }

  async closeByProviderAccount(
    providerAccountId: string,
    reason: string,
  ): Promise<void> {
    await this.closeMatching(
      (session) => session.binding.providerAccountId === providerAccountId,
      reason,
    );
  }

  async retireAll(reason: string): Promise<void> {
    await this.closeMatching(() => true, reason);
  }

  async close(): Promise<void> {
    await this.retireAll("worker_shutdown");
    this.store.close();
  }

  sessions(): WorkspaceToolBrokerSessionRecord[] {
    return this.store.sessions();
  }

  private boundClient(
    live: LiveSession,
    capability: object,
  ): BoundWorkspaceToolClient {
    return Object.freeze({
      sessionId: live.record.sessionId,
      brokerGeneration: live.record.brokerGeneration,
      request: (value: unknown) => {
        if (live.capability !== capability || live.closing)
          return Promise.reject(
            new Error("Workspace tool client capability is stale."),
          );
        const request = decodeWorkspaceToolRequest(value);
        if (live.transport === "worker_account_relay")
          return this.execute(live, request);
        if (live.pending.has(request.request_id))
          return Promise.reject(
            new Error("Workspace tool request is already pending."),
          );
        if (live.pending.size >= this.maxActiveRequests)
          return Promise.resolve(
            rejected(
              request.request_id,
              "broker_active_request_limit",
              "Broker active request limit is exhausted.",
            ),
          );
        const response = new Promise<WorkspaceToolResponse>(
          (resolve, reject) => {
            live.pending.set(request.request_id, {
              resolve,
              reject,
              response: null,
            });
          },
        );
        return (live.client as StreamedProcess)
          .write(
            new TextEncoder().encode(
              `${JSON.stringify({ type: "drive", request })}\n`,
            ),
          )
          .then(() => response)
          .catch((error) => {
            live.pending.delete(request.request_id);
            throw error;
          });
      },
      close: () =>
        this.closeSession(live.record.sessionId, "account_client_closed"),
    });
  }

  private async consumeClient(live: LiveSession): Promise<void> {
    let buffered = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      if (!live.client)
        throw new Error("Account-cell streamed broker client is missing.");
      for await (const event of live.client.stdout) {
        if (event.kind === "transport_error")
          throw new Error("Account-cell broker transport is unavailable.");
        if (event.kind !== "data") continue;
        buffered += decoder.decode(event.data, { stream: true });
        if (Buffer.byteLength(buffered, "utf8") > MAX_BROKER_FRAME_BYTES * 2)
          throw new Error("Account-cell broker transport exceeded its bound.");
        while (buffered.includes("\n")) {
          const index = buffered.indexOf("\n");
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          if (line.length === 0) continue;
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "request") {
            const request = decodeWorkspaceToolRequest(frame);
            void this.dispatchClientRequest(live, request);
          } else if (frame.type === "client_received") {
            if (
              Object.keys(frame).sort().join(",") !==
                ["request_id", "type"].sort().join(",") ||
              typeof frame.request_id !== "string"
            )
              throw new Error(
                "Account-cell client acknowledgement is invalid.",
              );
            const pending = live.pending.get(frame.request_id);
            if (pending?.response) {
              live.pending.delete(frame.request_id);
              pending.resolve(structuredClone(pending.response));
            }
          } else {
            throw new Error("Account-cell client emitted an unknown frame.");
          }
        }
      }
      buffered += decoder.decode();
      if (buffered.length > 0)
        throw new Error("Account-cell broker transport ended mid-frame.");
    } catch (_error) {
      if (!live.closing)
        await this.closeSession(
          live.record.sessionId,
          "account_client_transport_lost",
        );
    }
  }

  private async dispatchClientRequest(
    live: LiveSession,
    request: WorkspaceToolRequest,
  ): Promise<void> {
    let response: WorkspaceToolResponse;
    try {
      response = await this.execute(live, request);
    } catch (error) {
      response = rejected(
        request.request_id,
        "broker_internal_error",
        error instanceof Error ? error.message : "Broker request failed.",
      );
    }
    const pending = live.pending.get(request.request_id);
    if (pending) pending.response = structuredClone(response);
    if (!live.client)
      throw new Error("Account-cell streamed broker client is missing.");
    await live.client
      .write(
        new TextEncoder().encode(
          `${JSON.stringify({ type: "result", response })}\n`,
        ),
      )
      .catch(async () => {
        const record = this.store.request(
          live.record.sessionId,
          request.request_id,
        );
        if (record?.mutating && record.state === "completed") {
          // The operation completed, but delivery to the exact account process
          // was lost. Never replay it; retain completion and close transport.
          await this.closeSession(
            live.record.sessionId,
            "account_client_result_delivery_lost",
          );
        }
      });
  }

  private execute(
    live: LiveSession,
    request: WorkspaceToolRequest,
  ): Promise<WorkspaceToolResponse> {
    const sessionId = live.record.sessionId;
    const encoded = JSON.stringify(request);
    const bytes = Buffer.byteLength(encoded, "utf8");
    const digest = createHash("sha256").update(encoded).digest("hex");
    const existing = this.store.request(sessionId, request.request_id);
    if (existing) {
      if (existing.requestDigest !== digest)
        return Promise.resolve(
          rejected(
            request.request_id,
            "broker_request_conflict",
            "Broker request identity was reused with different content.",
          ),
        );
      const cached = live.completed.get(request.request_id);
      if (cached) return Promise.resolve(structuredClone(cached));
      return Promise.resolve(
        this.responseForSettled(
          live,
          request.request_id,
          existing.state,
          existing.errorCode,
        ),
      );
    }
    if (live.activeCount >= this.maxActiveRequests)
      return Promise.resolve(
        rejected(
          request.request_id,
          "broker_active_request_limit",
          "Broker active request limit is exhausted.",
        ),
      );
    this.store.createRequest({
      sessionId,
      requestId: request.request_id,
      operation: request.operation,
      mutating: isMutatingWorkspaceTool(request.operation),
      requestDigest: digest,
      requestBytes: bytes,
    });
    live.activeCount += 1;
    const operation = () => this.executeNow(live, request, bytes);
    const result = isMutatingWorkspaceTool(request.operation)
      ? live.mutationTail.then(operation, operation)
      : operation();
    if (isMutatingWorkspaceTool(request.operation))
      live.mutationTail = result.then(
        () => undefined,
        () => undefined,
      );
    return result.finally(() => {
      live.activeCount -= 1;
    });
  }

  private async executeNow(
    live: LiveSession,
    request: WorkspaceToolRequest,
    bytes: number,
  ): Promise<WorkspaceToolResponse> {
    const started = Date.now();
    const sessionId = live.record.sessionId;
    const queued = this.store.request(sessionId, request.request_id);
    if (!queued || queued.state !== "not_submitted")
      return this.responseForSettled(
        live,
        request.request_id,
        queued?.state ?? "rejected",
        queued?.errorCode ?? "broker_request_not_submitted",
      );
    let admissionError: { code: string; message: string } | null = null;
    try {
      this.assertAdmitted(live, request);
    } catch (error) {
      admissionError = brokerError(error, "broker_authority_rejected");
    }
    if (admissionError) {
      this.store.reject(sessionId, request.request_id, admissionError.code);
      const response = rejected(
        request.request_id,
        admissionError.code,
        admissionError.message,
      );
      live.completed.set(request.request_id, response);
      await this.safeReport(
        live.record,
        request,
        "not_submitted",
        "rejected",
        bytes,
        Buffer.byteLength(JSON.stringify(response)),
        Date.now() - started,
        admissionError.code,
      );
      return response;
    }
    this.store.submitted(sessionId, request.request_id);
    let process: StreamedProcess | null = null;
    try {
      const launched = await live.run.spawn(request);
      process = launched.process;
      live.active.set(request.request_id, process);
      const afterSpawn = this.store.request(sessionId, request.request_id);
      if (afterSpawn?.state !== "submitted") {
        await process.cancel().catch(() => undefined);
        return this.responseForSettled(
          live,
          request.request_id,
          afterSpawn?.state ?? "cancelled",
          afterSpawn?.errorCode ?? "broker_request_cancelled",
        );
      }
      this.store.bindProcess(sessionId, request.request_id, process.handle);
      await process.write(launched.input);
      await process.closeStdin();
      const stdoutPromise = collect(
        process.stdout,
        request.operation === "terminal.shell"
          ? MAX_BROKER_STDIO_BYTES
          : MAX_BROKER_FRAME_BYTES,
      );
      const stderrPromise = collect(process.stderr, MAX_BROKER_STDIO_BYTES);
      const timeoutMs =
        request.operation === "terminal.shell"
          ? request.arguments.timeout_ms
          : 10_000;
      let exit = await exitWithin(process.exit, timeoutMs);
      if (exit === null) {
        await process.cancel();
        exit = await exitWithin(process.exit, 5_000);
        if (exit === null)
          throw new EnvironmentBackendError(
            "streamed_process_cancellation_uncertain",
            "Workspace tool cancellation did not settle.",
            "cancel_streamed",
            "ambiguous",
          );
        await Promise.all([stdoutPromise, stderrPromise]);
        const current = this.store.request(sessionId, request.request_id);
        if (current && ["not_submitted", "submitted"].includes(current.state))
          this.store.cancelled(
            sessionId,
            request.request_id,
            "broker_request_timeout",
          );
        const response = cancelled(
          request.request_id,
          "broker_request_timeout",
        );
        live.completed.set(request.request_id, response);
        await this.safeReport(
          live.record,
          request,
          "acknowledged",
          "cancelled",
          bytes,
          Buffer.byteLength(JSON.stringify(response)),
          Date.now() - started,
          "broker_request_timeout",
        );
        return response;
      }
      const [stdout, stderr] = await Promise.all([
        stdoutPromise,
        stderrPromise,
      ]);
      const settled = this.store.request(sessionId, request.request_id);
      if (settled?.state !== "submitted") {
        const response = this.responseForSettled(
          live,
          request.request_id,
          settled?.state ?? "cancelled",
          settled?.errorCode ?? "broker_request_cancelled",
        );
        live.completed.set(request.request_id, response);
        return response;
      }
      live.run.assertCurrent();
      live.account.assertCurrent();
      let result: Record<string, unknown>;
      if (request.operation === "terminal.shell") {
        if (exit.kind !== "exited" && exit.kind !== "exited_nonzero")
          throw new Error("Run-side shell process outcome is unavailable.");
        result = {
          exit_code: exit.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdout_truncated: stdout.truncated,
          stderr_truncated: stderr.truncated,
        };
      } else {
        if (exit.kind !== "exited" || exit.exitCode !== 0)
          throw new Error(
            stderr.text || "Run-side workspace tool process did not complete.",
          );
        if (stdout.truncated)
          throw new Error(
            "Run-side workspace tool response exceeded its bound.",
          );
        result = decodeToolResult(stdout.text, request);
      }
      const response = completed(request.request_id, result);
      const resultBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
      const resultBound =
        request.operation === "filesystem.read" ||
        request.operation === "terminal.shell"
          ? MAX_BROKER_FRAME_BYTES
          : MAX_BROKER_METADATA_BYTES;
      if (resultBytes > resultBound)
        throw new Error("Workspace tool result exceeds its bound.");
      this.store.complete(sessionId, request.request_id, resultBytes);
      live.completed.set(request.request_id, response);
      await this.safeReport(
        live.record,
        request,
        "completed",
        "completed",
        bytes,
        resultBytes,
        Date.now() - started,
        null,
      );
      return response;
    } catch (error) {
      const current = this.store.request(sessionId, request.request_id);
      if (current && current.state !== "submitted")
        return this.responseForSettled(
          live,
          request.request_id,
          current.state,
          current.errorCode,
        );
      const classified = classifyExecutionError(
        error,
        current?.process ?? null,
        current?.mutating ?? isMutatingWorkspaceTool(request.operation),
      );
      if (classified.certainty === "uncertain")
        this.store.uncertain(sessionId, request.request_id, classified.code);
      else this.store.reject(sessionId, request.request_id, classified.code);
      const response =
        classified.certainty === "uncertain"
          ? uncertain(request.request_id, classified.code, classified.message)
          : classified.certainty === "acknowledged"
            ? failed(request.request_id, classified.code, classified.message)
            : rejected(request.request_id, classified.code, classified.message);
      live.completed.set(request.request_id, response);
      await this.safeReport(
        live.record,
        request,
        classified.certainty,
        response.status,
        bytes,
        Buffer.byteLength(JSON.stringify(response)),
        Date.now() - started,
        classified.code,
      );
      return response;
    } finally {
      if (process) live.active.delete(request.request_id);
    }
  }

  private assertAdmitted(
    live: LiveSession,
    request: WorkspaceToolRequest,
  ): void {
    const current = this.store.session(live.record.sessionId);
    if (!current || current.state !== "admitted" || live.closing)
      throw brokerFailure(
        "broker_session_not_admitted",
        "Broker session is not admitted.",
      );
    live.account.assertCurrent();
    live.run.assertCurrent();
    if (
      current.binding.workerGeneration !==
        live.record.binding.workerGeneration ||
      current.binding.accountEnvironment.incarnation !==
        live.account.ref.incarnation ||
      current.binding.runEnvironment.incarnation !== live.run.ref.incarnation ||
      current.binding.physicalLineageId !== live.run.physicalLineageId
    )
      throw brokerFailure("broker_binding_stale", "Broker binding is stale.");
    const required = requiredSemanticTool(request.operation);
    if (!live.run.resolvedToolProfile.tools.includes(required))
      throw brokerFailure(
        "broker_tool_denied",
        "Resolved tool policy denied the operation.",
      );
    if (
      (request.operation === "filesystem.write" ||
        request.operation === "filesystem.edit" ||
        request.operation === "terminal.shell") &&
      live.run.workspaceAccess !== "read_write"
    )
      throw brokerFailure(
        "broker_workspace_read_only",
        "Workspace permission denied the mutating operation.",
      );
    if (live.run.workspaceAccess === "none")
      throw brokerFailure(
        "broker_workspace_unavailable",
        "Workspace access is unavailable.",
      );
  }

  private responseForSettled(
    live: LiveSession,
    requestId: string,
    state: string,
    errorCode: string | null,
  ): WorkspaceToolResponse {
    const cached = live.completed.get(requestId);
    if (cached) return structuredClone(cached);
    if (state === "uncertain")
      return uncertain(
        requestId,
        errorCode ?? "broker_request_outcome_uncertain",
        "Broker request outcome is uncertain and will not be replayed.",
      );
    if (state === "cancelled") return cancelled(requestId);
    if (state === "completed")
      return rejected(
        requestId,
        "broker_result_unavailable",
        "The completed result is no longer available; the operation was not replayed.",
      );
    return rejected(
      requestId,
      errorCode ?? "broker_request_not_submitted",
      "Broker request was not submitted.",
    );
  }

  private async closeMatching(
    predicate: (session: WorkspaceToolBrokerSessionRecord) => boolean,
    reason: string,
  ): Promise<void> {
    await Promise.all(
      this.store
        .sessions()
        .filter((session) => session.state !== "closed" && predicate(session))
        .map((session) => this.closeSession(session.sessionId, reason)),
    );
  }

  private requiredLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId);
    if (!live || live.closing)
      throw new Error("Workspace tool broker session is unavailable.");
    return live;
  }

  private async monitorClient(live: LiveSession): Promise<void> {
    if (!live.client) return;
    const exit = await live.client.exit;
    if (!live.closing)
      await this.closeSession(
        live.record.sessionId,
        exit.kind === "exited" && exit.exitCode === 0
          ? "account_client_exited"
          : "account_client_lost",
      );
  }

  private async safeReport(
    session: WorkspaceToolBrokerSessionRecord,
    request: WorkspaceToolRequest | null,
    certainty: string | null,
    state: string,
    requestBytes: number | null,
    resultBytes: number | null,
    durationMs: number | null,
    errorCode: string | null,
  ): Promise<void> {
    await this.report({
      session_id: session.sessionId,
      broker_generation: session.brokerGeneration,
      authorization_id: session.binding.authorizationId,
      action_id: session.binding.actionId,
      attempt_id: session.binding.attemptId,
      operation: request?.operation ?? null,
      request_id: request?.request_id ?? null,
      state,
      certainty,
      request_bytes: requestBytes,
      result_bytes: resultBytes,
      duration_ms: durationMs,
      error_code: errorCode,
      observed_at: this.clock().toISOString(),
    }).catch(() => undefined);
  }
}

function validatePreparation(input: WorkspaceToolBrokerPreparation): void {
  const strings = [
    input.authorizationId,
    input.providerAccountId,
    input.runId,
    input.actionId,
    input.occurrenceId,
    input.attemptId,
    input.workspaceId,
    input.worktreeId,
    input.workspaceBindingId,
    input.workerId,
  ];
  if (
    strings.some((value) => typeof value !== "string" || value.length === 0) ||
    !Number.isSafeInteger(input.credentialGeneration) ||
    input.credentialGeneration < 1 ||
    !Number.isSafeInteger(input.accountEnvironmentGeneration) ||
    input.accountEnvironmentGeneration < 1 ||
    !Number.isSafeInteger(input.workerGeneration) ||
    input.workerGeneration < 1 ||
    !Number.isSafeInteger(input.operationalEpoch) ||
    input.operationalEpoch < 0 ||
    !Number.isSafeInteger(input.operationalAttempt) ||
    input.operationalAttempt < 1 ||
    !["none", "read_only", "read_write"].includes(input.workspaceAccess) ||
    !Array.isArray(input.resolvedToolProfile.tools)
  )
    throw new Error("Workspace tool broker preparation is invalid.");
}

function assertAccountRef(
  input: WorkspaceToolBrokerPreparation,
  ref: EnvironmentRef,
): void {
  if (
    ref.workerId !== input.workerId ||
    ref.owner.kind !== "provider_account" ||
    ref.owner.providerAccountId !== input.providerAccountId ||
    ref.owner.credentialGeneration !== input.accountEnvironmentGeneration ||
    ref.backendKind !== input.accountEnvironment.backendKind ||
    ref.environmentId !== input.accountEnvironment.environmentId ||
    ref.incarnation !== input.accountEnvironment.incarnation
  )
    throw new Error("ProviderAccount broker environment authority is stale.");
}

function assertRunAuthority(
  input: WorkspaceToolBrokerPreparation,
  run: WorkspaceToolRunAuthority,
): void {
  if (
    run.ref.workerId !== input.workerId ||
    run.ref.owner.kind !== "run" ||
    run.ref.owner.runId !== input.runId ||
    run.workspaceId !== input.workspaceId ||
    run.worktreeId !== input.worktreeId ||
    run.workspaceBindingId !== input.workspaceBindingId ||
    run.workspaceAccess !== input.workspaceAccess ||
    JSON.stringify([...run.resolvedToolProfile.tools].sort()) !==
      JSON.stringify([...input.resolvedToolProfile.tools].sort())
  )
    throw new Error("Run broker execution authority is stale.");
}

function preparationFromBinding(
  binding: WorkspaceToolBrokerBinding,
): WorkspaceToolBrokerPreparation {
  return {
    authorizationId: binding.authorizationId,
    providerAccountId: binding.providerAccountId,
    credentialGeneration: binding.credentialGeneration,
    accountEnvironmentGeneration: binding.accountEnvironmentGeneration,
    accountEnvironment: structuredClone(binding.accountEnvironment),
    runId: binding.runId,
    actionId: binding.actionId,
    occurrenceId: binding.occurrenceId,
    attemptId: binding.attemptId,
    operationalEpoch: binding.operationalEpoch,
    operationalAttempt: binding.operationalAttempt,
    workspaceId: binding.workspaceId,
    worktreeId: binding.worktreeId,
    workspaceBindingId: binding.workspaceBindingId,
    workspaceAccess: binding.workspaceAccess,
    resolvedToolProfile: structuredClone(binding.resolvedToolProfile),
    workerId: binding.workerId,
    workerGeneration: binding.workerGeneration,
  };
}

function toolProfileIdentity(
  profile: { tools: string[] },
  access: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ tools: [...profile.tools].sort(), access }))
    .digest("hex");
}

async function exitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collect(
  stream: AsyncIterable<StreamedProcessStreamEvent>,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  for await (const event of stream) {
    if (event.kind === "transport_error")
      throw new Error("Run-side broker stream became unavailable.");
    if (event.kind !== "data") continue;
    const remaining = Math.max(0, maximumBytes - length);
    const accepted = Math.min(event.data.byteLength, remaining);
    if (accepted > 0) {
      chunks.push(event.data.slice(0, accepted));
      length += accepted;
    }
    if (accepted < event.data.byteLength) truncated = true;
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

function decodeToolResult(
  text: string,
  request: Exclude<WorkspaceToolRequest, { operation: "terminal.shell" }>,
): Record<string, unknown> {
  const envelope = resultRecord(JSON.parse(text), "envelope");
  if (envelope.ok !== true) {
    resultExactKeys(envelope, ["ok", "error"]);
    const error = resultRecord(envelope.error, "error");
    resultExactKeys(error, ["code", "message", "certainty"]);
    const certainty = error.certainty;
    throw brokerToolFailure(
      resultString(error.code, "error code", 128),
      resultString(error.message, "error message", 1_024),
      certainty === "not_submitted" ||
        certainty === "acknowledged" ||
        certainty === "uncertain"
        ? certainty
        : "uncertain",
    );
  }
  resultExactKeys(envelope, ["ok", "result"]);
  const result = resultRecord(envelope.result, "result");
  const path = request.arguments.path;
  switch (request.operation) {
    case "filesystem.read": {
      resultExactKeys(result, ["path", "content", "bytes", "modified_ns"]);
      const content = resultString(
        result.content,
        "file content",
        256 * 1024,
        true,
      );
      if (
        result.path !== path ||
        result.bytes !== Buffer.byteLength(content, "utf8") ||
        !resultNonNegativeNumber(result.modified_ns)
      )
        throw new Error("Run-side file-read result is malformed.");
      break;
    }
    case "filesystem.list": {
      resultExactKeys(result, ["path", "entries"]);
      if (
        result.path !== path ||
        !Array.isArray(result.entries) ||
        result.entries.length > 256
      )
        throw new Error("Run-side directory-list result is malformed.");
      for (const entry of result.entries) validateMetadata(entry);
      break;
    }
    case "filesystem.stat":
      resultExactKeys(result, [
        "path",
        "name",
        "type",
        "size",
        "mode",
        "modified_ns",
      ]);
      if (result.path !== path)
        throw new Error("Run-side stat result is stale.");
      validateMetadata(result, true);
      break;
    case "filesystem.write":
      resultExactKeys(result, ["path", "bytes"]);
      if (result.path !== path || !resultNonNegativeInteger(result.bytes))
        throw new Error("Run-side write result is malformed.");
      break;
    case "filesystem.edit":
      resultExactKeys(result, ["path", "bytes", "replacements"]);
      if (
        result.path !== path ||
        !resultNonNegativeInteger(result.bytes) ||
        result.replacements !== request.arguments.expected_replacements
      )
        throw new Error("Run-side edit result is malformed.");
      break;
    case "search.grep":
      resultExactKeys(result, ["matches", "truncated"]);
      if (
        !Array.isArray(result.matches) ||
        result.matches.length > 100 ||
        typeof result.truncated !== "boolean"
      )
        throw new Error("Run-side search result is malformed.");
      for (const value of result.matches) {
        const match = resultRecord(value, "search match");
        resultExactKeys(match, ["path", "line", "text"]);
        const matchedPath = resultString(match.path, "search path", 1_024);
        if (
          matchedPath.startsWith("/") ||
          matchedPath.split("/").some((segment) => segment === "..") ||
          !resultNonNegativeInteger(match.line) ||
          match.line < 1
        )
          throw new Error("Run-side search match is malformed.");
        resultString(match.text, "search text", 4_096, true);
      }
      break;
  }
  return result;
}

function validateMetadata(value: unknown, includesPath = false): void {
  const metadata = resultRecord(value, "metadata");
  if (!includesPath)
    resultExactKeys(metadata, ["name", "type", "size", "mode", "modified_ns"]);
  resultString(metadata.name, "metadata name", 1_024);
  if (
    !["file", "directory", "symlink", "other"].includes(
      metadata.type as string,
    ) ||
    (metadata.size !== null && !resultNonNegativeInteger(metadata.size)) ||
    !resultNonNegativeInteger(metadata.mode) ||
    !resultNonNegativeNumber(metadata.modified_ns)
  )
    throw new Error("Run-side workspace metadata is malformed.");
}

function resultRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Run-side workspace tool ${label} is malformed.`);
  return value as Record<string, unknown>;
}

function resultExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error("Run-side workspace tool returned unexpected fields.");
}

function resultString(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw new Error(`Run-side workspace tool ${label} is malformed.`);
  return value;
}

function resultNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function resultNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function classifyExecutionError(
  error: unknown,
  process: StreamedProcessHandle | null,
  mutating: boolean,
): {
  certainty: "not_submitted" | "acknowledged" | "uncertain";
  code: string;
  message: string;
} {
  if (error instanceof Error) {
    const certainty = (error as Error & { sideEffectCertainty?: unknown })
      .sideEffectCertainty;
    if (certainty === "not_submitted") {
      const safe = brokerError(error, "broker_tool_rejected");
      return { certainty: "not_submitted", ...safe };
    }
    if (certainty === "acknowledged") {
      const safe = brokerError(error, "broker_tool_failed");
      return { certainty: "acknowledged", ...safe };
    }
    if (certainty === "ambiguous" || certainty === "uncertain") {
      const safe = brokerError(error, "broker_request_outcome_uncertain");
      return {
        certainty: mutating ? "uncertain" : "acknowledged",
        code: mutating ? "broker_request_outcome_uncertain" : safe.code,
        message: mutating
          ? "Workspace tool side-effect outcome is uncertain; it was not replayed."
          : safe.message,
      };
    }
  }
  if (error instanceof EnvironmentBackendError) {
    const uncertain =
      error.sideEffectCertainty === "ambiguous" ||
      error.code === "streamed_process_write_uncertain" ||
      error.code === "streamed_process_stream_unavailable" ||
      error.code === "streamed_process_cancellation_uncertain";
    const ambiguousMutation = mutating && (uncertain || process !== null);
    return {
      certainty: ambiguousMutation
        ? "uncertain"
        : process !== null
          ? "acknowledged"
          : "not_submitted",
      code: ambiguousMutation ? "broker_request_outcome_uncertain" : error.code,
      message: ambiguousMutation
        ? "Workspace tool side-effect outcome is uncertain; it was not replayed."
        : error.message,
    };
  }
  const safe = brokerError(error, "broker_tool_failed");
  const ambiguousMutation = mutating && process !== null;
  return {
    certainty: ambiguousMutation
      ? "uncertain"
      : process !== null
        ? "acknowledged"
        : "not_submitted",
    code: ambiguousMutation ? "broker_request_outcome_uncertain" : safe.code,
    message: ambiguousMutation
      ? "Workspace tool side-effect outcome is uncertain; it was not replayed."
      : safe.message,
  };
}

function brokerFailure(
  code: string,
  message: string,
): Error & { code: string; sideEffectCertainty: "not_submitted" } {
  return Object.assign(new Error(message), {
    code,
    sideEffectCertainty: "not_submitted" as const,
  });
}

function brokerToolFailure(
  code: string,
  message: string,
  certainty: "not_submitted" | "acknowledged" | "uncertain",
): Error & {
  code: string;
  sideEffectCertainty: "not_submitted" | "acknowledged" | "uncertain";
} {
  return Object.assign(new Error(message), {
    code,
    sideEffectCertainty: certainty,
  });
}

function brokerError(
  error: unknown,
  fallback: string,
): { code: string; message: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : fallback,
      message: error.message.slice(0, 1_024),
    };
  }
  return {
    code: fallback,
    message: "Workspace tool broker rejected the request.",
  };
}

function completed(
  requestId: string,
  result: Record<string, unknown>,
): WorkspaceToolResponse {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: requestId,
    status: "completed",
    certainty: "completed",
    result,
    error: null,
  };
}

function rejected(
  requestId: string,
  code: string,
  message: string,
): WorkspaceToolResponse {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: requestId,
    status: "rejected",
    certainty: "not_submitted",
    result: null,
    error: { code, message: message.slice(0, 1_024) },
  };
}

function failed(
  requestId: string,
  code: string,
  message: string,
): WorkspaceToolResponse {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: requestId,
    status: "rejected",
    certainty: "acknowledged",
    result: null,
    error: { code, message: message.slice(0, 1_024) },
  };
}

function uncertain(
  requestId: string,
  code: string,
  message: string,
): WorkspaceToolResponse {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: requestId,
    status: "uncertain",
    certainty: "uncertain",
    result: null,
    error: { code, message: message.slice(0, 1_024) },
  };
}

function cancelled(
  requestId: string,
  code = "broker_request_cancelled",
): WorkspaceToolResponse {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "response",
    request_id: requestId,
    status: "cancelled",
    certainty: "acknowledged",
    result: null,
    error: {
      code,
      message:
        code === "broker_request_timeout"
          ? "Broker request exceeded its timeout and was cancelled."
          : "Broker request was cancelled.",
    },
  };
}
