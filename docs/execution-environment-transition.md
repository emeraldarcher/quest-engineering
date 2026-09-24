# Execution-environment transition baseline

## Status

This document records the preservation boundary and phased transition. Phase 1 on `phase1/execution-environment-backend` added the Worker-internal contract, Fake backend, conformance suite, documentation, and un-wired HostNative adapter. Phase 2, based on Phase-1 commit `f4298557af70356eb8cef775ea0ac4b8cc55dbcc`, added a durable SBX implementation. Phase 3 added Worker-local private Git materialization, worktrees, checkpoint/export/import, and replacement restore. Phase 4 wires production **Pi only** to those boundaries; Antigravity remains on its existing path. No phase authorizes cleanup of the original dirty checkout, retained Run worktrees, Worker state, Herdr sessions, or databases.

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

Herdr remains host-native and executes the backend-selected `HostLaunchDescriptor` directly. Production Pi requires an absolute pinned Herdr binary and Herdr's generic explicit managed-launch capability; neither Herdr nor QE resolves Pi through a shell or `PATH`. `HarnessControlAuthority` remains Worker-owned; only a narrow attempt-scoped MCP/control relay enters the environment.

The production Pi backend uses the one normal host-side SBX daemon under the real macOS login and one microVM per Run. Isolation is the Run VM—not a fake host `HOME`, fake macOS user, per-Run daemon, or per-Run host credential store—and covers filesystem, Git state, HOME/cache/temp, container runtime, harness processes, network/credential grants, and control authority. Phase 2 implements lifecycle, persistence, restart adoption, generic exec, host launcher wrapping, private HOME/filesystem checks, deny-all networking, disabled ambient credentials, and private Docker proof. Phase 3 adds generic bounded transfer/Worker control execution plus private Git above the lease. Phase 4 adds the repository-owned Pi kit, host-Pi dynamic proxy credential, provider-only guest egress, attempt-scoped file mailbox, guest lifecycle relay, Herdr PTY wrapper, dynamic model discovery, and completion-ordered private-Git export/import. The generic contract deliberately exposes no SBX CLI naming or Docker-specific object shape.

## Run-scoped environment contract

One Run owns one private execution environment and private HOME, Git state, caches, and Docker daemon where supported. The workspace flow copies the exact local base OID into a Worker-owned isolated host repository, then bundle-imports it into the Run environment. The configured source repository remains a read authority and is never used for Run refs, temporary branches, linked worktrees, or writable remotes. Legacy source-linked records are fenced rather than treated as a compatibility mode.

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

Phase 3 implements and validates private source/Git infrastructure but deliberately does not integrate production. One Run environment owns one private bare repository domain; each PhysicalLineage owns a registered worktree. Exact source bundles support local-only commits without a network clone. The subsequent no-inference correction also moved the host Run/Delivery worktree into a Worker-owned isolated repository: the source repository's `HEAD`, refs, packed refs, index, status, config, hooks, and files remain byte-for-byte authorities across provisioning, cleanup, and injected failure. Separate index/result trees preserve committed, staged, unstaged, and non-ignored untracked work. A verified four-ref checkpoint bundle plus canonical manifest is the authoritative environment-replacement and future Delivery handoff. See [Private Git inside Run-owned execution environments](private-git-sbx.md).

Phase 4 integrates Pi production dispatch with physical-lineage path/access, attempt-scoped control translation, host-owned credential projection, exact egress grants, whole-store startup reconciliation, and operator-visible fail-closed records. `qe_step_result` is ordered behind physical export verification and isolated host Run-repository materialization. Backend/Git recovery does not become QE authorization and cannot select an Attempt, lineage, prompt, model, semantic handoff, or Delivery. HostNative is not a fallback. The host's normal Pi credential store is authoritative: QE invokes Pi's own expiry/refresh/rotation path under lock, commits rotations atomically, and exposes the current access token only to SBX's sandbox-scoped dynamic proxy source. The guest receives a deterministic nonsecret JWT-shaped account placeholder with refresh semantically disabled and cannot reach the OAuth token endpoint. Docker's built-in OpenAI credential store, API keys, API-credit billing, provider fallback, per-Run daemons, and alternate host `HOME` values are prohibited. The isolated RC3 daemon experiment was diagnostic only and was abandoned rather than introducing daemon-isolation machinery into QE. The normal stable v0.43.0 daemon has now passed exact no-inference host refresh, resource substitution, restart, cross-sandbox scope, revocation, global-policy preservation, and cleanup proofs.

The original paid acceptance stopped before prompt intent after legacy Herdr resolution selected host Pi. That failed Run, Attempt, PhysicalLineage, environment, session, and evidence remain immutable; provider/model cycles were zero. The correction makes the descriptor authoritative through a generic additive Herdr `agent.start.command`, requires exact `QE_HERDR_BIN`, removes the host `pi` PATH wrapper, persists launcher/guest argv provenance, and requires guest attestation of Run, environment incarnation, profile, lineage, workspace/cwd, `HOME`, and required paths before prompt authorization. A launch-only live retry passed with a hostile host `pi` PATH trap, process survival across controller restart, Open Session/Take Control projection, shell restoration, private Docker, source equality, zero prompts, and zero provider cycles.

One separately authorized paid Attempt then reached the exact guest but its first provider request rejected bundled `gpt-5.3-codex-spark` for the ChatGPT account. It stopped with zero tokens and `$0.00`; its failed execution and retained session remain immutable. Later direct Sol execution under the current OAuth generation disproved the former global zero-model conclusion. The corrected authority is now the immutable Pi runtime catalog intersected only with optional QE scope; host Pi model settings are UX preferences, and the authenticated provider models resource is advisory diagnostics.

Account availability is tracked independently per exact account/auth-generation/profile/provider/model as `verified_available`, `verified_unavailable`, or `unknown`. Unknown remains schedulable; only current direct rejection evidence excludes a model. Preserved direct evidence seeds Sol available and Spark unavailable, while Luna, Terra, Astra, and the other runtime models remain unknown until direct evidence changes them. Rejection still fails the frozen Attempt without another turn, substitution, or automatic retry. Guest lifecycle writes are serialized and relay teardown drains final idle, keeping terminal failure, retained attachment, native activity, and account evidence distinct. No further paid Attempt is authorized. Existing Worker `max_concurrency` remains the admission bound and exact one-environment-per-Run ownership is enforced by the durable backend.

The discovery/actionability feature must be ported later in small semantic commits after the isolated environment and private-Git model exist. The host-native Antigravity archive remains reference-only. Every phase must preserve the generic lifecycle and recovery tests and pass the applicable repository gates.

## Cleanup hold

No historical worktree is cleanup-safe merely because its branch is preserved. Before removal, verify the owning Run and Delivery state, retained-worktree state, branch/ref reachability, untracked snapshot recovery, and absence of active Worker/Herdr ownership. The active Builder Run and all ready or dirty worktrees remain protected until explicit human release.
