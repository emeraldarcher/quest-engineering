import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import type {
  EnvironmentCommandResult,
  EnvironmentLease,
  EnvironmentRef,
} from "../execution-environment/types.ts";
import {
  type PrivateCheckpointRecord,
  PrivateGitStore,
  type PrivateRepositoryRecord,
  type PrivateWorkspaceRecord,
} from "./private-git-store.ts";

const GIT = "/usr/bin/git";
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const SOURCE_BUNDLE_REF_PREFIX = "refs/qe/imports";
const CHECKPOINT_REF_PREFIX = "refs/qe/checkpoints";
const SNAPSHOT_NAME = "Quest Engineering Worker Snapshot";
const SNAPSHOT_EMAIL = "qe-worker@local";
const AGENT_NAME = "Quest Engineering Agent";
const AGENT_EMAIL = "qe-agent@local";
const DETERMINISTIC_GIT_DATE = "2000-01-01T00:00:00Z";

export interface RepositoryPublicationMetadata {
  /** Credential-free informational URL. It is not installed as a guest remote. */
  url: string;
  defaultBranch?: string;
}

export interface RepositorySourceRequest {
  repositoryId: string;
  /** Stable authoritative QE identifier. Never inferred from a guest path. */
  canonicalSourceIdentifier: string;
  /** Worker-only authorized infrastructure path; never copied into the guest. */
  hostRepositoryRoot: string;
  /** Full immutable object ID, never a branch or agent-supplied ref. */
  frozenBaseCommit: string;
  provenance: {
    kind: "authorized_local_object_database" | "authorized_remote_cache";
    detail?: string;
  };
  publication?: RepositoryPublicationMetadata;
}

export interface RepositorySourceIdentity {
  schemaVersion: 1;
  repositoryId: string;
  canonicalSourceIdentifier: string;
  baseCommit: string;
  baseTree: string;
  objectFormat: "sha1" | "sha256";
  repositoryFormatVersion: number;
  materializationMethod: "git_bundle_v1";
  provenance: RepositorySourceRequest["provenance"];
  publication?: RepositoryPublicationMetadata;
}

export interface PrivateGitPathMap {
  repository: string;
  workspace: string;
  runtimeHome: string;
  runtimeCache: string;
  runtimeTemp: string;
  workerState: string;
}

export interface MaterializedPrivateRepository {
  physicalId: string;
  environmentRef: EnvironmentRef;
  source: RepositorySourceIdentity;
  sourceDigest: string;
  importBundleSha256: string;
  gitDir: string;
}

export interface PrivateLineageWorkspace {
  physicalId: string;
  environmentRef: EnvironmentRef;
  repositoryPhysicalId: string;
  repositoryId: string;
  physicalLineageId: string;
  access: "read_only" | "read_write";
  branchRef: string;
  paths: PrivateGitPathMap;
}

export interface WorkspaceFingerprint {
  schemaVersion: 1;
  digest: string;
  baseCommit: string;
  headCommit: string;
  headTree: string;
  indexTree: string;
  resultTree: string;
  untrackedPaths: string[];
  changedPaths: ChangePath[];
}

export interface ChangePath {
  status: string;
  path: string;
  previousPath?: string;
}

export interface PrivateGitCheckpointManifest {
  schemaVersion: 1;
  kind: "qe_private_git_change_export";
  repository: RepositorySourceIdentity;
  sourceDigest: string;
  environment: {
    backendKind: string;
    environmentId: string;
    incarnation: string;
    workerId: string;
    runId: string;
  };
  physicalLineageId: string;
  access: "read_only" | "read_write";
  baseCommit: string;
  baseTree: string;
  headCommit: string;
  headTree: string;
  indexCommit: string;
  indexTree: string;
  resultCommit: string;
  resultTree: string;
  fingerprint: string;
  untrackedPaths: string[];
  changedPaths: ChangePath[];
  refs: {
    base: string;
    head: string;
    index: string;
    result: string;
  };
  bundle: {
    sha256: string;
    byteLength: number;
  };
}

export interface PrivateGitChangeExport {
  exportId: string;
  checkpointId: string;
  manifest: PrivateGitCheckpointManifest;
  /** Worker-private CAS path. Never exposed to the sandbox agent. */
  bundlePath: string;
}

export interface ChangeSetPhysicalContract {
  repositoryId: string;
  baseCommit: string;
  /** If present, exact Worker-observed changed paths must match. */
  expectedChangedPaths?: readonly string[];
}

export interface HostImportResult {
  exportId: string;
  fixtureGitDir: string;
  baseCommit: string;
  resultCommit: string;
  resultTree: string;
  importedRefs: string[];
  changedPaths: ChangePath[];
}

export type PrivateGitErrorCode =
  | "invalid_source_identity"
  | "source_repository_mismatch"
  | "base_commit_mismatch"
  | "source_objects_missing"
  | "unsupported_submodules"
  | "unsupported_lfs"
  | "unsafe_repository_path"
  | "repository_identity_conflict"
  | "private_repository_missing"
  | "private_repository_mismatch"
  | "workspace_identity_conflict"
  | "private_workspace_missing"
  | "private_workspace_mismatch"
  | "workspace_access_violation"
  | "bundle_invalid"
  | "unexpected_bundle_refs"
  | "fingerprint_mismatch"
  | "change_set_contract_mismatch"
  | "host_import_mismatch"
  | "private_git_operation_failed";

