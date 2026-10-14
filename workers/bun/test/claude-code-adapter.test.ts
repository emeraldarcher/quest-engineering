import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import type {
  EnvironmentLease,
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessExit,
  StreamedProcessStreamEvent,
} from "../src/execution-environment/types.ts";
import {
  attestClaudeInit,
  CLAUDE_CODE_EFFORT,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_NAME,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
  ClaudeCodeHarness,
} from "../src/harnesses/claude-code/adapter.ts";
import type { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("ClaudeCodeHarness reaches exact zero-inference readiness using only a synthetic non-query message", async () => {
  const root = await testRoot();
  const candidate = claudeAction();
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "claude_code",
  );
  const accepted = registry.accept(candidate).dispatch;
  registry.occupy(accepted.lineageId as string, accepted.action.action_id);
  const lineage = registry.getLineage(accepted.lineageId as string);
  const environment = accountEnvironment();
  const process = syntheticInitProcess(environment);
  const writes: Array<Record<string, unknown>> = [];
  process.onWrite = (frame) => writes.push(frame);
  const lease = accountLease(environment, process);
  const binding = brokerBinding(accepted.action.action_id, environment);
  const client = {
    sessionId: "broker-session-1",
    request: async () => {
      throw new Error(
        "No workspace request is permitted before prompt authorization.",
      );
    },
    close: async () => undefined,
  };
  const harness = new ClaudeCodeHarness(
    { workerId: "worker-test", dataRoot: root } as WorkerConfig,
    {
      prepare: async () => ({ materializedArtifacts: {} }),
    } as never,
    {
      claudeCodeRuntime: async () => ({
        lease,
        ref: environment,
        configRoot: "/qe/state/claude/config",
        cwd: "/qe/state/claude/empty-cwd",
        assertCurrent: () => undefined,
      }),
      withSerializedAccount: async (
        _account: string,
        operation: () => Promise<unknown>,
      ) => operation(),
      retireClaudeAccountProcesses: async () => undefined,
    } as never,
    () =>
      ({
        boundClientForAction: () => ({ binding, client }),
      }) as unknown as WorkspaceToolBroker,
  );

  const prepared = await harness.start(accepted, lineage);
  await harness.ready(accepted, prepared);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    type: "user",
    shouldQuery: false,
    isSynthetic: true,
    session_id: prepared.handle.nativeSession?.payload.opaqueId,
  });
  expect(
    String((writes[0]?.message as { content?: string }).content),
  ).toContain("zero-inference");
  expect(await harness.inspect(lineage)).toMatchObject({
    state: "starting",
    activity: { state: "idle" },
    health: "healthy",
    nativeSession: prepared.handle.nativeSession,
  });
  expect(process.queryWrites).toBe(0);
  await harness.close(lineage);
  registry.close();
});

test("Claude init requires OAuth provenance in addition to the exact Mod and tool inventory", () => {
  const frame = initFrame("11111111-1111-4111-8111-111111111111");
  expect(() =>
    attestClaudeInit(frame, {
      sessionId: frame.session_id as string,
      cwd: frame.cwd as string,
      model: CLAUDE_CODE_MODEL,
      effort: CLAUDE_CODE_EFFORT,
    }),
  ).not.toThrow();
  frame.apiKeySource = "apiKeyHelper";
  expect(() =>
    attestClaudeInit(frame, {
      sessionId: frame.session_id as string,
      cwd: frame.cwd as string,
      model: CLAUDE_CODE_MODEL,
      effort: CLAUDE_CODE_EFFORT,
    }),
  ).toThrow();
});

function claudeAction() {
  const base = action();
  return action({
    execution: {
      ...base.execution,
      configuration: {
        ...base.execution.configuration,
        harness_kind: "claude_code",
        model: { provider: "anthropic", model: CLAUDE_CODE_MODEL },
        reasoning: CLAUDE_CODE_EFFORT,
        reasoning_capability: {
          kind: "enumerated",
          values: [CLAUDE_CODE_EFFORT],
        },
        tool_policy: {
          kind: "exact",
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
        tool_enforcement: "exact",
        resolved_tool_profile: {
          tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
        },
      },
    },
  });
}

function accountEnvironment(): EnvironmentRef {
  return {
    backendKind: "fake-sbx",
    environmentId: "claude-account-environment-1",
    incarnation: "claude-account-incarnation-1",
    workerId: "worker-test",
    owner: {
      kind: "provider_account",
      providerAccountId: "account-1",
      credentialGeneration: 1,
    },
    profile: { id: "qe-claude-account-v1", digest: `sha256:${"a".repeat(64)}` },
  };
}

function accountLease(
  ref: EnvironmentRef,
  process: SyntheticInitProcess,
): EnvironmentLease {
  return {
    ref,
    paths: {
      workspace: "/qe/workspaces/default",
      state: "/qe/state",
      control: "/qe/control",
      home: "/home/agent",
      cache: "/qe/cache",
      temp: "/qe/tmp",
    },
    capabilities: [
      { kind: "credentials", mode: "account_private_claude_oauth" },
      { kind: "network_policy", mode: "anthropic_account_only" },
      { kind: "harness_runtime", mode: "claude_code_managed_mod_v1" },
      { kind: "control_channel", mode: "worker_account_mailbox_v1" },
      { kind: "process.streamed", mode: "attached_only" },
    ],
    exec: async (command: Parameters<EnvironmentLease["exec"]>[0]) => {
      if (command.args[0] === "auth")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            configDirectory: "/qe/state/claude/config",
          }),
          stderr: "",
        };
      return { exitCode: 0, stdout: "[]\n", stderr: "" };
    },
    workerExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    spawnStreamed: async () => process,
    writeFile: async (input: Parameters<EnvironmentLease["writeFile"]>[0]) => ({
      path: input.path,
      byteLength: input.data.byteLength,
      sha256: "a".repeat(64),
    }),
    readFile: async () => new Uint8Array(),
    reconcileStreamedProcess: async () => ({
      handle: process.handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    retireStreamedProcesses: async () => undefined,
    launcher: async () => {
      throw new Error("not used");
    },
  } as unknown as EnvironmentLease;
}

