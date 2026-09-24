# Execution environment backend architecture

## Status and scope

Phase 1 introduced the Worker-internal execution-environment contract; Phase 2 added durable SBX; Phase 3 added private Git; and Phase 4 wired Pi. Phase 5 routes Antigravity through the same Run-owned boundary. `qe-coding-execution-v1` composes Pi and Antigravity in one immutable VM, while historical `qe-pi-execution-v2` remains unchanged.

The production coding topology uses the one normal host-side SBX daemon owned by the real macOS login and creates one mixed-harness SBX microVM per Run. It never changes host `HOME`, creates synthetic macOS users, or creates per-Run daemons or credential stores. Each Run VM owns its filesystem, HOME, private repository, one worktree per PhysicalLineage, Docker daemon, network grants, credential binding, and control authority. A repository-owned `qe-pi-execution-v2` kit installs lockfile-pinned Pi 0.85.1 and receives a sandbox-scoped host proxy grant backed by the host Pi installation's **ChatGPT Plus/Pro subscription OAuth** for `openai-codex`. `OPENAI_API_KEY` remains disabled; API-credit billing and API-key fallback are not supported. The Worker imports the frozen source, stages exact extension bundles and document artifacts, and gives Herdr one authoritative `HostLaunchDescriptor`. Herdr executes that absolute QE/backend-owned launcher directly with literal argv, cwd, environment overlay, and PTY semantics; it never selects Pi through `PATH`, a shell, an alias, or a host wrapper named `pi`. The launcher enters the exact Run VM and starts the pinned guest Pi. The Worker then relays attempt-scoped control calls, checkpoints private Git before semantic completion, validates the export in an isolated host fixture, and materializes the verified result tree into the isolated Run delivery repository. There is no HostNative fallback for Pi or Antigravity.

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

`launcher` returns a `HostLaunchDescriptor` containing an absolute host-visible executable, literal arguments, absolute working directory, environment overlay, PTY requirement, and exact environment/profile provenance. HostNative returns the direct command. SBX returns the absolute Worker-controlled Bun runtime plus an absolute, digest-bound QE launcher entrypoint. The entrypoint rechecks native UUID/name/agent identity, enters the guest with structured arguments, requests interactive TTY mode, forwards resize/termination signals, and repairs an initially zero host PTY size before launch. Guest `HOME` is kept out of the host launcher environment. The descriptor also binds PhysicalLineage, private workspace, guest executable/cwd, and a digest of guest argv. That exact provenance is durable in `sbx-run-executions.sqlite`.

Herdr 0.9's additive `agent.start.command` transport executes the descriptor executable directly; top-level legacy `args` and explicit `command` cannot be mixed. The live server must advertise `agent_explicit_launch` in `ping`, and API schema metadata must expose `agent.start.params.command`. Relative executables, malformed environment names, NULs, or missing capability evidence fail before launch. Legacy Herdr launch behavior remains available to other callers, but production SBX harnesses never fall back to it. `QE_HERDR_BIN` is mandatory for production and must identify one absolute executable; every Herdr CLI and server subprocess uses that same canonical path.

Before launch, QE verifies the guest ownership marker, per-lineage launch binding, exact guest executable, private workspace, lineage-private HOME, control/mailbox paths, and immutable integration bundles. Pi attests through its native extension; Antigravity attests through a Node-compatible guest launcher before spawning the real TUI. Both bind Worker, Run, environment UUID/incarnation, profile, PhysicalLineage, workspace/cwd, HOME, and required paths. The Worker relay must receive that exact attestation before startup returns and before prompt intent or inference authorization can exist. A mismatched launch, explicit-launch failure, or attestation failure closes the owned pane and is a deterministic non-recoverable infrastructure failure. The descriptor exposes no SBX-specific shape to Herdr or an agent harness.

`exec` is Worker-controlled, noninteractive command execution as the environment user for setup and deterministic probes. `workerExec` is the privileged control-plane counterpart used for filesystem ownership and checkpoint setup; it is never an agent tool. Both preserve structured argv, cwd, environment, stdout, stderr, and nonzero exit status. Timeouts terminate the CLI operation and escalate to a forced kill after a grace period.

`writeFile` and `readFile` provide bounded binary transfer only below a lease path-map root. SBX uses `sbx cp`, regular-file and path checks, a pre/post exact-incarnation fence, byte bounds, and SHA-256 verification; HostNative applies containment and symlink checks; Fake keeps bytes per incarnation. This generic mechanism exists because source/checkpoint transfer is an environment concern, while bundle/ref semantics remain in the private-Git workspace layer.