export class PrivateGitError extends Error {
  constructor(
    readonly code: PrivateGitErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface SourceBundle {
  identity: RepositorySourceIdentity;
  sourceDigest: string;
  sourceJson: string;
  ref: string;
  bytes: Uint8Array;
  sha256: string;
}

interface SnapshotState {
  fingerprint: WorkspaceFingerprint;
  indexCommit: string;
  resultCommit: string;
}

interface PrivateLayout {
  root: string;
  repositories: string;
  workspaces: string;
  state: string;
  imports: string;
  exports: string;
  runtime: string;
}

export interface PrivateGitWorkspaceManagerOptions {
  dataRoot: string;
  store?: PrivateGitStore;
}

/**
 * Worker-owned private Git boundary layered above an EnvironmentLease.
 * It is deliberately not imported by dispatch or either harness in Phase 3.
 */
export class PrivateGitWorkspaceManager {
  private readonly store: PrivateGitStore;
  private readonly artifactRoot: string;
  private readonly stagingRoot: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: PrivateGitWorkspaceManagerOptions) {
    this.store = options.store ?? new PrivateGitStore(options.dataRoot);
    this.artifactRoot = join(options.dataRoot, "private-git-artifacts");
    this.stagingRoot = join(options.dataRoot, "private-git-staging");
  }

  close(): void {
    this.store.close();
  }

  async materializeSource(input: {
    lease: EnvironmentLease;
    source: RepositorySourceRequest;
  }): Promise<MaterializedPrivateRepository> {
    return this.withLease(input.lease, input.source.repositoryId, async () => {
      const bundle = await createSourceBundle(input.source, this.stagingRoot);
      const layout = privateLayout(input.lease);
      const repositoryKey = digest(input.source.repositoryId).slice(0, 24);
      const gitDir = posix.join(layout.repositories, `${repositoryKey}.git`);
      const claimInput = {
        recordId: randomUUID(),
        backendKind: input.lease.ref.backendKind,
        environmentId: input.lease.ref.environmentId,
        incarnation: input.lease.ref.incarnation,
        workerId: input.lease.ref.workerId,
        runId: input.lease.ref.runId,
        repositoryId: bundle.identity.repositoryId,
        sourceDigest: bundle.sourceDigest,
        sourceJson: bundle.sourceJson,
        baseCommit: bundle.identity.baseCommit,
        baseTree: bundle.identity.baseTree,
        importBundleSha256: bundle.sha256,
        guestGitDir: gitDir,
      };
      let claim: ReturnType<PrivateGitStore["claimRepository"]>;
      try {
        claim = this.store.claimRepository(claimInput);
      } catch (error) {
        throw coded("repository_identity_conflict", errorMessage(error));
      }
      if (claim.record.state === "attention_required")
        throw coded(
          "private_repository_mismatch",
          `Private repository requires attention: ${claim.record.failureCode ?? "unknown"}.`,
        );
      if (claim.record.state === "ready") {
        await this.verifyRepository(input.lease, claim.record);
        return materializedRepository(claim.record, input.lease);
      }

      try {
        const existing = await this.inspectGuestRepository(
          input.lease,
          claim.record,
        );
        if (existing === "exact") {
          const ready = this.store.markRepositoryReady(claim.record.recordId);
          return materializedRepository(ready, input.lease);
        }
        if (existing === "conflict")
          throw coded(
            "private_repository_mismatch",
            "Guest private repository conflicts with durable materialization intent.",
          );
        await this.initializeGuestRepository(input.lease, claim.record, bundle);
        const ready = this.store.markRepositoryReady(claim.record.recordId);
        return materializedRepository(ready, input.lease);
      } catch (error) {
        this.store.markRepositoryAttention(
          claim.record.recordId,
          privateCode(error),
        );
        throw normalizePrivate(error);
      }
    });
  }

  async ensureWorktree(input: {
    lease: EnvironmentLease;
    repositoryId: string;
    physicalLineageId: string;
    access: "read_only" | "read_write";
  }): Promise<PrivateLineageWorkspace> {
    const repository = this.requiredRepository(input.lease, input.repositoryId);
    return this.withLease(
      input.lease,
      `${input.repositoryId}\0${input.physicalLineageId}`,
      async () =>
        this.createWorkspace({
          lease: input.lease,
          repository,
          physicalLineageId: input.physicalLineageId,
          access: input.access,
          startCommit: repository.baseCommit,
          applyPermissions: true,
        }),
    );
  }

  async fingerprint(input: {
    lease: EnvironmentLease;
    physicalLineageId: string;
  }): Promise<WorkspaceFingerprint> {
    const workspace = this.requiredWorkspace(
      input.lease,
      input.physicalLineageId,
    );
    const repository = this.requiredRepositoryRecord(
      workspace.repositoryRecordId,
    );
    await this.verifyWorkspace(input.lease, workspace, repository);
    const fingerprint = await this.computeFingerprint(
      input.lease,
      workspace,
      repository,
    );
    this.store.updateWorkspaceState(workspace.recordId, fingerprint.digest);
    return fingerprint;
  }

  async checkpoint(input: {
    lease: EnvironmentLease;
    physicalLineageId: string;
    contract: ChangeSetPhysicalContract;
  }): Promise<PrivateGitChangeExport> {
    const workspace = this.requiredWorkspace(
      input.lease,
      input.physicalLineageId,
    );
    const repository = this.requiredRepositoryRecord(
      workspace.repositoryRecordId,
    );
    if (
      input.contract.repositoryId !== repository.repositoryId ||
      input.contract.baseCommit !== repository.baseCommit
    )
      throw coded(
        "change_set_contract_mismatch",
        "Declared Change Set repository or frozen base does not match physical state.",
      );
    return this.withLease(
      input.lease,
      `${repository.repositoryId}\0${workspace.physicalLineageId}\0checkpoint`,
      async () => {
        await this.verifyWorkspace(input.lease, workspace, repository);
        const state = await this.createSnapshotState(
          input.lease,
          workspace,
          repository,
        );
        assertChangeContract(input.contract, state.fingerprint.changedPaths);
        const checkpointId = digest(
          canonicalJson({
            schemaVersion: 1,
            sourceDigest: repository.sourceDigest,
            physicalLineageId: workspace.physicalLineageId,
            fingerprint: state.fingerprint,
            indexCommit: state.indexCommit,
            resultCommit: state.resultCommit,
          }),
        );
        const persisted = this.store.checkpoint(checkpointId);
        if (persisted) {
          const loaded = await this.loadPersistedExport(persisted);
          this.store.updateWorkspaceState(
            workspace.recordId,
            state.fingerprint.digest,
            checkpointId,
          );
          return loaded;
        }
        const refs = checkpointRefs(checkpointId);
        await this.ensureCheckpointRefs(input.lease, repository, refs, state);
        const bundlePath = posix.join(
          privateLayout(input.lease).exports,
          `${checkpointId}.bundle`,
        );
        await runGuestGit(input.lease, repository.guestGitDir, [
          "-c",
          "pack.threads=1",
          "-c",
          "pack.useBitmaps=false",
          "bundle",
          "create",
          bundlePath,
          refs.base,
          refs.head,
          refs.index,
          refs.result,
        ]);
        await runGuestGit(input.lease, repository.guestGitDir, [
          "bundle",
          "verify",
          bundlePath,
        ]);
        const heads = await guestBundleHeads(input.lease, bundlePath);
        assertExactHeads(heads, {
          [refs.base]: repository.baseCommit,
          [refs.head]: state.fingerprint.headCommit,
          [refs.index]: state.indexCommit,
          [refs.result]: state.resultCommit,
        });
        const bytes = await input.lease.readFile({
          path: bundlePath,
          maxBytes: MAX_BUNDLE_BYTES,
        });
        const bundleSha256 = digestBytes(bytes);
        const manifestWithoutBundle: Omit<
          PrivateGitCheckpointManifest,
          "bundle"
        > = {
          schemaVersion: 1,
          kind: "qe_private_git_change_export",
          repository: decodeSource(repository.sourceJson),
          sourceDigest: repository.sourceDigest,
          environment: {
            backendKind: workspace.backendKind,
            environmentId: workspace.environmentId,
            incarnation: workspace.incarnation,
            workerId: workspace.workerId,
            runId: workspace.runId,
          },
          physicalLineageId: workspace.physicalLineageId,
          access: workspace.access,
          baseCommit: repository.baseCommit,
          baseTree: repository.baseTree,
          headCommit: state.fingerprint.headCommit,
          headTree: state.fingerprint.headTree,
          indexCommit: state.indexCommit,
          indexTree: state.fingerprint.indexTree,
          resultCommit: state.resultCommit,
          resultTree: state.fingerprint.resultTree,
          fingerprint: state.fingerprint.digest,
          untrackedPaths: [...state.fingerprint.untrackedPaths],
          changedPaths: state.fingerprint.changedPaths.map((item) => ({
            ...item,
          })),
          refs,
        };
        const manifest: PrivateGitCheckpointManifest = {
          ...manifestWithoutBundle,
          bundle: { sha256: bundleSha256, byteLength: bytes.byteLength },
        };
        const manifestJson = canonicalJson(manifest);
        const exportId = digest(manifestJson);
        const hostBundlePath = await this.persistArtifact(
          exportId,
          bundleSha256,
          bytes,
          manifestJson,
        );
        const record = this.store.persistCheckpoint({
          checkpointId,
          workspaceRecordId: workspace.recordId,
          fingerprint: state.fingerprint.digest,
          exportId,
          bundleSha256,
          bundleBytes: bytes.byteLength,
          artifactPath: hostBundlePath,
          manifestJson,
          createdAt: new Date().toISOString(),
        });
        this.store.updateWorkspaceState(
          workspace.recordId,
          state.fingerprint.digest,
          checkpointId,
        );
        return checkpointExport(record);
      },
    );
  }

  async restoreCheckpoint(input: {
    lease: EnvironmentLease;
    changeExport: PrivateGitChangeExport;
    physicalLineageId: string;
    access: "read_only" | "read_write";
  }): Promise<PrivateLineageWorkspace> {
    const validated = await validateExportFiles(input.changeExport);
    const manifest = validated.manifest;
    return this.withLease(
      input.lease,
      `${manifest.repository.repositoryId}\0${input.physicalLineageId}\0restore`,
      async () => {
        const repository = await this.materializeCheckpointRepository(
          input.lease,
          validated,
        );
        const workspace = await this.createWorkspace({
          lease: input.lease,
          repository,
          physicalLineageId: input.physicalLineageId,
          access: input.access,
          startCommit: manifest.headCommit,
          applyPermissions: false,
        });
        await runGuestGit(input.lease, workspace.paths.workspace, [
          "read-tree",
          "--reset",
          "-u",
          manifest.resultCommit,
        ]);
        await runGuestGit(input.lease, workspace.paths.workspace, [
          "read-tree",
          manifest.indexTree,
        ]);
        if (input.access === "read_only")
          await applyReadOnlyPermissions(
            input.lease,
            workspace.paths.workspace,
          );
        const workspaceRecord = this.requiredWorkspace(
          input.lease,
          input.physicalLineageId,
        );
        const fingerprint = await this.computeFingerprint(
          input.lease,
          workspaceRecord,
          repository,
        );
        if (
          fingerprint.digest !== manifest.fingerprint ||
          fingerprint.resultTree !== manifest.resultTree ||
          fingerprint.indexTree !== manifest.indexTree ||
          fingerprint.headCommit !== manifest.headCommit
        )
          throw coded(
            "fingerprint_mismatch",
            "Restored workspace does not match the authoritative checkpoint.",
          );
        this.store.updateWorkspaceState(
          workspaceRecord.recordId,
          fingerprint.digest,
          input.changeExport.checkpointId,
        );
        return workspace;
      },
    );
  }

  private async initializeGuestRepository(
    lease: EnvironmentLease,
    record: PrivateRepositoryRecord,
    bundle: SourceBundle,
  ): Promise<void> {
    const layout = privateLayout(lease);
    await installGuestDirectories(lease, [
      layout.repositories,
      layout.imports,
      layout.exports,
      layout.runtime,
      layout.workspaces,
    ]);
    const bundlePath = posix.join(layout.imports, `${bundle.sha256}.bundle`);
    const receipt = await lease.writeFile({
      path: bundlePath,
      data: bundle.bytes,
      mode: 0o600,
    });
    if (receipt.sha256 !== bundle.sha256)
      throw coded(
        "bundle_invalid",
        "Source bundle changed during environment transfer.",
      );
    await runGuest(lease, GIT, [
      "init",
      "--bare",
      `--object-format=${bundle.identity.objectFormat}`,
      record.guestGitDir,
    ]);
    await configurePrivateRepository(lease, record.guestGitDir);
    await runGuestGit(lease, record.guestGitDir, [
      "bundle",
      "verify",
      bundlePath,
    ]);
    const heads = await guestBundleHeads(lease, bundlePath);
    assertExactHeads(heads, { [bundle.ref]: record.baseCommit });
    await runGuestGit(lease, record.guestGitDir, [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--no-tags",
      bundlePath,
      `+${bundle.ref}:refs/qe/base`,
    ]);
    await verifyBase(lease, record);
    const markerPath = repositoryMarkerPath(lease, record.repositoryId);
    await lease.writeFile({
      path: markerPath,
      data: new TextEncoder().encode(repositoryMarkerJson(record)),
      mode: 0o600,
    });
  }

  private async inspectGuestRepository(
    lease: EnvironmentLease,
    record: PrivateRepositoryRecord,
  ): Promise<"absent" | "exact" | "conflict"> {
    const probe = await lease.workerExec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; g=pathlib.Path(os.environ['QE_GIT']); m=pathlib.Path(os.environ['QE_MARKER']); print(json.dumps({'git':g.is_dir(),'marker':m.is_file()},separators=(',',':')))",
      ],
      environment: {
        QE_GIT: record.guestGitDir,
        QE_MARKER: repositoryMarkerPath(lease, record.repositoryId),
      },
    });
    if (probe.exitCode !== 0)
      throw coded("private_git_operation_failed", probe.stderr.trim());
    const value = parseObject(probe.stdout, "guest repository probe");
    const git = value.git === true;
    const marker = value.marker === true;
    if (!git && !marker) return "absent";
    if (!git || !marker) return "conflict";
    try {
      const markerBytes = await lease.readFile({
        path: repositoryMarkerPath(lease, record.repositoryId),
        maxBytes: 64 * 1024,
      });
      if (
        new TextDecoder().decode(markerBytes) !== repositoryMarkerJson(record)
      )
        return "conflict";
      await verifyBase(lease, record);
      return "exact";
    } catch {
      return "conflict";
    }
  }

  private async verifyRepository(
    lease: EnvironmentLease,
    record: PrivateRepositoryRecord,
  ): Promise<void> {
    const state = await this.inspectGuestRepository(lease, record);
    if (state === "absent")
      throw coded(
        "private_repository_missing",
        "Durable private repository ownership exists but guest state is missing; explicit restore is required.",
      );
    if (state !== "exact")
      throw coded(
        "private_repository_mismatch",
        "Guest private repository does not match durable ownership.",
      );
  }

  private async createWorkspace(input: {
    lease: EnvironmentLease;
    repository: PrivateRepositoryRecord;
    physicalLineageId: string;
    access: "read_only" | "read_write";
    startCommit: string;
    applyPermissions: boolean;
  }): Promise<PrivateLineageWorkspace> {
    await this.verifyRepository(input.lease, input.repository);
    const layout = privateLayout(input.lease);
    const lineageKey = digest(input.physicalLineageId).slice(0, 24);
    const guestPath = posix.join(layout.workspaces, lineageKey);
    const branchRef = `refs/heads/qe/lineages/${lineageKey}`;
    const runtime = {
      runtimeHome: posix.join(layout.runtime, lineageKey, "home"),
      runtimeCache: posix.join(layout.runtime, lineageKey, "cache"),
      runtimeTemp: posix.join(layout.runtime, lineageKey, "tmp"),
      workerState: posix.join(layout.state, "lineages", lineageKey),
    };
    const claimInput = {
      recordId: randomUUID(),
      repositoryRecordId: input.repository.recordId,
      backendKind: input.lease.ref.backendKind,
      environmentId: input.lease.ref.environmentId,
      incarnation: input.lease.ref.incarnation,
      workerId: input.lease.ref.workerId,
      runId: input.lease.ref.runId,
      physicalLineageId: input.physicalLineageId,
      access: input.access,
      guestPath,
      branchRef,
      runtimeJson: canonicalJson(runtime),
    };
    let claim: ReturnType<PrivateGitStore["claimWorkspace"]>;
    try {
      claim = this.store.claimWorkspace(claimInput);
    } catch (error) {
      throw coded("workspace_identity_conflict", errorMessage(error));
    }
    if (claim.record.state === "attention_required")
      throw coded(
        "private_workspace_mismatch",
        `Private workspace requires attention: ${claim.record.failureCode ?? "unknown"}.`,
      );
    if (claim.record.state === "ready") {
      await this.verifyWorkspace(input.lease, claim.record, input.repository);
      return lineageWorkspace(claim.record, input.repository, input.lease);
    }
    try {
      await installGuestDirectories(input.lease, [
        runtime.runtimeHome,
        runtime.runtimeCache,
        runtime.runtimeTemp,
        runtime.workerState,
      ]);
      const registrations = await worktreeRegistrations(
        input.lease,
        input.repository.guestGitDir,
      );
      const registration = registrations.find(
        (item) => item.path === claim.record.guestPath,
      );
      const pathExists = await guestDirectoryExists(
        input.lease,
        claim.record.guestPath,
      );
      if (!registration && !pathExists) {
        const branchExists = await guestGitSucceeds(
          input.lease,
          input.repository.guestGitDir,
          ["show-ref", "--verify", "--quiet", claim.record.branchRef],
        );
        if (branchExists)
          throw coded(
            "private_workspace_mismatch",
            "Private lineage branch exists without its durable worktree.",
          );
        await runGuestGit(input.lease, input.repository.guestGitDir, [
          "worktree",
          "add",
          "-b",
          claim.record.branchRef.slice("refs/heads/".length),
          claim.record.guestPath,
          input.startCommit,
        ]);
      } else if (
        !registration ||
        !pathExists ||
        registration.branch !== claim.record.branchRef
      )
        throw coded(
          "private_workspace_mismatch",
          "Private worktree path and shared Git registration disagree.",
        );
      const head = await runGuestGit(input.lease, claim.record.guestPath, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]);
      if (head.stdout.trim() !== input.startCommit)
        throw coded(
          "base_commit_mismatch",
          "New private worktree did not start at the required exact commit.",
        );
      if (input.applyPermissions && input.access === "read_only")
        await applyReadOnlyPermissions(input.lease, claim.record.guestPath);
      const ready = this.store.markWorkspaceReady(claim.record.recordId);
      return lineageWorkspace(ready, input.repository, input.lease);
    } catch (error) {
      this.store.markWorkspaceAttention(
        claim.record.recordId,
        privateCode(error),
      );
      throw normalizePrivate(error);
    }
  }

  private async verifyWorkspace(
    lease: EnvironmentLease,
    workspace: PrivateWorkspaceRecord,
    repository: PrivateRepositoryRecord,
  ): Promise<void> {
    assertLeaseOwnsRecord(lease, workspace);
    await this.verifyRepository(lease, repository);
    if (workspace.repositoryRecordId !== repository.recordId)
      throw coded(
        "private_workspace_mismatch",
        "Workspace is attached to another private repository.",
      );
    const registrations = await worktreeRegistrations(
      lease,
      repository.guestGitDir,
    );
    const exact = registrations.find(
      (item) => item.path === workspace.guestPath,
    );
    if (!exact || exact.branch !== workspace.branchRef)
      throw coded(
        "private_workspace_missing",
        "Durable private worktree ownership is absent or mismatched in the environment.",
      );
    const top = await runGuestGit(lease, workspace.guestPath, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (top.stdout.trim() !== workspace.guestPath)
      throw coded(
        "private_workspace_mismatch",
        "Private worktree top-level path changed.",
      );
    if (workspace.access === "read_only")
      await verifyReadOnlyPermissions(lease, workspace.guestPath);
  }

  private async computeFingerprint(
    lease: EnvironmentLease,
    workspace: PrivateWorkspaceRecord,
    repository: PrivateRepositoryRecord,
  ): Promise<WorkspaceFingerprint> {
    const headCommit = (
      await runGuestGit(lease, workspace.guestPath, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])
    ).stdout.trim();
    const headTree = (
      await runGuestGit(lease, workspace.guestPath, [
        "rev-parse",
        "--verify",
        "HEAD^{tree}",
      ])
    ).stdout.trim();
    const indexTree = (
      await runGuestGit(lease, workspace.guestPath, ["write-tree"])
    ).stdout.trim();
    const untracked = await runGuestGit(lease, workspace.guestPath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const untrackedPaths = nulStrings(untracked.stdout).sort(bytewise);
    await validateUntrackedPaths(lease, workspace.guestPath, untrackedPaths);
    const indexPath = posix.join(
      privateLayout(lease).state,
      "indexes",
      `${digest(workspace.recordId).slice(0, 24)}-${randomUUID()}`,
    );
    await installGuestDirectories(lease, [posix.dirname(indexPath)]);
    try {
      await runGuestGit(lease, workspace.guestPath, ["read-tree", "HEAD"], {
        GIT_INDEX_FILE: indexPath,
      });
      await runGuestGit(lease, workspace.guestPath, ["add", "-A", "--", "."], {
        GIT_INDEX_FILE: indexPath,
      });
      const resultTree = (
        await runGuestGit(lease, workspace.guestPath, ["write-tree"], {
          GIT_INDEX_FILE: indexPath,
        })
      ).stdout.trim();
      await validateTreePolicyGuest(lease, repository.guestGitDir, resultTree);
      const changedPaths = await changedPathsGuest(
        lease,
        repository.guestGitDir,
        repository.baseCommit,
        resultTree,
      );
      const body = {
        schemaVersion: 1 as const,
        baseCommit: repository.baseCommit,
        headCommit,
        headTree,
        indexTree,
        resultTree,
        untrackedPaths,
        changedPaths,
      };
      return { ...body, digest: digest(canonicalJson(body)) };
    } finally {
      await lease.workerExec({
        executable: "/bin/rm",
        args: ["-f", indexPath],
      });
    }
  }

  private async createSnapshotState(
    lease: EnvironmentLease,
    workspace: PrivateWorkspaceRecord,
    repository: PrivateRepositoryRecord,
  ): Promise<SnapshotState> {
    const fingerprint = await this.computeFingerprint(
      lease,
      workspace,
      repository,
    );
    const indexCommit = await commitTree(
      lease,
      repository.guestGitDir,
      fingerprint.indexTree,
      fingerprint.headCommit,
      "QE internal index snapshot v1\n",
    );
    const resultCommit = await commitTree(
      lease,
      repository.guestGitDir,
      fingerprint.resultTree,
      fingerprint.headCommit,
      "QE internal resulting-tree snapshot v1\n",
    );
    return { fingerprint, indexCommit, resultCommit };
  }

  private async ensureCheckpointRefs(
    lease: EnvironmentLease,
    repository: PrivateRepositoryRecord,
    refs: PrivateGitCheckpointManifest["refs"],
    state: SnapshotState,
  ): Promise<void> {
    for (const [ref, oid] of [
      [refs.base, repository.baseCommit],
      [refs.head, state.fingerprint.headCommit],
      [refs.index, state.indexCommit],
      [refs.result, state.resultCommit],
    ] as const)
      await ensureGuestRef(lease, repository.guestGitDir, ref, oid);
  }

  private async persistArtifact(
    exportId: string,
    bundleSha256: string,
    bytes: Uint8Array,
    manifestJson: string,
  ): Promise<string> {
    const directory = join(this.artifactRoot, exportId.slice(0, 2), exportId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bundlePath = join(directory, `${bundleSha256}.bundle`);
    const manifestPath = join(directory, "manifest.json");
    await writeImmutable(bundlePath, bytes);
    await writeImmutable(manifestPath, new TextEncoder().encode(manifestJson));
    return bundlePath;
  }

  private async loadPersistedExport(
    record: PrivateCheckpointRecord,
  ): Promise<PrivateGitChangeExport> {
    const value = checkpointExport(record);
    return validateExportFiles(value);
  }

  private async materializeCheckpointRepository(
    lease: EnvironmentLease,
    changeExport: PrivateGitChangeExport,
  ): Promise<PrivateRepositoryRecord> {
    const manifest = changeExport.manifest;
    const existing = this.store.repository(
      lease.ref.backendKind,
      lease.ref.environmentId,
      lease.ref.incarnation,
      manifest.repository.repositoryId,
    );
    if (existing) {
      if (
        existing.sourceDigest !== manifest.sourceDigest ||
        existing.baseCommit !== manifest.baseCommit ||
        existing.baseTree !== manifest.baseTree
      )
        throw coded(
          "repository_identity_conflict",
          "Replacement environment repository conflicts with checkpoint source identity.",
        );
      await this.verifyRepository(lease, existing);
      await this.importCheckpointRefs(lease, existing, changeExport);
      return existing;
    }
    const layout = privateLayout(lease);
    const repositoryKey = digest(manifest.repository.repositoryId).slice(0, 24);
    const claim = this.store.claimRepository({
      recordId: randomUUID(),
      backendKind: lease.ref.backendKind,
      environmentId: lease.ref.environmentId,
      incarnation: lease.ref.incarnation,
      workerId: lease.ref.workerId,
      runId: lease.ref.runId,
      repositoryId: manifest.repository.repositoryId,
      sourceDigest: manifest.sourceDigest,
      sourceJson: canonicalJson(manifest.repository),
      baseCommit: manifest.baseCommit,
      baseTree: manifest.baseTree,
      importBundleSha256: manifest.bundle.sha256,
      guestGitDir: posix.join(layout.repositories, `${repositoryKey}.git`),
    });
    try {
      await installGuestDirectories(lease, [
        layout.repositories,
        layout.imports,
        layout.exports,
        layout.runtime,
        layout.workspaces,
      ]);
      await runGuest(lease, GIT, [
        "init",
        "--bare",
        `--object-format=${manifest.repository.objectFormat}`,
        claim.record.guestGitDir,
      ]);
      await configurePrivateRepository(lease, claim.record.guestGitDir);
      await this.importCheckpointRefs(lease, claim.record, changeExport);
      await verifyBase(lease, claim.record);
      await lease.writeFile({
        path: repositoryMarkerPath(lease, claim.record.repositoryId),
        data: new TextEncoder().encode(repositoryMarkerJson(claim.record)),
        mode: 0o600,
      });
      return this.store.markRepositoryReady(claim.record.recordId);
    } catch (error) {
      this.store.markRepositoryAttention(
        claim.record.recordId,
        privateCode(error),
      );
      throw normalizePrivate(error);
    }
  }

  private async importCheckpointRefs(
    lease: EnvironmentLease,
    repository: PrivateRepositoryRecord,
    changeExport: PrivateGitChangeExport,
  ): Promise<void> {
    const manifest = changeExport.manifest;
    const bundlePath = posix.join(
      privateLayout(lease).imports,
      `${manifest.bundle.sha256}.bundle`,
    );
    const bytes = new Uint8Array(await readFile(changeExport.bundlePath));
    const receipt = await lease.writeFile({
      path: bundlePath,
      data: bytes,
      mode: 0o600,
    });
    if (receipt.sha256 !== manifest.bundle.sha256)
      throw coded("bundle_invalid", "Checkpoint transfer hash mismatch.");
    await runGuestGit(lease, repository.guestGitDir, [
      "bundle",
      "verify",
      bundlePath,
    ]);
    const heads = await guestBundleHeads(lease, bundlePath);
    assertExactHeads(heads, expectedManifestHeads(manifest));
    for (const [source, target] of [
      [manifest.refs.base, "refs/qe/base"],
      [manifest.refs.head, manifest.refs.head],
      [manifest.refs.index, manifest.refs.index],
      [manifest.refs.result, manifest.refs.result],
    ])
      await runGuestGit(lease, repository.guestGitDir, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        bundlePath,
        `+${source}:${target}`,
      ]);
  }

  private requiredRepository(
    lease: EnvironmentLease,
    repositoryId: string,
  ): PrivateRepositoryRecord {
    const record = this.store.repository(
      lease.ref.backendKind,
      lease.ref.environmentId,
      lease.ref.incarnation,
      repositoryId,
    );
    if (!record || record.state !== "ready")
      throw coded(
        "private_repository_missing",
        `No ready private repository ${repositoryId} belongs to this environment incarnation.`,
      );
    assertLeaseOwnsRecord(lease, record);
    return record;
  }

  private requiredRepositoryRecord(recordId: string): PrivateRepositoryRecord {
    const record = this.store.repositoryByRecordId(recordId);
    if (!record || record.state !== "ready")
      throw coded(
        "private_repository_missing",
        "Workspace private repository is unavailable.",
      );
    return record;
  }

  private requiredWorkspace(
    lease: EnvironmentLease,
    physicalLineageId: string,
  ): PrivateWorkspaceRecord {
    const record = this.store.workspace(
      lease.ref.backendKind,
      lease.ref.environmentId,
      lease.ref.incarnation,
      physicalLineageId,
    );
    if (!record || record.state !== "ready")
      throw coded(
        "private_workspace_missing",
        `No ready private workspace ${physicalLineageId} belongs to this environment incarnation.`,
      );
    assertLeaseOwnsRecord(lease, record);
    return record;
  }

  private async withLease<T>(
    lease: EnvironmentLease,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner = `${lease.ref.backendKind}\0${lease.ref.environmentId}\0${lease.ref.incarnation}\0${key}`;
    const previous = this.tails.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.tails.set(owner, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(owner) === tail) this.tails.delete(owner);
    }
  }
}