function brokerBinding(actionId: string, environment: EnvironmentRef) {
  return {
    authorizationId: "authorization-1",
    sessionId: "broker-session-1",
    brokerGeneration: 1,
    providerAccountId: "account-1",
    credentialGeneration: 1,
    accountEnvironmentGeneration: 1,
    accountEnvironment: {
      backendKind: environment.backendKind,
      environmentId: environment.environmentId,
      incarnation: environment.incarnation,
    },
    runEnvironment: {
      backendKind: "fake-run",
      environmentId: "run-environment-1",
      incarnation: "run-incarnation-1",
    },
    runId: "run-1",
    actionId,
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    operationalEpoch: 0,
    operationalAttempt: 1,
    physicalLineageId: "physical-lineage-1",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    worktreeId: "00000000-0000-4000-8000-000000000002",
    workspaceBindingId: "00000000-0000-4000-8000-000000000003",
    workspaceAccess: "read_write" as const,
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    workerId: "worker-test",
    workerGeneration: 1,
  };
}

interface SyntheticInitProcess extends StreamedProcess {
  onWrite: (frame: Record<string, unknown>) => void;
  queryWrites: number;
}

function syntheticInitProcess(
  environment: EnvironmentRef,
): SyntheticInitProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => (stdoutController = controller),
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => (stderrController = controller),
  });
  let settleExit!: (value: StreamedProcessExit) => void;
  const exit = new Promise<StreamedProcessExit>(
    (resolve) => (settleExit = resolve),
  );
  let sequence = 0;
  const handle = {
    contractVersion: 1 as const,
    backendKind: environment.backendKind,
    environment,
    backendProcessId: "1000",
    processStartIdentity: "start-1",
    processGeneration: "process-generation-1",
    executable: "/opt/qe/claude/claude",
    observedExecutable: "/opt/qe/claude/claude",
  };
  const process: SyntheticInitProcess = {
    handle,
    stdout: stream(stdout, () => ++sequence),
    stderr: stream(stderr, () => ++sequence),
    exit,
    onWrite: () => undefined,
    queryWrites: 0,
    write: async (data) => {
      const frame = JSON.parse(new TextDecoder().decode(data)) as Record<
        string,
        unknown
      >;
      process.onWrite(frame);
      if (frame.shouldQuery !== false) process.queryWrites += 1;
      else {
        const sessionId = frame.session_id as string;
        stdoutController.enqueue(
          new TextEncoder().encode(`${JSON.stringify(initFrame(sessionId))}\n`),
        );
      }
      return {
        certainty: "acknowledged",
        writeId: crypto.randomUUID(),
        byteLength: data.byteLength,
      };
    },
    closeStdin: async () => ({
      certainty: "acknowledged",
      writeId: crypto.randomUUID(),
      byteLength: 0,
    }),
    cancel: async () => {
      stdoutController.close();
      stderrController.close();
      settleExit({ kind: "signaled", signal: "SIGTERM" });
      return { certainty: "acknowledged", cancellationId: crypto.randomUUID() };
    },
    inspect: async () => ({
      handle,
      process: "running",
      streamAttachment: "attached",
      streamRecovery: "current_worker_only",
    }),
    disconnect: async () => undefined,
  };
  return process;
}

function initFrame(sessionId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.292",
    apiKeySource: "oauth",
    cwd: "/qe/state/claude/empty-cwd",
    model: CLAUDE_CODE_MODEL,
    effort: CLAUDE_CODE_EFFORT,
    permissionMode: "dontAsk",
    tools: [...CLAUDE_CODE_TOOLS],
    mcp_servers: [],
    skills: [],
    agents: [],
    plugins: [
      {
        name: CLAUDE_CODE_PLUGIN_NAME,
        path: CLAUDE_CODE_PLUGIN_PATH,
        version: "1.0.0",
      },
      { name: "cc-plugin-sec-default", path: "builtin" },
    ],
  };
}

async function* stream(
  readable: ReadableStream<Uint8Array>,
  nextSequence: () => number,
): AsyncIterable<StreamedProcessStreamEvent> {
  const reader = readable.getReader();
  for (;;) {
    const value = await reader.read();
    if (value.done) break;
    yield { kind: "data", sequence: nextSequence(), data: value.value };
  }
  yield { kind: "eof", sequence: nextSequence() };
}

async function testRoot(): Promise<string> {
  const parent = resolve(import.meta.dir, "../.pi/tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-code-adapter-"));
  roots.push(root);
  return root;
}
