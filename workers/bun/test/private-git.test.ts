import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HostNativeExecutionEnvironmentBackend } from "../src/execution-environment/host-native.ts";
import type {
  EnvironmentLease,
  EnvironmentSpec,
} from "../src/execution-environment/types.ts";
import {
  type PrivateGitChangeExport,
  PrivateGitWorkspaceManager,
  type RepositorySourceRequest,
  resolveRepositorySourceIdentity,
  validateAndImportPrivateGitExport,
} from "../src/workspace/private-git.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("private Git materializes an exact local-only base idempotently without changing the source", async () => {
  const fixture = await privateFixture("materialize");
  const before = await sourceSnapshot(fixture.sourceRoot);
  const first = await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const second = await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });

  expect(second).toEqual(first);
  expect(first.source.baseCommit).toBe(fixture.baseCommit);
  expect(first.source.baseTree).toBe(fixture.baseTree);
  expect(first.gitDir).not.toContain(fixture.sourceRoot);
  expect(await sourceSnapshot(fixture.sourceRoot)).toEqual(before);
  const escapedParent = join(fixture.lease.paths.state, "escape");
  await symlink(fixture.sourceRoot, escapedParent);
  await expect(
    fixture.lease.writeFile({
      path: join(escapedParent, "must-not-write"),
      data: new TextEncoder().encode("forbidden"),
    }),
  ).rejects.toMatchObject({ operation: "transfer" });
  expect(await fileExists(join(fixture.sourceRoot, "must-not-write"))).toBe(
    false,
  );

  const config = await git(first.gitDir, ["config", "--local", "--list"]);
  expect(config).toContain("user.name=Quest Engineering Agent");
  expect(config).toContain("user.email=qe-agent@local");
  expect(config).toContain("core.hookspath=/dev/null");
  expect(config).not.toMatch(/credential|signingkey|remote\..*\.url/i);
  expect(await fileExists(join(first.gitDir, "hooks", "pre-commit"))).toBe(
    false,
  );
});

test("private Git preserves SHA-256 repository format through bundle materialization", async () => {
  const root = await tempRoot("private-git-sha256-");
  const sourceRoot = join(root, "source");
  await initRepository(sourceRoot, "sha256");
  const baseCommit = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const environment = await environmentFixture(root, "run-sha256");
  const manager = new PrivateGitWorkspaceManager({
    dataRoot: environment.dataRoot,
  });
  const source = {
    ...sourceRequest(sourceRoot, baseCommit),
    repositoryId: "repository-sha256-test",
    canonicalSourceIdentifier: "fixture:sha256-test",
  };
  const repository = await manager.materializeSource({
    lease: environment.lease,
    source,
  });
  expect(repository.source.objectFormat).toBe("sha256");
  expect(repository.source.baseCommit).toHaveLength(64);
  expect(
    await git(repository.gitDir, ["rev-parse", "--show-object-format"]),
  ).toBe("sha256");
  manager.close();
});

test("physical lineages have separate private worktrees and retained state survives Worker restart", async () => {
  const fixture = await privateFixture("lineages");
  const repository = await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const lineageA = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "lineage-a",
    access: "read_write",
  });
  const lineageB = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "lineage-b",
    access: "read_write",
  });

  expect(lineageA.paths.workspace).not.toBe(lineageB.paths.workspace);
  expect(lineageA.paths.repository).toBe(lineageB.paths.repository);
  await writeFile(join(lineageA.paths.workspace, "tracked.txt"), "lineage-a\n");
  await writeFile(join(lineageA.paths.workspace, "new.txt"), "only-a\n");
  expect(
    await readFile(join(lineageB.paths.workspace, "tracked.txt"), "utf8"),
  ).toBe("base\n");
  expect(await fileExists(join(lineageB.paths.workspace, "new.txt"))).toBe(
    false,
  );

  const beforeRestart = await fixture.manager.fingerprint({
    lease: fixture.lease,
    physicalLineageId: "lineage-a",
  });
  fixture.manager.close();
  await fixture.backend.stop(fixture.lease.ref);
  const recovered = await fixture.backend.ensure(fixture.spec);
  const restarted = new PrivateGitWorkspaceManager({
    dataRoot: fixture.dataRoot,
  });
  fixture.manager = restarted;
  const adoptedRepository = await restarted.materializeSource({
    lease: recovered,
    source: fixture.source,
  });
  const adopted = await restarted.ensureWorktree({
    lease: recovered,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "lineage-a",
    access: "read_write",
  });
  const afterRestart = await restarted.fingerprint({
    lease: recovered,
    physicalLineageId: "lineage-a",
  });
  expect(adoptedRepository.physicalId).toBe(repository.physicalId);
  expect(adopted.physicalId).toBe(lineageA.physicalId);
  expect(afterRestart).toEqual(beforeRestart);
});

