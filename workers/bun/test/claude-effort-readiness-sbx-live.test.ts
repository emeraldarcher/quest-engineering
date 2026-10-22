import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { ProviderAccountEnvironmentManager } from "../src/execution-environment/provider-account.ts";
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
  StreamedProcess,
} from "../src/execution-environment/types.ts";
import {
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_PLUGIN_PATH,
  CLAUDE_CODE_TOOLS,
  ClaudeCodeHarness,
} from "../src/harnesses/claude-code/adapter.ts";
import { ClaudeCodeSessionStore } from "../src/harnesses/claude-code/session-store.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";
import { WorkspaceToolBroker } from "../src/workspace-tool-broker.ts";
import { WorkspaceToolBrokerStore } from "../src/workspace-tool-broker-store.ts";
import { action } from "./support.ts";

const python = [
  "import sys,json,os",
  "base=json.loads(os.environ['QE_FIXTURE_INIT']); applied=json.loads(os.environ['QE_FIXTURE_APPLIED'])",
  "for line in sys.stdin:",
  " value=json.loads(line)",
  " if value['type']=='user':",
  "  assert value['shouldQuery'] is False and value['isSynthetic'] is True and value['client_composed'] is True",
  "  assert len(line.encode())==301 and value['message']=={'role':'user','content':'Quest Engineering fixed zero-inference initialization probe.'}",
  "  base['session_id']=value['session_id']; print(json.dumps(base),flush=True)",
  "  print(json.dumps({'type':'result','subtype':'success','is_error':False,'num_turns':0,'modelUsage':{},'session_id':value['session_id']}),flush=True)",
  " else:",
  "  assert value['type']=='control_request' and value['request']=={'subtype':'get_settings'}",
  "  print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':value['request_id'],'response':{'applied':applied,'env':{'SECRET':'FIXTURE_CONFIG_CANARY'}}}}),flush=True)",
].join("\n");

