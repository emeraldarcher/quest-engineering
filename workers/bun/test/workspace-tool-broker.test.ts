import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EnvironmentBackendError,
  type EnvironmentRef,
  type StreamedProcess,
  type StreamedProcessExit,
  type StreamedProcessHandle,
  type StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  type WorkspaceToolAccountAuthority,
  WorkspaceToolBroker,
  type WorkspaceToolBrokerPreparation,
  type WorkspaceToolRunAuthority,
} from "../src/workspace-tool-broker.ts";
import {
  WORKSPACE_TOOL_BROKER_PROTOCOL,
  type WorkspaceToolRequest,
  type WorkspaceToolResponse,
} from "../src/workspace-tool-broker-protocol.ts";
import { WorkspaceToolBrokerStore } from "../src/workspace-tool-broker-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("WorkspaceToolBroker", () => {
  test("broker identifiers are not bearer capabilities and exact admission is required", async () => {
    const fixture = await brokerFixture();
    try {
      const prepared = await fixture.broker.prepare(preparation());
      await expect(
        fixture.broker.admitAuthorization(prepared.sessionId),
      ).rejects.toThrow("not prepared");
      const client = await fixture.broker.admitAuthorization(
        prepared.binding.authorizationId,
      );
      expect(await client.request(readRequest())).toMatchObject({
        status: "completed",
        result: { content: "run-cell-only" },
      });
    } finally {
      await fixture.broker.close();
    }
  });

  test("executes only through the Run-cell process and preserves account-cell state", async () => {
    const fixture = await brokerFixture();
    try {
      const client = await admit(fixture);
      expect(await client.request(readRequest())).toMatchObject({
        status: "completed",
      });
      expect(fixture.runOperations).toEqual(["filesystem.read"]);
      expect(fixture.accountOperations).toEqual([]);
      expect(fixture.accountCanary).toBe("account-canary-unchanged");
      expect(fixture.runCanary).toBe("run-canary");
    } finally {
      await fixture.broker.close();
    }
  });

  test("centrally enforces resolved tools, workspace permissions, paths, and operation vocabulary", async () => {
    const fixture = await brokerFixture({
      workspaceAccess: "read_only",
      tools: ["workspace.filesystem"],
    });
    try {
      const client = await admit(fixture, {
        workspaceAccess: "read_only",
        resolvedToolProfile: { tools: ["workspace.filesystem"] },
      });
      expect(await client.request(writeRequest("write-denied"))).toMatchObject({
        status: "rejected",
        certainty: "not_submitted",
        error: { code: "broker_workspace_read_only" },
      });
      expect(await client.request(shellRequest("shell-denied"))).toMatchObject({
        status: "rejected",
        error: { code: "broker_tool_denied" },
      });
      expect(() =>
        client.request({
          ...readRequest("traversal"),
          arguments: { path: "../outside" },
        }),
      ).toThrow("relative");
      expect(() =>
        client.request({
          ...readRequest("unknown"),
          operation: "provider.secret",
        }),
      ).toThrow("operation");
    } finally {
      await fixture.broker.close();
    }
  });

  test("replays acknowledged results but never replays ambiguous mutations", async () => {
    const fixture = await brokerFixture();
    try {
      const client = await admit(fixture);
      const write = writeRequest("write-once");
      expect(await client.request(write)).toMatchObject({
        status: "completed",
        certainty: "completed",
      });
      expect(await client.request(write)).toMatchObject({
        status: "completed",
      });
      expect(
        fixture.runOperations.filter((value) => value === "filesystem.write"),
      ).toHaveLength(1);
      expect(
        await client.request({
          ...write,
          arguments: { path: "x.txt", content: "different" },
        }),
      ).toMatchObject({
        status: "rejected",
        error: { code: "broker_request_conflict" },
      });

      fixture.ambiguousMutations = true;
      const ambiguous = writeRequest("ambiguous");
      expect(await client.request(ambiguous)).toMatchObject({
        status: "uncertain",
        certainty: "uncertain",
      });
      expect(await client.request(ambiguous)).toMatchObject({
        status: "uncertain",
      });
      expect(
        fixture.runOperations.filter((value) => value === "filesystem.write"),
      ).toHaveLength(2);
    } finally {
      await fixture.broker.close();
    }
  });

  test("allows concurrent reads, serializes mutations, and propagates cancellation", async () => {
    const fixture = await brokerFixture({ delayMs: 30 });
    try {
      const client = await admit(fixture);
      await Promise.all([
        client.request(readRequest("read-1")),
        client.request(readRequest("read-2")),
      ]);
      expect(fixture.maximumActiveReads).toBe(2);
      await Promise.all([
        client.request(writeRequest("write-1")),
        client.request(writeRequest("write-2")),
      ]);
      expect(fixture.maximumActiveMutations).toBe(1);

      fixture.blockShell = true;
      const pending = client.request(shellRequest("shell-blocked"));
      await Bun.sleep(10);
      expect(
        await fixture.broker.cancel(client.sessionId, "shell-blocked"),
      ).toMatchObject({
        status: "cancelled",
      });
      expect(await pending).toMatchObject({ status: "cancelled" });
      expect(fixture.runCancellationObserved).toBe(true);
    } finally {
      await fixture.broker.close();
    }
  });

  test("enforces the finite active-request bound before starting excess work", async () => {
    const fixture = await brokerFixture({ delayMs: 40, maxActiveRequests: 2 });
    try {
      const client = await admit(fixture);
      const first = client.request(readRequest("bounded-read-1"));
      const second = client.request(readRequest("bounded-read-2"));
      expect(
        await client.request(readRequest("bounded-read-excess")),
      ).toMatchObject({
        status: "rejected",
        certainty: "not_submitted",
        error: { code: "broker_active_request_limit" },
      });
      await Promise.all([first, second]);
      expect(fixture.runOperations).toEqual([
        "filesystem.read",
        "filesystem.read",
      ]);
    } finally {
      await fixture.broker.close();
    }
  });

  test("cancellation while Run process launch is pending submits no tool input", async () => {
    const fixture = await brokerFixture({ spawnDelayMs: 40 });
    try {
      const client = await admit(fixture);
      const pending = client.request(shellRequest("cancel-during-spawn"));
      await Bun.sleep(5);
      expect(
        await fixture.broker.cancel(client.sessionId, "cancel-during-spawn"),
      ).toMatchObject({ status: "cancelled" });
      expect(await pending).toMatchObject({ status: "cancelled" });
      expect(fixture.runWrites).toBe(0);
      expect(fixture.runCancellationObserved).toBe(true);
    } finally {
      await fixture.broker.close();
    }
  });

  test("prepared and admitted sessions are both retired by execution fences", async () => {
    const fixture = await brokerFixture();
    try {
      const prepared = await fixture.broker.prepare(preparation());
      await fixture.broker.closeByExecution(
        prepared.binding.actionId,
        "execution_cancelled",
      );
      await expect(
        fixture.broker.admitAuthorization(prepared.binding.authorizationId),
      ).rejects.toThrow("not prepared");

      const replacement = await fixture.broker.prepare(preparation());
      const client = await fixture.broker.admitAuthorization(
        replacement.binding.authorizationId,
      );
      await fixture.broker.closeByProviderAccount(
        replacement.binding.providerAccountId,
        "provider_account_generation_replaced",
      );
      await expect(client.request(readRequest("stale-client"))).rejects.toThrow(
        "stale",
      );
    } finally {
      await fixture.broker.close();
    }
  });

  test("keeps two accounts and two Runs independently bound", async () => {
    const fixture = await brokerFixture();
    try {
      const preparedA = await fixture.broker.prepare(preparation());
      const second = {
        ...preparation(),
        authorizationId: "authorization-2",
        providerAccountId: "account-2",
        accountEnvironment: {
          backendKind: "fake",
          environmentId: "account-2-environment",
          incarnation: "account-2-incarnation",
        },
        runId: "run-2",
        actionId: "action-2",
        occurrenceId: "occurrence-2",
        attemptId: "attempt-2",
        workspaceId: "workspace-2",
        worktreeId: "worktree-2",
        workspaceBindingId: "workspace-binding-2",
      } satisfies WorkspaceToolBrokerPreparation;
      const preparedB = await fixture.broker.prepare(second);
      const clientA = await fixture.broker.admitAuthorization(
        preparedA.binding.authorizationId,
      );
      const clientB = await fixture.broker.admitAuthorization(
        preparedB.binding.authorizationId,
      );
      expect(
        await clientA.request(readRequest("account-a-run-a")),
      ).toMatchObject({ status: "completed" });
      expect(
        await clientB.request(readRequest("account-b-run-b")),
      ).toMatchObject({ status: "completed" });
      expect(preparedA.binding.runEnvironment).not.toEqual(
        preparedB.binding.runEnvironment,
      );
      expect(preparedA.binding.accountEnvironment).not.toEqual(
        preparedB.binding.accountEnvironment,
      );

      await fixture.broker.closeByProviderAccount(
        "account-1",
        "account_a_invalidated",
      );
      await expect(
        clientA.request(readRequest("account-a-stale")),
      ).rejects.toThrow("stale");
      expect(
        await clientB.request(readRequest("account-b-current")),
      ).toMatchObject({ status: "completed" });
    } finally {
      await fixture.broker.close();
    }
  });

  test("fails closed on account and Run fence rollover", async () => {
    const fixture = await brokerFixture();
    try {
      const client = await admit(fixture);
      fixture.accountCurrent = false;
      expect(await client.request(readRequest("stale-account"))).toMatchObject({
        status: "rejected",
        error: { code: "broker_authority_rejected" },
      });
      fixture.accountCurrent = true;
      fixture.runCurrent = false;
      expect(await client.request(readRequest("stale-run"))).toMatchObject({
        status: "rejected",
        error: { code: "broker_authority_rejected" },
      });
    } finally {
      await fixture.broker.close();
    }
  });

  test("restart closes sessions and marks submitted mutations uncertain", async () => {
    const fixture = await brokerFixture();
    const prepared = await fixture.broker.prepare(preparation());
    fixture.store.admit(prepared.sessionId, handle(environment("account")));
    fixture.store.createRequest({
      sessionId: prepared.sessionId,
      requestId: "submitted-mutation",
      operation: "filesystem.write",
      mutating: true,
      requestDigest: "digest",
      requestBytes: 10,
    });
    fixture.store.submitted(prepared.sessionId, "submitted-mutation");
    fixture.store.close();
    const restarted = new WorkspaceToolBrokerStore(fixture.root);
    try {
      expect(restarted.sessions()[0]?.state).toBe("closed");
      expect(
        restarted.request(prepared.sessionId, "submitted-mutation"),
      ).toMatchObject({
        state: "uncertain",
        errorCode: "broker_request_outcome_uncertain",
      });
    } finally {
      restarted.close();
      fixture.abandon();
    }
  });

  test("durable SQLite stores no request path, content, command, query, or result", async () => {
    const fixture = await brokerFixture();
    const sensitive = "phase-c-sensitive-needle";
    try {
      const client = await admit(fixture);
      await client.request({
        ...writeRequest("sensitive-write"),
        arguments: { path: `${sensitive}.txt`, content: sensitive },
      });
    } finally {
      await fixture.broker.close();
    }
    const bytes = await readFile(
      join(fixture.root, "workspace-tool-broker-v1.sqlite"),
    );
    expect(bytes.includes(Buffer.from(sensitive))).toBe(false);
  });

  test("rejects stale dedicated SQLite schemas", async () => {
    const root = await temporaryRoot();
    const database = new Database(
      join(root, "workspace-tool-broker-v1.sqlite"),
      {
        create: true,
      },
    );
    database.run("CREATE TABLE broker_meta (schema_version INTEGER NOT NULL)");
    database.run("INSERT INTO broker_meta(schema_version) VALUES (0)");
    database.close();
    expect(() => new WorkspaceToolBrokerStore(root)).toThrow("stale");
  });
});

