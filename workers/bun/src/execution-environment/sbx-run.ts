import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { WorkerConfig, WorkspaceBindingConfig } from "../config.ts";
import type { DispatchRecord, HarnessLineage } from "../dispatch/registry.ts";
import {
  controlDescriptorPath,
  type StructuredCompletionBoundary,
} from "../harnesses/control/authority.ts";
import {
  forwardHarnessControlPayload,
  SBX_CONTROL_MAILBOX_ENV,
} from "../harnesses/control/client.ts";
import { mappedPiTools } from "../harnesses/pi/tools.ts";
import type { HarnessModelCapability } from "../harnesses/types.ts";
import type { JsonValue } from "../protocol/types.ts";
import type {
  NativeSessionRef,
  TerminalSessionBackend,
} from "../session-host/types.ts";
import type { MaterializedArtifact } from "../workspace/execution-artifacts.ts";
import {
  type PrivateGitChangeExport,
  PrivateGitWorkspaceManager,
  type PrivateLineageWorkspace,
  validateAndImportPrivateGitExport,
} from "../workspace/private-git.ts";
import type {
  RunWorktreeRecord,
  RunWorktreeRegistry,
} from "../workspace/run-worktrees.ts";
import { SbxExecutionEnvironmentBackend } from "./sbx-backend.ts";
import {
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_PI_DISCOVERY_SCRIPT,
  SBX_PI_EXECUTABLE,
  SBX_PI_EXECUTION_PROFILE_V1,
  SBX_PI_PROFILE,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
} from "./sbx-profile.ts";
import { SbxRunExecutionStore } from "./sbx-run-store.ts";
import type { EnvironmentLease, EnvironmentSpec } from "./types.ts";

const MAX_MAILBOX_REQUEST_BYTES = 1024 * 1024;
const PI_EXTENSION_ENTRIES = [
  "step-result-extension.ts",
  "workspace-permission-extension.ts",
  "human-assistance-extension.ts",
  "sbx-herdr-state-extension.ts",
] as const;

export interface PreparedSbxPiExecution {
  lease: EnvironmentLease;
  workspace: PrivateLineageWorkspace;
  hostCwd: string;
  paneEnvironment: Record<string, string>;
  guestEnvironment: Record<string, string>;
  extensionPaths: string[];
  materializedArtifacts: Record<string, MaterializedArtifact>;
  syncControl(): Promise<void>;
  activityCursor(): Promise<number>;
  observedActivityAfter(cursor: number): string | null;
  startRelay(host: TerminalSessionBackend, paneId: string): void;
  stopRelay(): Promise<void>;
}

interface ExtensionBundle {
  name: string;
  bytes: Uint8Array;
  sha256: string;
}

interface RuntimeContext {
  dispatch: DispatchRecord;
  lineage: HarnessLineage;
  lease: EnvironmentLease;
  workspace: PrivateLineageWorkspace;
  controlRoot: string;
  relay: SbxControlMailboxRelay | null;
}

/**
 * Production Pi execution boundary. There is intentionally no HostNative
 * branch: every prepared execution has an exact SBX lease and private Git
 * workspace before Herdr can launch Pi.
 */
export class SbxRunExecutionManager implements StructuredCompletionBoundary {
  private readonly backend: SbxExecutionEnvironmentBackend;
  private readonly privateGit: PrivateGitWorkspaceManager;
  private readonly store: SbxRunExecutionStore;
  private readonly contexts = new Map<string, RuntimeContext>();
  private extensionBundles: Promise<{
    digest: string;
    bundles: ExtensionBundle[];
  }> | null = null;
  private readonly launcherSource = resolve(
    import.meta.dir,
    "../harnesses/pi/pi-environment-launcher.ts",
  );

  constructor(
    private readonly config: WorkerConfig,
    private readonly worktrees: RunWorktreeRegistry,
    options: {
      backend?: SbxExecutionEnvironmentBackend;
      privateGit?: PrivateGitWorkspaceManager;
      store?: SbxRunExecutionStore;
    } = {},
  ) {
    this.backend =
      options.backend ??
      new SbxExecutionEnvironmentBackend({
        workerId: config.workerId,
        dataRoot: config.dataRoot,
        executionProfile: SBX_PI_PROFILE,
      });
    this.privateGit =
      options.privateGit ??
      new PrivateGitWorkspaceManager({ dataRoot: config.dataRoot });
    this.store = options.store ?? new SbxRunExecutionStore(config.dataRoot);
  }