export async function resolveRepositorySourceIdentity(
  request: RepositorySourceRequest,
): Promise<RepositorySourceIdentity> {
  validateSourceRequest(request);
  const canonicalRoot = await realpath(request.hostRepositoryRoot).catch(() =>
    fail(
      "source_repository_mismatch",
      "Authorized source repository is missing.",
    ),
  );
  const top = (
    await hostGit(canonicalRoot, ["rev-parse", "--show-toplevel"])
  ).text.trim();
  if ((await realpath(top)) !== canonicalRoot)
    throw coded(
      "source_repository_mismatch",
      "Authorized source path is not the exact Git worktree top-level.",
    );
  const resolvedCommit = await hostGit(
    canonicalRoot,
    ["rev-parse", "--verify", `${request.frozenBaseCommit}^{commit}`],
    true,
  );
  const commit = resolvedCommit.text.trim();
  if (!resolvedCommit.ok || commit !== request.frozenBaseCommit.toLowerCase())
    throw coded(
      "base_commit_mismatch",
      "Frozen base did not resolve to the exact supplied commit object ID.",
    );
  const type = (
    await hostGit(canonicalRoot, ["cat-file", "-t", commit])
  ).text.trim();
  if (type !== "commit")
    throw coded("base_commit_mismatch", "Frozen base is not a commit object.");
  const tree = (
    await hostGit(canonicalRoot, ["rev-parse", `${commit}^{tree}`])
  ).text.trim();
  const objectFormatResult = await hostGit(
    canonicalRoot,
    ["rev-parse", "--show-object-format"],
    true,
  );
  const objectFormat = objectFormatResult.ok
    ? objectFormatResult.text.trim()
    : commit.length === 64
      ? "sha256"
      : "sha1";
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw coded(
      "invalid_source_identity",
      `Unsupported Git object format ${objectFormat}.`,
    );
  const formatResult = await hostGit(
    canonicalRoot,
    ["config", "--local", "--get", "core.repositoryformatversion"],
    true,
  );
  const repositoryFormatVersion = formatResult.ok
    ? Number(formatResult.text.trim())
    : 0;
  if (!Number.isSafeInteger(repositoryFormatVersion))
    throw coded(
      "invalid_source_identity",
      "Repository format version is malformed.",
    );
  const missing = await hostGit(canonicalRoot, [
    "rev-list",
    "--objects",
    "--missing=print",
    commit,
    "--",
  ]);
  if (missing.text.split("\n").some((line) => line.startsWith("?")))
    throw coded(
      "source_objects_missing",
      "Frozen base object closure is incomplete; partial-clone fetching is disabled.",
    );
  await validateTreePolicyHost(canonicalRoot, tree);
  return {
    schemaVersion: 1,
    repositoryId: request.repositoryId,
    canonicalSourceIdentifier: request.canonicalSourceIdentifier,
    baseCommit: commit,
    baseTree: tree,
    objectFormat,
    repositoryFormatVersion,
    materializationMethod: "git_bundle_v1",
    provenance: { ...request.provenance },
    ...(request.publication ? { publication: { ...request.publication } } : {}),
  };
}