## Capabilities and profile identity

Capabilities use backend-neutral `{kind, mode}` values. In particular:

```text
{ kind: "container_runtime", mode: "isolated" }
{ kind: "container_runtime", mode: "unavailable" }
```

This represents the private container-runtime requirement without putting Docker-specific objects into generic interfaces. SBX advertises it only after environment-level verification starts a harmless scratch child container against the guest daemon and persists the daemon/incarnation proof.

An `EnvironmentProfileIdentity` is a stable versioned ID plus immutable digest. Production coding uses `qe-coding-execution-v1`, containing lockfile-pinned Pi 0.85.1 and Antigravity 1.2.7's Linux ARM64 archive and binary provenance. Creation permits only package/release endpoints; post-create sandbox denies remove those grants, leaving exact Pi and Antigravity subscription hosts. Both host-managed credential proxies are installed before the combined verifier admits the VM. Phase 2 also defines `qe-execution-v1`: the built-in shell kit with a tested SBX baseline, no host workspace mounts, shared skills off, empty static MCP, credential variables disabled, sandbox-scoped deny-all networking, and canonical guest paths. The profile uses a tested compatibility floor rather than an exact native-version gate: older, malformed, client/server-mismatched, and explicitly known-bad versions fail; a newer version is usable only after the complete readiness contract passes and emits `newer_than_tested_but_compatible`.

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
2. native inventory with the same immutable UUID, deterministic name, and profile-selected native agent (`shell` for `qe-execution-v1`, `qe-pi-execution-v2` for Pi); and
3. a guest marker containing Worker, Run, environment UUID/name, incarnation, profile, and spec identity.

The backend never adopts by name alone after physical binding. Missing environments, duplicate names, UUID/name conflicts, marker conflicts, incompatible specs, and ambiguous creation fail closed. Stop is recoverable. Removal verifies absence before retiring ownership. Failed initialization removes only an environment created by that exact operation; a pre-existing conflicting environment is preserved for investigation.

Environment verification proves the canonical layout and private HOME sentinel; absence of host `/Users` and unexpected virtiofs mounts; no host Docker socket or usable SSH agent; disabled ambient credential values; empty ambient MCP and exact sandbox-scoped network policy plus harmless denied-egress probes; CPU and memory bounds; private Docker-root identity and disk size; and a scratch child-container proof. The v1 disposable resource policy enforces 1 CPU, 1 GiB memory, and a 1 GiB private Docker disk. SBX v0.43 does not expose enforceable root-disk or PID limits, so those limitations appear as inspection diagnostics rather than false capabilities.

The shell profile accepts `disposable_fixture` and Worker-controlled `frozen_import` specs with no credential, egress, or control grants. The Pi profile requires exactly one `openai-codex-oauth` subscription grant, only `chatgpt.com` at runtime, and one required `worker_file_mailbox_v1` channel. Its setup-only `registry.npmjs.org` allow is revoked with a sandbox-scoped deny before verification; `auth.openai.com` is not guest-reachable.

For each Run sandbox, the Worker validates the host Pi `openai-codex` OAuth credential through Pi's own `ModelRuntime.getAuth` and asks native host Antigravity metadata discovery to own Google token readiness/refresh. Resolution runs under Pi's interoperable auth-file lock in a same-directory shadow store; Pi alone decides expiry, performs refresh, and rotates fields, after which QE verifies that unrelated providers did not change and atomically renames the mode-preserving result. The helper allows no host request except Pi's exact token endpoint, emits only the current access token on stdout, emits only a fixed redacted failure on stderr, and receives no token in argv. SBX stores only that helper command in a sandbox-scoped dynamic custom secret with a `5m` refresh interval and replaces the placeholder only for `chatgpt.com`. Actual tokens remain in host credential stores and SBX proxy memory; they never enter the VM, QE SQLite/PostgreSQL state, diagnostics, evidence, or retained command arguments. Antigravity follows the same pattern for `daily-cloudcode-pa.googleapis.com`: native `agy models` owns refresh, the host keyring retains refresh/ID authority, and the guest sees only an invalid account marker, a disabled-refresh sentinel, and an access placeholder.