  async discover(): Promise<{
    models: HarnessModelCapability[];
    diagnostics: string[];
    authenticated: boolean;
  }> {
    const runId = `discovery-${randomUUID()}`;
    const spec = this.spec({
      runId,
      workspaceId: `discovery-${randomUUID()}`,
      access: "none",
      sourceIdentity: "repository-owned-pi-profile",
      frozenBase: "none",
      materialization: "disposable_fixture",
    });
    let lease: EnvironmentLease | null = null;
    try {
      lease = await this.backend.ensure(spec);
      const result = await lease.exec({
        executable: "/usr/bin/node",
        args: [SBX_PI_DISCOVERY_SCRIPT],
        cwd: lease.paths.workspace,
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0)
        throw new Error(
          result.stderr.trim() || "In-sandbox Pi model discovery failed.",
        );
      const discovered = decodeDiscovery(result.stdout);
      const configured =
        this.config.executorModels ??
        (this.config.piModel
          ? [splitConfiguredModel(this.config.piModel)]
          : null);
      if (!configured) return discovered;
      const allowed = new Set(
        configured.map((model) => `${model.provider}/${model.model}`),
      );
      const models = discovered.models.filter((model) =>
        allowed.has(`${model.provider}/${model.model}`),
      );
      return {
        models,
        authenticated: discovered.authenticated && models.length > 0,
        diagnostics:
          models.length > 0
            ? discovered.diagnostics
            : [
                ...discovered.diagnostics,
                "No authenticated in-sandbox Pi model matches the configured Worker scope.",
              ],
      };
    } finally {
      if (lease) await this.backend.remove(lease.ref).catch(() => undefined);
    }
  }

  async reconcileDurableOwnership(): Promise<string[]> {
    const diagnostics: string[] = [];
    for (const record of this.store.list()) {
      if (record.changeExport) continue;
      try {
        const inspection = await this.backend.inspect(record.environmentRef);
        if (inspection.state !== "running" || !inspection.usable) {
          const code = `environment_${inspection.state}_${inspection.usable ? "usable" : "unusable"}`;
          this.store.attention(record.lineageId, code);
          diagnostics.push(`${record.lineageId}: ${code}`);
        }
      } catch (error) {
        this.store.attention(
          record.lineageId,
          "environment_reconciliation_failed",
        );
        diagnostics.push(
          `${record.lineageId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return diagnostics;
  }

  async prepare(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    hostArtifacts: Record<string, MaterializedArtifact>,
  ): Promise<PreparedSbxPiExecution> {
    const worktree = await this.requiredWorktree(dispatch);
    const binding = this.requiredBinding(worktree);
    if (!worktree.baseRevision)
      throw new Error("Run worktree has no frozen base revision.");
    const spec = this.spec({
      runId: dispatch.action.run_id,
      workspaceId: dispatch.action.execution.logical_workspace.workspace_id,
      // The environment spec is Run-stable. Per-Action access is enforced by
      // the lineage worktree permissions and exact Pi tool mapping below.
      access: binding.max_access,
      sourceIdentity:
        binding.publication_repository_identity ||
        binding.source_fingerprint ||
        binding.binding_id,
      frozenBase: worktree.baseRevision,
      materialization: "frozen_import",
    });
    const lease = await this.backend.ensure(spec);
    const access = dispatch.action.execution.execution_workspace.access;
    const physicalAccess = access === "read_write" ? "read_write" : "read_only";
    const existingExecution = this.store.get(lineage.lineageId);
    const replacingEnvironment = Boolean(
      existingExecution &&
        !sameEnvironmentRef(existingExecution.environmentRef, lease.ref),
    );
    if (replacingEnvironment && !existingExecution?.recoveryExport) {
      this.store.attention(lineage.lineageId, "replacement_checkpoint_missing");
      throw new Error(
        "SBX environment changed without a verified private-Git recovery export.",
      );
    }
    const predecessor = existingExecution
      ? null
      : (this.store
          .forRun(dispatch.action.run_id)
          .find((record) => record.recoveryExport !== null) ?? null);
    const recoveryExport = replacingEnvironment
      ? existingExecution?.recoveryExport
      : predecessor?.recoveryExport;
    let workspace: PrivateLineageWorkspace;
    if (recoveryExport) {
      workspace = await this.privateGit.restoreCheckpoint({
        lease,
        changeExport: recoveryExport,
        physicalLineageId: lineage.lineageId,
        access: physicalAccess,
      });
    } else {
      const repository = await this.privateGit.materializeSource({
        lease,
        source: {
          repositoryId: binding.binding_id,
          canonicalSourceIdentifier:
            binding.publication_repository_identity ||
            binding.source_fingerprint ||
            binding.binding_id,
          hostRepositoryRoot: worktree.canonicalRoot,
          frozenBaseCommit: worktree.baseRevision,
          provenance: { kind: "authorized_local_object_database" },
        },
      });
      workspace = await this.privateGit.ensureWorktree({
        lease,
        repositoryId: repository.source.repositoryId,
        physicalLineageId: lineage.lineageId,
        // Access-none keeps the source physically read-only and exposes no Pi
        // filesystem/search/shell tools. A private worktree still exists so
        // completion/recovery has one exact Git identity.
        access: physicalAccess,
      });
    }
    const extensions = await this.bundledExtensions();
    const controlRoot = posix.join(
      lease.paths.control,
      "lineages",
      digest(lineage.lineageId).slice(0, 32),
    );
    const extensionRoot = posix.join(lease.paths.state, "pi-extensions");
    await lease.workerExec({
      executable: "/usr/bin/install",
      args: [
        "-d",
        "-m",
        "0700",
        "-o",
        "1000",
        "-g",
        "1000",
        controlRoot,
        posix.join(controlRoot, "mailbox", "requests"),
        posix.join(controlRoot, "mailbox", "responses"),
        extensionRoot,
      ],
    });
    const extensionPaths: string[] = [];
    for (const bundle of extensions.bundles) {
      const path = posix.join(extensionRoot, bundle.name);
      const receipt = await lease.writeFile({
        path,
        data: bundle.bytes,
        mode: 0o500,
      });
      if (receipt.sha256 !== bundle.sha256)
        throw new Error(
          "Pi extension changed while crossing the SBX boundary.",
        );
      extensionPaths.push(path);
    }
    const materializedArtifacts = await this.stageArtifacts(
      lease,
      dispatch,
      hostArtifacts,
    );
    const guestPaths = guestControlPaths(controlRoot);
    const guestEnvironment: Record<string, string> = {
      QE_HARNESS_CONTROL_PATH: guestPaths.descriptor,
      [SBX_CONTROL_MAILBOX_ENV]: guestPaths.mailbox,
      QE_RESULT_CONTROL_PATH: guestPaths.result,
      QE_ATTENTION_CONTROL_PATH: guestPaths.attention,
      QE_RECOVERY_CONTROL_PATH: guestPaths.recovery,
      QE_SBX_RUNTIME_STATE_PATH: guestPaths.runtimeState,
      QE_WORKSPACE_ACCESS: access,
      QE_WORKSPACE_ROOT: workspace.paths.workspace,
      QE_ALLOWED_PI_TOOLS: mappedPiTools(dispatch).join(","),
      QE_ARTIFACT_ROOT: posix.join(lease.paths.state, "execution-artifacts"),
    };
    const launch = await lease.launcher({
      executable: SBX_PI_EXECUTABLE,
      args: [],
      cwd: workspace.paths.workspace,
      environment: guestEnvironment,
    });
    const launcher = await this.installHostLauncher(lineage.lineageId);
    const paneEnvironment = {
      PATH: `${launcher.directory}:${process.env.PATH ?? ""}`,
      QE_PI_ENVIRONMENT_LAUNCH: Buffer.from(JSON.stringify(launch)).toString(
        "base64",
      ),
    };
    const context: RuntimeContext = {
      dispatch,
      lineage,
      lease,
      workspace,
      controlRoot,
      relay: null,
    };
    const previous = this.contexts.get(lineage.lineageId);
    if (previous?.relay) await previous.relay.stop();
    this.contexts.set(lineage.lineageId, context);
    this.store.ready({
      lineageId: lineage.lineageId,
      actionId: dispatch.action.action_id,
      runId: dispatch.action.run_id,
      environmentRef: lease.ref,
      workspace,
      extensionSetDigest: extensions.digest,
      ...(predecessor?.hostResultTree
        ? { inheritedHostResultTree: predecessor.hostResultTree }
        : {}),
      ...(predecessor?.recoveryExport
        ? { inheritedRecoveryExport: predecessor.recoveryExport }
        : {}),
      ...(replacingEnvironment && existingExecution
        ? { replacementOf: existingExecution.environmentRef }
        : {}),
    });
    const prepared: PreparedSbxPiExecution = {
      lease,
      workspace,
      hostCwd: launcher.directory,
      paneEnvironment,
      guestEnvironment,
      extensionPaths,
      materializedArtifacts,
      syncControl: () => this.syncControl(context),
      activityCursor: async () => {
        await context.relay?.refresh();
        return context.relay?.activityCursor() ?? 0;
      },
      observedActivityAfter: (cursor) =>
        context.relay?.observedActivityAfter(cursor) ?? null,
      startRelay: (host, paneId) => {
        if (context.relay) return;
        context.relay = new SbxControlMailboxRelay(
          lease,
          controlRoot,
          lineage,
          host,
          paneId,
          () =>
            this.store.attention(
              lineage.lineageId,
              "control_mailbox_relay_failed",
            ),
          () =>
            this.store.clearAttention(
              lineage.lineageId,
              "control_mailbox_relay_failed",
            ),
        );
        context.relay.start();
      },
      stopRelay: async () => {
        await context.relay?.stop();
        context.relay = null;
      },
    };
    await prepared.syncControl();
    return prepared;
  }

  async verifyAndBind(input: {
    dispatch: DispatchRecord;
    lineageId: string;
    outputs: Record<string, JsonValue>;
  }): Promise<Record<string, JsonValue>> {
    const context = this.contexts.get(input.lineageId);
    if (
      !context ||
      context.dispatch.action.action_id !== input.dispatch.action.action_id ||
      context.lease.ref.runId !== input.dispatch.action.run_id
    )
      throw new Error(
        "No exact active SBX/private-Git completion context exists.",
      );
    const durable = this.store.get(input.lineageId);
    const changeExport =
      durable?.changeExport ??
      (await this.privateGit.checkpoint({
        lease: context.lease,
        physicalLineageId: input.lineageId,
        contract: {
          repositoryId: context.workspace.repositoryId,
          baseCommit: this.requiredBase(context.dispatch),
        },
      }));
    await this.importVerifiedExport(context.dispatch, changeExport);
    if (!durable?.changeExport)
      this.store.bindExport(
        input.lineageId,
        input.dispatch.action.action_id,
        changeExport,
      );
    const outputs = structuredClone(input.outputs);
    for (const declaration of input.dispatch.action.execution.work
      .declared_outputs) {
      if (declaration.kind !== "change_set") continue;
      const current = outputs[declaration.name];
      if (!current || typeof current !== "object" || Array.isArray(current))
        throw new Error(
          `Change Set output ${declaration.name} must be a JSON object.`,
        );
      outputs[declaration.name] = {
        ...current,
        physical: physicalExportValue(changeExport),
      };
    }
    return outputs;
  }

  failureCode(lineageId: string): string | null {
    return this.store.get(lineageId)?.failureCode ?? null;
  }

  async stopRelay(lineageId: string): Promise<void> {
    const context = this.contexts.get(lineageId);
    await context?.relay?.stop();
    if (context) context.relay = null;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.contexts.values()].map((context) => context.relay?.stop()),
    );
    this.contexts.clear();
    this.store.close();
    this.privateGit.close();
    this.backend.close();
  }

  private async syncControl(context: RuntimeContext): Promise<void> {
    const paths = guestControlPaths(context.controlRoot);
    const hostDirectory = dirname(context.lineage.resultControlPath);
    for (const [hostPath, guestPath] of [
      [controlDescriptorPath(context.lineage), paths.descriptor],
      [context.lineage.resultControlPath, paths.result],
      [join(hostDirectory, "attention-control.json"), paths.attention],
      [join(hostDirectory, "recovery-control.json"), paths.recovery],
    ] as const) {
      try {
        await context.lease.writeFile({
          path: guestPath,
          data: new Uint8Array(await readFile(hostPath)),
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async stageArtifacts(
    lease: EnvironmentLease,
    dispatch: DispatchRecord,
    artifacts: Record<string, MaterializedArtifact>,
  ): Promise<Record<string, MaterializedArtifact>> {
    const root = posix.join(
      lease.paths.state,
      "execution-artifacts",
      digest(dispatch.action.attempt_id).slice(0, 24),
    );
    const result: Record<string, MaterializedArtifact> = {};
    for (const [name, artifact] of Object.entries(artifacts)) {
      const path = posix.join(root, artifact.filename);
      await lease.writeFile({
        path,
        data: new Uint8Array(await readFile(artifact.path)),
        mode: 0o400,
      });
      const manifest = `${artifact.path}.qe-artifact.json`;
      try {
        await lease.writeFile({
          path: `${path}.qe-artifact.json`,
          data: new Uint8Array(await readFile(manifest)),
          mode: 0o400,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      result[name] = { ...artifact, path };
    }
    return result;
  }

  private async bundledExtensions(): Promise<{
    digest: string;
    bundles: ExtensionBundle[];
  }> {
    if (this.extensionBundles) return this.extensionBundles;
    this.extensionBundles = (async () => {
      const entrypoints = PI_EXTENSION_ENTRIES.map((name) =>
        resolve(import.meta.dir, `../harnesses/pi/${name}`),
      );
      const result = await Bun.build({
        entrypoints,
        target: "node",
        format: "esm",
        splitting: false,
        minify: false,
        naming: "[name].mjs",
      });
      if (!result.success)
        throw new Error(
          `Failed to build immutable Pi extensions: ${result.logs.join(" ")}`,
        );
      const bundles = await Promise.all(
        result.outputs.map(async (output) => {
          const bytes = new Uint8Array(await output.arrayBuffer());
          return {
            name: basename(output.path),
            bytes,
            sha256: digestBytes(bytes),
          };
        }),
      );
      bundles.sort((left, right) => left.name.localeCompare(right.name));
      return {
        digest: `sha256:${digest(
          JSON.stringify(
            bundles.map((bundle) => ({
              name: bundle.name,
              sha256: bundle.sha256,
            })),
          ),
        )}`,
        bundles,
      };
    })();
    return this.extensionBundles;
  }

  private async installHostLauncher(lineageId: string): Promise<{
    directory: string;
    executable: string;
  }> {
    const directory = join(
      resolve(this.config.dataRoot),
      "environment-launchers",
      digest(lineageId).slice(0, 32),
    );
    const executable = join(directory, "pi");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(this.launcherSource, executable);
    await chmod(executable, 0o700);
    return { directory, executable };
  }

  private async importVerifiedExport(
    dispatch: DispatchRecord,
    changeExport: PrivateGitChangeExport,
  ): Promise<void> {
    const worktree = await this.requiredWorktree(dispatch);
    const fixtureGitDir = join(
      resolve(this.config.dataRoot),
      "verified-private-git-imports",
      changeExport.exportId,
    );
    const imported = await validateAndImportPrivateGitExport({
      changeExport,
      fixtureGitDir,
    });
    const hostHead = (
      await hostGit(worktree.canonicalRoot, ["rev-parse", "HEAD^{commit}"])
    ).trim();
    const durable = this.store.get(changeExport.manifest.physicalLineageId);
    const expectedHostHead =
      durable?.recoveryExport?.manifest.headCommit ?? imported.baseCommit;
    if (
      hostHead !== expectedHostHead &&
      hostHead !== changeExport.manifest.headCommit
    )
      throw new Error(
        "Host Run worktree HEAD changed outside its last verified SBX export.",
      );
    const expectedHostTree =
      durable?.hostResultTree ?? changeExport.manifest.baseTree;
    const hostTree = await hostWorkingTree(
      worktree.canonicalRoot,
      join(fixtureGitDir, "host-observation.index"),
    );
    const alreadyMaterialized = hostTree === imported.resultTree;
    if (hostTree !== expectedHostTree && !alreadyMaterialized)
      throw new Error(
        "Host Run worktree changed outside its last verified SBX export.",
      );
    await hostGit(worktree.canonicalRoot, [
      "fetch",
      "--no-tags",
      imported.fixtureGitDir,
      imported.importedRefs.find((ref) => ref.endsWith("/result")) as string,
    ]);
    const fetchedTree = (
      await hostGit(worktree.canonicalRoot, ["rev-parse", "FETCH_HEAD^{tree}"])
    ).trim();
    if (fetchedTree !== imported.resultTree)
      throw new Error("Controlled host import produced the wrong result tree.");
    if (!alreadyMaterialized) {
      await hostGit(worktree.canonicalRoot, ["read-tree", expectedHostTree]);
      await hostGit(worktree.canonicalRoot, [
        "read-tree",
        "--reset",
        "-u",
        "FETCH_HEAD",
      ]);
      const materializedTree = (
        await hostGit(worktree.canonicalRoot, ["write-tree"])
      ).trim();
      if (materializedTree !== imported.resultTree)
        throw new Error(
          "Host Run worktree did not materialize the verified result tree.",
        );
    }
    if (hostHead !== changeExport.manifest.headCommit)
      await hostGit(worktree.canonicalRoot, [
        "update-ref",
        "HEAD",
        changeExport.manifest.headCommit,
        hostHead,
      ]);
    await hostGit(worktree.canonicalRoot, ["reset", "--mixed", "HEAD"]);
  }

  private async requiredWorktree(
    dispatch: DispatchRecord,
  ): Promise<RunWorktreeRecord> {
    const record = await this.worktrees.verify(
      dispatch.action.execution.execution_workspace.worktree_id,
    );
    if (
      record.state !== "ready" ||
      record.runId !== dispatch.action.run_id ||
      record.bindingId !==
        dispatch.action.execution.execution_workspace.workspace_binding_id
    )
      throw new Error("Run worktree is not an exact ready source boundary.");
    return record;
  }

  private requiredBinding(worktree: RunWorktreeRecord): WorkspaceBindingConfig {
    const binding = this.config.workspaceBindings.find(
      (candidate) => candidate.binding_id === worktree.bindingId,
    );
    if (!binding)
      throw new Error("Run worktree has no active authorized source binding.");
    return binding;
  }

  private requiredBase(dispatch: DispatchRecord): string {
    const worktree = this.worktrees.get(
      dispatch.action.execution.execution_workspace.worktree_id,
    );
    if (!worktree?.baseRevision)
      throw new Error("Run worktree frozen base is unavailable.");
    return worktree.baseRevision;
  }

  private spec(input: {
    runId: string;
    workspaceId: string;
    access: "none" | "read_only" | "read_write";
    sourceIdentity: string;
    frozenBase: string;
    materialization: "frozen_import" | "disposable_fixture";
  }): EnvironmentSpec {
    return {
      workerId: this.config.workerId,
      runId: input.runId,
      workspace: {
        workspaceId: input.workspaceId,
        access: input.access,
        materialization: {
          kind: input.materialization,
          sourceIdentity: input.sourceIdentity,
          frozenBase: { kind: "git_commit", value: input.frozenBase },
        },
      },
      profile: SBX_PI_EXECUTION_PROFILE_V1,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "model_provider",
          targets: SBX_PI_RUNTIME_NETWORK_TARGETS,
        },
      ],
      credentialGrants: [
        {
          grantId: "sbx-host-openai-oauth",
          kind: "openai-codex-oauth",
          scope: "subscription",
        },
      ],
      controlChannels: [{ kind: "worker_file_mailbox_v1", required: true }],
      requiredCapabilities: [
        { kind: "filesystem_namespace", mode: "isolated" },
        { kind: "home", mode: "private" },
        { kind: "host_filesystem", mode: "unexposed" },
        { kind: "container_runtime", mode: "isolated" },
        { kind: "harness_runtime", mode: "pi_native_extensions" },
        { kind: "credentials", mode: "host_proxy_openai_oauth" },
        { kind: "network_policy", mode: "openai_subscription_only" },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
        { kind: "pty_launcher", mode: "available" },
      ],
    };
  }
}

class SbxControlMailboxRelay {
  private stopped = false;
  private operation: Promise<void> | null = null;
  private pollTail: Promise<void> = Promise.resolve();
  private lastRuntimeSequence = 0;
  private lastWorkingSequence = 0;
  private lastWorkingAt: string | null = null;
  private lastAttention = "";
  private lastRecovery = "";
  private readonly processedRequests = new Map<string, string>();
  private consecutiveFailures = 0;
  private failureReported = false;

  constructor(
    private readonly lease: EnvironmentLease,
    private readonly controlRoot: string,
    private readonly lineage: HarnessLineage,
    private readonly host: TerminalSessionBackend,
    private readonly paneId: string,
    private readonly onFailure: () => void,
    private readonly onRecovery: () => void,
  ) {}

  start(): void {
    if (this.operation) return;
    this.stopped = false;
    this.operation = this.loop().finally(() => {
      this.operation = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.operation;
  }

  async refresh(): Promise<void> {
    const operation = this.pollTail.then(() => this.poll());
    this.pollTail = operation.catch(() => undefined);
    await operation;
  }

  activityCursor(): number {
    return this.lastWorkingSequence;
  }

  observedActivityAfter(cursor: number): string | null {
    return this.lastWorkingSequence > cursor ? this.lastWorkingAt : null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.refresh();
        this.consecutiveFailures = 0;
        if (this.failureReported) {
          this.failureReported = false;
          this.onRecovery();
        }
      } catch {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 3 && !this.failureReported) {
          this.failureReported = true;
          this.onFailure();
        }
        // A guest tool call remains fail-closed and times out if the relay is
        // unavailable. Recovery recreates the relay from durable identities.
      }
      if (!this.stopped) await Bun.sleep(100);
    }
  }

  private async poll(): Promise<void> {
    const paths = guestControlPaths(this.controlRoot);
    const result = await this.lease.exec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; root=pathlib.Path(os.environ['QE_ROOT']); req=root/'mailbox'/'requests'; out={'requests':sorted([p.name for p in req.glob('*.json')])[:16] if req.is_dir() else []};\nfor key,name in [('runtime','runtime-state.json'),('attention','attention-control.json'),('recovery','recovery-control.json')]:\n p=root/name\n try:\n  if p.is_file() and p.stat().st_size <= 65536: out[key]=json.loads(p.read_text())\n except Exception: pass\nprint(json.dumps(out,separators=(',',':')))",
      ],
      environment: { QE_ROOT: this.controlRoot },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new Error("SBX control mailbox probe failed.");
    const value = JSON.parse(result.stdout) as {
      requests?: string[];
      runtime?: unknown;
      attention?: unknown;
      recovery?: unknown;
    };
    const requestNames = new Set(value.requests ?? []);
    for (const processed of this.processedRequests.keys())
      if (!requestNames.has(processed))
        this.processedRequests.delete(processed);
    for (const name of requestNames) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const requestPath = posix.join(paths.mailbox, "requests", name);
      const responsePath = posix.join(paths.mailbox, "responses", name);
      const bytes = await this.lease.readFile({
        path: requestPath,
        maxBytes: MAX_MAILBOX_REQUEST_BYTES,
      });
      const requestDigest = digestBytes(bytes);
      if (this.processedRequests.get(name) === requestDigest) continue;
      const response = await forwardHarnessControlPayload(
        controlDescriptorPath(this.lineage),
        new TextDecoder().decode(bytes),
      );
      await this.lease.writeFile({
        path: responsePath,
        data: new TextEncoder().encode(response),
        mode: 0o600,
      });
      this.processedRequests.set(name, requestDigest);
    }
    await this.reportRuntime(value.runtime);
    await this.mirrorControl("attention", value.attention, this.lastAttention);
    await this.mirrorControl("recovery", value.recovery, this.lastRecovery);
  }

  private async reportRuntime(value: unknown): Promise<void> {
    if (!record(value) || value.schemaVersion !== 1) return;
    const sequence = Number(value.sequence);
    const workingSequence = Number(value.lastWorkingSequence);
    const state = value.state;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= this.lastRuntimeSequence ||
      !["idle", "working", "blocked"].includes(String(state))
    )
      return;
    this.lastRuntimeSequence = sequence;
    if (
      Number.isSafeInteger(workingSequence) &&
      workingSequence > this.lastWorkingSequence
    ) {
      this.lastWorkingSequence = workingSequence;
      this.lastWorkingAt =
        typeof value.observedAt === "string"
          ? value.observedAt
          : new Date().toISOString();
    }
    const native = record(value.nativeSession)
      ? value.nativeSession
      : undefined;
    let nativeSession: NativeSessionRef | undefined;
    if (
      native &&
      (native.kind === "id" || native.kind === "path") &&
      typeof native.value === "string"
    )
      nativeSession = {
        source: "pi",
        agent: "pi",
        kind: native.kind,
        value: native.value,
      };
    await this.host.reportAgentState?.({
      paneId: this.paneId,
      state: state as "idle" | "working" | "blocked",
      sequence,
      ...(nativeSession ? { nativeSession } : {}),
    });
  }

  private async mirrorControl(
    kind: "attention" | "recovery",
    value: unknown,
    previous: string,
  ): Promise<void> {
    if (!record(value)) return;
    const encoded = `${JSON.stringify(value)}\n`;
    if (encoded === previous) return;
    const hostPath = join(
      dirname(this.lineage.resultControlPath),
      `${kind}-control.json`,
    );
    await writeAtomic(hostPath, encoded);
    if (kind === "attention") this.lastAttention = encoded;
    else this.lastRecovery = encoded;
  }
}

function sameEnvironmentRef(
  left: EnvironmentLease["ref"],
  right: EnvironmentLease["ref"],
): boolean {
  return (
    left.backendKind === right.backendKind &&
    left.environmentId === right.environmentId &&
    left.incarnation === right.incarnation &&
    left.workerId === right.workerId &&
    left.runId === right.runId &&
    left.profile.id === right.profile.id &&
    left.profile.digest === right.profile.digest
  );
}

function guestControlPaths(root: string) {
  return {
    descriptor: posix.join(root, "harness-control.json"),
    result: posix.join(root, "result-control.json"),
    attention: posix.join(root, "attention-control.json"),
    recovery: posix.join(root, "recovery-control.json"),
    runtimeState: posix.join(root, "runtime-state.json"),
    mailbox: posix.join(root, "mailbox"),
  };
}

function splitConfiguredModel(value: string): {
  provider: string;
  model: string;
} {
  const separator = value.indexOf("/");
  return separator > 0
    ? { provider: value.slice(0, separator), model: value.slice(separator + 1) }
    : { provider: "openai-codex", model: value };
}

function decodeDiscovery(value: string): {
  models: HarnessModelCapability[];
  diagnostics: string[];
  authenticated: boolean;
} {
  const parsed = JSON.parse(value) as {
    schemaVersion?: number;
    authenticated?: boolean;
    diagnostics?: unknown[];
    models?: Array<{
      provider?: unknown;
      model?: unknown;
      displayName?: unknown;
      reasoning?: unknown;
    }>;
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.models))
    throw new Error(
      "In-sandbox Pi discovery returned an incompatible contract.",
    );
  const models = parsed.models.map((model) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.model !== "string" ||
      typeof model.displayName !== "string" ||
      !Array.isArray(model.reasoning) ||
      !model.reasoning.every((item) => typeof item === "string")
    )
      throw new Error("In-sandbox Pi discovery returned a malformed model.");
    return {
      provider: model.provider,
      model: model.model,
      displayName: model.displayName,
      reasoningCapability:
        model.reasoning.length > 0
          ? ({ kind: "enumerated", values: model.reasoning } as const)
          : ({ kind: "unsupported" } as const),
    };
  });
  return {
    models,
    diagnostics: (parsed.diagnostics ?? []).filter(
      (item): item is string => typeof item === "string",
    ),
    authenticated: parsed.authenticated === true && models.length > 0,
  };
}

function physicalExportValue(changeExport: PrivateGitChangeExport): JsonValue {
  return {
    kind: "qe_private_git_export_v1",
    export_id: changeExport.exportId,
    checkpoint_id: changeExport.checkpointId,
    repository_id: changeExport.manifest.repository.repositoryId,
    physical_lineage_id: changeExport.manifest.physicalLineageId,
    environment: {
      backend_kind: changeExport.manifest.environment.backendKind,
      environment_id: changeExport.manifest.environment.environmentId,
      incarnation: changeExport.manifest.environment.incarnation,
    },
    base_commit: changeExport.manifest.baseCommit,
    result_tree: changeExport.manifest.resultTree,
    fingerprint: changeExport.manifest.fingerprint,
    changed_paths: changeExport.manifest.changedPaths.map((item) => ({
      status: item.status,
      path: item.path,
      ...(item.previousPath ? { previous_path: item.previousPath } : {}),
    })),
  };
}

async function hostWorkingTree(
  cwd: string,
  temporaryIndex: string,
): Promise<string> {
  await hostGit(cwd, ["read-tree", "HEAD"], {
    GIT_INDEX_FILE: temporaryIndex,
  });
  await hostGit(cwd, ["add", "-A", "--", "."], {
    GIT_INDEX_FILE: temporaryIndex,
  });
  return (
    await hostGit(cwd, ["write-tree"], { GIT_INDEX_FILE: temporaryIndex })
  ).trim();
}

async function hostGit(
  cwd: string,
  args: string[],
  extraEnvironment: Record<string, string> = {},
): Promise<string> {
  const process = Bun.spawn(
    [
      "/usr/bin/git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: resolve(cwd),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...extraEnvironment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Controlled host Git command failed: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
