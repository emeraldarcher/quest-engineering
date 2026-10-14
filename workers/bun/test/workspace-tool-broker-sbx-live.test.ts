import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_TOOL_BROKER_ACCOUNT_CANARY } from "../src/execution-environment/provider-account.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_SHELL_PROFILE,
} from "../src/execution-environment/sbx-profile.ts";
import { WORKSPACE_TOOL_PROGRAM } from "../src/execution-environment/sbx-run.ts";
import type {
  EnvironmentLease,
  ProviderAccountEnvironmentSpec,
} from "../src/execution-environment/types.ts";
import { networkIsolatedWorkspaceToolCommand } from "../src/execution-environment/workspace-tool-network.ts";
import type {
  WorkspaceToolAccountAuthority,
  WorkspaceToolRunAuthority,
} from "../src/workspace-tool-broker.ts";
import { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import type { WorkspaceToolRequest } from "../src/workspace-tool-broker-protocol.ts";
import { WorkspaceToolBrokerStore } from "../src/workspace-tool-broker-store.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_SBX === "1";
const workerId = "worker-workspace-tool-broker-live";
const accountId = "account-workspace-tool-broker-live";
const runId = "run-workspace-tool-broker-live";
const accountCanary = `${WORKSPACE_TOOL_BROKER_ACCOUNT_CANARY}:${randomUUID()}`;
const runCanary = "QE_RUN_CELL_VISIBLE_CANARY";

const ACCOUNT_CLIENT_PROGRAM = [
  "import json,sys",
  "while True:",
  " line=sys.stdin.readline()",
  " if not line: break",
  " value=json.loads(line)",
  " if value.get('type')=='drive' and set(value)=={'type','request'}:",
  "  request=value['request'];print(json.dumps(request,separators=(',',':')),flush=True)",
  " elif value.get('type')=='result' and set(value)=={'type','response'}:",
  "  response=value['response'];print(json.dumps({'type':'client_received','request_id':response.get('request_id')},separators=(',',':')),flush=True)",
  " else: sys.exit(42)",
].join("\n");

test.skipIf(!live)(
  "physical two-SBX broker proves exact routing, isolation, restart, and cleanup",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "workspace-tool-broker-sbx-live-"));
    const createBackend = () =>
      new SbxExecutionEnvironmentBackend({
        workerId,
        dataRoot: root,
        reconciliationPollMs: 500,
        reconciliationAttempts: 120,
      });
    let backend = createBackend();
    let accountLease: EnvironmentLease | null = null;
    let runLease: EnvironmentLease | null = null;
    let broker: WorkspaceToolBroker | null = null;
    const activities: Array<Record<string, unknown>> = [];
    try {
      expect(await backend.readiness()).toMatchObject({ ready: true });
      [accountLease, runLease] = await Promise.all([
        backend.ensure(accountSpec()),
        backend.ensure(sbxSpec(runId, workerId)),
      ]);
      expect(accountLease.ref.environmentId).not.toBe(
        runLease.ref.environmentId,
      );
      expect(accountLease.ref.incarnation).not.toBe(runLease.ref.incarnation);

      await Promise.all([
        accountLease.writeFile({
          path: `${accountLease.paths.state}/account-canary`,
          data: new TextEncoder().encode(accountCanary),
          mode: 0o600,
        }),
        runLease.writeFile({
          path: `${runLease.paths.workspace}/run-canary.txt`,
          data: new TextEncoder().encode(runCanary),
          mode: 0o600,
        }),
      ]);

      expect(
        await cellCannotSeePath(
          accountLease,
          `${runLease.paths.workspace}/run-canary.txt`,
        ),
      ).toBe(true);
      expect(
        await cellCannotSeePath(
          runLease,
          `${accountLease.paths.state}/account-canary`,
        ),
      ).toBe(true);
      await proveDirectionalNetworkIsolation(accountLease, runLease);

      const store = new WorkspaceToolBrokerStore(root);
      broker = createBroker(store, accountLease, runLease, activities);
      const prepared = await broker.prepare(
        preparation("authorization-live-1", accountLease),
      );
      const client = await broker.admitAuthorization(
        prepared.binding.authorizationId,
      );

      expect(
        await client.request(
          request("filesystem.write", "write", {
            path: "broker.txt",
            content: "alpha beta\nalpha\n",
          }),
        ),
      ).toMatchObject({ status: "completed", result: { bytes: 17 } });
      expect(
        await cellCannotSeePath(
          accountLease,
          `${accountLease.paths.workspace}/broker.txt`,
        ),
      ).toBe(true);
      expect(
        await client.request(
          request("filesystem.read", "read", { path: "broker.txt" }),
        ),
      ).toMatchObject({
        status: "completed",
        result: { content: "alpha beta\nalpha\n" },
      });
      expect(
        await client.request(request("filesystem.list", "list", { path: "." })),
      ).toMatchObject({ status: "completed" });
      expect(
        await client.request(
          request("filesystem.stat", "stat", { path: "broker.txt" }),
        ),
      ).toMatchObject({ status: "completed", result: { type: "file" } });
      expect(
        await client.request(
          request("filesystem.edit", "edit", {
            path: "broker.txt",
            old_text: "alpha",
            new_text: "gamma",
            expected_replacements: 2,
          }),
        ),
      ).toMatchObject({
        status: "completed",
        result: { replacements: 2 },
      });
      expect(
        await client.request(
          request("search.grep", "grep", { path: ".", query: "gamma" }),
        ),
      ).toMatchObject({ status: "completed", result: { truncated: false } });
      const shell = await client.request(
        request("terminal.shell", "shell", {
          command:
            "printf 'cwd='; pwd; printf 'home=%s\\n' \"$HOME\"; printf 'uid='; id -u; if sudo -n true 2>/dev/null; then echo elevated; else echo unprivileged; fi; env | sort; cat run-canary.txt",
          cwd: ".",
          timeout_ms: 5_000,
        }),
      );
      expect(shell).toMatchObject({ status: "completed" });
      expect(String(shell.result?.stdout)).toContain(
        `cwd=${runLease.paths.workspace}`,
      );
      expect(String(shell.result?.stdout)).toContain(
        `home=${runLease.paths.home}`,
      );
      expect(String(shell.result?.stdout)).toContain("uid=1000");
      expect(String(shell.result?.stdout)).toContain("unprivileged");
      expect(String(shell.result?.stdout)).not.toContain("SUDO_");
      expect(String(shell.result?.stdout)).not.toContain(
        "QE_FAKE_BROKER_CLIENT",
      );
      expect(String(shell.result?.stdout)).toContain(runCanary);
      expect(String(shell.result?.stdout)).not.toContain(accountCanary);
      expect(
        await client.request(
          request("filesystem.read", "run-canary", {
            path: "run-canary.txt",
          }),
        ),
      ).toMatchObject({ status: "completed", result: { content: runCanary } });
      expect(
        await client.request(
          request("search.grep", "run-canary-search", {
            path: ".",
            query: runCanary,
          }),
        ),
      ).toMatchObject({
        status: "completed",
        result: { matches: [{ path: "run-canary.txt" }] },
      });
      expect(
        await client.request(
          request("search.grep", "account-canary-search", {
            path: ".",
            query: accountCanary,
          }),
        ),
      ).toMatchObject({ status: "completed", result: { matches: [] } });

      const brokerResultText = JSON.stringify(activities);
      expect(brokerResultText).not.toContain(accountCanary);
      expect(brokerResultText).not.toContain(runCanary);
      expect(brokerResultText).not.toContain("broker.txt");

      const accountRef = structuredClone(accountLease.ref);
      const runRef = structuredClone(runLease.ref);
      await broker.close();
      broker = null;
      await backend.close();
      backend = createBackend();
      [accountLease, runLease] = await Promise.all([
        backend.recover(accountRef, accountSpec()),
        backend.recover(runRef, sbxSpec(runId, workerId)),
      ]);
      broker = createBroker(
        new WorkspaceToolBrokerStore(root),
        accountLease,
        runLease,
        activities,
      );
      const recovered = await broker.prepare(
        preparation("authorization-live-after-restart", accountLease),
      );
      const recoveredClient = await broker.admitAuthorization(
        recovered.binding.authorizationId,
      );
      expect(
        await recoveredClient.request(
          request("filesystem.read", "after-restart", {
            path: "broker.txt",
          }),
        ),
      ).toMatchObject({
        status: "completed",
        result: { content: "gamma beta\ngamma\n" },
      });

      await broker.close();
      broker = null;
      await backend.remove(runLease.ref);
      runLease = null;
      expect(await backend.inspect(accountLease.ref)).toMatchObject({
        state: "running",
        usable: true,
      });
      expect(
        new TextDecoder().decode(
          await accountLease.readFile({
            path: `${accountLease.paths.state}/account-canary`,
            maxBytes: 1_024,
          }),
        ),
      ).toBe(accountCanary);
      await backend.remove(accountLease.ref);
      accountLease = null;
    } finally {
      await broker?.close().catch(() => undefined);
      if (accountLease)
        await backend.remove(accountLease.ref).catch(() => undefined);
      if (runLease) await backend.remove(runLease.ref).catch(() => undefined);
      await backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

function createBroker(
  store: WorkspaceToolBrokerStore,
  accountLease: EnvironmentLease,
  runLease: EnvironmentLease,
  activities: Array<Record<string, unknown>>,
): WorkspaceToolBroker {
  const account: WorkspaceToolAccountAuthority = {
    ref: structuredClone(accountLease.ref),
    assertCurrent: () => undefined,
    spawnClient: () =>
      accountLease.spawnStreamed(
        networkIsolatedWorkspaceToolCommand({
          executable: "/usr/bin/python3",
          args: ["-u", "-c", ACCOUNT_CLIENT_PROGRAM],
          cwd: accountLease.paths.state,
          environment: {
            HOME: accountLease.paths.home,
            QE_WORKSPACE_TOOL_BROKER_CHANNEL: "stdio-jsonl-v1",
          },
        }),
        { bufferBytes: 384 * 1024, acknowledgementTimeoutMs: 5_000 },
      ),
  };
  const run: WorkspaceToolRunAuthority = {
    ref: structuredClone(runLease.ref),
    physicalLineageId: "physical-lineage-live",
    workspaceId: `workspace-${runId}`,
    worktreeId: "worktree-live",
    workspaceBindingId: "binding-live",
    workspaceAccess: "read_write",
    resolvedToolProfile: {
      tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    },
    assertCurrent: () => undefined,
    spawn: async (toolRequest) => {
      if (toolRequest.operation === "terminal.shell") {
        const process = await runLease.spawnStreamed(
          networkIsolatedWorkspaceToolCommand({
            executable: "/bin/sh",
            args: [],
            cwd: runLease.paths.workspace,
            environment: { HOME: runLease.paths.home, PATH: "/usr/bin:/bin" },
          }),
          { bufferBytes: 128 * 1024, acknowledgementTimeoutMs: 5_000 },
        );
        return {
          process,
          input: new TextEncoder().encode(`${toolRequest.arguments.command}\n`),
        };
      }
      const process = await runLease.spawnStreamed(
        networkIsolatedWorkspaceToolCommand({
          executable: "/usr/bin/python3",
          args: ["-u", "-c", WORKSPACE_TOOL_PROGRAM],
          cwd: runLease.paths.workspace,
          environment: { HOME: runLease.paths.home, PATH: "/usr/bin:/bin" },
        }),
        { bufferBytes: 384 * 1024, acknowledgementTimeoutMs: 5_000 },
      );
      return {
        process,
        input: new TextEncoder().encode(`${JSON.stringify(toolRequest)}\n`),
      };
    },
  };
  return new WorkspaceToolBroker(
    store,
    { account: async () => account, run: async () => run },
    async (activity) => {
      activities.push(activity as unknown as Record<string, unknown>);
    },
  );
}

function preparation(authorizationId: string, accountLease: EnvironmentLease) {
  return {
    authorizationId,
    providerAccountId: accountId,
    credentialGeneration: 1,
    accountEnvironmentGeneration: 1,
    accountEnvironment: {
      backendKind: accountLease.ref.backendKind,
      environmentId: accountLease.ref.environmentId,
      incarnation: accountLease.ref.incarnation,
    },
    runId,
    actionId: "action-live",
    occurrenceId: "occurrence-live",
    attemptId: "attempt-live",
    operationalEpoch: 0,
    operationalAttempt: 1,
    workspaceId: `workspace-${runId}`,
    worktreeId: "worktree-live",
    workspaceBindingId: "binding-live",
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
    profile: SBX_SHELL_PROFILE.identity,
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
  };
}

async function cellCannotSeePath(
  lease: EnvironmentLease,
  path: string,
): Promise<boolean> {
  const result = await lease.exec({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import os,sys;sys.exit(1 if os.path.exists(sys.argv[1]) else 0)",
      path,
    ],
    timeoutMs: 30_000,
  });
  return result.exitCode === 0;
}