The guest auth file contains only a deterministic, account-bound, cryptographically invalid JWT-shaped placeholder, a fixed nonsecret refresh marker, and `Number.MAX_SAFE_INTEGER` expiry. That is the smallest ordinary Pi OAuth credential contract: Pi resolves it without patching internals or attempting guest refresh, while its normal Codex account-header logic can read the required account claim. Verification checks that exact shape and file mode, runs Pi credential resolution with `fetch` trapped at zero calls, proves the token endpoint and unrelated/bootstrap egress are denied, and performs only the harmless authenticated Codex models-resource request. Exact kit assets, base-image digest, Pi package graph, profile digest, runtime versions, and extension-bundle digest remain provenance rather than compatibility gates.

The immutable Pi runtime catalog is harness-support authority. Production publishes every runtime-supported `openai-codex` model, then applies only the optional QE scope (omitted means unrestricted, `[]` means deny-all, and nonempty means an exact allowlist). Host Pi model preferences are not projected into the sandbox and do not become scheduling policy. The authenticated models-resource response is retained as advisory, inconclusive diagnostics and never intersects the runtime catalog.

Each model carries independent account availability: `verified_available`, `verified_unavailable`, or `unknown`. Unknown remains schedulable. Direct successful execution and exact provider account/model rejection are the only state-changing evidence. Durable evidence is keyed by one-way account scope, OAuth generation, immutable profile ID/digest, provider, and model; it expires after seven days and is ignored after any generation mismatch. Explicit recheck clears the exact tuple. Rejection fails the frozen Attempt without substitution, another provider turn, or automatic retry; it does not suppress unrelated models. Successful guest lifecycle events record the positive state through the same attested relay.

`SbxRunExecutionManager` composes the backend with private Git and production Pi. It persists environment/workspace/extension/export/launch identity in `sbx-run-executions.sqlite`, reconciles unfinished records at startup, stages control files and immutable inputs, and owns the host/guest relay. Guest extensions write attested lifecycle state and mailbox requests under `/qe/control`; the Worker forwards unchanged authenticated requests to the loopback `HarnessControlAuthority` and reports only lifecycle/native-session identity through Herdr. No host socket, host path, transcript, prompt, bearer token, or provider response is exposed through the relay.

The configured host source repository is a read authority, not Run staging storage. Provisioning resolves and fetches the exact local base OID into a Worker-owned isolated repository under `QE_WORKTREE_ROOT`; its `.git`, branch, index, config, and optional distinct publication remote are private to that Run. QE never creates `qe/run/*`, `refs/qe/*`, temporary branches, or worktrees in the source repository and never retains the source as a writable remote. Cleanup recursively removes only the isolated repository. Legacy records whose Git common directory is source-linked fail closed instead of being cleaned up. Tests compare source `HEAD`, symbolic `HEAD`, all refs, packed refs, index, status, config, hooks, and working files across successful provision, cleanup, and injected failure.

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

The suite retains opt-in physical-proof extension points. SBX deterministic tests cover readiness/version policy, SQLite migration/history, process-race reconciliation, restart adoption, create-response loss, stale/missing/conflicting identities, verifier fail-closed behavior, private Docker proof, host-Pi resolver serialization/atomic rotation/redaction, exact dynamic-secret scope, guest no-refresh behavior, advisory metadata handling, three-state account evidence and invalidation, final-idle relay drain, mailbox forwarding, command timeout/redaction, launcher construction, pre-prompt attestation, source-repository immutability, and bounded transfer. `QE_LIVE_SBX=1 bun test test/sbx-live.test.ts` proves the Phase-2 lifecycle/PTY boundary. `QE_LIVE_SBX=1 bun test test/private-git-live.test.ts` proves the Phase-3 private-Git boundary. With a valid host Pi subscription login, `QE_RUN_SBX_PI_LIVE=1 QE_SBX_BIN=/absolute/sbx bun test test/sbx-pi-live.test.ts` runs `PiCapabilityContract`, validates the immutable Pi 0.85.1 profile and sandbox-scoped OAuth substitution, and proves publication of all eight runtime-supported Codex models—including Astra—with account annotations **without submitting a model turn or incurring inference**. An empty advisory metadata response remains a successful, inconclusive diagnostic. Adding `QE_FORCE_SBX_PI_OAUTH_REFRESH=1` forces Pi's native refresh path against only the locked shadow credential and requires the rotated host credential to be committed atomically.

`QE_RUN_SBX_ANTIGRAVITY_LIVE=1 QE_SBX_BIN=/absolute/sbx bun test test/sbx-antigravity-live.test.ts` is the Antigravity no-inference profile gate. It proves pinned runtime provenance, authenticated catalog, profile-owned MCP registration, host-only long-lived credentials, disabled guest refresh, restart continuity, and zero prompts/provider cycles.

