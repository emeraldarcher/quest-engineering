import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { ProviderAccountEnvironmentManager } from "../src/execution-environment/provider-account.ts";
import { ClaudeSubscriptionSetupLauncher } from "../src/execution-environment/provider-account-setup-launcher.ts";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  CliSbxClient,
  type SbxExecOptions,
} from "../src/execution-environment/sbx-client.ts";
import {
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_CLAUDE_BROKER_RUN_PROFILE,
  SBX_CLAUDE_EXECUTABLE,
} from "../src/execution-environment/sbx-profile.ts";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";
import type {
  EnvironmentCommand,
  EnvironmentRef,
} from "../src/execution-environment/types.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";
import { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import { WorkspaceToolBrokerStore } from "../src/workspace-tool-broker-store.ts";
import { action } from "./support.ts";

const live = process.env.QE_LIVE_SBX === "1";

test.skipIf(!live)(
  "physical generation-1 account cell survives synthetic auth rollover and Worker reconstruction for real Run preparation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "qe-account-runtime-live-"));
    const workerId = `runtime-proof-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const workspaceId = randomUUID(),
      bindingId = randomUUID(),
      worktreeId = randomUUID();
    const source = join(root, "source");
    await mkdir(source);
    await git(["init", "-q", source]);
    await writeFile(
      join(source, "README.md"),
      "# Provider-free runtime fixture\n",
    );
    await git(["-C", source, "add", "README.md"]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=QE",
      "-c",
      "user.email=qe@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const config = loadConfig({
      QE_HOME: join(root, "qe"),
      QE_WORKER_ID: workerId,
      QE_WORKER_TOKEN: "fixture-only",
      QE_CONTROL_PLANE_URL: "ws://127.0.0.1/unused",
      QE_WORKER_HARNESSES: "claude_code",
      QE_EXECUTOR_MODELS: "anthropic/claude-opus-4-6",
      QE_REASONING_LEVELS: "high",
      QE_ALLOWED_ROOTS_JSON: JSON.stringify([
        {
          key: "fixture",
          path: source,
          max_access: "read_write",
          discover_depth: 0,
          allow_unconfined_shell: false,
        },
      ]),
      QE_WORKSPACE_BINDINGS_JSON: JSON.stringify([
        {
          binding_id: bindingId,
          workspace_id: workspaceId,
          authorized_root_key: "fixture",
          source_repository_root: source,
          max_access: "read_write",
          allow_unconfined_shell: false,
        },
      ]),
    });
    // Real immutable production cells and verifiers; no CLI auth command, dynamic
    // secret, provider call, native model process, or query is permitted.
    class ProviderFreeClient extends CliSbxClient {
      forbiddenCommands = 0;
      override async exec(
        name: string,
        command: EnvironmentCommand,
        options: SbxExecOptions = {},
      ) {
        if (command.executable === SBX_CLAUDE_EXECUTABLE) {
          this.forbiddenCommands++;
          throw new Error(
            "No native authentication or inference in this proof",
          );
        }
        return super.exec(name, command, options);
      }
      override async setDynamicSecret(): Promise<void> {
        throw new Error("No credential operations");
      }
    }
    const client = new ProviderFreeClient();
    let store = new ExecutionEnvironmentStore(config.dataRoot);
    let accountBackend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: config.dataRoot,
      store,
      client,
      executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
    });
    const runBackend = new SbxExecutionEnvironmentBackend({
      workerId,
      dataRoot: config.dataRoot,
      client,
      executionProfile: SBX_CLAUDE_BROKER_RUN_PROFILE,
    });
    let semanticCredentialGeneration = 1;
    const manager = () =>
      new ProviderAccountEnvironmentManager(config, {
        backend: accountBackend,
        store,
        fake: false,
        setupLauncher: new ClaudeSubscriptionSetupLauncher(),
        // Synthetic authentication evidence only. No credential is ever created.
        fakeAuthentication: () =>
          semanticCredentialGeneration === 2
            ? { state: "authenticated", method: "provider_account" }
            : { state: "authentication_required", method: "none" },
      });
    let accounts = manager();
    const worktrees = new RunWorktreeRegistry(config);
    const runs = new SbxRunExecutionManager(config, worktrees, {
      backend: runBackend,
    });
    const dispatches = new DispatchRegistry(
      join(config.dataRoot, "dispatches.sqlite"),
      config.dataRoot,
      "claude_code",
    );
    let broker: WorkspaceToolBroker | null = null;
    let proofPassed = false;
    let accountRef: EnvironmentRef | null = null,
      runRef: EnvironmentRef | null = null;
    const desired = {
      providerAccountId: accountId,
      providerKey: "anthropic",
      credentialGeneration: 1,
      workerGeneration: 1,
      operationId: randomUUID(),
      desiredState: "available" as const,
      expectedPhysicalIdentity: null as {
        backendKind: string;
        environmentId: string;
        incarnation: string;
      } | null,
    };
    try {
      const initial = await accounts.apply(desired);
      if (initial.physicalState !== "available")
        console.log(
          JSON.stringify({
            fixtureRoot: root,
            initial,
            diagnostics: store.list().map((record) => record.diagnostics),
          }),
        );
      expect(initial.physicalState).toBe("available");
      expect(initial.authentication).toMatchObject({
        state: "authentication_required",
        method: "none",
      });
      accountRef = await accountBackend.currentEnvironment({
        kind: "provider_account",
        providerAccountId: accountId,
        credentialGeneration: 1,
      });
      if (!accountRef) throw new Error("Physical account cell missing");
      desired.expectedPhysicalIdentity = {
        backendKind: accountRef.backendKind,
        environmentId: accountRef.environmentId,
        incarnation: accountRef.incarnation,
      };
      semanticCredentialGeneration = 2;
      const rolled = await accounts.apply({
        ...desired,
        operationId: randomUUID(),
      });
      expect(rolled.authentication).toMatchObject({
        state: "authenticated",
        method: "provider_account",
      });
      expect(rolled.environmentId).toBe(accountRef.environmentId);
      await accounts.close();
      store = new ExecutionEnvironmentStore(config.dataRoot);
      accountBackend = new SbxExecutionEnvironmentBackend({
        workerId,
        dataRoot: config.dataRoot,
        store,
        client,
        executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
      });
      accounts = manager();
      const recovered = await accounts.apply({
        ...desired,
        workerGeneration: 2,
        operationId: randomUUID(),
      });
      expect(recovered.authentication).toMatchObject({
        state: "authenticated",
        method: "provider_account",
      });
      expect(recovered.environmentId).toBe(accountRef.environmentId);
      expect(recovered.incarnation).toBe(accountRef.incarnation);

      const materialized = await worktrees.provision({
        worktree_id: worktreeId,
        run_id: runId,
        workspace_id: workspaceId,
        workspace_binding_id: bindingId,
        base: { kind: "binding_head_v1" },
        branch_name: `qe/run/${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`,
        identity_hash: createHash("sha256").update(runId).digest("hex"),
      });
      expect(materialized.state).toBe("ready");
      const base = action({
        action_id: `action-${randomUUID()}`,
        run_id: runId,
        worker_id: workerId,
      });
      const tools = [
        "workspace.filesystem",
        "workspace.search",
        "terminal.shell",
      ];
      const request = action({
        ...base,
        execution: {
          ...base.execution,
          configuration: {
            ...base.execution.configuration,
            harness_kind: "claude_code",
            model: { provider: "anthropic", model: "claude-opus-4-6" },
            reasoning: "high",
            reasoning_capability: { kind: "enumerated", values: ["high"] },
            tool_policy: { kind: "exact", tools },
            resolved_tool_profile: { tools },
          },
          logical_workspace: {
            workspace_id: workspaceId,
            workspace_key: "fixture",
          },
          execution_workspace: {
            worktree_id: worktreeId,
            workspace_binding_id: bindingId,
            canonical_root: materialized.canonicalRoot,
            access: "read_write",
          },
        },
      });
      const dispatch = dispatches.accept(request).dispatch;
      if (!dispatch.lineageId)
        throw new Error("Fresh Run has no PhysicalLineage");
      const lineage = dispatches.getLineage(dispatch.lineageId);
      const prepared = await runs.prepare(dispatch, lineage, {});
      runRef = prepared.lease.ref;
      broker = new WorkspaceToolBroker(
        new WorkspaceToolBrokerStore(config.dataRoot),
        {
          account: async (input) => {
            const physical = await accounts.workspaceToolBrokerAuthority({
              providerAccountId: input.providerAccountId,
              environmentOwnerGeneration: input.accountEnvironmentGeneration,
              expected: input.accountEnvironment,
            });
            const physicalAssert = physical.assertCurrent;
            physical.assertCurrent = () => {
              if (input.credentialGeneration !== semanticCredentialGeneration)
                throw new Error("Stale synthetic credential authority");
              physicalAssert();
            };
            return physical;
          },
          run: async (input) => runs.workspaceToolBrokerAuthority(input),
        },
        async () => undefined,
      );
      const admitted = await broker.prepare({
        authorizationId: `proof-${randomUUID()}`,
        providerAccountId: accountId,
        credentialGeneration: 2,
        accountEnvironmentGeneration: 1,
        accountEnvironment: desired.expectedPhysicalIdentity,
        runId,
        actionId: request.action_id,
        occurrenceId: request.occurrence_id,
        attemptId: request.attempt_id,
        operationalEpoch: 0,
        operationalAttempt: 1,
        workspaceId,
        worktreeId,
        workspaceBindingId: bindingId,
        workspaceAccess: "read_write",
        resolvedToolProfile: { tools },
        workerId,
        workerGeneration: 2,
      });
      await broker.admitLocalAuthorization(admitted.binding.authorizationId);
      const bound = broker.boundClientForAction(request.action_id);
      const runtime = await accounts.claudeCodeRuntime({
        providerAccountId: accountId,
        credentialGeneration: 2,
        authority: bound.accountAuthority,
      });
      expect(runtime.ref).toEqual(accountRef);
      expect(runtime.ref.owner).toMatchObject({ credentialGeneration: 1 });
      runtime.assertCurrent();
      await expect(
        accounts.claudeCodeRuntime({
          providerAccountId: accountId,
          credentialGeneration: 1,
          authority: bound.accountAuthority,
        }),
      ).rejects.toMatchObject({ code: "stale_environment_ref" });
      expect(client.forbiddenCommands).toBe(0);
      expect(dispatches.get(request.action_id).promptIntentAt).toBeNull();
      expect(dispatches.getLineage(lineage.lineageId).nativeSession).toBeNull();
      proofPassed = true;
      console.log(
        JSON.stringify({
          proof: "account-runtime-generation-rollover",
          result: "PASS",
          semanticCredentialGeneration,
          physicalEnvironmentOwnerGeneration: 1,
          accountEnvironment: runtime.ref,
          runEnvironment: runRef,
          physicalLineage: lineage.lineageId,
          nextBoundary:
            "local canonical auth inspection, before native Claude execution; intentionally not entered",
          syntheticAuthenticationOnly: true,
          loginActivity: 0,
          providerTraffic: 0,
          credentialOperations: 0,
          modelInference: 0,
          retainedAcceptanceMutations: 0,
        }),
      );
    } finally {
      await broker?.close();
      if (proofPassed) {
        if (runRef) await runBackend.remove(runRef);
        if (accountRef) await accountBackend.remove(accountRef);
      } else {
        console.log(
          JSON.stringify({
            retainedFailedFixture: root,
            workerId,
            accountId,
            accountRef,
            runRef,
          }),
        );
      }
      await runs.close();
      await accounts.close();
      dispatches.close();
      worktrees.close();
      if (proofPassed) await rm(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(error);
}
