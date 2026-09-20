# Execution-environment transition baseline

## Status

This document records the preservation boundary and phased transition. Phase 1 on `phase1/execution-environment-backend` added the Worker-internal contract, Fake backend, conformance suite, documentation, and un-wired HostNative adapter. Phase 2, based on Phase-1 commit `f4298557af70356eb8cef775ea0ac4b8cc55dbcc`, added an un-wired durable SBX implementation. Phase 3 adds un-wired Worker-local private Git materialization, worktrees, checkpoint/export/import, and replacement restore. None of these phases authorizes cleanup of the original dirty checkout, retained Run worktrees, Worker state, Herdr sessions, or databases.

The original clean implementation baseline remains commit `430908ecf216f796ea2e038615e9b21c00f71a53` on `preserve/generic-qe-post-multiharness`. No preservation/reference branch is merged. See [execution environment backend architecture](execution-environment-backend.md) for the implemented contract, ownership authority, security checks, and remaining Phase-4 gate.

## Authoritative migration history

PostgreSQL reports all five previously uncommitted migrations as applied. Their filenames and bytes are immutable:

| Version | SHA-256 |
| --- | --- |
| `20260914000000` | `10bd9753f4979d7625e52e350e037160a92b836c3cf39f68441981aab87440b5` |
| `20260914000100` | `bd317bf946a1b755186cf4b9c347f05f79565a7ad17fd107f5ac0504cee71d66` |
| `20260914000200` | `b74c195945c6846f7553f2232f922530600cc4715363e45b00dc4ba478eb069f` |
| `20260914000400` | `d74b5cf8562116bdcf66e6be2ed3cb99a0943339289b89a37fa9963f6b472e5f` |
| `20260916000000` | `940fe0bbc6aa6e6e0ae4e14abcae9c0fd74e60fee5df96eb4432833c705440f1` |

The migration formatter excludes `20260916000000_separate_discovery_and_execution_authorization.exs` so an ordinary formatting gate cannot rewrite the already-applied file. Any correction to an applied schema must use a later forward migration.

## Preserved branches

### Generic runtime baseline

`preserve/generic-qe-post-multiharness` preserves:

- execution lifecycle, recovery authorization, status projection, and slot release;
- durable Worker dispatch, prompt, native-activity, settlement, and uncertainty evidence;
- generation-fenced Phoenix registration and reply handling;
- Worker-owned Herdr session ownership, capability-based compatibility, launch reconciliation, and exact process provenance;
- generic harness control authority, MCP transport, descriptor rotation, and completion failure classification;
- Pi and Antigravity model discovery, exact model/effort selection, interactive terminal behavior, recovery identity, HumanAttention through generic terminal state, and conformance tests;
- the idempotent Run-worktree replay/deadlock fix; and
- all five exact applied migration files.

It intentionally excludes host-native Antigravity permission hooks, host Antigravity state inspection, `unbash`, shared Git-metadata grants, and host path policy.

### Discovery/actionability reference

`preserve/discovery-actionability` preserves the retained Builder feature as a separate semantic reference:

- discovery observations distinct from execution authorization;
- repository identity and authority status;
- Product authorization intent and intent revision;
- Worker physical readiness and policy digest;
- server-side actionability checks and scheduling fences; and
- Projects UI actionability and recheck/revoke/enable flows.

This branch must not be merged wholesale. Its host-root concepts (`QE_ALLOWED_ROOTS_JSON`, `allow_unconfined_shell`, source paths, and effective host access) require reinterpretation for isolated execution environments. Its exact applied migration is already present on the generic baseline, so a port must not add, rename, squash, or edit that migration.

### Rejected host-native experiment

`preserve/host-native-antigravity-archive` contains a forensic archive under `docs/archive/host-native-antigravity-policy/`. It is not a supported runtime mode and must not be merged into the implementation branch.

## Target boundaries

Add `ExecutionEnvironmentBackend` as a third orthogonal concern:

- `AgentHarness` owns coding-agent semantics.
- `TerminalSessionBackend` owns interactive terminal transport.
- `ExecutionEnvironmentBackend` owns isolated environment lifecycle, workspace import, process execution, restart discovery, export, credentials, network policy, resource limits, and environment identity.

Herdr remains host-native and attaches to the backend-selected interactive command. `HarnessControlAuthority` remains Worker-owned; only a narrow attempt-scoped MCP/control relay enters the environment.

