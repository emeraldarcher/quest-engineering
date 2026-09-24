import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { WorkerConfig, WorkspaceBindingConfig } from "../config.ts";
import type { DispatchRecord, HarnessLineage } from "../dispatch/registry.ts";
import {
  type AccountAvailabilityContext,
  AccountAvailabilityEvidenceStore,
  newAccountAvailabilityEvidence,
} from "../harnesses/account-availability.ts";
import {
  type AntigravityDiscoveryResult,
  discoverAntigravityModels,
} from "../harnesses/antigravity/discovery.ts";
import type { AntigravityCommandHookSpec } from "../harnesses/antigravity/hook-readiness.ts";
import {
  controlDescriptorPath,
  type StructuredCompletionBoundary,
} from "../harnesses/control/authority.ts";
import {
  forwardHarnessControlPayload,
  HarnessControlClient,
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
import { resolveRunExecutionProfile } from "./profile-resolution.ts";
import { SbxExecutionEnvironmentBackend } from "./sbx-backend.ts";
import {
  SBX_ANTIGRAVITY_EXECUTABLE,
  SBX_CODING_EXECUTION_PROFILE_V1,
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_MIXED_RUNTIME_NETWORK_TARGETS,
  SBX_PI_DISCOVERY_SCRIPT,
  SBX_PI_EXECUTABLE,
} from "./sbx-profile.ts";
import { SbxRunExecutionStore } from "./sbx-run-store.ts";
import type {
  EnvironmentLease,
  EnvironmentSpec,
  HostLaunchDescriptor,
} from "./types.ts";

const MAX_MAILBOX_REQUEST_BYTES = 1024 * 1024;
const PI_EXTENSION_ENTRIES = [
  "step-result-extension.ts",
  "workspace-permission-extension.ts",
  "human-assistance-extension.ts",
  "sbx-herdr-state-extension.ts",
] as const;
const ANTIGRAVITY_CONTROL_ENTRIES = [
  "mcp-server.ts",
  "bridge-cli.ts",
  "sbx-launcher.ts",
] as const;

export interface DiscoveredPiModelCatalog {
  models: HarnessModelCapability[];
  diagnostics: string[];
  /** OAuth/account resource authentication, independent of model count. */
  authenticated: boolean;
  accountScope: string;
  authGeneration: string;
  metadata: {
    authority: "advisory";
    conclusive: false;
    status: number | null;
    observedAt: string;
    modelCount: number | null;
  };
}

export function applyConfiguredPiModelScope(
  discovered: DiscoveredPiModelCatalog,
  configured: readonly { provider: string; model: string }[] | undefined,
): DiscoveredPiModelCatalog {
  const total = discovered.models.length;
  if (configured === undefined)
    return {
      ...discovered,
      models: [...discovered.models],
      authenticated: discovered.authenticated,
      diagnostics: [
        ...discovered.diagnostics,
        total > 0
          ? `QE model scope is omitted; retained all ${total} dynamically discovered model(s).`
          : "Dynamic Pi discovery returned zero compatible models; QE model scope is omitted.",
      ],
    };

  if (configured.length === 0)
    return {
      ...discovered,
      models: [],
      authenticated: discovered.authenticated,
      diagnostics: [
        ...discovered.diagnostics,
        ...(total === 0
          ? ["Dynamic Pi discovery returned zero compatible models."]
          : []),
        `QE model scope is explicitly empty; policy retained 0 of ${total} dynamically discovered model(s).`,
      ],
    };

  const allowed = new Set(
    configured.map((model) => `${model.provider}/${model.model}`),
  );
  const models = discovered.models.filter((model) =>
    allowed.has(`${model.provider}/${model.model}`),
  );
  const diagnostic =
    total === 0
      ? "Dynamic Pi discovery returned zero compatible models; the configured QE model scope could not be applied."
      : models.length === 0
        ? `Configured QE model scope retained 0 of ${total} dynamically discovered model(s); policy excluded the entire discovered catalog.`
        : `Configured QE model scope retained ${models.length} of ${total} dynamically discovered model(s).`;
  return {
    ...discovered,
    models,
    authenticated: discovered.authenticated,
    diagnostics: [...discovered.diagnostics, diagnostic],
  };
}

interface ProviderAvailabilityEvidenceBase {
  provider: string;
  model: string;
  accountScope: string;
  authGeneration: string;
  observedAt: string;
}

export type ProviderAvailabilityEvidence = ProviderAvailabilityEvidenceBase &
  (
    | {
        state: "verified_available";
        code: "provider_model_succeeded";
      }
    | {
        state: "verified_unavailable";
        code: "provider_model_ineligible";
      }
  );

export type ProviderEligibilityFailure = Extract<
  ProviderAvailabilityEvidence,
  { state: "verified_unavailable" }
>;

export interface PreparedSbxHarnessExecution {
  lease: EnvironmentLease;
  workspace: PrivateLineageWorkspace;
  harnessKind: "pi" | "antigravity";
  guestExecutable: string;
  guestHome: string;
  guestLogPath: string | null;
  hostLogPath: string | null;
  hostCwd: string;
  paneEnvironment: Record<string, string>;
  guestEnvironment: Record<string, string>;
  extensionPaths: string[];
  materializedArtifacts: Record<string, MaterializedArtifact>;
  /** Bind exact harness argv to the environment-owned host launcher. */
  launchDescriptor(args: readonly string[]): Promise<HostLaunchDescriptor>;
  syncControl(): Promise<void>;
  installAntigravityHook(spec: AntigravityCommandHookSpec): Promise<void>;
  removeAntigravityHook(name: string): Promise<void>;
  proveAntigravityReadiness(input: {
    spec: AntigravityCommandHookSpec;
    binding: {
      actionId: string;
      attemptId: string;
      lineageId: string;
      resultNonce: string;
    };
    timeoutMs: number;
  }): Promise<void>;
  activityCursor(): Promise<number>;
  observedActivityAfter(cursor: number): string | null;
  providerTurnCursor(): Promise<number>;
  observedProviderTurnAfter(cursor: number): string | null;
  providerEligibilityFailure(): Promise<ProviderEligibilityFailure | null>;
  startRelay(host: TerminalSessionBackend, paneId: string): void;
  awaitAttestation(timeoutMs?: number): Promise<void>;
  stopRelay(awaitNativeIdleMs?: number): Promise<void>;
}

/** Compatibility name for the accepted Pi adapter; the boundary is mixed. */
export type PreparedSbxPiExecution = PreparedSbxHarnessExecution;

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
  guestHome: string;
  guestLogPath: string | null;
  hostLogPath: string | null;
  relay: SbxControlMailboxRelay | null;
}