test("fingerprint, checkpoint, export, host import, and replacement restore preserve staged, unstaged, and untracked state", async () => {
  const fixture = await privateFixture("checkpoint");
  const sourceBefore = await sourceSnapshot(fixture.sourceRoot);
  await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const workspace = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "implementation",
    access: "read_write",
  });
  await writeFile(join(workspace.paths.workspace, "tracked.txt"), "staged\n");
  await git(workspace.paths.workspace, ["add", "tracked.txt"]);
  await writeFile(join(workspace.paths.workspace, "tracked.txt"), "working\n");
  await writeFile(join(workspace.paths.workspace, "untracked.txt"), "new\n");
  await mkdir(join(workspace.paths.workspace, "ignored"));
  await writeFile(
    join(workspace.paths.workspace, "ignored", "cache"),
    "skip\n",
  );
  await writeFile(join(workspace.paths.workspace, ".gitignore"), "ignored/\n");

  const fingerprint = await fixture.manager.fingerprint({
    lease: fixture.lease,
    physicalLineageId: "implementation",
  });
  expect(
    await fixture.manager.fingerprint({
      lease: fixture.lease,
      physicalLineageId: "implementation",
    }),
  ).toEqual(fingerprint);
  expect(fingerprint.indexTree).not.toBe(fingerprint.resultTree);
  expect(fingerprint.untrackedPaths).toEqual([".gitignore", "untracked.txt"]);

  const changeExport = await fixture.manager.checkpoint({
    lease: fixture.lease,
    physicalLineageId: "implementation",
    contract: {
      repositoryId: fixture.source.repositoryId,
      baseCommit: fixture.baseCommit,
      expectedChangedPaths: [".gitignore", "tracked.txt", "untracked.txt"],
    },
  });
  const repeated = await fixture.manager.checkpoint({
    lease: fixture.lease,
    physicalLineageId: "implementation",
    contract: {
      repositoryId: fixture.source.repositoryId,
      baseCommit: fixture.baseCommit,
    },
  });
  expect(repeated).toEqual(changeExport);
  expect(changeExport.manifest.resultTree).toBe(fingerprint.resultTree);
  expect(changeExport.manifest.indexTree).toBe(fingerprint.indexTree);

  const importRoot = await tempRoot("private-git-import-");
  const imported = await validateAndImportPrivateGitExport({
    changeExport,
    fixtureGitDir: join(importRoot, "fixture.git"),
  });
  expect(imported.resultTree).toBe(fingerprint.resultTree);
  expect(imported.importedRefs).toHaveLength(4);
  expect(
    await validateAndImportPrivateGitExport({
      changeExport,
      fixtureGitDir: join(importRoot, "fixture.git"),
    }),
  ).toEqual(imported);
  expect(
    await fileExists(join(importRoot, "fixture.git", "hooks", "pre-commit")),
  ).toBe(false);
  expect(
    await git(join(importRoot, "fixture.git"), ["config", "--local", "--list"]),
  ).not.toMatch(/credential|signingkey|remote\..*\.url|user\.(name|email)/i);
  expect(
    await git(join(importRoot, "fixture.git"), [
      "show",
      `${changeExport.manifest.resultCommit}:tracked.txt`,
    ]),
  ).toBe("working");
  expect(
    await git(join(importRoot, "fixture.git"), [
      "show",
      `${changeExport.manifest.indexCommit}:tracked.txt`,
    ]),
  ).toBe("staged");

  const replacementRoot = await tempRoot("private-git-replacement-");
  const replacementEnvironment = await environmentFixture(
    replacementRoot,
    "run-checkpoint-replacement",
  );
  const restored = await fixture.manager.restoreCheckpoint({
    lease: replacementEnvironment.lease,
    changeExport,
    physicalLineageId: "implementation",
    access: "read_write",
  });
  const restoredFingerprint = await fixture.manager.fingerprint({
    lease: replacementEnvironment.lease,
    physicalLineageId: "implementation",
  });
  expect(restored.physicalId).not.toBe(workspace.physicalId);
  expect(restored.environmentRef.incarnation).not.toBe(
    workspace.environmentRef.incarnation,
  );
  expect(restoredFingerprint).toEqual(fingerprint);
  const restoredRepositoryReplay = await fixture.manager.materializeSource({
    lease: replacementEnvironment.lease,
    source: fixture.source,
  });
  expect(restoredRepositoryReplay.physicalId).toBe(
    restored.repositoryPhysicalId,
  );
  expect(
    await git(restored.paths.workspace, [
      "diff",
      "--cached",
      "--",
      "tracked.txt",
    ]),
  ).toContain("+staged");
  expect(
    await readFile(join(restored.paths.workspace, "tracked.txt"), "utf8"),
  ).toBe("working\n");
  expect(
    await readFile(join(restored.paths.workspace, "untracked.txt"), "utf8"),
  ).toBe("new\n");
  expect(
    await fileExists(join(restored.paths.workspace, "ignored", "cache")),
  ).toBe(false);
  expect(await sourceSnapshot(fixture.sourceRoot)).toEqual(sourceBefore);
});