The intended production backend is SBX with one microVM per Run and a private filesystem, Git state, HOME/cache/temp, container runtime, harness processes, and controlled bridge/network/credentials. Phase 2 implements lifecycle, persistence, restart adoption, generic exec, host launcher wrapping, private HOME/filesystem checks, deny-all networking, disabled ambient credentials, and private Docker proof. Phase 3 adds generic bounded transfer/Worker control execution plus private Git above the lease. Bridge credentials, provider egress, harness launch, and production execution remain absent. The generic contract deliberately exposes no SBX CLI naming or Docker-specific object shape.

## Run-scoped environment contract

One Run owns one private execution environment and private HOME, Git state, caches, and Docker daemon where supported. The default workspace flow is a private clone or bundle import; sharing a linked worktree common Git directory is an explicit lower-isolation compatibility mode, not the default.

The environment boundary must enforce:

1. immutable backend/image identity and Run-to-environment ownership;
2. non-root process defaults plus backend-specific containment;
3. no host HOME, ambient SSH agent, shared skills, broad credentials, or ambient MCP access;
4. default-deny networking with exact destination grants;
5. narrow credential materialization with explicit refresh/write semantics;
6. attempt-scoped control relay identity and fail-closed behavior;
7. durable restart reconciliation without duplicate model work;
8. scheduler admission based on environment capacity;
9. explicit artifact and Git export; and
10. Delivery authorization as the only publication boundary.

## Discovery/actionability port

Preserve the feature's semantics while replacing host access assumptions:

| Preserved concept | Isolated interpretation |
| --- | --- |
| candidate observation | repository/import source is discoverable without granting execution |
| repository identity | immutable source identity verified before import |
| Product authorization intent | permission to admit a source into a Run environment |
| intent revision | fences stale environment provisioning and exports |
| physical readiness | environment import completed and backend policy is active |
| maximum access | allowed import/export/Delivery operations, not host filesystem reach |
| shell authorization | backend admission profile, not an unconfined host shell boolean |
| actionability | Product intent + identity + current environment readiness + scheduler capacity |
| policy digest | digest of backend/image/network/credential/export policy |

Port the discovery branch in small semantic commits after `ExecutionEnvironmentBackend` exists. Resolve the overlapping server protocol, Worker protocol/configuration, Worker lifecycle, scheduler, and integration tests manually; do not use a direct merge as conflict resolution.

## Phase boundaries

Phase 1 freezes the generic contract and ownership rules. It adds deterministic Fake and compatibility implementations and reusable conformance tests, but production dispatch continues to use the baseline workspace, harness, Herdr, recovery, and control paths directly.

Phase 2 implements but does not wire `SbxExecutionEnvironmentBackend`. Its Worker-local SQLite store commits creation intent before SBX mutation and retains incarnation history; it is separate from Product/PostgreSQL protocol state and requires no Product migration. The immutable v1 profile has a tested v0.43.0 compatibility floor, no host mounts, skills off, empty MCP, disabled credential variables, scoped deny-all policy, fixed guest paths, and conservative 1-CPU/1-GiB/private-Docker resources. Adoption requires durable record + native UUID/name/agent + guest marker. Real disposable tests prove private Docker child execution and PTY sizing without model inference.

Phase 3 implements and validates private source/Git infrastructure but deliberately does not integrate production. One Run environment owns one private bare repository domain; each PhysicalLineage owns a registered worktree. Exact source bundles support local-only commits without a network clone. Separate index/result trees preserve committed, staged, unstaged, and non-ignored untracked work. A verified four-ref checkpoint bundle plus canonical manifest is the authoritative environment-replacement and future Delivery handoff. See [Private Git inside Run-owned execution environments](private-git-sbx.md).

Phase 4 is the earliest possible production-integration phase. It must integrate physical-lineage path/access, attempt-scoped control translation, credential refresh/revocation, exact egress grants, scheduler capacity, whole-store startup reconciliation, and operator-visible failure handling before dispatch can acquire a lease. It must order `qe_complete_step` behind physical export verification and must not reinterpret backend/Git recovery as QE authorization or allow an environment to select an Attempt, lineage, prompt, model, semantic handoff, or Delivery.

The discovery/actionability feature must be ported later in small semantic commits after the isolated environment and private-Git model exist. The host-native Antigravity archive remains reference-only. Every phase must preserve the generic lifecycle and recovery tests and pass the applicable repository gates.

## Cleanup hold

No historical worktree is cleanup-safe merely because its branch is preserved. Before removal, verify the owning Run and Delivery state, retained-worktree state, branch/ref reachability, untracked snapshot recovery, and absence of active Worker/Herdr ownership. The active Builder Run and all ready or dirty worktrees remain protected until explicit human release.