async function brokerFixture(
  options: {
    delayMs?: number;
    spawnDelayMs?: number;
    blockShell?: boolean;
    maxActiveRequests?: number;
    workspaceAccess?: "none" | "read_only" | "read_write";
    tools?: string[];
  } = {},
) {
  const root = await temporaryRoot();
  const store = new WorkspaceToolBrokerStore(root);
  const fixture = {
    root,
    store,
    broker: undefined as unknown as WorkspaceToolBroker,
    runOperations: [] as string[],
    accountOperations: [] as string[],
    accountCanary: "account-canary-unchanged",
    runCanary: "run-canary",
    accountCurrent: true,
    runCurrent: true,
    ambiguousMutations: false,
    blockShell: options.blockShell ?? false,
    activeReads: 0,
    maximumActiveReads: 0,
    activeMutations: 0,
    maximumActiveMutations: 0,
    runCancellationObserved: false,
    runWrites: 0,
    processes: [] as FakeProcess[],
    abandon: () => {
      for (const process of fixture.processes) process.abandon();
    },
  };
  const account = (
    input: WorkspaceToolBrokerPreparation,
  ): WorkspaceToolAccountAuthority => {
    const ref: EnvironmentRef = {
      backendKind: input.accountEnvironment.backendKind,
      environmentId: input.accountEnvironment.environmentId,
      incarnation: input.accountEnvironment.incarnation,
      workerId: input.workerId,
      owner: {
        kind: "provider_account",
        providerAccountId: input.providerAccountId,
        credentialGeneration: input.accountEnvironmentGeneration,
      },
      profile: { id: "test-profile", digest: "test-profile-digest" },
    };
    return {
      ref,
      assertCurrent: () => {
        if (!fixture.accountCurrent) throw new Error("stale account authority");
      },
      spawnClient: async () => {
        const process = FakeProcess.accountClient(ref);
        fixture.processes.push(process);
        return process;
      },
    };
  };
  const run = (
    input: WorkspaceToolBrokerPreparation,
  ): WorkspaceToolRunAuthority => {
    const ref: EnvironmentRef = {
      backendKind: "fake",
      environmentId: `${input.runId}-environment`,
      incarnation: `${input.runId}-incarnation`,
      workerId: input.workerId,
      owner: { kind: "run", runId: input.runId },
      profile: { id: "test-profile", digest: "test-profile-digest" },
    };
    return {
      ref,
      physicalLineageId: `lineage-${input.runId}`,
      workspaceId: input.workspaceId,
      worktreeId: input.worktreeId,
      workspaceBindingId: input.workspaceBindingId,
      workspaceAccess: options.workspaceAccess ?? "read_write",
      resolvedToolProfile: {
        tools: options.tools ?? [
          "workspace.filesystem",
          "workspace.search",
          "terminal.shell",
        ],
      },
      assertCurrent: () => {
        if (!fixture.runCurrent) throw new Error("stale run authority");
      },
      spawn: async (request) => {
        fixture.runOperations.push(request.operation);
        if (options.spawnDelayMs) await Bun.sleep(options.spawnDelayMs);
        const mutating = [
          "filesystem.write",
          "filesystem.edit",
          "terminal.shell",
        ].includes(request.operation);
        if (mutating) {
          fixture.activeMutations += 1;
          fixture.maximumActiveMutations = Math.max(
            fixture.maximumActiveMutations,
            fixture.activeMutations,
          );
        } else {
          fixture.activeReads += 1;
          fixture.maximumActiveReads = Math.max(
            fixture.maximumActiveReads,
            fixture.activeReads,
          );
        }
        const result = fakeToolResult(request);
        const process = new FakeProcess(ref, {
          output:
            request.operation === "terminal.shell"
              ? "run-shell-output"
              : JSON.stringify({ ok: true, result }),
          ...(options.delayMs === undefined
            ? {}
            : { delayMs: options.delayMs }),
          blocked: fixture.blockShell && request.operation === "terminal.shell",
          ambiguousWrite: fixture.ambiguousMutations && mutating,
          onSettle: () => {
            if (mutating) fixture.activeMutations -= 1;
            else fixture.activeReads -= 1;
          },
          onCancel: () => {
            fixture.runCancellationObserved = true;
          },
          onWrite: () => {
            fixture.runWrites += 1;
          },
        });
        fixture.processes.push(process);
        return {
          process,
          input: new TextEncoder().encode(JSON.stringify(request)),
        };
      },
    };
  };
  fixture.broker = new WorkspaceToolBroker(
    store,
    {
      account: async (input) => account(input),
      run: async (input) => run(input),
    },
    async () => undefined,
    options.maxActiveRequests === undefined
      ? {}
      : { maxActiveRequests: options.maxActiveRequests },
  );
  return fixture;
}

