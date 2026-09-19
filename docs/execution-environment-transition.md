# Execution-environment transition baseline

## Status

This document records the Phase 0.5 preservation boundary. It does not implement an execution-environment backend and does not authorize cleanup of the original dirty checkout, retained Run worktrees, Worker state, Herdr sessions, or databases.

The clean implementation baseline is `preserve/generic-qe-post-multiharness`. The proposed implementation branch is `phase1/execution-environment-backend`, created from that baseline only after the preservation commits and repository gates are accepted.

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

The first production backend should be hardened ordinary Docker because it offers a mature API, explicit security controls, reproducible digest-pinned images, lower startup/resource overhead, and no Docker-account runtime gate. Docker Sandboxes remains a second backend/pilot with stronger VM isolation and private Docker state, guarded by live capability probes in addition to version checks.

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

## Phase 1 sequence

1. Introduce the backend interface and typed environment identity while retaining `HostNative` behavior unchanged.
2. Move workspace/process path construction behind the backend without changing harness semantics.
3. Implement hardened ordinary Docker with digest-pinned images and private import/export.
4. Route Herdr attachment and the attempt-scoped control relay through the selected environment.
5. Add restart reconciliation, ownership, capacity, network, credential, and export tests.
6. Port discovery/actionability semantics using environment admission and Delivery policy.
7. Retire HostNative-only Antigravity policy code only after isolated parity and migration gates pass.
8. Pilot Docker Sandboxes as a separate backend after ordinary Docker is operational.

Each step must preserve the generic lifecycle and recovery tests, add backend contract tests, and pass formatting, warning-free compilation, dependency checks, Elixir tests, Credo, Worker checks/tests, client checks/tests, and `git diff --check`.

## Cleanup hold

No historical worktree is cleanup-safe merely because its branch is preserved. Before removal, verify the owning Run and Delivery state, retained-worktree state, branch/ref reachability, untracked snapshot recovery, and absence of active Worker/Herdr ownership. The active Builder Run and all ready or dirty worktrees remain protected until explicit human release.