test("read-only content is physically non-writable while runtime paths stay writable", async () => {
  const fixture = await privateFixture("read-only");
  await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const readOnly = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "review",
    access: "read_only",
  });
  const readWrite = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "implementation",
    access: "read_write",
  });
  expect(
    (await lstat(join(readOnly.paths.workspace, "tracked.txt"))).mode & 0o222,
  ).toBe(0);
  await expect(
    writeFile(join(readOnly.paths.workspace, "tracked.txt"), "forbidden\n"),
  ).rejects.toBeDefined();
  await writeFile(join(readOnly.paths.runtimeHome, "notes"), "allowed\n");
  await writeFile(join(readWrite.paths.workspace, "tracked.txt"), "allowed\n");
  const cleanupPermissions = Bun.spawn(
    ["/bin/chmod", "-R", "u+w", readOnly.paths.workspace],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await cleanupPermissions.exited).toBe(0);
});

test("materialization rejects base mismatch, submodules, LFS, credential URLs, and incomplete contracts", async () => {
  const root = await tempRoot("private-git-policy-");
  const source = join(root, "source");
  await initRepository(source);
  const base = await git(source, ["rev-parse", "HEAD"]);
  const request = sourceRequest(source, base);

  await expect(
    resolveRepositorySourceIdentity({
      ...request,
      frozenBaseCommit: "0".repeat(40),
    }),
  ).rejects.toMatchObject({ code: "base_commit_mismatch" });
  await expect(
    resolveRepositorySourceIdentity({
      ...request,
      publication: { url: "https://token@example.invalid/repo.git" },
    }),
  ).rejects.toMatchObject({ code: "invalid_source_identity" });

  await writeFile(
    join(source, ".gitattributes"),
    "*.bin filter=lfs diff=lfs\n",
  );
  await git(source, ["add", ".gitattributes"]);
  await git(source, ["commit", "--no-verify", "-qm", "lfs policy"]);
  const lfsBase = await git(source, ["rev-parse", "HEAD"]);
  await expect(
    resolveRepositorySourceIdentity(sourceRequest(source, lfsBase)),
  ).rejects.toMatchObject({ code: "unsupported_lfs" });

  const submoduleRoot = join(root, "submodule");
  const containingRoot = join(root, "containing");
  await initRepository(submoduleRoot);
  await initRepository(containingRoot);
  await git(containingRoot, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    submoduleRoot,
    "vendor/submodule",
  ]);
  await git(containingRoot, ["commit", "--no-verify", "-qm", "submodule"]);
  const submoduleBase = await git(containingRoot, ["rev-parse", "HEAD"]);
  await expect(
    resolveRepositorySourceIdentity(
      sourceRequest(containingRoot, submoduleBase),
    ),
  ).rejects.toMatchObject({ code: "unsupported_submodules" });

  const fixture = await privateFixture("contract");
  await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const workspace = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "lineage",
    access: "read_write",
  });
  await writeFile(join(workspace.paths.workspace, "tracked.txt"), "changed\n");
  await expect(
    fixture.manager.checkpoint({
      lease: fixture.lease,
      physicalLineageId: "lineage",
      contract: {
        repositoryId: fixture.source.repositoryId,
        baseCommit: fixture.baseCommit,
        expectedChangedPaths: ["not-the-change.txt"],
      },
    }),
  ).rejects.toMatchObject({ code: "change_set_contract_mismatch" });
});