class AsyncEventQueue implements AsyncIterable<StreamedProcessStreamEvent> {
  private values: StreamedProcessStreamEvent[] = [];
  private waiters: Array<
    (value: IteratorResult<StreamedProcessStreamEvent>) => void
  > = [];
  private ended = false;

  push(value: StreamedProcessStreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedProcessStreamEvent> {
    while (true) {
      const value = this.values.shift();
      if (value) yield value;
      else if (this.ended) return;
      else {
        const next = await new Promise<
          IteratorResult<StreamedProcessStreamEvent>
        >((resolve) => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

class FakeProcess implements StreamedProcess {
  readonly handle: StreamedProcessHandle;
  readonly stdout = new AsyncEventQueue();
  readonly stderr = new AsyncEventQueue();
  readonly exit: Promise<StreamedProcessExit>;
  private resolveExit!: (exit: StreamedProcessExit) => void;
  private settled = false;
  private sequence = 0;

  constructor(
    ref: EnvironmentRef,
    private readonly options: {
      output?: string;
      delayMs?: number;
      blocked?: boolean;
      ambiguousWrite?: boolean;
      accountClient?: boolean;
      onSettle?: () => void;
      onCancel?: () => void;
      onWrite?: () => void;
    } = {},
  ) {
    this.handle = handle(ref);
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static accountClient(ref: EnvironmentRef): FakeProcess {
    return new FakeProcess(ref, { accountClient: true });
  }

  async write(data: Uint8Array) {
    this.options.onWrite?.();
    if (this.options.ambiguousWrite)
      throw new EnvironmentBackendError(
        "streamed_process_write_uncertain",
        "ambiguous write",
        "write_streamed",
        "ambiguous",
      );
    const text = new TextDecoder().decode(data);
    if (this.options.accountClient) {
      for (const line of text.trim().split("\n")) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === "drive")
          this.emit({ type: "request", ...(frame.request as object) });
        if (frame.type === "result") {
          const response = frame.response as WorkspaceToolResponse;
          this.emit({
            type: "client_received",
            request_id: response.request_id,
          });
        }
      }
    }
    return {
      certainty: "acknowledged" as const,
      writeId: crypto.randomUUID(),
      byteLength: data.byteLength,
    };
  }

  async closeStdin() {
    if (!this.options.accountClient && !this.options.blocked) {
      if (this.options.delayMs) await Bun.sleep(this.options.delayMs);
      if (this.options.output) this.emitRaw(this.options.output);
      this.settle({ kind: "exited", exitCode: 0 });
    }
    return {
      certainty: "acknowledged" as const,
      writeId: crypto.randomUUID(),
      byteLength: 0,
    };
  }

  async cancel() {
    this.options.onCancel?.();
    this.settle({ kind: "signaled", signal: "TERM" });
    return {
      certainty: "acknowledged" as const,
      cancellationId: crypto.randomUUID(),
    };
  }

  async inspect() {
    return {
      handle: this.handle,
      process: this.settled ? ("exited" as const) : ("running" as const),
      streamAttachment: "attached" as const,
      streamRecovery: "current_worker_only" as const,
    };
  }

  async disconnect(): Promise<void> {
    this.settle({ kind: "signaled", signal: "DISCONNECT" });
  }

  abandon(): void {
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({
      kind: "observation_unavailable",
      errorCode: "streamed_process_stream_unavailable",
    });
  }

  private emit(frame: object): void {
    this.emitRaw(`${JSON.stringify(frame)}\n`);
  }

  private emitRaw(value: string): void {
    this.stdout.push({
      kind: "data",
      sequence: ++this.sequence,
      data: new TextEncoder().encode(value),
    });
  }

  private settle(exit: StreamedProcessExit): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.options.onSettle?.();
    this.resolveExit(exit);
  }
}

function fakeToolResult(
  request: WorkspaceToolRequest,
): Record<string, unknown> | null {
  switch (request.operation) {
    case "filesystem.read":
      return {
        path: request.arguments.path,
        content: "run-cell-only",
        bytes: 13,
        modified_ns: 1,
      };
    case "filesystem.list":
      return { path: request.arguments.path, entries: [] };
    case "filesystem.stat":
      return {
        path: request.arguments.path,
        name: "fixture",
        type: "file",
        size: 13,
        mode: 0o644,
        modified_ns: 1,
      };
    case "filesystem.write":
      return {
        path: request.arguments.path,
        bytes: Buffer.byteLength(request.arguments.content),
      };
    case "filesystem.edit":
      return {
        path: request.arguments.path,
        bytes: Buffer.byteLength(request.arguments.new_text),
        replacements: request.arguments.expected_replacements,
      };
    case "search.grep":
      return { matches: [], truncated: false };
    case "terminal.shell":
      return null;
  }
}

async function admit(
  fixture: Awaited<ReturnType<typeof brokerFixture>>,
  overrides: Partial<WorkspaceToolBrokerPreparation> = {},
) {
  const prepared = await fixture.broker.prepare({
    ...preparation(),
    ...overrides,
  });
  return fixture.broker.admitAuthorization(prepared.binding.authorizationId);
}

function preparation(): WorkspaceToolBrokerPreparation {
  return {
    authorizationId: "authorization-1",
    providerAccountId: "account-1",
    credentialGeneration: 2,
    accountEnvironmentGeneration: 1,
    accountEnvironment: {
      backendKind: "fake",
      environmentId: "account-environment",
      incarnation: "account-incarnation",
    },
    runId: "run-1",
    actionId: "action-1",
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    operationalEpoch: 0,
    operationalAttempt: 1,
    workspaceId: "workspace-1",
    worktreeId: "worktree-1",
    workspaceBindingId: "workspace-binding-1",
    workspaceAccess: "read_write",
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    workerId: "worker-1",
    workerGeneration: 1,
  };
}

function readRequest(requestId = "read-1"): WorkspaceToolRequest {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "request",
    request_id: requestId,
    operation: "filesystem.read",
    arguments: { path: "README.md" },
  };
}

function writeRequest(requestId: string): WorkspaceToolRequest {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "request",
    request_id: requestId,
    operation: "filesystem.write",
    arguments: { path: `${requestId}.txt`, content: requestId },
  };
}

function shellRequest(requestId: string): WorkspaceToolRequest {
  return {
    version: WORKSPACE_TOOL_BROKER_PROTOCOL,
    type: "request",
    request_id: requestId,
    operation: "terminal.shell",
    arguments: { command: "pwd", cwd: ".", timeout_ms: 5_000 },
  };
}

function environment(kind: "account" | "run"): EnvironmentRef {
  return {
    backendKind: "fake",
    environmentId: `${kind}-environment`,
    incarnation: `${kind}-incarnation`,
    workerId: "worker-1",
    owner:
      kind === "account"
        ? {
            kind: "provider_account",
            providerAccountId: "account-1",
            credentialGeneration: 1,
          }
        : { kind: "run", runId: "run-1" },
    profile: { id: "test-profile", digest: "test-profile-digest" },
  };
}

function handle(ref: EnvironmentRef): StreamedProcessHandle {
  return {
    contractVersion: 1,
    backendKind: ref.backendKind,
    environment: ref,
    backendProcessId: crypto.randomUUID(),
    processStartIdentity: crypto.randomUUID(),
    processGeneration: crypto.randomUUID(),
    executable: "/usr/bin/python3",
  };
}

async function temporaryRoot(): Promise<string> {
  const scratch = join(process.cwd(), ".pi", "tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "workspace-tool-broker-"));
  roots.push(root);
  return root;
}
