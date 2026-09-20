# Execution environment backend architecture

## Status and scope

Phase 1 introduced the Worker-internal execution-environment contract, deterministic test backend, conformance suite, and an un-wired host-native compatibility adapter. Phase 2 added a real, durable `SbxExecutionEnvironmentBackend` and exercised it against Docker Sandboxes. Phase 3 adds the Worker-local private-Git workspace layer described in [Private Git inside Run-owned execution environments](private-git-sbx.md). Production dispatch, Worker Protocol v7, Pi, Antigravity, Herdr, the control bridge, Product databases, and Delivery remain unchanged.

The target production topology remains one Run-scoped SBX microVM. Phase 2 proves lifecycle, ownership, isolation, private-Docker, exec, and PTY-launch boundaries. Phase 3 proves frozen source import, private repository/worktree state, checkpoint/export/import, restart persistence, and environment-replacement restore. Neither backend nor workspace infrastructure changes current production behavior merely by existing.

## Orthogonal responsibilities

The runtime has three independent boundaries:

- `AgentHarness` owns coding-agent behavior: model/configuration validation, prompting, native conversation state, semantic completion, and harness-specific recovery evidence.
- `TerminalSessionBackend` owns persistent terminal transport: PTY topology, observation, terminal input/takeover, and terminal-session lifecycle. Herdr is the current implementation.
- `ExecutionEnvironmentBackend` owns the machine/environment boundary: filesystem namespace, workspace materialization, HOME/cache/temp, Git environment, network and credential capabilities, resource/profile identity, and process launch/exec.

Consequences:

- Agent harnesses do not know SBX commands or identifiers.
- Herdr does not become a filesystem-isolation system.
- An execution-environment backend does not interpret prompts, models, results, or recovery authorization.
- Product concepts such as Quest, Tactic, Step, Class, Loadout, and semantic Artifact remain independent of the physical backend.

## Ownership and identity

A durable Quest is human intent. A Run is one concrete execution of that intent and owns one current environment boundary on one Worker/backend:

```text
Run
└── EnvironmentLease (EnvironmentRef + exact incarnation)
    ├── PhysicalLineage A
    │   └── harness process / native conversation / terminal binding
    ├── PhysicalLineage B
    │   └── harness process / native conversation / terminal binding
    └── Run workspace, Git state, HOME/cache/temp and runtime capabilities
```

An Attempt does not own the environment. A recovery may append an Attempt while retaining the same Run environment and may retain/adopt a PhysicalLineage when existing QE recovery rules authorize it. Attempt identity, environment identity, environment incarnation, and physical-lineage identity are therefore separate.

If a physical environment is removed and recreated, it receives a new `EnvironmentRef` and incarnation even when the logical Run remains the same. The contract never fabricates physical continuity.

Recovery authorization remains in the existing QE recovery/runtime code. The backend can recover only an exact current physical ref against an exact spec. It cannot decide that an old environment, process, lineage, or conversation belongs to a new Attempt.

## Contract

The Worker-side interface is:

```ts
interface ExecutionEnvironmentBackend {
  readonly kind: string;

  readiness(): Promise<EnvironmentReadiness>;
  ensure(spec: EnvironmentSpec): Promise<EnvironmentLease>;
  recover(ref: EnvironmentRef, spec: EnvironmentSpec): Promise<EnvironmentLease>;
  inspect(ref: EnvironmentRef): Promise<EnvironmentInspection>;
  stop(ref: EnvironmentRef): Promise<void>;
  remove(ref: EnvironmentRef): Promise<void>;
}
```

`ensure` is Run-scoped and exact-spec idempotent. Reusing a Run environment with any changed spec field fails closed. `recover` accepts only the current exact ref, exact incarnation, and exact spec. `stop` retains identity but makes a lease unusable; SBX `recover` or `ensure` starts and re-verifies that same incarnation. `remove` retires the physical binding; a later `ensure` creates a new physical identity/incarnation and fences every old ref and lease. Removed refs are stale for every operation except idempotent repeated removal.

The SBX implementation persists restart-safe ownership before physical creation and verifies durable ownership, native UUID/name/agent inventory, and a guest ownership marker before adoption. A missing or conflicting physical environment is never silently replaced.

## EnvironmentSpec

`EnvironmentSpec` contains physical requirements derived from authoritative Worker/QE state:

- Worker and Run identity;
- logical Workspace and optional Project identity;
- workspace access and materialization kind;
- immutable source identity and frozen base identity;
- pinned profile ID and digest;
- pinned resource-policy ID and digest;
- capability-oriented network requirements;
- credential-grant descriptors;
- control-channel requirements; and
- required environment capabilities.

It deliberately contains no Attempt ID, prompt, model, harness semantics, mutable display name, or backend CLI syntax. Credential descriptors carry opaque grant identity, kind, and optional scope only. Raw secret values are not part of the type; Phase 1 adds no persistence or secret broker.