test("symlinks are captured as Git links without following host targets and unexpected bundle refs fail closed", async () => {
  const fixture = await privateFixture("symlink");
  await fixture.manager.materializeSource({
    lease: fixture.lease,
    source: fixture.source,
  });
  const workspace = await fixture.manager.ensureWorktree({
    lease: fixture.lease,
    repositoryId: fixture.source.repositoryId,
    physicalLineageId: "lineage",
    access: "read_write",
  });
  await symlink(
    "../../outside-secret",
    join(workspace.paths.workspace, "link"),
  );
  const changeExport = await fixture.manager.checkpoint({
    lease: fixture.lease,
    physicalLineageId: "lineage",
    contract: {
      repositoryId: fixture.source.repositoryId,
      baseCommit: fixture.baseCommit,
      expectedChangedPaths: ["link"],
    },
  });
  expect(await readlink(join(workspace.paths.workspace, "link"))).toBe(
    "../../outside-secret",
  );
  expect(
    await git(workspace.paths.repository, [
      "show",
      `${changeExport.manifest.resultCommit}:link`,
    ]),
  ).toBe("../../outside-secret");

  const unsafe = structuredClone(changeExport) as PrivateGitChangeExport;
  unsafe.manifest.changedPaths = [{ status: "A", path: "../escape" }];
  unsafe.exportId = sha256(canonicalJson(unsafe.manifest));
  const unsafeImportRoot = await tempRoot("private-git-unsafe-import-");
  await expect(
    validateAndImportPrivateGitExport({
      changeExport: unsafe,
      fixtureGitDir: join(unsafeImportRoot, "fixture.git"),
    }),
  ).rejects.toMatchObject({ code: "unsafe_repository_path" });

  const evilRef = "refs/qe/unexpected/replacement";
  await git(workspace.paths.repository, [
    "update-ref",
    evilRef,
    changeExport.manifest.headCommit,
  ]);
  const evilRoot = await tempRoot("private-git-evil-bundle-");
  const evilBundlePath = join(evilRoot, "evil.bundle");
  await git(workspace.paths.repository, [
    "bundle",
    "create",
    evilBundlePath,
    ...Object.values(changeExport.manifest.refs),
    evilRef,
  ]);
  const evilBytes = await readFile(evilBundlePath);
  const evil = structuredClone(changeExport) as PrivateGitChangeExport;
  evil.bundlePath = evilBundlePath;
  evil.manifest.bundle = {
    sha256: createHash("sha256").update(evilBytes).digest("hex"),
    byteLength: evilBytes.byteLength,
  };
  evil.exportId = sha256(canonicalJson(evil.manifest));
  const importRoot = await tempRoot("private-git-bad-import-");
  await expect(
    validateAndImportPrivateGitExport({
      changeExport: evil,
      fixtureGitDir: join(importRoot, "fixture.git"),
    }),
  ).rejects.toMatchObject({ code: "unexpected_bundle_refs" });
});

