# Private Git inside Run-owned execution environments

## Status

Phase 3 adds independently testable Worker infrastructure for private Git materialization, physical-lineage worktrees, deterministic workspace fingerprints, checkpoints, export, restore, and isolated host-fixture import. It is not imported by production dispatch, Pi, Antigravity, Herdr, the server, protocol, Delivery, or UI.

The implementation is `workers/bun/src/workspace/private-git.ts` with durable state in `private-git-store.ts`. It is a workspace layer above `EnvironmentLease`, not an execution-environment backend capability. An SBX machine can exist without a repository and a Run can materialize more than one repository in future, so no gratuitous `private_git` capability was added to the environment contract.

## Authority boundary

The Worker chooses and verifies all source inputs:

- authorized host repository path;
- logical repository ID and canonical source identifier;
- exact full base commit OID;
- source provenance;
- import method; and
- optional credential-free publication metadata.

None comes from a model or harness. The host path is an infrastructure input and is neither copied into the guest nor used as logical repository identity. Worker-side Git reads are authorized infrastructure reads. They do not grant the sandbox access to the host worktree, common Git directory, refs, sibling worktrees, config, hooks, credentials, or filesystem paths.

The guest has no host mount. All mutable Git objects, refs, config, indexes, worktree registrations, and implementation commits live in the Run environment. Normal agent Git commands therefore mutate only private Run state.

Future discovery/actionability must authorize source admission before `materializeSource`. Discovery remains an observation; it is not import authority. The future check belongs at the Worker command that resolves `RepositorySourceRequest`, before any host object read or bundle creation—not in an ambient shell path allowlist.

## Source identity

`RepositorySourceIdentity` is a canonical versioned value containing:

- repository ID;
- canonical credential-free source identifier;
- exact base commit and tree OIDs;
- SHA-1 or SHA-256 object format;
- repository format version;
- source provenance (`authorized_local_object_database` or `authorized_remote_cache`); and
- optional credential-free publication URL/default-branch metadata.

The source identity is canonically encoded and SHA-256 hashed. Raw credentials and the Worker host path are absent. URL userinfo other than conventional `ssh://git@...`, passwords, query strings, and fragments are rejected. Guest paths are physical locations and never repository identity.

The resolver requires a full 40- or 64-hex OID, verifies `<oid>^{commit}`, records `<oid>^{tree}`, checks the complete reachable object closure with `--missing=print`, and applies the repository policy before creating a bundle. Branch names, later `HEAD`, remote refs, and agent-supplied refs are not accepted as execution identity. A local-only, never-pushed commit works because import reads the authorized local object database.

## Materialization

The Worker creates a temporary bare staging repository under its data root. The staging repository uses the authorized source object directory as an alternate, creates one staging-only `refs/qe/imports/<source-digest>/base` ref, and emits a full Git bundle. No host source ref or index is changed. The bundle is verified, its sole advertised ref and OID are checked, its bytes are bounded, and its SHA-256 is recorded.

The bundle crosses the lease through the generic bounded file-transfer contract. SBX implements transfer with `sbx cp`, a pre/post exact-incarnation fence, regular-file checks, a byte bound, and SHA-256 verification on both sides. Temporary host transfer files stay under the Worker data root. `workerExec` is a privileged setup/checkpoint control plane and is never an agent tool. All Git-domain guest operations still use `lease.exec`/`workerExec`; private-Git code contains no ad hoc SBX CLI invocation.

Inside the environment the Worker:

1. initializes one bare private repository;
2. installs only intentional local config;
3. verifies the bundle before fetch;
4. requires exactly the expected import ref;
5. fetches with an operation-local file-transport allowance while repository policy otherwise disables file transport;
6. verifies the exact base commit/tree; and
7. writes an incarnation-bound repository marker under Worker state.

Durable `ready` state with a missing or conflicting guest repository fails closed. It is never silently recreated. A `materializing` intent can reconcile an exact already-created repository after response loss.

## Guest layout and ownership

Paths are derived from the generic lease path map rather than reconstructed by a harness:

```text
/qe/git/<sha256(repository-id)[0:24]>.git
/qe/workspaces/<sha256(physical-lineage-id)[0:24]>
/qe/state/private-git/
  repositories/
  imports/
  exports/
  indexes/
  lineages/
  runtime/<lineage-hash>/{home,cache,tmp}
```

`PrivateGitPathMap` returns the private repository, exact lineage workspace, writable runtime HOME/cache/temp, and Worker-state paths. Pi- and Antigravity-specific names do not appear.

