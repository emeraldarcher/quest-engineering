import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_CLAUDE_ACCOUNT_BRIDGE,
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1,
  SBX_CLAUDE_BROKER_RUN_PROFILE,
  SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
  SBX_CLAUDE_RUNTIME_NETWORK_TARGETS,
  SBX_DISPOSABLE_RESOURCE_POLICY,
} from "../src/execution-environment/sbx-profile.ts";
import { WORKSPACE_TOOL_PROGRAM } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentLease,
  ProviderAccountEnvironmentSpec,
  RunEnvironmentSpec,
  StreamedProcess,
} from "../src/execution-environment/types.ts";
import { networkIsolatedWorkspaceToolCommand } from "../src/execution-environment/workspace-tool-network.ts";
import { ClaudeAccountCellRelay } from "../src/harnesses/claude-code/account-relay.ts";
import type { HarnessControlClient } from "../src/harnesses/control/client.ts";
import {
  type WorkspaceToolAccountAuthority,
  WorkspaceToolBroker,
  type WorkspaceToolRunAuthority,
} from "../src/workspace-tool-broker.ts";
import { WorkspaceToolBrokerStore } from "../src/workspace-tool-broker-store.ts";

const live = process.env.QE_LIVE_SBX === "1";
const workerId = "worker-claude-two-cell-live";
const accountId = "account-claude-two-cell-live";
const runId = "run-claude-two-cell-live";