export async function validateAndImportPrivateGitExport(input: {
  changeExport: PrivateGitChangeExport;
  fixtureGitDir: string;
}): Promise<HostImportResult> {
  const changeExport = await validateExportFiles(input.changeExport);
  const manifest = changeExport.manifest;
  if (existsSync(input.fixtureGitDir)) {
    const entries = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: input.fixtureGitDir, dot: true }),
    );
    if (entries.length > 0)
      throw coded(
        "host_import_mismatch",
        "Host import destination must be an empty isolated fixture.",
      );
  }
  await mkdir(input.fixtureGitDir, { recursive: true });
  await hostGit(input.fixtureGitDir, [
    "init",
    "--bare",
    `--object-format=${manifest.repository.objectFormat}`,
  ]);
  await hostGit(input.fixtureGitDir, [
    "config",
    "--local",
    "core.hooksPath",
    "/dev/null",
  ]);
  await hostGit(input.fixtureGitDir, [
    "bundle",
    "verify",
    changeExport.bundlePath,
  ]);
  const heads = await hostBundleHeads(changeExport.bundlePath);
  assertExactHeads(heads, expectedManifestHeads(manifest));
  const prefix = `refs/qe/imported/${changeExport.exportId}`;
  const importedRefs: string[] = [];
  for (const [name, source] of Object.entries(manifest.refs).sort()) {
    const target = `${prefix}/${name}`;
    await hostGit(input.fixtureGitDir, [
      "fetch",
      "--no-tags",
      changeExport.bundlePath,
      `+${source}:${target}`,
    ]);
    importedRefs.push(target);
  }
  await hostGit(input.fixtureGitDir, ["fsck", "--strict", "--no-dangling"]);
  const actualRefs = (
    await hostGit(input.fixtureGitDir, ["for-each-ref", "--format=%(refname)"])
  ).text
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort(bytewise);
  if (canonicalJson(actualRefs) !== canonicalJson(importedRefs.sort(bytewise)))
    throw coded(
      "host_import_mismatch",
      "Host fixture contains unexpected refs after controlled import.",
    );
  const [base, baseTree, resultTree] = await Promise.all([
    hostGit(input.fixtureGitDir, ["rev-parse", `${prefix}/base^{commit}`]),
    hostGit(input.fixtureGitDir, ["rev-parse", `${prefix}/base^{tree}`]),
    hostGit(input.fixtureGitDir, ["rev-parse", `${prefix}/result^{tree}`]),
  ]);
  if (
    base.text.trim() !== manifest.baseCommit ||
    baseTree.text.trim() !== manifest.baseTree ||
    resultTree.text.trim() !== manifest.resultTree
  )
    throw coded(
      "host_import_mismatch",
      "Imported base or resulting tree identity does not match the manifest.",
    );
  await validateTreePolicyHost(input.fixtureGitDir, manifest.resultTree);
  const changedPaths = await changedPathsHost(
    input.fixtureGitDir,
    manifest.baseCommit,
    manifest.resultTree,
  );
  if (canonicalJson(changedPaths) !== canonicalJson(manifest.changedPaths))
    throw coded(
      "host_import_mismatch",
      "Imported changed paths do not match the manifest.",
    );
  const config = (
    await hostGit(input.fixtureGitDir, ["config", "--local", "--list"])
  ).text;
  if (
    /credential|include\.path|user\.(name|email)|remote\..*\.url|signingkey/i.test(
      config,
    )
  )
    throw coded(
      "host_import_mismatch",
      "Controlled fixture import acquired forbidden repository configuration.",
    );
  return {
    exportId: changeExport.exportId,
    fixtureGitDir: resolve(input.fixtureGitDir),
    baseCommit: manifest.baseCommit,
    resultCommit: manifest.resultCommit,
    resultTree: manifest.resultTree,
    importedRefs,
    changedPaths,
  };
}