/**
 * Production mixed-harness execution boundary. There is intentionally no
 * HostNative branch: every Pi or Antigravity execution has the Run's exact SBX
 * lease and a PhysicalLineage private-Git workspace before Herdr can launch it.
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
  private antigravityBundles: Promise<{
    digest: string;
    bundles: ExtensionBundle[];
  }> | null = null;
  private readonly accountAvailability: AccountAvailabilityEvidenceStore;
  constructor(
    private readonly config: WorkerConfig,
    private readonly worktrees: RunWorktreeRegistry,
    options: {
      backend?: SbxExecutionEnvironmentBackend;
      privateGit?: PrivateGitWorkspaceManager;
      store?: SbxRunExecutionStore;
    } = {},
  ) {
    const executionProfile = resolveRunExecutionProfile(
      config.enabledHarnesses ?? ["pi", "antigravity"],
    ).profile;
    this.backend =
      options.backend ??
      new SbxExecutionEnvironmentBackend({
        workerId: config.workerId,
        dataRoot: config.dataRoot,
        executionProfile,
      });
    this.privateGit =
      options.privateGit ??
      new PrivateGitWorkspaceManager({ dataRoot: config.dataRoot });
    this.store = options.store ?? new SbxRunExecutionStore(config.dataRoot);
    this.accountAvailability = new AccountAvailabilityEvidenceStore(
      join(config.dataRoot, "pi-account-availability.json"),
    );
  }

  async discover(): Promise<DiscoveredPiModelCatalog> {
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
      for (const path of this.config.piAccountEvidenceSeedPaths ?? [])
        await this.accountAvailability.importFile(path);
      const context: AccountAvailabilityContext = {
        accountScope: discovered.accountScope,
        authGeneration: discovered.authGeneration,
        profileId: SBX_CODING_EXECUTION_PROFILE_V1.id,
        profileDigest: SBX_CODING_EXECUTION_PROFILE_V1.digest,
      };
      discovered.models = await this.accountAvailability.annotate(
        discovered.models,
        context,
      );
      const configured =
        this.config.executorModels ??
        (this.config.piModel
          ? [splitConfiguredModel(this.config.piModel)]
          : undefined);
      return applyConfiguredPiModelScope(discovered, configured);
    } finally {
      if (lease) await this.backend.remove(lease.ref).catch(() => undefined);
    }
  }

  async discoverAntigravity(): Promise<AntigravityDiscoveryResult> {
    const runId = `antigravity-discovery-${randomUUID()}`;
    const spec = this.spec({
      runId,
      workspaceId: `discovery-${randomUUID()}`,
      access: "none",
      sourceIdentity: "repository-owned-mixed-coding-profile",
      frozenBase: "none",
      materialization: "disposable_fixture",
    });
    let lease: EnvironmentLease | null = null;
    try {
      lease = await this.backend.ensure(spec);
      const discovered = await discoverAntigravityModels(async (args) => {
        const result = await (lease as EnvironmentLease).exec({
          executable: SBX_ANTIGRAVITY_EXECUTABLE,
          args,
          cwd: (lease as EnvironmentLease).paths.workspace,
          environment: {
            HOME: (lease as EnvironmentLease).paths.home,
            BROWSER: "/bin/false",
          },
          timeoutMs: 60_000,
        });
        return result;
      });
      const registration = await lease.exec({
        executable: SBX_ANTIGRAVITY_EXECUTABLE,
        args: ["mcp", "list"],
        environment: { HOME: lease.paths.home, BROWSER: "/bin/false" },
        timeoutMs: 30_000,
      });
      const mcpReady =
        registration.exitCode === 0 &&
        registration.stdout
          .split("\n")
          .some(
            (line) =>
              /^qe\s/.test(line.trim()) &&
              /\bstdio\b/.test(line) &&
              /\benabled\b/.test(line),
          );
      if (mcpReady) discovered.capabilities.push("native.mcp");
      else discovered.missingCapabilities.push("native.mcp");
      discovered.compatible =
        discovered.compatible &&
        mcpReady &&
        lease.ref.profile.id === SBX_CODING_EXECUTION_PROFILE_V1.id &&
        lease.ref.profile.digest === SBX_CODING_EXECUTION_PROFILE_V1.digest;
      discovered.diagnostics.push(
        mcpReady
          ? "The profile-owned qe stdio MCP registration is enabled."
          : "The profile-owned qe stdio MCP registration is missing or disabled.",
        `Runtime provenance: ${lease.ref.profile.id}@${lease.ref.profile.digest}.`,
      );
      discovered.capabilities.sort();
      discovered.missingCapabilities.sort();
      return discovered;
    } finally {
      if (lease) await this.backend.remove(lease.ref).catch(() => undefined);
    }
  }

  private recordProviderEvidence(
    evidence: ProviderAvailabilityEvidence,
  ): Promise<void> {
    return this.accountAvailability.record(
      newAccountAvailabilityEvidence(
        {
          accountScope: evidence.accountScope,
          authGeneration: evidence.authGeneration,
          profileId: SBX_CODING_EXECUTION_PROFILE_V1.id,
          profileDigest: SBX_CODING_EXECUTION_PROFILE_V1.digest,
        },
        { provider: evidence.provider, model: evidence.model },
        evidence.state,
        evidence.state === "verified_available"
          ? "direct_execution_success"
          : "direct_provider_rejection",
        new Date(evidence.observedAt),
      ),
    );
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
  ): Promise<PreparedSbxHarnessExecution> {
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
    const harnessKind = dispatch.action.execution.configuration.harness_kind;
    if (harnessKind !== "pi" && harnessKind !== "antigravity")
      throw new Error(
        `The mixed coding profile cannot launch harness ${harnessKind}.`,
      );
    const controlRoot = posix.join(
      lease.paths.control,
      "lineages",
      digest(lineage.lineageId).slice(0, 32),
    );
    const guestHome =
      harnessKind === "antigravity"
        ? posix.join(
            lease.paths.state,
            "antigravity-lineages",
            digest(lineage.lineageId).slice(0, 32),
            "home",
          )
        : lease.paths.home;
    const guestExecutable =
      harnessKind === "antigravity"
        ? SBX_ANTIGRAVITY_EXECUTABLE
        : SBX_PI_EXECUTABLE;
    const guestLogPath =
      harnessKind === "antigravity"
        ? posix.join(controlRoot, "antigravity.log")
        : null;
    const hostLogPath =
      harnessKind === "antigravity"
        ? join(dirname(lineage.resultControlPath), "antigravity.log")
        : null;
    const extensions =
      harnessKind === "antigravity"
        ? await this.bundledAntigravityControl()
        : await this.bundledExtensions();
    const extensionRoot = posix.join(
      lease.paths.state,
      harnessKind === "antigravity" ? "antigravity-control" : "pi-extensions",
    );
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
        guestHome,
        posix.join(guestHome, ".cache"),
        posix.join(guestHome, ".tmp"),
      ],
    });
    if (harnessKind === "antigravity")
      await this.seedAntigravityHome(lease, guestHome);
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
          "Harness integration changed while crossing the SBX boundary.",
        );
      extensionPaths.push(path);
    }
    const materializedArtifacts = await this.stageArtifacts(
      lease,
      dispatch,
      hostArtifacts,
    );
    const guestPaths = guestControlPaths(controlRoot);
    const attestation = {
      schemaVersion: 1,
      workerId: lease.ref.workerId,
      runId: lease.ref.runId,
      environmentId: lease.ref.environmentId,
      incarnation: lease.ref.incarnation,
      profileId: lease.ref.profile.id,
      profileDigest: lease.ref.profile.digest,
      physicalLineageId: lineage.lineageId,
      workspacePath: workspace.paths.workspace,
      homePath: guestHome,
      harnessKind,
    } as const;
    const ownershipMarkerPath = posix.join(
      lease.paths.state,
      "environment-ownership.json",
    );
    const launchBindingPath = posix.join(controlRoot, "launch-binding.json");
    const launchBindingReceipt = await lease.writeFile({
      path: launchBindingPath,
      data: new TextEncoder().encode(`${JSON.stringify(attestation)}\n`),
      mode: 0o400,
    });
    if (
      launchBindingReceipt.sha256 !== digest(`${JSON.stringify(attestation)}\n`)
    )
      throw environmentLaunchFailure(
        "environment_launch_mismatch",
        "SBX launch-binding marker changed while crossing the environment boundary.",
      );
    const requiredGuestPaths = [
      ownershipMarkerPath,
      launchBindingPath,
      guestExecutable,
      workspace.paths.workspace,
      guestHome,
      controlRoot,
      guestPaths.mailbox,
      ...extensionPaths,
    ];
    await this.validateGuestLaunchPaths(
      lease,
      attestation,
      ownershipMarkerPath,
      launchBindingPath,
      requiredGuestPaths,
      workspace.paths.workspace,
      guestExecutable,
    );
    const guestEnvironment: Record<string, string> = {
      HOME: guestHome,
      XDG_CACHE_HOME: posix.join(guestHome, ".cache"),
      TMPDIR: posix.join(guestHome, ".tmp"),
      BROWSER: "/bin/false",
      QE_HARNESS_CONTROL_PATH: guestPaths.descriptor,
      [SBX_CONTROL_MAILBOX_ENV]: guestPaths.mailbox,
      QE_RESULT_CONTROL_PATH: guestPaths.result,
      QE_ATTENTION_CONTROL_PATH: guestPaths.attention,
      QE_RECOVERY_CONTROL_PATH: guestPaths.recovery,
      QE_SBX_RUNTIME_STATE_PATH: guestPaths.runtimeState,
      QE_HARNESS_MCP_STARTUP_EVIDENCE_PATH: guestPaths.mcpStartup,
      QE_WORKSPACE_ACCESS: access,
      QE_WORKSPACE_ROOT: workspace.paths.workspace,
      ...(harnessKind === "pi"
        ? { QE_ALLOWED_PI_TOOLS: mappedPiTools(dispatch).join(",") }
        : {
            QE_ANTIGRAVITY_EXPECTED_ARGV_JSON: JSON.stringify([
              ...(lineage.nativeSession?.agent === "agy" &&
              lineage.nativeSession.kind === "id"
                ? ["--conversation", lineage.nativeSession.value]
                : []),
              "--model",
              dispatch.action.execution.configuration.model.model,
              ...(typeof dispatch.action.execution.configuration.reasoning ===
              "string"
                ? [
                    "--effort",
                    dispatch.action.execution.configuration.reasoning,
                  ]
                : []),
              "--dangerously-skip-permissions",
              "--log-file",
              guestLogPath as string,
            ]),
          }),
      QE_ARTIFACT_ROOT: posix.join(lease.paths.state, "execution-artifacts"),
      QE_SBX_ATTESTATION_JSON: JSON.stringify(attestation),
      QE_SBX_OWNERSHIP_MARKER_PATH: ownershipMarkerPath,
      QE_SBX_LAUNCH_BINDING_PATH: launchBindingPath,
      QE_SBX_REQUIRED_GUEST_PATHS_JSON: JSON.stringify(requiredGuestPaths),
    };
    const paneEnvironment: Record<string, string> = {};
    const context: RuntimeContext = {
      dispatch,
      lineage,
      lease,
      workspace,
      controlRoot,
      guestHome,
      guestLogPath,
      hostLogPath,
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
    let launchPromise: Promise<HostLaunchDescriptor> | null = null;
    let launchArgvDigest: string | null = null;
    const prepared: PreparedSbxHarnessExecution = {
      lease,
      workspace,
      harnessKind,
      guestExecutable,
      guestHome,
      guestLogPath,
      hostLogPath,
      hostCwd: worktree.canonicalRoot,
      paneEnvironment,
      guestEnvironment,
      extensionPaths,
      materializedArtifacts,
      launchDescriptor: async (args) => {
        const guestArgvSha256 = digest(JSON.stringify([...args]));
        if (launchArgvDigest && launchArgvDigest !== guestArgvSha256)
          throw environmentLaunchFailure(
            "environment_launch_mismatch",
            "The physical lineage requested conflicting harness launch argv.",
          );
        launchArgvDigest = guestArgvSha256;
        const nativeLaunch =
          harnessKind === "antigravity"
            ? {
                executable: "/usr/bin/node",
                args: [
                  posix.join(extensionRoot, "sbx-launcher.mjs"),
                  guestExecutable,
                  ...args,
                ],
              }
            : { executable: guestExecutable, args: [...args] };
        launchPromise ??= lease
          .launcher({
            ...nativeLaunch,
            cwd: workspace.paths.workspace,
            environment: guestEnvironment,
          })
          .then((descriptor) => {
            const launcherProvenance = descriptor.provenance.launcher;
            if (!launcherProvenance)
              throw environmentLaunchFailure(
                "environment_launch_mismatch",
                "The SBX backend omitted exact launcher provenance.",
              );
            const launch: HostLaunchDescriptor = {
              ...descriptor,
              provenance: {
                ...descriptor.provenance,
                binding: {
                  physicalLineageId: lineage.lineageId,
                  workspacePath: workspace.paths.workspace,
                  guestExecutable,
                  guestCwd: workspace.paths.workspace,
                  guestArgvSha256,
                },
              },
            };
            this.store.bindLaunch(
              lineage.lineageId,
              dispatch.action.action_id,
              {
                schemaVersion: 1,
                executable: launch.executable,
                cwd: launch.cwd,
                argvSha256: digest(JSON.stringify([...launch.args])),
                environmentKeys: Object.keys(launch.environment).sort(),
                launcherContractVersion: launcherProvenance.contractVersion,
                launcherEntrypoint: launcherProvenance.entrypoint,
                launcherEntrypointSha256: launcherProvenance.entrypointSha256,
                guestExecutable,
                guestCwd: workspace.paths.workspace,
                guestArgvSha256,
                physicalLineageId: lineage.lineageId,
                environmentId: lease.ref.environmentId,
                incarnation: lease.ref.incarnation,
                profileId: lease.ref.profile.id,
                profileDigest: lease.ref.profile.digest,
              },
            );
            return launch;
          });
        return launchPromise;
      },
      syncControl: () => this.syncControl(context),
      installAntigravityHook: (hook) =>
        this.installAntigravityHook(context, hook, guestHome),
      removeAntigravityHook: (name) =>
        this.removeAntigravityHook(context, name),
      proveAntigravityReadiness: (input) =>
        this.proveAntigravityReadiness(context, input),
      activityCursor: async () => {
        await context.relay?.refresh();
        return context.relay?.activityCursor() ?? 0;
      },
      observedActivityAfter: (cursor) =>
        context.relay?.observedActivityAfter(cursor) ?? null,
      providerTurnCursor: async () => {
        await context.relay?.refresh();
        return context.relay?.providerTurnCursor() ?? 0;
      },
      observedProviderTurnAfter: (cursor) =>
        context.relay?.observedProviderTurnAfter(cursor) ?? null,
      providerEligibilityFailure: () =>
        context.relay?.awaitProviderEligibilityFailureOrIdle() ??
        Promise.resolve(null),
      startRelay: (host, paneId) => {
        if (context.relay) return;
        context.relay = new SbxControlMailboxRelay(
          lease,
          controlRoot,
          lineage,
          host,
          paneId,
          attestation,
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
          async (evidence) => {
            await this.recordProviderEvidence(evidence);
          },
          guestLogPath,
          hostLogPath,
        );
        context.relay.start();
      },
      awaitAttestation: (timeoutMs = 30_000) => {
        if (!context.relay)
          throw environmentLaunchFailure(
            "environment_attestation_failed",
            "The guest attestation relay was not started.",
          );
        return context.relay.awaitAttestation(timeoutMs);
      },
      stopRelay: async (awaitNativeIdleMs = 2_000) => {
        await context.relay?.stop(awaitNativeIdleMs);
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
    const outputs = structuredClone(input.outputs);
    if (!input.dispatch.completionRequirement.physicalExportRequired)
      return outputs;
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
    for (const declaration of input.dispatch.completionRequirement.outputs) {
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

  private async seedAntigravityHome(
    lease: EnvironmentLease,
    guestHome: string,
  ): Promise<void> {
    const result = await lease.workerExec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import os,pathlib,shutil; home=pathlib.Path(os.environ['QE_HOME']); sources=[('/home/agent/.gemini/config/mcp_config.json',home/'.gemini/config/mcp_config.json'),('/home/agent/.gemini/antigravity-cli/antigravity-oauth-token',home/'.gemini/antigravity-cli/antigravity-oauth-token'),('/home/agent/.gemini/antigravity-cli/qe-auth-generation',home/'.gemini/antigravity-cli/qe-auth-generation'),('/home/agent/.gemini/antigravity-cli/qe-account-scope',home/'.gemini/antigravity-cli/qe-account-scope')];\nfor source,target in sources:\n target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,target); os.chown(target,1000,1000); os.chmod(target,0o600)\nfor p in [home,home/'.gemini',home/'.gemini/config',home/'.gemini/antigravity-cli']:\n os.chown(p,1000,1000); os.chmod(p,0o700)",
      ],
      environment: { QE_HOME: guestHome },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new Error("Could not seed the Run-private Antigravity HOME.");
  }

  private async installAntigravityHook(
    context: RuntimeContext,
    spec: AntigravityCommandHookSpec,
    guestHome: string,
  ): Promise<void> {
    if (
      context.dispatch.action.execution.configuration.harness_kind !==
      "antigravity"
    )
      throw new Error("Antigravity hook requested for another harness.");
    const path = antigravityHookPath(guestHome);
    const result = await context.lease.exec({
      executable: "/usr/bin/node",
      args: [
        "-e",
        "const{mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync}=require('node:fs');const{dirname}=require('node:path');const p=process.env.QE_HOOK_PATH;let c={};try{c=JSON.parse(readFileSync(p,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}const s=JSON.parse(process.env.QE_HOOK_SPEC);c[s.name]={...(c[s.name]||{}),[s.event]:[{type:'command',command:s.command,timeout:s.timeoutSeconds}]};mkdirSync(dirname(p),{recursive:true,mode:0o700});const t=p+'.qe-new';writeFileSync(t,JSON.stringify(c,null,2)+'\\n',{mode:0o600});chmodSync(t,0o600);renameSync(t,p)",
      ],
      environment: {
        HOME: guestHome,
        QE_HOOK_PATH: path,
        QE_HOOK_SPEC: JSON.stringify(spec),
      },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new Error(
        "Could not install the Run-private Antigravity Stop hook.",
      );
  }

  private async removeAntigravityHook(
    context: RuntimeContext,
    name: string,
  ): Promise<void> {
    if (
      context.dispatch.action.execution.configuration.harness_kind !==
      "antigravity"
    )
      return;
    const path = antigravityHookPath(context.guestHome);
    await context.lease.exec({
      executable: "/usr/bin/node",
      args: [
        "-e",
        "const{readFileSync,writeFileSync,renameSync,rmSync}=require('node:fs');const p=process.env.QE_HOOK_PATH;try{const c=JSON.parse(readFileSync(p,'utf8'));delete c[process.env.QE_HOOK_NAME];if(Object.keys(c).length===0)rmSync(p,{force:true});else{const t=p+'.qe-new';writeFileSync(t,JSON.stringify(c,null,2)+'\\n',{mode:0o600});renameSync(t,p)}}catch(e){if(e.code!=='ENOENT')throw e}",
      ],
      environment: { QE_HOOK_PATH: path, QE_HOOK_NAME: name },
      timeoutMs: 30_000,
    });
  }

  private async proveAntigravityReadiness(
    context: RuntimeContext,
    input: {
      spec: AntigravityCommandHookSpec;
      binding: {
        actionId: string;
        attemptId: string;
        lineageId: string;
        resultNonce: string;
      };
      timeoutMs: number;
    },
  ): Promise<void> {
    if (!context.guestLogPath || !context.hostLogPath)
      throw new Error("Antigravity readiness has no guest log binding.");
    const paths = guestControlPaths(context.controlRoot);
    const hookContract = await context.lease.exec({
      executable: "/usr/bin/node",
      args: [
        "-e",
        "const{readFileSync}=require('node:fs');const c=JSON.parse(readFileSync(process.env.QE_HOOK_PATH,'utf8'));const s=JSON.parse(process.env.QE_HOOK_SPEC);const a=c?.[s.name]?.[s.event];const ok=Array.isArray(a)&&a.length===1&&a[0]?.type==='command'&&a[0]?.command===s.command&&a[0]?.timeout===s.timeoutSeconds;process.stdout.write(ok?'true':'false')",
      ],
      environment: {
        QE_HOOK_PATH: antigravityHookPath(context.guestHome),
        QE_HOOK_SPEC: JSON.stringify(input.spec),
      },
      timeoutMs: 30_000,
    });
    if (hookContract.stdout !== "true")
      throw new Error(
        "Antigravity's lineage-private Stop hook contract is not exact.",
      );
    const deadline = Date.now() + Math.min(input.timeoutMs, 30_000);
    let mcpReady = false;
    let hookReady = false;
    while (Date.now() < deadline && (!mcpReady || !hookReady)) {
      await context.relay?.refresh();
      const result = await context.lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import hashlib,json,os,pathlib; evidence=pathlib.Path(os.environ['QE_EVIDENCE']); descriptor=os.environ['QE_DESCRIPTOR']; expected=hashlib.sha256(descriptor.encode()).hexdigest(); ok=False\ntry:\n lines=evidence.read_text().splitlines()[-128:]\n for line in reversed(lines):\n  v=json.loads(line); pid=v.get('pid',0); ok=v.get('kind')=='qe_harness_mcp_startup' and v.get('descriptorPathHash')==expected and v.get('bridgeAcceptedContext') is True and isinstance(pid,int) and pid>0;\n  if ok:\n   try:\n    os.kill(pid,0); cmd=(pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\\0',b' ')); env=pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\\0'); ok=b'/qe/state/antigravity-control/mcp-server.mjs' in cmd and f'QE_HARNESS_CONTROL_PATH={descriptor}'.encode() in env\n   except OSError: ok=False\n   break\nexcept Exception: pass\nprint(json.dumps({'ready':ok},separators=(',',':')))",
        ],
        environment: {
          QE_EVIDENCE: paths.mcpStartup,
          QE_DESCRIPTOR: paths.descriptor,
        },
        timeoutMs: 30_000,
      });
      try {
        mcpReady = JSON.parse(result.stdout).ready === true;
      } catch {
        mcpReady = false;
      }
      try {
        const log = await readFile(context.hostLogPath, "utf8");
        hookReady =
          /loaded \d+ named hooks from \d+ hooks\.json file\(s\)/.test(log);
      } catch {
        hookReady = false;
      }
      if (!mcpReady || !hookReady) await Bun.sleep(100);
    }
    if (!mcpReady)
      throw new Error("Antigravity's guest QE MCP child is not alive.");
    if (!hookReady)
      throw new Error("Antigravity did not discover the guest Stop hook.");
    const descriptor = controlDescriptorPath(context.lineage);
    const status = await new HarnessControlClient(
      descriptor,
    ).completionStatus();
    if (
      !status.binding ||
      status.binding.actionId !== input.binding.actionId ||
      status.binding.attemptId !== input.binding.attemptId ||
      status.binding.lineageId !== input.binding.lineageId ||
      status.binding.resultNonce !== input.binding.resultNonce
    )
      throw new Error("Antigravity MCP resolved stale control authority.");
    const hookResult = await context.lease.exec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,subprocess; p=subprocess.run(['/usr/bin/node',os.environ['QE_BRIDGE'],'hook','stop'],input=json.dumps({'conversationId':'00000000-0000-4000-8000-000000000001','executionNum':0,'terminationReason':'qe_zero_inference_readiness','fullyIdle':True,'modelName':'synthetic-no-inference'}),text=True,capture_output=True,env=os.environ); print(json.dumps({'code':p.returncode,'stdout':p.stdout},separators=(',',':')))",
      ],
      environment: {
        ...preparedControlEnvironment(paths),
        QE_BRIDGE: posix.join(
          context.lease.paths.state,
          "antigravity-control",
          "bridge-cli.mjs",
        ),
      },
      timeoutMs: 30_000,
    });
    const synthetic = JSON.parse(hookResult.stdout) as {
      code: number;
      stdout: string;
    };
    const output = JSON.parse(synthetic.stdout || "{}") as Record<
      string,
      unknown
    >;
    if (synthetic.code !== 0 || output.decision !== "continue")
      throw new Error(
        "Antigravity Stop hook did not reach current QE authority.",
      );
  }

  private async bundledAntigravityControl(): Promise<{
    digest: string;
    bundles: ExtensionBundle[];
  }> {
    if (this.antigravityBundles) return this.antigravityBundles;
    const entrypoints = ANTIGRAVITY_CONTROL_ENTRIES.map((name) =>
      resolve(import.meta.dir, `../harnesses/antigravity/${name}`),
    );
    // MCP and bridge live in the generic control directory.
    entrypoints[0] = resolve(
      import.meta.dir,
      "../harnesses/control/mcp-server.ts",
    );
    entrypoints[1] = resolve(
      import.meta.dir,
      "../harnesses/control/bridge-cli.ts",
    );
    this.antigravityBundles = this.bundleEntrypoints(
      entrypoints,
      "Antigravity control",
    );
    return this.antigravityBundles;
  }

  private async bundledExtensions(): Promise<{
    digest: string;
    bundles: ExtensionBundle[];
  }> {
    if (this.extensionBundles) return this.extensionBundles;
    const entrypoints = PI_EXTENSION_ENTRIES.map((name) =>
      resolve(import.meta.dir, `../harnesses/pi/${name}`),
    );
    this.extensionBundles = this.bundleEntrypoints(
      entrypoints,
      "Pi extensions",
    );
    return this.extensionBundles;
  }

  private async bundleEntrypoints(
    entrypoints: string[],
    label: string,
  ): Promise<{ digest: string; bundles: ExtensionBundle[] }> {
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
        `Failed to build immutable ${label}: ${result.logs.join(" ")}`,
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
  }

  private async validateGuestLaunchPaths(
    lease: EnvironmentLease,
    attestation: Record<string, string | number>,
    ownershipMarkerPath: string,
    launchBindingPath: string,
    requiredPaths: readonly string[],
    workspacePath: string,
    guestExecutable: string,
  ): Promise<void> {
    const result = await lease.exec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib,sys; expected=json.loads(os.environ['QE_EXPECTED']); marker=json.loads(pathlib.Path(os.environ['QE_MARKER']).read_text()); binding=json.loads(pathlib.Path(os.environ['QE_BINDING']).read_text()); keys=('workerId','runId','environmentId','incarnation','profileId','profileDigest'); bad=[k for k in keys if marker.get(k)!=expected.get(k)]; binding_bad=[k for k,v in expected.items() if binding.get(k)!=v]; paths=json.loads(os.environ['QE_PATHS']); missing=[p for p in paths if not pathlib.Path(p).exists()]; exe=os.environ['QE_EXECUTABLE']; ok=os.path.isfile(exe) and os.access(exe,os.X_OK) and pathlib.Path(os.environ['QE_WORKSPACE']).is_dir(); print(json.dumps({'bad':bad,'binding_bad':binding_bad,'missing':missing,'executable':ok},separators=(',',':'))); sys.exit(0 if not bad and not binding_bad and not missing and ok else 41)",
      ],
      environment: {
        QE_EXPECTED: JSON.stringify(attestation),
        QE_MARKER: ownershipMarkerPath,
        QE_BINDING: launchBindingPath,
        QE_PATHS: JSON.stringify(requiredPaths),
        QE_EXECUTABLE: guestExecutable,
        QE_WORKSPACE: workspacePath,
      },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw environmentLaunchFailure(
        "environment_launch_mismatch",
        `SBX guest launch-path validation failed: ${result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
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
      profile: SBX_CODING_EXECUTION_PROFILE_V1,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "model_provider",
          targets: SBX_MIXED_RUNTIME_NETWORK_TARGETS,
        },
      ],
      credentialGrants: [
        {
          grantId: "sbx-host-openai-oauth",
          kind: "openai-codex-oauth",
          scope: "subscription",
        },
        {
          grantId: "sbx-host-antigravity-oauth",
          kind: "antigravity-oauth",
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
        {
          kind: "harness_runtime",
          mode: "antigravity_capability_contract_v1",
        },
        {
          kind: "credentials",
          mode: "host_mixed_oauth_dynamic_proxies",
        },
        {
          kind: "network_policy",
          mode: "mixed_subscription_providers_only",
        },
        { kind: "control_channel", mode: "worker_file_mailbox_v1" },
        { kind: "pty_launcher", mode: "available" },
      ],
    };
  }
}

export class SbxControlMailboxRelay {
  private stopped = false;
  private operation: Promise<void> | null = null;
  private pollTail: Promise<void> = Promise.resolve();
  private lastRuntimeSequence = 0;
  private lastRuntimeState: "idle" | "working" | "blocked" | null = null;
  private lastWorkingSequence = 0;
  private lastWorkingAt: string | null = null;
  private lastProviderTurnSequence = 0;
  private lastProviderTurnAt: string | null = null;
  private providerFailure: ProviderEligibilityFailure | null = null;
  private lastProviderEvidence = "";
  private lastAttention = "";
  private lastRecovery = "";
  private readonly processedRequests = new Map<string, string>();
  private consecutiveFailures = 0;
  private failureReported = false;
  private attestationState: "pending" | "passed" | "failed" = "pending";
  private attestationFailure: string | null = null;
  private guestLogOffset = 0;
  private guestLogMirrored = false;

  constructor(
    private readonly lease: EnvironmentLease,
    private readonly controlRoot: string,
    private readonly lineage: HarnessLineage,
    private readonly host: TerminalSessionBackend,
    private readonly paneId: string,
    private readonly expectedAttestation: Record<string, string | number>,
    private readonly onFailure: () => void,
    private readonly onRecovery: () => void,
    private readonly onProviderEvidence: (
      evidence: ProviderAvailabilityEvidence,
    ) => Promise<void> = async () => undefined,
    private readonly guestLogPath: string | null = null,
    private readonly hostLogPath: string | null = null,
  ) {}

  start(): void {
    if (this.operation) return;
    this.stopped = false;
    this.operation = this.loop().finally(() => {
      this.operation = null;
    });
  }

  async stop(awaitNativeIdleMs = 2_000): Promise<void> {
    // Keep mailbox servicing and guest-native lifecycle publication alive while
    // a completion acknowledgement can still cause Pi's final agent_settled.
    // This is deliberately separate from semantic Attempt settlement.
    const deadline = Date.now() + Math.max(0, awaitNativeIdleMs);
    while (
      this.lastRuntimeState === "working" &&
      Date.now() < deadline &&
      !this.stopped
    ) {
      try {
        await this.refresh();
        this.consecutiveFailures = 0;
      } catch {
        this.onFailure();
        break;
      }
      if (this.lastRuntimeState === "working") await Bun.sleep(50);
    }
    this.stopped = true;
    await this.operation;
    // One serialized final poll drains a racing mailbox request or idle event.
    try {
      await this.refresh();
      this.consecutiveFailures = 0;
    } catch {
      this.onFailure();
    }
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

  providerTurnCursor(): number {
    return this.lastProviderTurnSequence;
  }

  observedProviderTurnAfter(cursor: number): string | null {
    return this.lastProviderTurnSequence > cursor
      ? this.lastProviderTurnAt
      : null;
  }

  providerEligibilityFailure(): ProviderEligibilityFailure | null {
    return this.providerFailure ? { ...this.providerFailure } : null;
  }

  async awaitProviderEligibilityFailureOrIdle(
    timeoutMs = 2_000,
  ): Promise<ProviderEligibilityFailure | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      await this.refresh();
      if (this.providerFailure) return { ...this.providerFailure };
      if (this.lastRuntimeState && this.lastRuntimeState !== "working")
        return null;
      if (Date.now() < deadline) await Bun.sleep(50);
    } while (Date.now() < deadline);
    return null;
  }

  async awaitAttestation(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.attestationState === "pending" && Date.now() < deadline) {
      await this.refresh().catch(() => undefined);
      if (this.attestationState === "pending") await Bun.sleep(50);
    }
    if (this.attestationState !== "passed")
      throw environmentLaunchFailure(
        "environment_attestation_failed",
        this.attestationFailure ??
          "The exact SBX Run/environment/lineage attestation did not arrive before the launch deadline.",
      );
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
        "import base64,json,os,pathlib; root=pathlib.Path(os.environ['QE_ROOT']); req=root/'mailbox'/'requests'; out={'requests':sorted([p.name for p in req.glob('*.json')])[:16] if req.is_dir() else []};\nfor key,name in [('runtime','runtime-state.json'),('attention','attention-control.json'),('recovery','recovery-control.json')]:\n p=root/name\n try:\n  if p.is_file() and p.stat().st_size <= 65536: out[key]=json.loads(p.read_text())\n except Exception: pass\ntry:\n p=pathlib.Path(os.environ['QE_LOG']); offset=int(os.environ['QE_LOG_OFFSET']); size=p.stat().st_size if p.is_file() else 0; start=offset if size>=offset else 0\n if p.is_file():\n  with p.open('rb') as f: f.seek(start); chunk=f.read(524288)\n  out.update({'logChunk':base64.b64encode(chunk).decode(),'logOffset':start+len(chunk),'logReset':start==0})\nexcept Exception: pass\nprint(json.dumps(out,separators=(',',':')))",
      ],
      environment: {
        QE_ROOT: this.controlRoot,
        QE_LOG: this.guestLogPath ?? "/qe/no-antigravity-log",
        QE_LOG_OFFSET: String(this.guestLogOffset),
      },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new Error("SBX control mailbox probe failed.");
    const value = JSON.parse(result.stdout) as {
      requests?: string[];
      runtime?: unknown;
      attention?: unknown;
      recovery?: unknown;
      logChunk?: unknown;
      logOffset?: unknown;
      logReset?: unknown;
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
    if (
      this.hostLogPath &&
      typeof value.logChunk === "string" &&
      Number.isSafeInteger(value.logOffset) &&
      Number(value.logOffset) >= 0
    ) {
      const chunk = new Uint8Array(Buffer.from(value.logChunk, "base64"));
      if (!this.guestLogMirrored || value.logReset === true)
        await writeAtomic(this.hostLogPath, chunk);
      else if (chunk.length > 0) await appendFile(this.hostLogPath, chunk);
      this.guestLogMirrored = true;
      this.guestLogOffset = Number(value.logOffset);
    }
    await this.reportRuntime(value.runtime);
    await this.mirrorControl("attention", value.attention, this.lastAttention);
    await this.mirrorControl("recovery", value.recovery, this.lastRecovery);
  }

  private async reportRuntime(value: unknown): Promise<void> {
    if (!record(value) || value.schemaVersion !== 1) return;
    const reportedFailure =
      typeof value.attestationFailure === "string"
        ? value.attestationFailure
        : null;
    const observedAttestation = record(value.attestation)
      ? value.attestation
      : null;
    if (
      reportedFailure ||
      !observedAttestation ||
      !sameAttestation(this.expectedAttestation, observedAttestation)
    ) {
      this.attestationState = "failed";
      this.attestationFailure = reportedFailure
        ? `Guest environment attestation failed: ${reportedFailure}`
        : "Guest environment attestation did not match the exact Run, environment incarnation, profile, lineage, and workspace binding.";
      throw environmentLaunchFailure(
        "environment_attestation_failed",
        this.attestationFailure,
      );
    }
    this.attestationState = "passed";
    const sequence = Number(value.sequence);
    const workingSequence = Number(value.lastWorkingSequence);
    const providerTurnSequence = Number(value.providerTurnSequence ?? 0);
    const state = value.state;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= this.lastRuntimeSequence ||
      !["idle", "working", "blocked"].includes(String(state))
    )
      return;
    this.lastRuntimeSequence = sequence;
    this.lastRuntimeState = state as "idle" | "working" | "blocked";
    const providerEvidence = decodeProviderAvailabilityEvidence(
      value.providerEvidence,
    );
    const encodedProviderEvidence = providerEvidence
      ? JSON.stringify(providerEvidence)
      : "";
    if (
      providerEvidence &&
      encodedProviderEvidence !== this.lastProviderEvidence
    ) {
      await this.onProviderEvidence(providerEvidence);
      this.lastProviderEvidence = encodedProviderEvidence;
      if (providerEvidence.state === "verified_unavailable")
        this.providerFailure = providerEvidence;
    }
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
    if (
      Number.isSafeInteger(providerTurnSequence) &&
      providerTurnSequence > this.lastProviderTurnSequence
    ) {
      this.lastProviderTurnSequence = providerTurnSequence;
      this.lastProviderTurnAt =
        typeof value.providerTurnSettledAt === "string"
          ? value.providerTurnSettledAt
          : typeof value.observedAt === "string"
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
    mcpStartup: posix.join(root, "mcp-startup.jsonl"),
    mailbox: posix.join(root, "mailbox"),
  };
}

function antigravityHookPath(home: string): string {
  return posix.join(home, ".gemini", "config", "hooks.json");
}

function preparedControlEnvironment(
  paths: ReturnType<typeof guestControlPaths>,
): Record<string, string> {
  return {
    QE_HARNESS_CONTROL_PATH: paths.descriptor,
    [SBX_CONTROL_MAILBOX_ENV]: paths.mailbox,
    QE_RESULT_CONTROL_PATH: paths.result,
    QE_ATTENTION_CONTROL_PATH: paths.attention,
    QE_RECOVERY_CONTROL_PATH: paths.recovery,
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

function decodeDiscovery(value: string): DiscoveredPiModelCatalog {
  const parsed = JSON.parse(value) as {
    schemaVersion?: number;
    authenticated?: boolean;
    accountScope?: unknown;
    authGeneration?: unknown;
    diagnostics?: unknown[];
    metadata?: Record<string, unknown>;
    models?: Array<{
      provider?: unknown;
      model?: unknown;
      displayName?: unknown;
      reasoning?: unknown;
      accountAvailability?: unknown;
    }>;
  };
  const metadata = parsed.metadata;
  if (
    parsed.schemaVersion !== 3 ||
    parsed.authenticated !== true ||
    typeof parsed.accountScope !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.accountScope) ||
    typeof parsed.authGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.authGeneration) ||
    !metadata ||
    metadata.authority !== "advisory" ||
    metadata.conclusive !== false ||
    (metadata.status !== null && typeof metadata.status !== "number") ||
    typeof metadata.observedAt !== "string" ||
    (metadata.modelCount !== null && typeof metadata.modelCount !== "number") ||
    !Array.isArray(parsed.models)
  )
    throw new Error(
      "In-sandbox Pi discovery returned an incompatible runtime-catalog contract.",
    );
  const models = parsed.models.map((model) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.model !== "string" ||
      typeof model.displayName !== "string" ||
      model.accountAvailability !== "unknown" ||
      !Array.isArray(model.reasoning) ||
      !model.reasoning.every((item) => typeof item === "string")
    )
      throw new Error("In-sandbox Pi discovery returned a malformed model.");
    return {
      provider: model.provider,
      model: model.model,
      displayName: model.displayName,
      accountAvailability: "unknown" as const,
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
    authenticated: true,
    accountScope: parsed.accountScope,
    authGeneration: parsed.authGeneration,
    metadata: {
      authority: "advisory",
      conclusive: false,
      status: metadata.status as number | null,
      observedAt: metadata.observedAt as string,
      modelCount: metadata.modelCount as number | null,
    },
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

async function writeAtomic(
  path: string,
  value: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeProviderAvailabilityEvidence(
  value: unknown,
): ProviderAvailabilityEvidence | null {
  if (!record(value)) return null;
  if (
    (value.state !== "verified_available" &&
      value.state !== "verified_unavailable") ||
    (value.code !== "provider_model_succeeded" &&
      value.code !== "provider_model_ineligible") ||
    (value.state === "verified_available" &&
      value.code !== "provider_model_succeeded") ||
    (value.state === "verified_unavailable" &&
      value.code !== "provider_model_ineligible") ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.accountScope !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.accountScope) ||
    typeof value.authGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.authGeneration) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return null;
  const identity = {
    provider: value.provider,
    model: value.model,
    accountScope: value.accountScope,
    authGeneration: value.authGeneration,
    observedAt: value.observedAt,
  };
  return value.state === "verified_available"
    ? {
        ...identity,
        state: "verified_available",
        code: "provider_model_succeeded",
      }
    : {
        ...identity,
        state: "verified_unavailable",
        code: "provider_model_ineligible",
      };
}

function sameAttestation(
  expected: Record<string, string | number>,
  observed: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => observed[key] === value,
  );
}

function environmentLaunchFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