One environment repository owns the common object/ref/config domain. Each `PhysicalLineage` owns one registered Git worktree and deterministic private branch. Attempt IDs are absent. Replaying the same `{environment incarnation, repository, physical lineage, access}` converges on the same durable and physical worktree. Another Run or incarnation receives another record and physical identity even when logical IDs are the same.

Two lineages can coexist and share private objects while their checkout paths, branches, and files remain distinct. Attempt recovery can retain the same worktree. Environment replacement creates a new physical repository/worktree identity and restores content; it never claims physical continuity.

## Workspace access

For `read_write`, the environment user owns a normal private worktree and can add, commit, branch, reset, rebase, checkout, and clean without a host-protection command parser. The private repository has no configured remote and the SBX profile has deny-all networking and no Git/SSH credentials, so agent-driven push and PR creation are unavailable.

For `read_only`, the Worker removes all write bits from the worktree and, on SBX, recursively assigns checkout ownership to root. Recovery re-verifies that no non-symlink source path is writable. The lineage runtime HOME/cache/temp remains owned by the environment user and writable; the VM and Worker control state are not made globally read-only. The live test proves an environment-user write fails while a runtime-temp write succeeds.

The shared common Git directory remains readable and supports Worker checkpointing. Phase 4 must preserve the returned access mode and workspace path when constructing the harness launch. It must not replace this with host-root shell authorization. For stronger hostile isolation between simultaneously active lineages, Phase 4 should use per-lineage execution principals; Phase 3 proves source-content enforcement and filesystem separation but does not expose a harness yet.

## Repository config, identity, hooks, and publication

Private repositories receive only:

- `Quest Engineering Agent <qe-agent@local>`;
- commit/tag signing disabled;
- `core.hooksPath=/dev/null`;
- recursive submodule behavior disabled; and
- file transport disabled except for explicit Worker import operations.

Host `.git/config`, includes, aliases, credential helpers, filesystem paths, signing configuration, remotes, and user identity are not copied. Publication metadata remains in the source/export manifest and is not installed as a remote. No signing keys are configured.

Host `.git/hooks` is never copied. Repository-tracked hook frameworks remain ordinary project files and may execute when explicitly invoked by project tooling inside the sandbox. Initial Git hook dispatch is disabled by the private repository config; an agent may mutate its private config without affecting the host.

QE-generated index/result snapshot commits use `Quest Engineering Worker Snapshot <qe-worker@local>`, a fixed timestamp, and explicit internal messages. They are physical provenance, not claims that the coding agent authored semantic commits. Agent-created private commits retain the deterministic agent identity unless the agent changes private config.

## Repository policy and untrusted input

Phase 3 applies these fail-closed boundaries:

- tree paths are NUL-delimited and reject absolute paths, normalization changes, `.`/`..`, and case-insensitive `.git` components;
- untracked entries must be regular files or symlinks; symlink targets are hashed/stored as links and never followed;
- bundle advertised refs must exactly equal the manifest allowlist under `refs/qe/...`;
- replacement refs and unexpected refs are rejected;
- object IDs, source/checkpoint/fingerprint hashes, byte counts, and bundle bytes are revalidated;
- host import is into an empty isolated bare fixture before any optional future checkout;
- no archive path extraction is used; and
- Git config and hooks do not cross the boundary.

Newline and tab filenames are handled through NUL-delimited Git output. Phase 3 assumes repository paths are valid UTF-8. Non-UTF-8 path support is a documented future extension because the current structured `EnvironmentCommandResult` is text.

### Submodules

Any Gitlink (`160000`) in the frozen base or resulting tree is unsupported and fails clearly. `.gitmodules` is inert project content; QE never initializes it or fetches a submodule URL. Recursive, explicitly authorized offline submodule materialization is future work.

### Git LFS

A tree whose `.gitattributes` enables `filter=lfs` is unsupported and fails clearly. QE does not claim pointer files are materialized content and never performs hidden LFS network fetches. Controlled import of already-present local LFS objects is future work.

### Sparse and partial clones

An authorized sparse worktree is acceptable only when the frozen commit's complete Git object closure already exists locally. Missing/promisor objects fail before bundle creation; QE does not fetch them. Phase 3 does not preserve sparse-checkout shape and does not introduce partial-clone behavior.

## Fingerprint and uncommitted state

Fingerprinting does not trust mtimes or model prose. For an exact workspace it records:

- frozen base commit;
- current `HEAD` commit and tree;
- current index tree (`git write-tree`), preserving staged content;
- a resulting tree built with a temporary QE index initialized from `HEAD` and `git add -A -- .`;
- sorted, non-ignored untracked paths; and
- sorted base-to-result name-status changes.