async function createSourceBundle(
  request: RepositorySourceRequest,
  stagingRoot: string,
): Promise<SourceBundle> {
  const identity = await resolveRepositorySourceIdentity(request);
  const sourceJson = canonicalJson(identity);
  const sourceDigest = digest(sourceJson);
  const ref = `${SOURCE_BUNDLE_REF_PREFIX}/${sourceDigest}/base`;
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stagingRoot, "source-"));
  const bare = join(directory, "repository.git");
  const bundlePath = join(directory, "source.bundle");
  try {
    await hostGit(directory, [
      "init",
      "--bare",
      `--object-format=${identity.objectFormat}`,
      bare,
    ]);
    const sourceObjects = (
      await hostGit(request.hostRepositoryRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ])
    ).text.trim();
    const alternates = { GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects };
    await hostGit(
      bare,
      ["update-ref", ref, identity.baseCommit],
      false,
      alternates,
    );
    await hostGit(
      bare,
      [
        "-c",
        "pack.threads=1",
        "-c",
        "pack.useBitmaps=false",
        "bundle",
        "create",
        bundlePath,
        ref,
      ],
      false,
      alternates,
    );
    await hostGit(bare, ["bundle", "verify", bundlePath], false, alternates);
    const heads = await hostBundleHeads(bundlePath);
    assertExactHeads(heads, { [ref]: identity.baseCommit });
    const bytes = new Uint8Array(await readFile(bundlePath));
    if (bytes.byteLength > MAX_BUNDLE_BYTES)
      throw coded(
        "bundle_invalid",
        `Source bundle exceeds the ${MAX_BUNDLE_BYTES}-byte Phase-3 bound.`,
      );
    return {
      identity,
      sourceDigest,
      sourceJson,
      ref,
      bytes,
      sha256: digestBytes(bytes),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function privateLayout(lease: EnvironmentLease): PrivateLayout {
  const root = posix.dirname(lease.paths.state);
  const workspaceRoot = posix.dirname(lease.paths.workspace);
  if (
    !posix.isAbsolute(root) ||
    !posix.isAbsolute(workspaceRoot) ||
    root === "/" ||
    workspaceRoot === "/"
  )
    throw coded(
      "private_git_operation_failed",
      "Environment path map cannot derive private Git roots safely.",
    );
  const state = posix.join(lease.paths.state, "private-git");
  return {
    root,
    repositories: posix.join(root, "git"),
    workspaces: workspaceRoot,
    state,
    imports: posix.join(state, "imports"),
    exports: posix.join(state, "exports"),
    runtime: posix.join(state, "runtime"),
  };
}

async function installGuestDirectories(
  lease: EnvironmentLease,
  paths: readonly string[],
): Promise<void> {
  const result = await lease.workerExec({
    executable: "/usr/bin/install",
    args: [
      "-d",
      "-m",
      "0700",
      ...(lease.ref.backendKind === "sbx" ? ["-o", "1000", "-g", "1000"] : []),
      ...paths,
    ],
  });
  if (result.exitCode !== 0)
    throw coded(
      "private_git_operation_failed",
      result.stderr.trim() || "Could not create private Git directories.",
    );
}

async function configurePrivateRepository(
  lease: EnvironmentLease,
  gitDir: string,
): Promise<void> {
  for (const [key, value] of [
    ["user.name", AGENT_NAME],
    ["user.email", AGENT_EMAIL],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["core.hooksPath", "/dev/null"],
    ["fetch.recurseSubmodules", "false"],
    ["submodule.recurse", "false"],
    ["protocol.file.allow", "never"],
  ] as const)
    await runGuestGit(lease, gitDir, ["config", "--local", key, value]);
}

async function verifyBase(
  lease: EnvironmentLease,
  record: PrivateRepositoryRecord,
): Promise<void> {
  const [commit, tree] = await Promise.all([
    runGuestGit(lease, record.guestGitDir, [
      "rev-parse",
      "--verify",
      "refs/qe/base^{commit}",
    ]),
    runGuestGit(lease, record.guestGitDir, [
      "rev-parse",
      "--verify",
      "refs/qe/base^{tree}",
    ]),
  ]);
  if (
    commit.stdout.trim() !== record.baseCommit ||
    tree.stdout.trim() !== record.baseTree
  )
    throw coded(
      "base_commit_mismatch",
      "Private repository frozen base commit/tree verification failed.",
    );
}

async function verifyReadOnlyPermissions(
  lease: EnvironmentLease,
  workspace: string,
): Promise<void> {
  const result = await lease.workerExec({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import json,os,pathlib,stat; root=pathlib.Path(os.environ['QE_WORKSPACE']); bad=[]\nfor p in [root,*root.rglob('*')]:\n s=p.lstat(); bad.append(str(p)) if not stat.S_ISLNK(s.st_mode) and (s.st_mode & 0o222) else None\nprint(json.dumps({'bad':bad},separators=(',',':')))",
    ],
    environment: { QE_WORKSPACE: workspace },
  });
  if (result.exitCode !== 0)
    throw coded(
      "workspace_access_violation",
      result.stderr.trim() ||
        "Could not verify read-only workspace permissions.",
    );
  const proof = parseObject(result.stdout, "read-only workspace proof");
  if (!Array.isArray(proof.bad) || proof.bad.length > 0)
    throw coded(
      "workspace_access_violation",
      "Read-only workspace contains writable source paths.",
    );
}