Network requirements identify purposes such as QE control, provider egress, registries, Git remotes, or project services. There is no blanket `network: true` flag.

## EnvironmentRef and inspection

`EnvironmentRef` contains:

- backend kind;
- opaque environment ID;
- physical incarnation;
- owning Worker ID;
- owning Run ID; and
- exact profile identity.

The opaque environment ID is not a mutable display name and does not assume an SBX CLI naming convention. `EnvironmentInspection` reports the exact ref, lifecycle state, usability, canonical spec digest, path map, and advertised capabilities.

`EnvironmentReadiness` is backend-level, side-effect-free readiness with status, diagnostics, capabilities, and contract/implementation provenance. It is distinct from readiness of a particular leased environment and from harness/model readiness.

## Lease, paths, launch, and exec

An `EnvironmentLease` is a verified currently usable binding. It exposes:

- the exact `EnvironmentRef`;
- `EnvironmentPathMap` for workspace, state, control, HOME, cache, and temp in the environment namespace;
- environment capabilities;
- pane/process environment variables;
- `launcher(command)`;
- environment-user `exec(command)`;
- privileged Worker-only `workerExec(command)`; and
- bounded, hash-verified `writeFile`/`readFile` transfer.

Harnesses must consume the path map instead of reconstructing host or guest paths. HostNative maps these entries to existing absolute host paths. SBX maps them to namespace-local guest paths (`/qe/workspaces/default`, `/qe/state`, `/qe/control`, `/home/agent`, its cache, and `/tmp/qe`). Identical guest path strings in two leases refer to different microVM namespaces. The Phase-3 workspace layer derives repository/workspace roots from this map and returns a `PrivateGitPathMap`; a harness must not guess `/qe/git` or physical-lineage paths.

`launcher` returns a `HostLaunchDescriptor` containing a host-visible executable, arguments, working directory, environment overlay, PTY requirement, and exact environment/profile provenance. HostNative returns the direct command. SBX returns a Worker-controlled Bun wrapper that rechecks native UUID/name identity, enters the guest with structured arguments, requests interactive TTY mode, forwards resize/termination signals, and repairs an initially zero host PTY size before launch. Guest `HOME` is kept out of the host launcher environment. The descriptor exposes no SBX-specific shape to Herdr or an agent harness.

`exec` is Worker-controlled, noninteractive command execution as the environment user for setup and deterministic probes. `workerExec` is the privileged control-plane counterpart used for filesystem ownership and checkpoint setup; it is never an agent tool. Both preserve structured argv, cwd, environment, stdout, stderr, and nonzero exit status. Timeouts terminate the CLI operation and escalate to a forced kill after a grace period.

`writeFile` and `readFile` provide bounded binary transfer only below a lease path-map root. SBX uses `sbx cp`, regular-file and path checks, a pre/post exact-incarnation fence, byte bounds, and SHA-256 verification; HostNative applies containment and symlink checks; Fake keeps bytes per incarnation. This generic mechanism exists because source/checkpoint transfer is an environment concern, while bundle/ref semantics remain in the private-Git workspace layer.

## Capabilities and profile identity

Capabilities use backend-neutral `{kind, mode}` values. In particular:

```text
{ kind: "container_runtime", mode: "isolated" }
{ kind: "container_runtime", mode: "unavailable" }
```

This represents the private container-runtime requirement without putting Docker-specific objects into generic interfaces. SBX advertises it only after environment-level verification starts a harmless scratch child container against the guest daemon and persists the daemon/incarnation proof.

An `EnvironmentProfileIdentity` is a stable versioned ID plus immutable digest. Phase 2 defines `qe-execution-v1`: the built-in shell kit with a tested SBX baseline, no host workspace mounts, shared skills off, empty static MCP, credential variables disabled, sandbox-scoped deny-all networking, and canonical guest paths. The profile uses a tested compatibility floor rather than an exact native-version gate: older, malformed, client/server-mismatched, and explicitly known-bad versions fail; a newer version is usable only after the complete readiness contract passes and emits `newer_than_tested_but_compatible`.

## Backend implementations

### FakeExecutionEnvironmentBackend

The fake implements exact lifecycle behavior entirely in memory:

- concurrent exact `ensure` calls converge on one lease;
- changed specs are rejected while a physical binding exists;
- recovery requires exact ref/spec and a running state;
- stop, remove, inspection, replacement, and incarnation fencing are deterministic;
- launcher descriptors carry exact provenance;
- exec results are deterministic and command history is isolated per incarnation; and
- every contract operation supports one-shot deterministic failure injection.

Its paths and launcher are descriptors, not proof of filesystem or PTY isolation. It advertises the isolated container runtime as unavailable.

### HostNativeExecutionEnvironmentBackend

The compatibility backend represents current direct host execution: configured existing host paths, direct host launcher descriptors, and direct noninteractive process execution. It explicitly advertises shared host filesystem/HOME/Git and no isolated container runtime. Its stop/remove operations retire only the in-memory logical lease; they never stop the host or delete files.