async function proveDirectionalNetworkIsolation(
  accountLease: EnvironmentLease,
  runLease: EnvironmentLease,
): Promise<void> {
  const accountPort = 39_871;
  const runPort = 39_872;
  await Promise.all([
    startCellListener(accountLease, accountPort),
    startCellListener(runLease, runPort),
  ]);
  const [accountAddress, runAddress] = await Promise.all([
    cellAddress(accountLease),
    cellAddress(runLease),
  ]);
  expect(await cellCanConnect(accountLease, "::1", accountPort)).toBe(true);
  expect(await cellCanConnect(runLease, "::1", runPort)).toBe(true);
  expect(await cellCannotConnect(accountLease, runAddress, runPort)).toBe(true);
  expect(await cellCannotConnect(runLease, accountAddress, accountPort)).toBe(
    true,
  );
}

async function startCellListener(
  lease: EnvironmentLease,
  port: number,
): Promise<void> {
  const result = await lease.exec({
    executable: "/bin/sh",
    args: [
      "-lc",
      `nohup /usr/bin/python3 -c 'import socket,time;s=socket.socket(socket.AF_INET6);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("::",${port}));s.listen();time.sleep(60)' </dev/null >/dev/null 2>&1 &`,
    ],
    timeoutMs: 30_000,
  });
  expect(result.exitCode).toBe(0);
  await Bun.sleep(250);
}