async function applyReadOnlyPermissions(
  lease: EnvironmentLease,
  workspace: string,
): Promise<void> {
  const chmod = await lease.workerExec({
    executable: "/bin/chmod",
    args: ["-R", "a-w", workspace],
  });
  if (chmod.exitCode !== 0)
    throw coded(
      "workspace_access_violation",
      chmod.stderr.trim() || "Could not make workspace content read-only.",
    );
  if (lease.ref.backendKind === "sbx") {
    const chown = await lease.workerExec({
      executable: "/usr/bin/chown",
      args: ["-R", "root:root", workspace],
    });
    if (chown.exitCode !== 0)
      throw coded(
        "workspace_access_violation",
        chown.stderr.trim() || "Could not fence read-only workspace ownership.",
      );
  }
}

async function runGuestGit(
  lease: EnvironmentLease,
  cwdOrGitDir: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<EnvironmentCommandResult> {
  const isBare = cwdOrGitDir.endsWith(".git");
  return runGuest(
    lease,
    GIT,
    [...(isBare ? ["--git-dir", cwdOrGitDir] : ["-C", cwdOrGitDir]), ...args],
    undefined,
    environment,
  );
}

async function runGuest(
  lease: EnvironmentLease,
  executable: string,
  args: string[],
  cwd?: string,
  environment: Record<string, string> = {},
): Promise<EnvironmentCommandResult> {
  const result = await lease.exec({
    executable,
    args,
    ...(cwd ? { cwd } : {}),
    environment: { ...safeGitEnvironment(), ...environment },
    timeoutMs: 5 * 60_000,
  });
  if (result.exitCode !== 0)
    throw coded(
      "private_git_operation_failed",
      result.stderr.trim() || `${executable} failed with ${result.exitCode}.`,
    );
  return result;
}

async function guestGitSucceeds(
  lease: EnvironmentLease,
  gitDir: string,
  args: string[],
): Promise<boolean> {
  const result = await lease.exec({
    executable: GIT,
    args: ["--git-dir", gitDir, ...args],
    environment: safeGitEnvironment(),
  });
  return result.exitCode === 0;
}

async function guestDirectoryExists(
  lease: EnvironmentLease,
  path: string,
): Promise<boolean> {
  const result = await lease.workerExec({
    executable: "/bin/test",
    args: ["-d", path],
  });
  return result.exitCode === 0;
}

async function worktreeRegistrations(
  lease: EnvironmentLease,
  gitDir: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  const output = (
    await runGuestGit(lease, gitDir, ["worktree", "list", "--porcelain"])
  ).stdout;
  const result: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice(9), branch: null };
    } else if (current && line.startsWith("branch "))
      current.branch = line.slice(7);
  }
  if (current) result.push(current);
  return result;
}

async function validateUntrackedPaths(
  lease: EnvironmentLease,
  root: string,
  paths: string[],
): Promise<void> {
  for (const path of paths) validateRepositoryPath(path);
  if (paths.length === 0) return;
  const result = await lease.workerExec({
    executable: "/usr/bin/python3",
    args: [
      "-c",
      "import json,os,pathlib,stat; root=pathlib.Path(os.environ['QE_ROOT']); paths=json.loads(os.environ['QE_PATHS']); bad=[]\nfor rel in paths:\n p=root.joinpath(*rel.split('/')); s=p.lstat(); bad.append(rel) if not (stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode)) else None\nprint(json.dumps({'bad':bad},separators=(',',':')))",
    ],
    environment: { QE_ROOT: root, QE_PATHS: JSON.stringify(paths) },
  });
  if (result.exitCode !== 0)
    throw coded(
      "unsafe_repository_path",
      result.stderr.trim() || "Could not validate untracked files.",
    );
  const value = parseObject(result.stdout, "untracked path validation");
  if (
    !Array.isArray(value.bad) ||
    value.bad.some((item) => typeof item !== "string")
  )
    throw coded(
      "unsafe_repository_path",
      "Untracked path validation was malformed.",
    );
  if (value.bad.length > 0)
    throw coded(
      "unsafe_repository_path",
      "Checkpoint contains an unsupported untracked file type.",
    );
}

async function commitTree(
  lease: EnvironmentLease,
  gitDir: string,
  tree: string,
  parent: string,
  message: string,
): Promise<string> {
  const result = await runGuestGit(
    lease,
    gitDir,
    ["commit-tree", tree, "-p", parent, "-m", message],
    {
      GIT_AUTHOR_NAME: SNAPSHOT_NAME,
      GIT_AUTHOR_EMAIL: SNAPSHOT_EMAIL,
      GIT_AUTHOR_DATE: DETERMINISTIC_GIT_DATE,
      GIT_COMMITTER_NAME: SNAPSHOT_NAME,
      GIT_COMMITTER_EMAIL: SNAPSHOT_EMAIL,
      GIT_COMMITTER_DATE: DETERMINISTIC_GIT_DATE,
    },
  );
  return result.stdout.trim();
}

async function ensureGuestRef(
  lease: EnvironmentLease,
  gitDir: string,
  ref: string,
  oid: string,
): Promise<void> {
  const current = await lease.exec({
    executable: GIT,
    args: ["--git-dir", gitDir, "rev-parse", "--verify", ref],
    environment: safeGitEnvironment(),
  });
  if (current.exitCode === 0) {
    if (current.stdout.trim() !== oid)
      throw coded(
        "private_repository_mismatch",
        `Checkpoint ref ${ref} already names another object.`,
      );
    return;
  }
  await runGuestGit(lease, gitDir, ["update-ref", ref, oid]);
}

async function guestBundleHeads(
  lease: EnvironmentLease,
  bundlePath: string,
): Promise<Record<string, string>> {
  const result = await runGuest(lease, GIT, [
    "bundle",
    "list-heads",
    bundlePath,
  ]);
  return parseBundleHeads(result.stdout);
}

async function hostBundleHeads(
  bundlePath: string,
): Promise<Record<string, string>> {
  const result = await hostGit(dirname(bundlePath), [
    "bundle",
    "list-heads",
    bundlePath,
  ]);
  return parseBundleHeads(result.text);
}