It is not wired into production dispatch and is not the long-term default. Its purpose is to prove that the generic contract can represent current execution without changing current execution.

### SbxExecutionEnvironmentBackend

The Phase-2 backend uses the installed `sbx` CLI through one structured client boundary. Lifecycle commands target the deterministic display name because SBX v0.43 does not accept its immutable UUID as a command target; adoption therefore requires both the durable UUID and the exact name to resolve to the same shell sandbox. CLI JSON is schema-checked, command timeouts are bounded, and retained error argv redacts environment values.

Ownership is persisted under the configured Worker data root in `execution-environments.sqlite` with SQLite WAL, `synchronous=FULL`, forward schema migration, and unique current `{backend, Worker, Run}`, display-name, and physical-ID constraints. An intent containing a random incarnation and creation token commits before `sbx create`. Same-Run operations serialize in-process; separate processes coordinate through the intent's PID/token and SQLite. A live creator is allowed to finish, a dead creator can be taken over, and a lost create response is reconciled only through the deterministic name plus creation identity. History is retired, not overwritten.

Adoption authority is the conjunction of:

1. the current, unretired durable Worker record and exact spec/profile digest;
2. native inventory with the same immutable UUID, deterministic name, and `shell` agent; and
3. a guest marker containing Worker, Run, environment UUID/name, incarnation, profile, and spec identity.

The backend never adopts by name alone after physical binding. Missing environments, duplicate names, UUID/name conflicts, marker conflicts, incompatible specs, and ambiguous creation fail closed. Stop is recoverable. Removal verifies absence before retiring ownership. Failed initialization removes only an environment created by that exact operation; a pre-existing conflicting environment is preserved for investigation.

Environment verification proves the canonical layout and private HOME sentinel; absence of host `/Users` and unexpected virtiofs mounts; no host Docker socket or usable SSH agent; disabled ambient credential values; empty ambient MCP and active global/scoped deny-all network policy plus a harmless denied-egress probe; CPU and memory bounds; private Docker-root identity and disk size; and a scratch child-container proof. The v1 disposable resource policy enforces 1 CPU, 1 GiB memory, and a 1 GiB private Docker disk. SBX v0.43 does not expose enforceable root-disk or PID limits, so those limitations appear as inspection diagnostics rather than false capabilities.

The SBX backend accepts `disposable_fixture` and Worker-controlled `frozen_import` workspace specs with no credential grants, egress requirements, or control channels. The backend itself does not interpret repositories: Phase 3 layers source bundles, private Git, worktrees, and exports above a verified lease. It still does not launch Pi/Antigravity, attach Herdr, relay MCP/control traffic, or wire production artifact completion.

## Conformance suite

The reusable contract suite runs against Fake, HostNative, and SBX (with explicit backend differences for namespace-local path strings, stopped-environment startup, and spec error naming) and covers:

- backend readiness and capability representation;
- concurrent and sequential ensure idempotency;
- exact spec matching;
- rejection of incompatible adoption;
- exact-ref recovery;
- inspection;
- stop and remove;
- replacement incarnation fencing and stale-ref/old-lease rejection;
- launcher provenance;
- noninteractive exec; and
- concurrent Run identity/path/exec separation.

The suite retains opt-in physical-proof extension points. SBX deterministic tests cover readiness/version policy, SQLite migration/history, process-race reconciliation, restart adoption, create-response loss, stale/missing/conflicting identities, verifier fail-closed behavior, private Docker proof, network/credential checks, command timeout/redaction, launcher construction, and bounded transfer. `QE_LIVE_SBX=1 bun test test/sbx-live.test.ts` proves the Phase-2 lifecycle/PTY boundary. `QE_LIVE_SBX=1 bun test test/private-git-live.test.ts` proves Phase-3 import, private Git/worktrees, read-only enforcement, committed and uncommitted changes, restart persistence, checkpoint/export/import, replacement restore, source immutability, and cleanup. Neither test launches a harness or performs paid inference.

## Phase-4 production gate

Phase 3 deliberately stops before production dispatch. Private source/Git import and export now exist, but Phase 4 still must integrate the returned physical-lineage path/access contract, attempt-scoped control translation, credentials and narrow provider egress, scheduler capacity, startup reconciliation, completion/export ordering, and operator-visible failure handling. Existing QE recovery remains authoritative; an environment or Git restore must not authorize a new Attempt, lineage, prompt, model action, semantic Artifact, or Delivery.

`AgentHarness` and `TerminalSessionBackend` must continue to receive generic paths, launch descriptors, access mode, and provenance rather than SBX lifecycle or bundle mechanics. Read-only launches must preserve the Phase-3 path/permission boundary; stronger concurrent-lineage isolation should use per-lineage execution principals. Semantic cross-harness handoff remains Artifact-only.

Until that gate is approved, production dispatch continues to use the current host worktree/process path. SBX/private-Git modules have no import from dispatch, harness, Herdr, protocol, server, or UI modules.