// Actual immutable account/Run cells, ownership, private Git, runtime lookup,
// broker, harness preparation, parser and readiness. Only auth-status and the
// native executable are deterministic fixture boundaries; Claude never runs.
test.skipIf(process.env.QE_LIVE_SBX !== "1")(
  "physical managed effort readiness: omitted init effort, independent native-state fixture, no model turn",
  async () => {
    const parent = process.env.QE_EFFORT_PROOF_ROOT ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const output = await mkdtemp(join(parent, "effort-proof-"));
    const root = join(output, "fixture");
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await git(["init", "-q", source]);
    await writeFile(
      join(source, "README.md"),
      "# Deterministic provider-free effort fixture\n",
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
    const workerId = `effort-proof-${randomUUID()}`,
      accountId = randomUUID(),
      runId = randomUUID();
    const workspaceId = randomUUID(),
      bindingId = randomUUID(),
      worktreeId = randomUUID();
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
    class GuardedClient extends CliSbxClient {
      forbiddenNative = 0;
      credentialOperations = 0;
      override async exec(
        name: string,
        command: EnvironmentCommand,
        options: SbxExecOptions = {},
      ) {
        if (command.executable === SBX_CLAUDE_EXECUTABLE) {
          this.forbiddenNative++;
          throw new Error("Native Claude forbidden in effort fixture");
        }
        return super.exec(name, command, options);
      }
      override async setDynamicSecret(): Promise<void> {
        this.credentialOperations++;
        throw new Error("No credentials in effort fixture");
      }
    }
    const client = new GuardedClient();
    const store = new ExecutionEnvironmentStore(config.dataRoot);
    const accountBackend = new SbxExecutionEnvironmentBackend({
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
    const accounts = new ProviderAccountEnvironmentManager(config, {
      backend: accountBackend,
      store,
      fake: false,
      setupLauncher: {
        launch: async () => {
          throw new Error("No login in effort fixture");
        },
      } as never,
      fakeAuthentication: () => ({
        state: "authenticated",
        method: "provider_account",
      }),
    });
    const worktrees = new RunWorktreeRegistry(config);
    const runs = new SbxRunExecutionManager(config, worktrees, {
      backend: runBackend,
    });
    const dispatches = new DispatchRegistry(
      join(config.dataRoot, "dispatches.sqlite"),
      config.dataRoot,
      "claude_code",
    );
    const sessions = new ClaudeCodeSessionStore(config.dataRoot);
    let broker: WorkspaceToolBroker | null = null,
      harness: ClaudeCodeHarness | null = null;
    let accountRef: EnvironmentRef | null = null,
      runRef: EnvironmentRef | null = null;
    let fixtureState: Record<string, unknown> = {};
    let syntheticAuthInspections = 0,
      fixtureProcesses = 0,
      metadataRequests = 0,
      probeWrites = 0;
    const cases: Array<{ mode: string; verdict: string }> = [];
    const lineages: Array<Parameters<ClaudeCodeHarness["close"]>[0]> = [];
    let removedAccount = false,
      removedRun = false;
    try {
      const desired = {
        providerAccountId: accountId,
        providerKey: "anthropic",
        credentialGeneration: 1,
        workerGeneration: 1,
        operationId: randomUUID(),
        desiredState: "available" as const,
        expectedPhysicalIdentity: null,
      };
      expect((await accounts.apply(desired)).physicalState).toBe("available");
      accountRef = await accountBackend.currentEnvironment({
        kind: "provider_account",
        providerAccountId: accountId,
        credentialGeneration: 1,
      });
      if (!accountRef) throw new Error("Missing disposable account cell");
      const physical = {
        backendKind: accountRef.backendKind,
        environmentId: accountRef.environmentId,
        incarnation: accountRef.incarnation,
      };
      expect(
        (
          await accounts.apply({
            ...desired,
            // Environment commands retain physical owner generation 1. The
            // independent admitted semantic credential authority below is 2.
            workerGeneration: 2,
            operationId: randomUUID(),
            expectedPhysicalIdentity: physical,
          })
        ).physicalState,
      ).toBe("available");
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
      broker = new WorkspaceToolBroker(
        new WorkspaceToolBrokerStore(config.dataRoot),
        {
          account: (input) =>
            accounts.workspaceToolBrokerAuthority({
              providerAccountId: input.providerAccountId,
              environmentOwnerGeneration: input.accountEnvironmentGeneration,
              expected: input.accountEnvironment,
            }),
          run: async (input) => runs.workspaceToolBrokerAuthority(input),
        },
        async () => {
          throw new Error("No workspace/model tools in readiness fixture");
        },
      );
      const fixtureAccounts = {
        withSerializedAccount: accounts.withSerializedAccount.bind(accounts),
        claudeCodeRuntime: async (
          input: Parameters<
            ProviderAccountEnvironmentManager["claudeCodeRuntime"]
          >[0],
        ) => {
          const runtime = await accounts.claudeCodeRuntime(input);
          const lease = runtime.lease;
          return {
            ...runtime,
            lease: {
              ...lease,
              exec: async (command: EnvironmentCommand) => {
                if (command.executable !== SBX_CLAUDE_EXECUTABLE)
                  return lease.exec(command);
                expect(command.args).toEqual(["auth", "status"]);
                syntheticAuthInspections++;
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    loggedIn: true,
                    authMethod: "claude.ai",
                    apiProvider: "firstParty",
                    analyticsDisabled: true,
                    projectsDirectory: `${runtime.configRoot}/projects`,
                    configDirectory: runtime.configRoot,
                    email: null,
                    orgId: null,
                    orgName: null,
                    subscriptionType: null,
                  }),
                  stderr: "",
                };
              },
              spawnStreamed: async (
                command: EnvironmentCommand,
                options: Parameters<typeof lease.spawnStreamed>[1],
              ) => {
                expect(command.executable).toBe(SBX_CLAUDE_EXECUTABLE);
                expect(command.args[command.args.indexOf("--model") + 1]).toBe(
                  CLAUDE_CODE_MODEL,
                );
                expect(command.args[command.args.indexOf("--effort") + 1]).toBe(
                  "high",
                );
                expect(command.args).toContain("--restricted");
                expect(command.cwd).toBe(runtime.cwd);
                fixtureProcesses++;
                const process = await lease.spawnStreamed(
                  {
                    executable: "/usr/bin/python3",
                    args: ["-u", "-c", python],
                    cwd: runtime.cwd,
                    environment: {
                      QE_FIXTURE_INIT: JSON.stringify({
                        type: "system",
                        subtype: "init",
                        claude_code_version: "2.1.292",
                        apiKeySource: "oauth",
                        cwd: runtime.cwd,
                        model: CLAUDE_CODE_MODEL,
                        permissionMode: "dontAsk",
                        tools: [...CLAUDE_CODE_TOOLS],
                        mcp_servers: [],
                        skills: [],
                        agents: [],
                        plugins: [
                          {
                            name: "qe-account-cell",
                            path: CLAUDE_CODE_PLUGIN_PATH,
                          },
                          { name: "cc-plugin-sec-default", path: "builtin" },
                        ],
                      }),
                      QE_FIXTURE_APPLIED: JSON.stringify(fixtureState),
                    },
                  },
                  options,
                );
                return {
                  ...process,
                  write: async (data: Uint8Array) => {
                    const value = JSON.parse(new TextDecoder().decode(data));
                    if (value.type === "user") {
                      expect(value.shouldQuery).toBe(false);
                      probeWrites++;
                    } else {
                      expect(value.request).toEqual({
                        subtype: "get_settings",
                      });
                      metadataRequests++;
                    }
                    return process.write(data);
                  },
                } as StreamedProcess;
              },
            },
          };
        },
      };
      const tools = [
        "workspace.filesystem",
        "workspace.search",
        "terminal.shell",
      ];
      harness = new ClaudeCodeHarness(
        config,
        {
          prepare: async (
            ...args: Parameters<SbxRunExecutionManager["prepare"]>
          ) => {
            const prepared = await runs.prepare(...args);
            runRef = prepared.lease.ref;
            // Drive Product's admission response only after the real Run context
            // is ready. Pre-admitting before prepare would fence a stale context.
            const dispatch = args[0];
            if (!broker) throw new Error("Fixture broker missing");
            const admitted = await broker.prepare({
              authorizationId: randomUUID(),
              providerAccountId: accountId,
              credentialGeneration: 2,
              accountEnvironmentGeneration: 1,
              accountEnvironment: physical,
              runId,
              actionId: dispatch.action.action_id,
              occurrenceId: dispatch.action.occurrence_id,
              attemptId: dispatch.action.attempt_id,
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
            await broker.admitLocalAuthorization(
              admitted.binding.authorizationId,
            );
            return prepared;
          },
        } as never,
        fixtureAccounts as never,
        () => broker as WorkspaceToolBroker,
        sessions,
      );
      for (const [mode, applied] of [
        ["high", { model: CLAUDE_CODE_MODEL, effort: "high" }],
        [
          "wrong_effort_override",
          { model: CLAUDE_CODE_MODEL, effort: "medium" },
        ],
        ["missing_effort", { model: CLAUDE_CODE_MODEL }],
        ["unsupported_effort", { model: CLAUDE_CODE_MODEL, effort: null }],
        [
          "wrong_model_correct_effort",
          { model: "claude-sonnet-4-6", effort: "high" },
        ],
      ] as const) {
        fixtureState = applied;
        const base = action({
          action_id: randomUUID(),
          run_id: runId,
          worker_id: workerId,
        });
        const request = action({
          ...base,
          execution: {
            ...base.execution,
            configuration: {
              ...base.execution.configuration,
              harness_kind: "claude_code",
              model: { provider: "anthropic", model: CLAUDE_CODE_MODEL },
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
        const lineage = dispatches.getLineage(dispatch.lineageId as string);
        lineages.push(lineage);
        const preparing = harness.start(dispatch, lineage);
        if (mode === "high") {
          const prepared = await preparing;
          await harness.ready(dispatch, prepared);
          expect(prepared.handle.nativeSession).toBeDefined();
        } else
          await expect(preparing).rejects.toMatchObject({
            code: "environment_attestation_failed",
            phase: "readiness",
          });
        expect(dispatches.get(request.action_id).promptIntentAt).toBeNull();
        await harness.close(lineage);
        cases.push({
          mode,
          verdict: mode === "high" ? "READY" : "REJECTED_BEFORE_INFERENCE",
        });
      }
      expect(fixtureProcesses).toBe(5);
      expect(probeWrites).toBe(5);
      expect(metadataRequests).toBe(5);
      expect(client.forbiddenNative).toBe(0);
      expect(client.credentialOperations).toBe(0);
      const evidenceDb = new Database(
        join(config.dataRoot, "claude-code-sessions-v1.sqlite"),
        { readonly: true },
      );
      const rows = evidenceDb
        .query("SELECT evidence_json FROM managed_harness_lifecycle")
        .all() as Array<{ evidence_json: string }>;
      evidenceDb.close();
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.evidence_json).not.toContain("FIXTURE_CONFIG_CANARY");
        expect(JSON.parse(row.evidence_json).modExecution).toBe(
          "unestablished",
        );
      }
      expect(
        rows.filter(
          (row) =>
            JSON.parse(row.evidence_json).lastProvenStage ===
            "protocol_frame_validated",
        ),
      ).toHaveLength(1);
    } finally {
      for (const lineage of lineages) await harness?.close(lineage);
      await broker?.close();
      if (runRef) {
        await runBackend.remove(runRef);
        removedRun = true;
      }
      if (accountRef) {
        await accountBackend.remove(accountRef);
        removedAccount = true;
      }
      await runs.close();
      await accounts.close();
      dispatches.close();
      sessions.close();
      worktrees.close();
      await rm(root, { recursive: true, force: true });
      await writeFile(
        join(output, "proof.json"),
        JSON.stringify(
          {
            proof: "managed-effort-readiness",
            cases,
            fixtureProcesses,
            probeWrites,
            metadataRequests,
            syntheticAuthInspections,
            removedRun,
            removedAccount,
            nativeClaudeExecutions: client.forbiddenNative,
            credentialOperations: client.credentialOperations,
            logins: 0,
            providerRequests: 0,
            modelTurns: 0,
            retainedStateMutations: 0,
            boundary:
              "Pinned native source statically verified; auth inspection and native executable replaced by explicitly deterministic fixtures. No claim of live native execution.",
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          proof: "managed-effort-readiness",
          output,
          cases,
          removedAccount,
          removedRun,
        }),
      );
    }
  },
  15 * 60_000,
);

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) !== 0)
    throw new Error("Disposable fixture Git failed");
}