function parseBundleHeads(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const separator = line.indexOf(" ");
    if (separator < 1)
      throw coded("bundle_invalid", "Bundle advertised a malformed ref.");
    const oid = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (!/^refs\/qe\/[A-Za-z0-9._/-]+$/.test(ref) || !isOid(oid))
      throw coded("unexpected_bundle_refs", "Bundle advertised an unsafe ref.");
    if (result[ref])
      throw coded(
        "unexpected_bundle_refs",
        "Bundle advertised a duplicate ref.",
      );
    result[ref] = oid;
  }
  return result;
}

function assertExactHeads(
  actual: Record<string, string>,
  expected: Record<string, string>,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw coded(
      "unexpected_bundle_refs",
      "Bundle refs or object IDs do not exactly match the authoritative manifest.",
    );
}

async function validateTreePolicyHost(
  gitDirOrWorktree: string,
  tree: string,
): Promise<void> {
  const listing = await hostGit(gitDirOrWorktree, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    tree,
  ]);
  const entries = parseTreeEntries(listing.bytes);
  await validateTreeEntries(
    entries,
    async (path) =>
      (await hostGit(gitDirOrWorktree, ["show", `${tree}:${path}`])).bytes,
  );
}

async function validateTreePolicyGuest(
  lease: EnvironmentLease,
  gitDir: string,
  tree: string,
): Promise<void> {
  const listing = await runGuestGit(lease, gitDir, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    tree,
  ]);
  const entries = parseTreeEntries(new TextEncoder().encode(listing.stdout));
  await validateTreeEntries(entries, async (path) => {
    const value = await runGuestGit(lease, gitDir, ["show", `${tree}:${path}`]);
    return new TextEncoder().encode(value.stdout);
  });
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

function parseTreeEntries(bytes: Uint8Array): TreeEntry[] {
  return nulStrings(new TextDecoder().decode(bytes)).map((entry) => {
    const tab = entry.indexOf("\t");
    const metadata = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (
      tab < 1 ||
      metadata.length !== 3 ||
      !metadata[0] ||
      !metadata[1] ||
      !metadata[2]
    )
      throw coded("bundle_invalid", "Git tree entry is malformed.");
    validateRepositoryPath(path);
    return {
      mode: metadata[0],
      type: metadata[1],
      oid: metadata[2],
      path,
    };
  });
}

async function validateTreeEntries(
  entries: TreeEntry[],
  readBlob: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  if (
    entries.some((entry) => entry.mode === "160000" || entry.type === "commit")
  )
    throw coded(
      "unsupported_submodules",
      "Phase 3 rejects Gitlink/submodule entries and never fetches submodule URLs.",
    );
  for (const entry of entries.filter(
    (item) => posix.basename(item.path) === ".gitattributes",
  )) {
    const contents = new TextDecoder().decode(await readBlob(entry.path));
    if (/(?:^|\s)filter\s*=\s*lfs(?:\s|$)/m.test(contents))
      throw coded(
        "unsupported_lfs",
        "Phase 3 rejects Git LFS filters; pointer objects are not sufficient for offline materialization.",
      );
  }
}

function validateRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  )
    throw coded(
      "unsafe_repository_path",
      "Repository tree contains a path that is unsafe for controlled import.",
    );
}

async function changedPathsGuest(
  lease: EnvironmentLease,
  gitDir: string,
  base: string,
  tree: string,
): Promise<ChangePath[]> {
  const result = await runGuestGit(lease, gitDir, [
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-status",
    "-z",
    "--find-renames",
    base,
    tree,
  ]);
  return parseChangedPaths(result.stdout);
}

async function changedPathsHost(
  gitDir: string,
  base: string,
  tree: string,
): Promise<ChangePath[]> {
  const result = await hostGit(gitDir, [
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-status",
    "-z",
    "--find-renames",
    base,
    tree,
  ]);
  return parseChangedPaths(new TextDecoder().decode(result.bytes));
}

function parseChangedPaths(output: string): ChangePath[] {
  const values = nulStrings(output);
  const changes: ChangePath[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const status = values[index] as string;
    if (/^[RC]/.test(status)) {
      const previousPath = values[index + 1];
      const path = values[index + 2];
      if (!previousPath || !path)
        throw coded("bundle_invalid", "Git rename/copy diff is malformed.");
      validateRepositoryPath(previousPath);
      validateRepositoryPath(path);
      changes.push({ status, previousPath, path });
      index += 2;
    } else {
      const path = values[index + 1];
      if (!path)
        throw coded("bundle_invalid", "Git name-status diff is malformed.");
      validateRepositoryPath(path);
      changes.push({ status, path });
      index += 1;
    }
  }
  return changes.sort((left, right) =>
    bytewise(
      `${left.path}\0${left.previousPath ?? ""}\0${left.status}`,
      `${right.path}\0${right.previousPath ?? ""}\0${right.status}`,
    ),
  );
}

async function hostGit(
  cwd: string,
  args: string[],
  allowFailure = false,
  environment: Record<string, string> = {},
): Promise<{ ok: boolean; text: string; bytes: Uint8Array }> {
  const child = Bun.spawn([GIT, "--no-replace-objects", "-C", cwd, ...args], {
    env: {
      ...definedProcessEnvironment(),
      ...safeGitEnvironment(),
      ...environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const bytes = new Uint8Array(stdout);
  if (exitCode !== 0 && !allowFailure)
    throw coded(
      "private_git_operation_failed",
      stderr.trim() || `git ${args[0] ?? "operation"} failed with ${exitCode}.`,
    );
  return {
    ok: exitCode === 0,
    text: new TextDecoder().decode(bytes),
    bytes,
  };
}

function safeGitEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function validateSourceRequest(request: RepositorySourceRequest): void {
  if (
    !safeIdentity(request.repositoryId) ||
    !safeIdentity(request.canonicalSourceIdentifier) ||
    !isAbsolute(request.hostRepositoryRoot) ||
    !isOid(request.frozenBaseCommit) ||
    !["authorized_local_object_database", "authorized_remote_cache"].includes(
      request.provenance.kind,
    )
  )
    throw coded(
      "invalid_source_identity",
      "Repository source identity is incomplete or malformed.",
    );
  request.frozenBaseCommit = request.frozenBaseCommit.toLowerCase();
  if (
    /[?#]/.test(request.canonicalSourceIdentifier) ||
    (request.canonicalSourceIdentifier.includes("@") &&
      !request.canonicalSourceIdentifier.startsWith("ssh://git@"))
  )
    throw coded(
      "invalid_source_identity",
      "Canonical source identifiers must not contain credentials, query data, or fragments.",
    );
  if (request.canonicalSourceIdentifier.includes("://"))
    validatePublication({ url: request.canonicalSourceIdentifier });
  if (request.publication) validatePublication(request.publication);
}

function validatePublication(value: RepositoryPublicationMetadata): void {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw coded(
      "invalid_source_identity",
      "Publication metadata must use an absolute credential-free URL.",
    );
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && url.username !== "git")
  )
    throw coded(
      "invalid_source_identity",
      "Publication URL contains credentials or unsupported mutable metadata.",
    );
  if (value.defaultBranch && !safeIdentity(value.defaultBranch))
    throw coded(
      "invalid_source_identity",
      "Default branch metadata is unsafe.",
    );
}

function safeIdentity(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/.test(value)
  );
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.toLowerCase());
}

function repositoryMarkerPath(
  lease: EnvironmentLease,
  repositoryId: string,
): string {
  return posix.join(
    privateLayout(lease).state,
    "repositories",
    `${digest(repositoryId).slice(0, 24)}.json`,
  );
}

function repositoryMarkerJson(record: PrivateRepositoryRecord): string {
  return canonicalJson({
    schemaVersion: 1,
    backendKind: record.backendKind,
    environmentId: record.environmentId,
    incarnation: record.incarnation,
    workerId: record.workerId,
    runId: record.runId,
    repositoryId: record.repositoryId,
    sourceDigest: record.sourceDigest,
    baseCommit: record.baseCommit,
    baseTree: record.baseTree,
    importBundleSha256: record.importBundleSha256,
    guestGitDir: record.guestGitDir,
  });
}

function materializedRepository(
  record: PrivateRepositoryRecord,
  lease: EnvironmentLease,
): MaterializedPrivateRepository {
  return {
    physicalId: record.recordId,
    environmentRef: structuredClone(lease.ref),
    source: decodeSource(record.sourceJson),
    sourceDigest: record.sourceDigest,
    importBundleSha256: record.importBundleSha256,
    gitDir: record.guestGitDir,
  };
}