async function cellAddress(lease: EnvironmentLease): Promise<string> {
  const result = await lease.exec({
    executable: "/bin/sh",
    args: ["-lc", "hostname -i | awk '{print $1}'"],
    timeoutMs: 30_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).not.toBe("");
  return result.stdout.trim();
}

async function cellCanConnect(
  lease: EnvironmentLease,
  address: string,
  port: number,
): Promise<boolean> {
  return (await connectionProbe(lease, address, port, false)) === 0;
}

async function cellCannotConnect(
  lease: EnvironmentLease,
  address: string,
  port: number,
): Promise<boolean> {
  return (await connectionProbe(lease, address, port, true)) !== 0;
}

async function connectionProbe(
  lease: EnvironmentLease,
  address: string,
  port: number,
  isolated: boolean,
): Promise<number> {
  const script =
    "import socket,sys;s=socket.socket(socket.AF_INET6 if ':' in sys.argv[1] else socket.AF_INET);s.settimeout(.5);r=s.connect_ex((sys.argv[1],int(sys.argv[2])));sys.exit(0 if not r else 1)";
  const executable = isolated ? "/usr/bin/sudo" : "/usr/bin/python3";
  const args = isolated
    ? [
        "-n",
        "/usr/bin/unshare",
        "--net",
        "--",
        "/usr/bin/python3",
        "-c",
        script,
        address,
        String(port),
      ]
    : ["-c", script, address, String(port)];
  const result = await lease.exec({ executable, args, timeoutMs: 30_000 });
  return result.exitCode;
}

function request(
  operation: WorkspaceToolRequest["operation"],
  requestId: string,
  args: Record<string, unknown>,
): WorkspaceToolRequest {
  return {
    version: "workspace_tool_broker_v1",
    type: "request",
    request_id: requestId,
    operation,
    arguments: args,
  } as WorkspaceToolRequest;
}