`QE_RUN_SBX_HERDR_LIVE=1 QE_HERDR_BIN=/absolute/patched/herdr QE_SBX_BIN=/absolute/sbx bun test test/sbx-herdr-live.test.ts` is the Pi launch-only end-to-end gate. It selects only a runtime-supported model that is not currently verified unavailable, puts a hostile host `pi` first on `PATH`, launches only the descriptor-owned SBX entrypoint, verifies exact guest attestation and private Docker, projects Open Session/Take Control, disconnects and adopts the surviving Pi process, then terminates it and verifies shell restoration. It never submits a prompt; required counters are `prompts: 0` and `providerCycles: 0`.

## Phase-4 acceptance hold

Production Pi dispatch now acquires the exact SBX lease and private lineage workspace before Herdr launch. Environment/Git recovery remains subordinate to existing QE authorization: it cannot select a new Attempt, lineage, prompt, model action, semantic Artifact, or Delivery. Completion authority validates semantic outputs, checkpoints and exports private Git, verifies the four-ref bundle and result tree on the host, updates the Run delivery worktree, and only then writes the nonce-bound Step result. The trusted physical identity is added to each declared Change Set output.

The profile no-inference acceptance passed on the normal stable SBX v0.43.0 daemon. It proved setup-time npm access followed by runtime registry denial, authenticated HTTP 200 Codex model-resource access, account-scoped model discovery, sandbox-scope isolation, exact-sandbox restart continuity, immediate revocation failure, cleanup of the dynamic scope, unchanged global policy, and absence of the access token from the guest, Worker data root, retained SBX secret metadata, diagnostics, and command arguments. A separate forced native Pi refresh succeeded and atomically persisted the rotation. The corrective live query returned an authoritative empty `models` array for the active ChatGPT account, so all seven bundled candidates—including `gpt-5.3-codex-spark`—are currently ineligible and Worker publication is empty rather than falling back to Pi's generated registry.

The first paid acceptance attempt is retained as failed pre-prompt evidence: legacy Herdr launch selected host Pi instead of guest Pi, so no prompt intent, provider cycle, semantic completion, edit, checkpoint, export, Change Set, or artifact occurred. The correction removes PATH interception entirely. A subsequent launch-only live gate proved exact patched-Herdr → QE launcher → Run-owned SBX → guest Pi transport, full guest attestation, controller restart/adoption, Open Session/Take Control projection, shell restoration, source immutability, and private Docker with a hostile host `pi` PATH trap. It recorded `prompts: 0` and `providerCycles: 0`.

A later single paid Sol/medium Attempt proved provider execution, autonomous edits, fixture tests, OAuth/network isolation, and source immutability, but remains terminal failed infrastructure history. Pi's first native-idle projection entered the adapter branch that immediately called `collectStepResult`; the absent result threw `Harness settled without a structured step result`, the Worker persisted failure and stopped the SBX mailbox relay, and Pi's later `qe_step_result` timed out. The correction keeps provider settlement, native idle, accepted structured result, and terminal Attempt state separate. For a typed `change_set` Action, the pre-prompt frozen contract requires accepted semantic output plus verified private-Git export. Native idle projects `awaiting_result`; the mailbox stays live until result acknowledgement and bounded final-idle reconciliation. The failed historical implementation is never checkpointed or exported retroactively.

The separately authorized paid Attempt used that exact transport but the first request was rejected because bundled `gpt-5.3-codex-spark` is not supported for the ChatGPT account. It consumed zero input/output tokens and reported `$0.00`; no retry, model/provider substitution, edit, completion, export, or settlement followed. Its failed Attempt and retained attachable session remain forensic evidence. The correction serializes and drains guest lifecycle publication so terminal failure projects a settled turn and retained idle Pi session rather than Herdr `working`. No further paid Attempt is authorized.

Release acceptance requires a valid host Pi ChatGPT Plus/Pro login in the normal macOS user's Pi credential store and the no-inference live profile test. QE does not use Docker's built-in OpenAI OAuth store, API-key secret flow, or service binding plan. It registers only a sandbox-scoped dynamic command source, and the environment-removal path removes that scope; explicit revocation must immediately make the resource proof fail and another sandbox cannot use the grant. Worker restart re-registers and re-verifies the same exact Run sandbox without copying host auth into it. Missing host auth, resolver, profile, proxy substitution, relay, or recovery capability suppresses Pi scheduling or fails closed; it never broadens networking or falls back to host execution. Existing Worker `max_concurrency` admission bounds simultaneous executions, while exact one-environment-per-Run ownership is enforced locally. The final paid-inference gate remains closed.