test.skipIf(!live)(
  "physical managed Claude account cell relays only to a credential-free broker Run cell with zero provider requests",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "claude-two-cell-live-"));
    const accountBackend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: join(root, "account"),
      executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    const runBackend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: join(root, "run"),
      executionProfile: SBX_CLAUDE_BROKER_RUN_PROFILE,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let account: EnvironmentLease | null = null;
    let run: EnvironmentLease | null = null;
    let broker: WorkspaceToolBroker | null = null;
    let relay: ClaudeAccountCellRelay | null = null;
    try {
      [account, run] = await Promise.all([
        accountBackend.ensure(accountSpec()),
        runBackend.ensure(runSpec()),
      ]);
      expect(account.ref.environmentId).not.toBe(run.ref.environmentId);
      expect(account.ref.profile).toEqual(SBX_CLAUDE_ACCOUNT_PROFILE_V1);
      expect(run.ref.profile).toEqual(SBX_CLAUDE_BROKER_RUN_PROFILE_V1);

      const accountCanary = `QE_ACCOUNT_CREDENTIAL_CANARY_${crypto.randomUUID()}`;
      const runCanary = `QE_RUN_WORKSPACE_CANARY_${crypto.randomUUID()}`;
      await Promise.all([
        account.writeFile({
          path: `${account.paths.state}/credential-canary`,
          data: new TextEncoder().encode(accountCanary),
          mode: 0o600,
        }),
        run.writeFile({
          path: `${run.paths.workspace}/run-canary.txt`,
          data: new TextEncoder().encode(runCanary),
          mode: 0o600,
        }),
      ]);
      expect(
        await absent(account, `${account.paths.workspace}/run-canary.txt`),
      ).toBe(true);
      expect(await absent(run, `${run.paths.state}/credential-canary`)).toBe(
        true,
      );

      broker = physicalBroker(root, account, run);
      const prepared = await broker.prepare(preparation(account));
      const client = await broker.admitLocalAuthorization(
        prepared.binding.authorizationId,
      );
      expect(brokerStoreSession(broker, client.sessionId)).toBeNull();

      const mailbox = `${account.paths.control}/claude/${"a".repeat(32)}`;
      const token = "b".repeat(64);
      relay = new ClaudeAccountCellRelay(
        account,
        mailbox,
        token,
        client,
        {} as HarnessControlClient,
        () => undefined,
        (error) => {
          throw error;
        },
        10,
      );
      await relay.start();

      const read = await bridgeRequest(account, mailbox, token, {
        type: "workspace_read",
        path: "run-canary.txt",
      });
      expect(read.exit).toMatchObject({ kind: "exited", exitCode: 0 });
      expect(JSON.parse(read.stdout)).toMatchObject({ content: runCanary });

      const shell = await bridgeRequest(account, mailbox, token, {
        type: "run_shell",
        command:
          "printf 'uid='; id -u; printf 'net='; if python3 -c \"import socket; socket.create_connection(('example.com',443),.5)\" 2>/dev/null; then echo open; else echo isolated; fi; env | sort",
        timeoutMs: 5_000,
      });
      expect(shell.exit).toMatchObject({ kind: "exited", exitCode: 0 });
      const shellResult = JSON.parse(shell.stdout) as { stdout: string };
      expect(shellResult.stdout).toContain("uid=1000");
      expect(shellResult.stdout).toContain("net=isolated");
      expect(shellResult.stdout).not.toContain(accountCanary);
      expect(shellResult.stdout).not.toContain("ANTHROPIC_API_KEY");
      expect(shellResult.stdout).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");

      const traversal = await bridgeRequest(account, mailbox, token, {
        type: "workspace_write",
        path: "../escaped",
        content: "must-not-write",
      });
      expect(traversal.exit.kind).not.toBe("exited");
      expect(await absent(run, `${run.paths.state}/escaped`)).toBe(true);

      const policies = await accountBackend.readiness();
      expect(policies.ready).toBe(true);
      // No command in this proof addresses api.anthropic.com or claude.ai from
      // the account cell. The only network probe runs in the deny-all Run cell.
    } finally {
      await relay?.stop().catch(() => undefined);
      await broker?.close().catch(() => undefined);
      if (run) await runBackend.remove(run.ref).catch(() => undefined);
      if (account)
        await accountBackend.remove(account.ref).catch(() => undefined);
      await Promise.all([accountBackend.close(), runBackend.close()]);
      await rm(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

function physicalBroker(
  root: string,
  account: EnvironmentLease,
  run: EnvironmentLease,
): WorkspaceToolBroker {
  const accountAuthority: WorkspaceToolAccountAuthority = {
    ref: structuredClone(account.ref),
    assertCurrent: () => undefined,
    spawnClient: async () => {
      throw new Error(
        "The Claude Worker relay must not spawn an account broker client.",
      );
    },
  };
  const runAuthority: WorkspaceToolRunAuthority = {
    ref: structuredClone(run.ref),
    physicalLineageId: "claude-two-cell-physical-lineage",
    workspaceId: "workspace-claude-two-cell-live",
    worktreeId: "worktree-claude-two-cell-live",
    workspaceBindingId: "binding-claude-two-cell-live",
    workspaceAccess: "read_write",
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    assertCurrent: () => undefined,
    spawn: async (request) => {
      if (request.operation === "terminal.shell") {
        const process = await run.spawnStreamed(
          networkIsolatedWorkspaceToolCommand({
            executable: "/bin/sh",
            args: [],
            cwd: run.paths.workspace,
            environment: { HOME: run.paths.home, PATH: "/usr/bin:/bin" },
          }),
          { bufferBytes: 128 * 1024, acknowledgementTimeoutMs: 5_000 },
        );
        return {
          process,
          input: new TextEncoder().encode(`${request.arguments.command}\n`),
        };
      }
      const process = await run.spawnStreamed(
        networkIsolatedWorkspaceToolCommand({
          executable: "/usr/bin/python3",
          args: ["-u", "-c", WORKSPACE_TOOL_PROGRAM],
          cwd: run.paths.workspace,
          environment: { HOME: run.paths.home, PATH: "/usr/bin:/bin" },
        }),
        { bufferBytes: 384 * 1024, acknowledgementTimeoutMs: 5_000 },
      );
      return {
        process,
        input: new TextEncoder().encode(`${JSON.stringify(request)}\n`),
      };
    },
  };
  return new WorkspaceToolBroker(
    new WorkspaceToolBrokerStore(root),
    {
      account: async () => accountAuthority,
      run: async () => runAuthority,
    },
    async () => undefined,
  );
}

function preparation(account: EnvironmentLease) {
  return {
    authorizationId: "authorization-claude-two-cell-live",
    providerAccountId: accountId,
    credentialGeneration: 1,
    accountEnvironmentGeneration: 1,
    accountEnvironment: {
      backendKind: account.ref.backendKind,
      environmentId: account.ref.environmentId,
      incarnation: account.ref.incarnation,
    },
    runId,
    actionId: "action-claude-two-cell-live",
    occurrenceId: "occurrence-claude-two-cell-live",
    attemptId: "attempt-claude-two-cell-live",
    operationalEpoch: 0,
    operationalAttempt: 1,
    workspaceId: "workspace-claude-two-cell-live",
    worktreeId: "worktree-claude-two-cell-live",
    workspaceBindingId: "binding-claude-two-cell-live",
    workspaceAccess: "read_write" as const,
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    workerId,
    workerGeneration: 1,
  };
}

function accountSpec(): ProviderAccountEnvironmentSpec {
  return {
    workerId,
    owner: {
      kind: "provider_account",
      providerAccountId: accountId,
      credentialGeneration: 1,
    },
    layout: { kind: "provider_account", version: "provider-account-cell-v1" },
    profile: SBX_CLAUDE_ACCOUNT_PROFILE_V1,
    resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
    networkRequirements: [
      {
        capability: "anthropic_account",
        targets: [...SBX_CLAUDE_RUNTIME_NETWORK_TARGETS],
      },
    ],
    credentialGrants: [
      {
        grantId: `provider-account:${accountId}:1`,
        kind: "claude-oauth",
        scope: "provider_account",
      },
    ],
    controlChannels: [{ kind: "worker_account_mailbox_v1", required: true }],
    requiredCapabilities: [
      { kind: "environment_persistence", mode: "verified" },
      { kind: "credentials", mode: "account_private_claude_oauth" },
      { kind: "network_policy", mode: "anthropic_account_only" },
      { kind: "harness_runtime", mode: "claude_code_managed_mod_v1" },
      { kind: "control_channel", mode: "worker_account_mailbox_v1" },
      { kind: "process.streamed", mode: "attached_only" },
    ],
  };
}

function runSpec(): RunEnvironmentSpec {
  return {
    workerId,
    owner: { kind: "run", runId },
    layout: { kind: "run" },
    profile: SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
    resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [
      { kind: "environment_persistence", mode: "verified" },
      { kind: "credentials", mode: "none" },
      { kind: "network_policy", mode: "deny_all" },
      { kind: "process.streamed", mode: "attached_only" },
    ],
    workspace: {
      workspaceId: "workspace-claude-two-cell-live",
      access: "read_write",
      materialization: {
        kind: "disposable_fixture",
        sourceIdentity: "fixture:claude-two-cell-live",
        frozenBase: { kind: "fixture", value: "claude-two-cell-live" },
      },
    },
  };
}

async function bridgeRequest(
  account: EnvironmentLease,
  mailbox: string,
  token: string,
  operation: Record<string, unknown>,
): Promise<{
  stdout: string;
  stderr: string;
  exit: Awaited<StreamedProcess["exit"]>;
}> {
  const process = await account.spawnStreamed(
    {
      executable: SBX_CLAUDE_ACCOUNT_BRIDGE,
      args: ["bound-operation"],
      cwd: account.paths.state,
      environment: {
        HOME: account.paths.home,
        QE_ACCOUNT_CELL_MAILBOX: mailbox,
        QE_ACCOUNT_CELL_BRIDGE_TOKEN: token,
      },
    },
    { bufferBytes: 128 * 1024, acknowledgementTimeoutMs: 5_000 },
  );
  const stdout = collect(process.stdout);
  const stderr = collect(process.stderr);
  await process.write(
    new TextEncoder().encode(`${JSON.stringify(operation)}\n`),
  );
  await process.closeStdin();
  return {
    stdout: await stdout,
    stderr: await stderr,
    exit: await process.exit,
  };
}

async function collect(
  stream: AsyncIterable<{ kind: string; data?: Uint8Array }>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const event of stream) {
    if (event.kind === "data" && event.data) chunks.push(event.data);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function absent(lease: EnvironmentLease, path: string): Promise<boolean> {
  return (
    (
      await lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import os,sys;sys.exit(1 if os.path.exists(sys.argv[1]) else 0)",
          path,
        ],
        timeoutMs: 30_000,
      })
    ).exitCode === 0
  );
}

function brokerStoreSession(
  broker: WorkspaceToolBroker,
  sessionId: string,
): unknown {
  return (
    broker as unknown as { store: WorkspaceToolBrokerStore }
  ).store.session(sessionId)?.process;
}