The SHA-256 fingerprint is over a canonical JSON encoding of those fields. The temporary index means the agent's index and worktree are not changed. The resulting tree includes tracked modifications/deletions and non-ignored untracked regular files/symlinks. Ignored dependency, cache, and build output is excluded by Git's ignore rules. HEAD plus separate index/result trees preserves committed, staged, unstaged, and untracked state—including different staged and working content for the same path.

Git object creation during fingerprinting is private QE physical state. It creates no semantic ref until checkpoint.

## Checkpoint and export

Checkpoint creates deterministic internal commits for the index tree and resulting tree, each parented by the current private HEAD. It then creates four exact refs:

```text
refs/qe/checkpoints/<checkpoint-id>/base
refs/qe/checkpoints/<checkpoint-id>/head
refs/qe/checkpoints/<checkpoint-id>/index
refs/qe/checkpoints/<checkpoint-id>/result
```

A full verified bundle contains those refs and all required objects. The canonical manifest contains repository/source identity, source environment/incarnation provenance, physical lineage/access, base/head/index/result commits and trees, fingerprint, untracked paths, changed paths, exact refs, bundle byte length, and bundle SHA-256. `exportId` is SHA-256 of the canonical manifest. The deterministic checkpoint ID binds source, lineage, fingerprint, and internal snapshot commits.

The Worker stores immutable bundle and manifest bytes in a content-addressed directory under `private-git-artifacts/` and stores identity/state in `private-git.sqlite`. A repeated checkpoint of unchanged state reuses the exact durable export.

`checkpoint` requires a `ChangeSetPhysicalContract` containing the exact repository/base and can require exact declared changed paths. The Worker computes actual state; a declaration mismatch fails. Future `qe_complete_step` integration must complete only after this boundary returns a validated export and must place the returned export/result-tree identity in the semantic Change Set artifact. Phase 3 deliberately does not wire that production path.

## Restore and recovery

Private Git and worktrees naturally survive harness restart, Attempt recovery, Worker restart, and SBX stop/start because they live in the retained Run environment. Durable Worker records use exact backend, environment UUID, incarnation, Worker, Run, repository, lineage, access, guest path, and branch identities.

If the environment is gone, ordinary materialization fails closed against the missing physical state. Explicit `restoreCheckpoint` is the recovery authority:

1. revalidate manifest/export/checkpoint/fingerprint identities and bundle hash/size;
2. create/import into a fresh environment repository identity;
3. create a fresh lineage worktree at checkpoint HEAD;
4. populate the worktree from the result commit;
5. reset the index to the separate index tree;
6. reapply read-only permissions when required; and
7. recompute and require the exact original fingerprint/result/index/HEAD identities.

This preserves uncommitted work without `git stash`. Ignored output is intentionally absent. A replacement has a new environment incarnation and new repository/worktree physical IDs even though content identity matches.

## Controlled host import and Delivery handoff

`validateAndImportPrivateGitExport` accepts only an empty isolated bare fixture. It verifies manifest/export/checkpoint/fingerprint hashes, bundle bytes, exact refs, `git bundle verify`, strict object validity, base commit/tree, result tree, changed paths, safe tree paths, and the no-submodule/no-LFS policy. It fetches only four namespaced refs and then requires the complete fixture ref set to equal those refs. It installs no remote, credentials, user identity, signing config, or imported hooks.

Future Delivery receives this validated accepted export—not a sandbox path or model description. Delivery may then create a Worker/server-controlled host branch/worktree, import exact objects, and publish with controlled credentials. The sandbox agent never receives the host repository, publication credentials, push authority, or PR API authority.

Physical sharing inside a Run does not change semantic Tactic handoff. Cross-harness context remains typed Artifacts. Seeing the same private filesystem is not an implicit semantic handoff.

## Validation

Deterministic tests cover source identity, exact/local-only base import, source immutability, idempotency, stale transfer fencing, ownership conflicts, read-only/read-write behavior, separate lineages, fingerprints, staged/unstaged/untracked/ignored state, symlinks, LFS/submodule rejection, path traversal, unexpected refs, checkpoint/export, isolated import, clean/existing SQLite migration, Worker restart, and replacement restore.

`QE_LIVE_SBX=1 bun test test/private-git-live.test.ts` uses no harness or model. Against SBX v0.43.0 it creates a local-only host fixture, imports it, creates concurrent read-write/read-only worktrees, performs a private implementation commit plus uncommitted and untracked changes, proves read-only/runtime permissions, fingerprints, stops/restarts, recreates Worker backend/store objects, checkpoints, imports into an isolated host fixture, removes the old disposable environment, restores into a fresh incarnation, compares exact state, proves the host source unchanged, and cleans all disposable resources.