interface Fixture {
  root: string;
  dataRoot: string;
  sourceRoot: string;
  source: RepositorySourceRequest;
  baseCommit: string;
  baseTree: string;
  backend: HostNativeExecutionEnvironmentBackend;
  lease: EnvironmentLease;
  spec: EnvironmentSpec;
  manager: PrivateGitWorkspaceManager;
}

async function privateFixture(label: string): Promise<Fixture> {
  const root = await tempRoot(`private-git-${label}-`);
  const sourceRoot = join(root, "source");
  await initRepository(sourceRoot);
  const baseCommit = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const baseTree = await git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const environment = await environmentFixture(root, `run-${label}`);
  return {
    root,
    sourceRoot,
    source: sourceRequest(sourceRoot, baseCommit),
    baseCommit,
    baseTree,
    ...environment,
    manager: new PrivateGitWorkspaceManager({ dataRoot: environment.dataRoot }),
  };
}

async function environmentFixture(root: string, runId: string) {
  const dataRoot = join(root, "worker-data");
  const environmentRoot = join(root, "environment");
  const paths = {
    workspace: join(environmentRoot, "qe", "workspaces", "default"),
    state: join(environmentRoot, "qe", "state"),
    control: join(environmentRoot, "qe", "control"),
    home: join(environmentRoot, "home", "agent"),
    cache: join(environmentRoot, "home", "agent", ".cache"),
    temp: join(environmentRoot, "tmp", "qe"),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true })),
  );
  const backend = new HostNativeExecutionEnvironmentBackend({
    workerId: "worker-private-git-test",
    pathsFor: () => paths,
  });
  const spec = environmentSpec(runId);
  const lease = await backend.ensure(spec);
  return { dataRoot, backend, lease, spec };
}

function environmentSpec(runId: string): EnvironmentSpec {
  return {
    workerId: "worker-private-git-test",
    runId,
    workspace: {
      workspaceId: "workspace-private-git-test",
      projectId: "project-private-git-test",
      access: "read_write",
      materialization: {
        kind: "frozen_import",
        sourceIdentity: `source:${runId}`,
        frozenBase: { kind: "git_commit", value: "fixture" },
      },
    },
    profile: { id: "host-test", digest: "sha256:host-test" },
    resourcePolicy: { id: "test", digest: "sha256:test" },
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [],
  };
}

async function initRepository(
  root: string,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", `--object-format=${objectFormat}`, "-q"]);
  await git(root, ["config", "user.name", "Source User"]);
  await git(root, ["config", "user.email", "source@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-qm", "local-only base"]);
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await writeFile(
    join(root, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nexit 77\n",
  );
  await chmod(join(root, ".git", "hooks", "pre-commit"), 0o755);
}

function sourceRequest(root: string, base: string): RepositorySourceRequest {
  return {
    repositoryId: "repository-private-git-test",
    canonicalSourceIdentifier: "fixture:private-git-test",
    hostRepositoryRoot: root,
    frozenBaseCommit: base,
    provenance: { kind: "authorized_local_object_database" },
    publication: {
      url: "https://example.invalid/acme/repository.git",
      defaultBranch: "main",
    },
  };
}

async function sourceSnapshot(root: string): Promise<Record<string, string>> {
  const files = [
    ["refs", await git(root, ["show-ref"], true)],
    ["status", await git(root, ["status", "--porcelain=v2", "-z"])],
    ["config", await readFile(join(root, ".git", "config"), "utf8")],
    ["hook", await readFile(join(root, ".git", "hooks", "pre-commit"), "utf8")],
    [
      "index",
      createHash("sha256")
        .update(await readFile(join(root, ".git", "index")))
        .digest("hex"),
    ],
  ];
  return Object.fromEntries(files);
}

async function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure)
    throw new Error(stderr.trim() || `git ${args[0]} failed.`);
  return stdout.trim();
}

async function tempRoot(prefix: string): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, prefix));
  roots.push(root);
  return root;
}

async function fileExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