function lineageWorkspace(
  workspace: PrivateWorkspaceRecord,
  repository: PrivateRepositoryRecord,
  lease: EnvironmentLease,
): PrivateLineageWorkspace {
  const runtime = parseObject(workspace.runtimeJson, "workspace runtime paths");
  const paths: PrivateGitPathMap = {
    repository: repository.guestGitDir,
    workspace: workspace.guestPath,
    runtimeHome: text(runtime.runtimeHome, "runtimeHome"),
    runtimeCache: text(runtime.runtimeCache, "runtimeCache"),
    runtimeTemp: text(runtime.runtimeTemp, "runtimeTemp"),
    workerState: text(runtime.workerState, "workerState"),
  };
  return {
    physicalId: workspace.recordId,
    environmentRef: structuredClone(lease.ref),
    repositoryPhysicalId: repository.recordId,
    repositoryId: repository.repositoryId,
    physicalLineageId: workspace.physicalLineageId,
    access: workspace.access,
    branchRef: workspace.branchRef,
    paths,
  };
}

function assertLeaseOwnsRecord(
  lease: EnvironmentLease,
  record: Pick<
    PrivateRepositoryRecord,
    "backendKind" | "environmentId" | "incarnation" | "workerId" | "runId"
  >,
): void {
  if (
    record.backendKind !== lease.ref.backendKind ||
    record.environmentId !== lease.ref.environmentId ||
    record.incarnation !== lease.ref.incarnation ||
    record.workerId !== lease.ref.workerId ||
    record.runId !== lease.ref.runId
  )
    throw coded(
      "private_repository_mismatch",
      "Private Git state belongs to another environment incarnation.",
    );
}

function checkpointRefs(
  checkpointId: string,
): PrivateGitCheckpointManifest["refs"] {
  const prefix = `${CHECKPOINT_REF_PREFIX}/${checkpointId}`;
  return {
    base: `${prefix}/base`,
    head: `${prefix}/head`,
    index: `${prefix}/index`,
    result: `${prefix}/result`,
  };
}

function expectedManifestHeads(
  manifest: PrivateGitCheckpointManifest,
): Record<string, string> {
  return {
    [manifest.refs.base]: manifest.baseCommit,
    [manifest.refs.head]: manifest.headCommit,
    [manifest.refs.index]: manifest.indexCommit,
    [manifest.refs.result]: manifest.resultCommit,
  };
}

function assertChangeContract(
  contract: ChangeSetPhysicalContract,
  changes: ChangePath[],
): void {
  if (!contract.expectedChangedPaths) return;
  const actual = [
    ...new Set(
      changes.flatMap((change) => [
        ...(change.previousPath ? [change.previousPath] : []),
        change.path,
      ]),
    ),
  ].sort(bytewise);
  const expected = [...new Set(contract.expectedChangedPaths)].sort(bytewise);
  for (const path of expected) validateRepositoryPath(path);
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw coded(
      "change_set_contract_mismatch",
      "Worker-observed changed paths do not match the declared Change Set contract.",
    );
}

function checkpointExport(
  record: PrivateCheckpointRecord,
): PrivateGitChangeExport {
  const manifest = decodeManifest(record.manifestJson);
  return {
    exportId: record.exportId,
    checkpointId: record.checkpointId,
    manifest,
    bundlePath: record.artifactPath,
  };
}

async function validateExportFiles(
  changeExport: PrivateGitChangeExport,
): Promise<PrivateGitChangeExport> {
  const manifest = changeExport.manifest;
  const manifestJson = canonicalJson(manifest);
  if (digest(manifestJson) !== changeExport.exportId)
    throw coded(
      "bundle_invalid",
      "Change export manifest identity does not match its content.",
    );
  for (const path of manifest.untrackedPaths) validateRepositoryPath(path);
  for (const change of manifest.changedPaths) {
    validateRepositoryPath(change.path);
    if (change.previousPath) validateRepositoryPath(change.previousPath);
    if (!/^(?:[AMDUTX]|[RC][0-9]{1,3})$/.test(change.status))
      throw coded(
        "bundle_invalid",
        "Change export contains an invalid Git status.",
      );
  }
  const expectedOidLength =
    manifest.repository.objectFormat === "sha256" ? 64 : 40;
  for (const oid of [
    manifest.baseCommit,
    manifest.baseTree,
    manifest.headCommit,
    manifest.headTree,
    manifest.indexCommit,
    manifest.indexTree,
    manifest.resultCommit,
    manifest.resultTree,
  ])
    if (!isOid(oid) || oid.length !== expectedOidLength)
      throw coded(
        "bundle_invalid",
        "Change export contains an invalid object ID.",
      );
  if (manifest.sourceDigest !== digest(canonicalJson(manifest.repository)))
    throw coded(
      "bundle_invalid",
      "Change export source identity digest is invalid.",
    );
  const fingerprintBody = {
    schemaVersion: 1 as const,
    baseCommit: manifest.baseCommit,
    headCommit: manifest.headCommit,
    headTree: manifest.headTree,
    indexTree: manifest.indexTree,
    resultTree: manifest.resultTree,
    untrackedPaths: manifest.untrackedPaths,
    changedPaths: manifest.changedPaths,
  };
  if (manifest.fingerprint !== digest(canonicalJson(fingerprintBody)))
    throw coded(
      "fingerprint_mismatch",
      "Change export fingerprint is invalid.",
    );
  const expectedCheckpointId = digest(
    canonicalJson({
      schemaVersion: 1,
      sourceDigest: manifest.sourceDigest,
      physicalLineageId: manifest.physicalLineageId,
      fingerprint: { ...fingerprintBody, digest: manifest.fingerprint },
      indexCommit: manifest.indexCommit,
      resultCommit: manifest.resultCommit,
    }),
  );
  if (
    expectedCheckpointId !== changeExport.checkpointId ||
    canonicalJson(manifest.refs) !==
      canonicalJson(checkpointRefs(changeExport.checkpointId))
  )
    throw coded(
      "bundle_invalid",
      "Change export checkpoint identity is invalid.",
    );
  const metadata = await stat(changeExport.bundlePath).catch(() => null);
  if (
    !metadata?.isFile() ||
    metadata.size !== manifest.bundle.byteLength ||
    metadata.size > MAX_BUNDLE_BYTES
  )
    throw coded("bundle_invalid", "Change export bundle size is invalid.");
  const bytes = new Uint8Array(await readFile(changeExport.bundlePath));
  if (digestBytes(bytes) !== manifest.bundle.sha256)
    throw coded("bundle_invalid", "Change export bundle hash is invalid.");
  if (
    manifest.kind !== "qe_private_git_change_export" ||
    manifest.schemaVersion !== 1 ||
    manifest.baseCommit !== manifest.repository.baseCommit ||
    manifest.baseTree !== manifest.repository.baseTree
  )
    throw coded("bundle_invalid", "Change export manifest is inconsistent.");
  return {
    ...changeExport,
    manifest: structuredClone(manifest),
  };
}

function decodeSource(value: string): RepositorySourceIdentity {
  const source = parseObject(value, "repository source identity");
  if (
    source.schemaVersion !== 1 ||
    typeof source.repositoryId !== "string" ||
    typeof source.canonicalSourceIdentifier !== "string" ||
    typeof source.baseCommit !== "string" ||
    typeof source.baseTree !== "string" ||
    (source.objectFormat !== "sha1" && source.objectFormat !== "sha256") ||
    typeof source.repositoryFormatVersion !== "number" ||
    source.materializationMethod !== "git_bundle_v1" ||
    !source.provenance ||
    typeof source.provenance !== "object"
  )
    throw coded(
      "invalid_source_identity",
      "Persisted source identity is malformed.",
    );
  return JSON.parse(value) as RepositorySourceIdentity;
}

function decodeManifest(value: string): PrivateGitCheckpointManifest {
  const manifest = JSON.parse(value) as PrivateGitCheckpointManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "qe_private_git_change_export" ||
    !manifest.bundle ||
    !manifest.refs
  )
    throw coded(
      "bundle_invalid",
      "Persisted checkpoint manifest is malformed.",
    );
  return manifest;
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  if (existsSync(path)) {
    const existing = new Uint8Array(await readFile(path));
    if (digestBytes(existing) !== digestBytes(bytes))
      throw coded(
        "bundle_invalid",
        "Immutable private-Git artifact path contains different bytes.",
      );
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw coded("private_git_operation_failed", "Non-finite JSON value.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => bytewise(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw coded("private_git_operation_failed", "Value is not JSON-compatible.");
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw coded(
        "private_git_operation_failed",
        `${label} is not valid JSON.`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw coded("private_git_operation_failed", `${label} must be an object.`);
  return parsed as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw coded("private_git_operation_failed", `${label} is malformed.`);
  return value;
}

function nulStrings(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function coded(code: PrivateGitErrorCode, message: string): PrivateGitError {
  return new PrivateGitError(code, message);
}

function privateCode(error: unknown): PrivateGitErrorCode {
  return error instanceof PrivateGitError
    ? error.code
    : "private_git_operation_failed";
}

function normalizePrivate(error: unknown): PrivateGitError {
  return error instanceof PrivateGitError
    ? error
    : coded("private_git_operation_failed", errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(code: PrivateGitErrorCode, message: string): never {
  throw coded(code, message);
}
