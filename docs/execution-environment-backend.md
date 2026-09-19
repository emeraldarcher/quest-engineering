# Execution environment backend architecture

## Status and scope

Phase 1 introduces the Worker-internal execution-environment contract, deterministic test backend, conformance suite, and an un-wired host-native compatibility adapter. It does not provision SBX, change production dispatch, change Worker Protocol v7, add database state, or change where Pi, Antigravity, Herdr, Git, or the control bridge run.

The intended production topology is one Run-scoped SBX microVM. SBX lifecycle and production integration are later work. No SBX command is issued by the Phase-1 code.

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

`ensure` is Run-scoped and exact-spec idempotent. Reusing a live Run environment with any changed spec field fails closed. `recover` accepts only the current exact ref, exact incarnation, and exact spec. `stop` retains identity but makes a lease unusable; a later exact `ensure` reactivates that same incarnation. `remove` retires the physical binding; a later `ensure` creates a new physical identity/incarnation and fences every old ref and lease.

The Phase-1 in-memory implementations provide these semantics. A durable production backend will additionally need restart-safe identity and ownership storage before adoption can be claimed.

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
- `launcher(command)`; and
- `exec(command)`.

Harnesses must consume the path map instead of reconstructing host or guest paths. The Phase-1 host-native adapter maps these entries to existing absolute host paths. A future SBX backend can map them to guest paths without changing harness semantics.

`launcher` returns a `HostLaunchDescriptor` containing a host-visible executable, arguments, working directory, environment overlay, PTY requirement, and exact environment/profile provenance. Host-native returns the direct command. A future SBX backend can return a controlled wrapper that enters the leased microVM. The descriptor exposes no SBX-specific shape to Herdr or an agent harness.

`exec` is Worker-controlled, noninteractive command execution for setup, source materialization, Git operations, and deterministic probes. It returns exit code, stdout, and stderr. It is not the coding agent's shell/tool interface and grants no model authority.

## Capabilities and profile identity

Capabilities use backend-neutral `{kind, mode}` values. In particular:

```text
{ kind: "container_runtime", mode: "isolated" }
{ kind: "container_runtime", mode: "unavailable" }
```

This can represent the private container-runtime requirement that motivates SBX without putting Docker-specific objects into generic interfaces. Phase 1 does not claim or test an isolated container runtime.

An `EnvironmentProfileIdentity` is a stable versioned ID plus immutable digest, for example `qe-execution-v1` and its resolved digest. Future profiles may pin an SBX template/kit, toolchains, harness versions, layout, and security defaults. Phase 1 models identity/provenance only and builds no image or template.

## Phase-1 backends

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

It is not wired into production dispatch and is not the long-term default. Its purpose in Phase 1 is to prove that the generic contract can represent current execution without changing current execution.

## Conformance suite

The reusable suite runs unchanged against Fake and HostNative and covers:

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

The suite has opt-in extension points for filesystem isolation, private HOME, private Git, real PTY behavior, network policy, credentials, isolated container runtime, and Worker-restart adoption. No Phase-1 backend registers those extensions, so the tests do not claim unimplemented physical guarantees.

## Future SBX mapping

A later SBX backend is expected to map one Run to one microVM with private filesystem, Git metadata, HOME/cache/temp, container runtime, Pi/Antigravity processes, narrow control relay, and controlled credential/network policy. The backend will translate guest commands into host launch wrappers for Herdr and use noninteractive exec for Worker-controlled setup/probes.

Before production integration, Phase 2 must settle durable environment identity/incarnation ownership, restart adoption, wrapper provenance, capacity/readiness, and path/control translation. Those decisions must not move recovery authorization into the backend or expose SBX semantics through `AgentHarness` or `TerminalSessionBackend`.
