import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import {
  SbxExecutionEnvironmentBackend,
  sbxEnvironmentName,
} from "../src/execution-environment/sbx-backend.ts";
import { CliSbxClient } from "../src/execution-environment/sbx-client.ts";
import { SBX_CODING_PROFILE } from "../src/execution-environment/sbx-profile.ts";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import { SbxRunExecutionStore } from "../src/execution-environment/sbx-run-store.ts";
import { PiHarness } from "../src/harnesses/pi/adapter.ts";
import type { ExecuteAction } from "../src/protocol/types.ts";
import { LocalHerdrConnectionProvider } from "../src/session-host/herdr/connection.ts";
import { HerdrTerminalBackend } from "../src/session-host/herdr/session-host.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";
import { action } from "./support.ts";

const enabled = process.env.QE_RUN_SBX_HERDR_LIVE === "1";
const herdrBin = process.env.QE_HERDR_BIN ?? "";
const sbxBin = process.env.QE_SBX_BIN ?? "/opt/homebrew/bin/sbx";

/**
 * This is deliberately a launch-only acceptance. It never calls prompt/send-input
 * and therefore cannot authorize a provider/model cycle.
 */
test.skipIf(!enabled)(
  "live mixed-profile Pi launch uses exact Herdr/SBX execution without inference",
  async () => {
    expect(herdrBin.startsWith("/")).toBe(true);
    expect(sbxBin.startsWith("/")).toBe(true);
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "sbx-herdr-live-"));
    const externalSource = process.env.QE_SBX_HERDR_LIVE_SOURCE;
    const source = externalSource ?? join(root, "source");
    const authorizedRoot = externalSource ?? root;
    const dataRoot = join(root, "data");
    const worktreeRoot = join(root, "worktrees");
    const trapRoot = join(root, "path-trap");
    const trapMarker = join(root, "host-pi-trap-ran");
    const workerId =
      process.env.QE_SBX_HERDR_LIVE_WORKER_ID ??
      `sbx-herdr-live-${randomUUID().slice(0, 12)}`;
    const runId = process.env.QE_SBX_HERDR_LIVE_RUN_ID ?? `run-${randomUUID()}`;
    const actionId =
      process.env.QE_SBX_HERDR_LIVE_ACTION_ID ?? `action-${randomUUID()}`;
    const attemptId =
      process.env.QE_SBX_HERDR_LIVE_ATTEMPT_ID ?? `attempt-${randomUUID()}`;
    const occurrenceId =
      process.env.QE_SBX_HERDR_LIVE_OCCURRENCE_ID ??
      `occurrence-${randomUUID()}`;
    const sessionName = `qe-sbx-live-${randomUUID().slice(0, 12)}`;
    const workspaceId = randomUUID();
    const bindingId = randomUUID();
    const worktreeId = randomUUID();
    const originalPath = process.env.PATH;
    let worktrees: RunWorktreeRegistry | null = null;
    let dispatches: DispatchRegistry | null = null;
    let manager: SbxRunExecutionManager | null = null;
    let backend: SbxExecutionEnvironmentBackend | null = null;
    let environmentRef:
      | ReturnType<SbxRunExecutionStore["forRun"]>[number]["environmentRef"]
      | null = null;
    let sourceBefore = "";
    try {
      await mkdir(worktreeRoot, { recursive: true });
      await mkdir(trapRoot, { recursive: true });
      if (!externalSource) {
        await mkdir(source, { recursive: true });
        await git(["init", "-q", source]);
        await writeFile(join(source, "README.md"), "# launch-only fixture\n");
        await git(["-C", source, "add", "README.md"]);
        await git([
          "-C",
          source,
          "-c",
          "user.name=QE",
          "-c",
          "user.email=qe@example.invalid",
          "commit",
          "-q",
          "-m",
          "fixture",
        ]);
      }
      sourceBefore = await repositorySnapshot(source);
      const trap = join(trapRoot, "pi");
      await writeFile(
        trap,
        `#!/bin/sh\nprintf trap > ${JSON.stringify(trapMarker)}\nexit 99\n`,
      );
      await chmod(trap, 0o755);
      process.env.PATH = `${trapRoot}:/opt/homebrew/bin:/usr/bin:/bin`;

      const config: WorkerConfig = {
        controlPlaneUrl: "ws://localhost/worker/websocket",
        workerId,
        workerToken: "launch-only",
        maxConcurrency: 1,
        tags: ["launch-only"],
        herdrSession: sessionName,
        herdrBin,
        allowedRoots: [
          {
            key: "fixture",
            path: authorizedRoot,
            max_access: "read_write",
            discover_depth: externalSource ? 0 : 2,
            allow_unconfined_shell: true,
          },
        ],
        workspaceBindings: [
          {
            binding_id: bindingId,
            workspace_id: workspaceId,
            authorized_root_key: "fixture",
            source_repository_root: source,
            max_access: "read_write",
            allow_unconfined_shell: true,
          },
        ],
        worktreeRoot,
        dataRoot,
        piThinking: "medium",
        heartbeatMs: 1_000,
        reconnectMs: 1_000,
        resultTimeoutMs: 60_000,
        provider: "pi",
        enabledHarnesses: ["pi", "antigravity"],
        fakeOutputs: {},
        fakeDelayMs: 0,
      };
      worktrees = new RunWorktreeRegistry(config);
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
      expect(await repositorySnapshot(source)).toBe(sourceBefore);

      const sbxClient = new CliSbxClient(sbxBin);
      backend = new SbxExecutionEnvironmentBackend({
        workerId,
        dataRoot,
        client: sbxClient,
        executionProfile: SBX_CODING_PROFILE,
      });
      manager = new SbxRunExecutionManager(config, worktrees, { backend });
      const catalog = await manager.discover();
      expect(catalog.authenticated).toBe(true);
      const model = catalog.models[0];
      if (!model) throw new Error("Pi runtime catalog returned no models");
      expect(model.provider).toBe("openai-codex");
      expect(model.accountAvailability).not.toBe("verified_unavailable");
      if (model.reasoningCapability.kind === "unknown")
        throw new Error(
          "Dynamic Pi discovery returned unknown reasoning metadata.",
        );

      const request = launchAction({
        workerId,
        runId,
        actionId,
        attemptId,
        occurrenceId,
        workspaceId,
        bindingId,
        worktreeId,
        canonicalRoot: materialized.canonicalRoot,
        provider: model.provider,
        model: model.model,
        reasoningCapability: model.reasoningCapability,
      });
      dispatches = new DispatchRegistry(
        join(dataRoot, "dispatch.sqlite"),
        dataRoot,
      );
      const accepted = dispatches.accept(request).dispatch;
      if (!accepted.lineageId)
        throw new Error("Fresh dispatch has no lineage.");
      const lineage = dispatches.getLineage(accepted.lineageId);

      const provider = new LocalHerdrConnectionProvider(sessionName, {
        workerId,
        dataRoot,
        herdrExecutable: herdrBin,
      });
      const infrastructure = await provider.ensureInfrastructure();
      const host = new HerdrTerminalBackend(provider);
      const harness = new PiHarness(host, config, {
        executionManager: manager,
      });
      const prepared = await harness.start(accepted, lineage);
      expect(prepared.agent.agent).toBe("pi");
      expect(prepared.agent.status).toBe("idle");
      expect(await Bun.file(trapMarker).exists()).toBe(false);
      const attachment = host.attachment(prepared.ref);
      expect(attachment).toMatchObject({
        mode: "local_native_terminal",
        terminalTargetId: prepared.ref.paneId,
        supportsObservation: true,
        supportsTakeover: true,
      });

      const executionStore = new SbxRunExecutionStore(dataRoot);
      const durable = executionStore.forRun(runId);
      executionStore.close();
      expect(durable).toHaveLength(1);
      const execution = durable[0];
      if (!execution) throw new Error("Missing durable SBX execution.");
      environmentRef = execution.environmentRef;
      expect(execution.launchProvenance).toMatchObject({
        schemaVersion: 1,
        executable: process.execPath,
        physicalLineageId: lineage.lineageId,
        environmentId: execution.environmentRef.environmentId,
        incarnation: execution.environmentRef.incarnation,
      });
      expect(
        execution.launchProvenance?.launcherEntrypoint.startsWith("/"),
      ).toBe(true);
      expect(execution.launchProvenance?.guestExecutable).toBe(
        "/opt/qe/pi/node_modules/.bin/pi",
      );

      const controlHash = createHash("sha256")
        .update(lineage.lineageId)
        .digest("hex")
        .slice(0, 32);
      const runtimeState = await sbxClient.exec(
        sbxEnvironmentName(workerId, runId),
        {
          executable: "/bin/cat",
          args: [`/qe/control/lineages/${controlHash}/runtime-state.json`],
        },
      );
      expect(runtimeState.exitCode).toBe(0);
      const attested = JSON.parse(runtimeState.stdout) as {
        state: string;
        attestation?: Record<string, string>;
        attestationFailure?: string;
      };
      expect(attested.state).toBe("idle");
      expect(attested.attestationFailure).toBeUndefined();
      expect(attested.attestation).toMatchObject({
        workerId,
        runId,
        environmentId: execution.environmentRef.environmentId,
        incarnation: execution.environmentRef.incarnation,
        physicalLineageId: lineage.lineageId,
        workspacePath: execution.workspace.paths.workspace,
        homePath: "/home/agent",
      });

      const holdPath = process.env.QE_SBX_HERDR_LIVE_HOLD_PATH;
      if (holdPath) {
        const releasePath = process.env.QE_SBX_HERDR_LIVE_RELEASE_PATH;
        if (!releasePath)
          throw new Error(
            "QE_SBX_HERDR_LIVE_RELEASE_PATH is required with the live hold path.",
          );
        await Bun.write(
          holdPath,
          `${JSON.stringify(
            {
              workerId,
              runId,
              actionId,
              attemptId: accepted.action.attempt_id,
              occurrenceId: accepted.action.occurrence_id,
              lineageId: lineage.lineageId,
              sessionName: prepared.ref.sessionName,
              paneId: prepared.ref.paneId,
              terminalId: prepared.ref.terminalId,
              environmentId: execution.environmentRef.environmentId,
              environmentIncarnation: execution.environmentRef.incarnation,
              profileId: execution.environmentRef.profile.id,
              profileDigest: execution.environmentRef.profile.digest,
              providerCycles: 0,
              prompts: 0,
            },
            null,
            2,
          )}\n`,
        );
        while (!(await Bun.file(releasePath).exists())) await Bun.sleep(100);
      }

      // No-inference lifecycle probe: exercise Herdr's actual managed state API
      // while the exact guest Pi process and pane remain alive. These terminal
      // state reports do not send TUI input or contact a model provider.
      const probeSequence = Number.MAX_SAFE_INTEGER - 1;
      await host.reportAgentState({
        paneId: prepared.ref.paneId,
        state: "working",
        sequence: probeSequence,
      });
      expect(await host.inspectAgentState(prepared.ref.paneId)).toMatchObject({
        status: "working",
        paneId: prepared.ref.paneId,
      });
      await host.reportAgentState({
        paneId: prepared.ref.paneId,
        state: "idle",
        sequence: probeSequence + 1,
      });
      // Herdr normalizes an explicit native-idle report for this retained Pi
      // process to its terminal non-working `done` status.
      expect(await host.inspectAgentState(prepared.ref.paneId)).toMatchObject({
        status: "done",
        paneId: prepared.ref.paneId,
      });
      expect(
        (await host.snapshot()).agents.some(
          (agent) =>
            agent.paneId === prepared.ref.paneId && agent.status === "done",
        ),
      ).toBe(true);

      const docker = await sbxClient.exec(sbxEnvironmentName(workerId, runId), {
        executable: "/usr/bin/docker",
        args: ["info", "--format", "{{json .DockerRootDir}}"],
        timeoutMs: 60_000,
      });
      expect(docker.exitCode).toBe(0);
      expect(JSON.parse(docker.stdout)).toBe("/var/lib/docker");

      host.disconnect();
      const restartedProvider = new LocalHerdrConnectionProvider(sessionName, {
        workerId,
        dataRoot,
        herdrExecutable: herdrBin,
      });
      const adopted = await restartedProvider.ensureInfrastructure();
      expect(adopted.sessionIncarnation).toBe(
        infrastructure.sessionIncarnation,
      );
      expect(adopted.serverGeneration).toBe(infrastructure.serverGeneration);
      const restartedHost = new HerdrTerminalBackend(restartedProvider);
      const surviving = await restartedHost.inspectAgentState(
        prepared.ref.paneId,
      );
      expect(surviving).toMatchObject({
        agent: "pi",
        paneId: prepared.ref.paneId,
        status: "done",
      });
      expect(restartedHost.attachment(prepared.ref).supportsTakeover).toBe(
        true,
      );
      expect(await Bun.file(trapMarker).exists()).toBe(false);

      await restartedHost.sendKeys(prepared.ref.paneId, ["ctrl+c", "ctrl+c"]);
      await waitFor(async () => {
        const snapshot = await restartedHost.snapshot();
        return (
          snapshot.panes.some((pane) => pane.paneId === prepared.ref.paneId) &&
          !snapshot.agents.some((agent) => agent.paneId === prepared.ref.paneId)
        );
      });
      expect(await repositorySnapshot(source)).toBe(sourceBefore);
      console.log(
        JSON.stringify({
          event: "sbx_herdr_pi_launch_only",
          sessionName,
          sessionIncarnation: infrastructure.sessionIncarnation,
          serverGeneration: infrastructure.serverGeneration,
          environmentId: execution.environmentRef.environmentId,
          environmentIncarnation: execution.environmentRef.incarnation,
          physicalLineageId: lineage.lineageId,
          paneId: prepared.ref.paneId,
          terminalId: prepared.ref.terminalId,
          exactHerdrBinary: herdrBin,
          exactLauncher: execution.launchProvenance?.executable,
          guestExecutable: execution.launchProvenance?.guestExecutable,
          attested: true,
          processSurvivedControllerRestart: true,
          nativeLifecycleReports: ["idle", "working", "idle"],
          herdrObservedLifecycle: ["idle", "working", "done"],
          retainedRestartState: "done",
          openSession: true,
          takeControl: true,
          shellRestored: true,
          hostPiPathTrapRan: false,
          providerCycles: 0,
          prompts: 0,
        }),
      );
    } finally {
      process.env.PATH = originalPath;
      if (environmentRef)
        await backend?.remove(environmentRef).catch(() => undefined);
      await manager?.close().catch(() => undefined);
      if (!manager) backend?.close();
      if (worktrees) {
        await worktrees.cleanup(worktreeId).catch(() => undefined);
        worktrees.close();
      }
      dispatches?.close();
      await stopSession(herdrBin, sessionName).catch(() => undefined);
      if (sourceBefore)
        expect(await repositorySnapshot(source)).toBe(sourceBefore);
      await rm(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

function launchAction(input: {
  workerId: string;
  runId: string;
  actionId: string;
  attemptId: string;
  occurrenceId: string;
  workspaceId: string;
  bindingId: string;
  worktreeId: string;
  canonicalRoot: string;
  provider: string;
  model: string;
  reasoningCapability: ExecuteAction["execution"]["configuration"]["reasoning_capability"];
}): ExecuteAction {
  const value = action({
    action_id: input.actionId,
    run_id: input.runId,
    occurrence_id: input.occurrenceId,
    attempt_id: input.attemptId,
  });
  value.worker_id = input.workerId;
  value.execution = {
    ...value.execution,
    identity: {
      ...value.execution.identity,
      launch_id: `launch-${randomUUID()}`,
    },
    configuration: {
      harness_kind: "pi",
      model: { provider: input.provider, model: input.model },
      reasoning: null,
      reasoning_capability: input.reasoningCapability,
      tool_policy: { kind: "exact", tools: ["workspace.filesystem"] },
      tool_enforcement: "exact",
      resolved_tool_profile: { tools: ["workspace.filesystem"] },
    },
    logical_workspace: {
      workspace_id: input.workspaceId,
      workspace_key: "launch-only",
    },
    execution_workspace: {
      worktree_id: input.worktreeId,
      workspace_binding_id: input.bindingId,
      canonical_root: input.canonicalRoot,
      access: "read_write",
    },
  };
  return value;
}

async function waitFor(probe: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await probe()) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for Pi exit and Herdr shell restoration.");
}

async function repositorySnapshot(root: string): Promise<string> {
  const [head, symbolicHead, refs, status, config] = await Promise.all([
    gitOutput(["-C", root, "rev-parse", "HEAD"]),
    gitOutput(["-C", root, "symbolic-ref", "HEAD"]),
    gitOutput([
      "-C",
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]),
    gitOutput([
      "-C",
      root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    readFile(join(root, ".git", "config")),
  ]);
  return JSON.stringify({
    head,
    symbolicHead,
    refs,
    status,
    config: createHash("sha256").update(config).digest("hex"),
  });
}

async function git(args: string[]): Promise<void> {
  await gitOutput(args);
}

async function gitOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function stopSession(executable: string, sessionName: string) {
  if (!executable.startsWith("/")) return;
  const child = Bun.spawn(
    [executable, "session", "stop", "--json", sessionName],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await child.exited;
}
