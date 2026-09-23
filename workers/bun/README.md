# Quest Engineering Bun Worker v0.12

The Bun Worker is the sole filesystem authority for Worker Protocol v8. Phoenix schedules logical Workspaces; Bun discovers authorized source repositories, persists bindings, provisions one managed Git worktree per Run, and executes every filesystem-enabled Action in that Run worktree.

## Required configuration

```text
QE_CONTROL_PLANE_URL=ws://127.0.0.1:4000/worker/websocket
QE_WORKER_ID=stable-worker-id
QE_WORKER_TOKEN=...
QE_HERDR_BIN=/absolute/pinned/herdr
QE_ALLOWED_ROOTS_JSON=[{"key":"code","path":"/absolute/code","max_access":"read_write","discover_depth":4,"allow_unconfined_shell":false}]
QE_WORKER_HARNESSES=pi,antigravity
```

Optional:

```text
QE_WORKER_DATA_ROOT=.quest-engineering-worker
QE_WORKTREE_ROOT=/durable/managed/worktrees
QE_WORKSPACE_BINDINGS_JSON=[{"binding_id":"...","workspace_id":"...","authorized_root_key":"code","source_repository_root":"/absolute/code/repo","max_access":"read_write","allow_unconfined_shell":false}]
QE_EXECUTOR_MODELS=openai-codex/optional-pi-scope
QE_PI_ACCOUNT_EVIDENCE_SEEDS=/absolute/nonsecret/evidence.json
QE_REASONING_LEVELS=low,medium,high
QE_MAX_CONCURRENCY=1
QE_WORKER_DISPATCH_AVAILABILITY=active
QE_PROMPT_ACTIVITY_STALL_MS=30000
```

`QE_HERDR_BIN` is required in production. It must be one absolute executable path; Worker startup canonicalizes it and uses that exact binary for every Herdr CLI and server subprocess. There is no `herdr` PATH fallback. `QE_HERDR_SESSION` is an optional explicit override. Omit it to use the collision-resistant session name derived from `QE_WORKER_ID`.

Pi publishes every `openai-codex` model supported by the immutable execution profile's runtime. Host `enabledModels`, `defaultModel`, and `defaultThinkingLevel` are optional Pi UX preferences and do not constrain Worker scheduling. The authenticated `originator: pi` models-resource response is advisory diagnostics only; empty, nonempty, malformed, or unavailable metadata neither grants nor removes account availability.

Account availability is tracked independently per exact account, OAuth generation, execution-profile digest, provider, and model as `verified_available`, `verified_unavailable`, or `unknown`. Direct successful execution verifies availability; an exact provider account/model rejection verifies unavailability. Evidence expires after seven days and is ignored after account, credential generation, or profile changes; an explicit recheck clears the exact tuple. Unknown models remain schedulable, while only currently verified-unavailable models are rejected. `QE_PI_ACCOUNT_EVIDENCE_SEEDS` may name comma-separated, nonsecret, exact-context seed documents generated from preserved direct evidence; imports never expand the runtime catalog.

Omit `QE_EXECUTOR_MODELS` for no additional QE scope. A present empty value is explicit deny-all; a nonempty comma-separated value is an exact `provider/model` allowlist over the runtime catalog. Account annotations survive this optional policy intersection. No missing model, reasoning value, harness, or provider is substituted.

The repository-owned `qe-pi-execution-v2` profile lockfile pins Pi 0.85.1. Admission runs a `PiCapabilityContract` covering the runtime catalog, interactive CLI, native extensions, structured tools, externally managed OAuth sentinel, disabled guest refresh, proxy routing, Node, and Git. Package versions are retained as provenance rather than used as the compatibility decision.

Bindings created through control-plane discovery are stored in `workspace-bindings.json`. Physical Run mappings and Git provenance are stored with SQLite `synchronous=FULL` in `run-worktrees.sqlite`. Dispatch, harness-neutral QE lineage, harness kind, native conversation identity, QE physical Herdr session incarnation, activity, and unresolved HumanAttention are stored in `dispatches.sqlite`.

`QE_MAX_CONCURRENCY` is the number of simultaneous execution slots advertised by this long-lived host; it defaults conservatively to `1`. Set `QE_MAX_CONCURRENCY=2` explicitly on a development/staging Worker to allow two otherwise-eligible Actions to execute at once. Worker slots are independent of Product Member occupancy: with an Engineering Pair, Run A's reviewer and Run B's builder may use two slots concurrently, while the same `{squad_id, member_key}` builder may not execute for both Runs at once.

`QE_WORKER_DISPATCH_AVAILABILITY` is a generic admission state and defaults to `active`. `maintenance` keeps registration, binding reconciliation, diagnostics, and Product-safe session observation available while making every executor unschedulable before workspace assignment and dispatch matching. Diagnostic/preflight Workers must register in maintenance mode, be terminated by captured PID/process group, and reach authoritative server-side `disconnected` state before an active Worker is launched. A maintenance Worker can never claim an Action.

## Long-lived host and binding recovery

A Worker is a long-lived execution host, not a process created per Run. A Workspace binding is the durable mapping between a logical Product Project owned by PostgreSQL and a physical repository reachable by that Worker. A Run is isolated execution provisioned on the Worker using that mapping.

Startup ensures Worker-owned Herdr infrastructure before harness/model discovery, then registers Worker identity and base capabilities before reconciling bindings independently. Unreconciled bindings are unavailable for new scheduling. Accepted bindings become available; one rejected binding does not affect other bindings or Worker connectivity.

Phoenix topic membership is generation-fenced independently from the underlying WebSocket. `phx_error`, `phx_close`, an `unmatched topic` reply, socket loss, or a protocol reply timeout invalidates exactly that local generation and starts one reconnect/rejoin path; stale replies, close callbacks, and timers cannot affect its successor. New execution claims wait behind successful registration reconciliation. Existing native Pi and Antigravity work continues locally while offline. After rejoin the Worker reconstructs current dispatch, session, completion/failure/result, worktree, binding, and readiness facts from durable stores instead of replaying a raw failed-message queue. Terminal facts are idempotent by exact Action identity, and only completion IDs explicitly accepted by Phoenix are marked server-acknowledged locally.

If Product storage no longer contains a binding's logical Workspace, the server returns a definitive `stale_workspace` outcome. Worker-owned bindings move atomically from the active set to the retired set in `workspace-bindings.json` and are not advertised again. Retired metadata remains available to identify historical retained worktrees; reconciliation never deletes worktrees, branches, dispatch SQLite data, harness lineage, or native session state. The physical repository remains discoverable and can be intentionally added as a new Project with a new Workspace ID without restarting the Worker.

`QE_WORKSPACE_BINDINGS_JSON` remains explicit operator configuration. A stale configured binding is fenced for the current Worker process and logged, but the environment is never rewritten. Update that configuration before the next process restart. Socket, server, timeout, and unexpected persistence failures do not retire local bindings; only a definitive semantic rejection does.

## Worktree invariant

Before any Action, including `workspace_access: none`:

1. Phoenix pins the Run to one Worker and one source binding.
2. Bun locks the source Git common directory, resolves committed source `HEAD`, and records the full object ID and optional publication authority.
3. Bun initializes a Worker-owned isolated repository under `QE_WORKTREE_ROOT`, fetches the exact local base OID without retaining the source as a remote, and creates `qe/run/<stable-id>` only inside that isolated repository.
4. Bun verifies canonical top-level, isolated Git common directory, branch, exact base, and absence of source linkage.
5. Phoenix schedules only after the durable ready report.

The configured source repository is read authority, never staging storage. Provisioning, replay, injected failure, and cleanup must leave its `HEAD`, symbolic `HEAD`, all refs, packed refs, index, status, config, hooks, and working files unchanged. Local-only, unpushed base commits remain supported because the OID is copied from the authorized local object database. A publication remote is copied only when its canonical identity differs from the source. Legacy records whose Git common directory points at the source are fenced as `run_worktree_legacy_source_linked`; cleanup recursively removes only the isolated Run repository.

Dirty source changes are allowed but excluded and reported. Missing, corrupt, branch-switched, or source-linked Run repositories are never silently repaired, relocated, or recreated. Terminal Run repositories are retained. There is no automatic GC.

## Filesystem access

- `none`: Worker-controlled isolation CWD, no repository tools, no skills/templates/context files, Run worktree not exposed to the model.
- `read_only`: canonical Run worktree CWD with inspection-only mapped tools.
- `read_write`: canonical Run worktree CWD with requested mutation tools.

`terminal.shell` requires `read_write` and root-specific `allow_unconfined_shell: true`. Pi always starts with `--no-skills`, `--no-prompt-templates`, and `--no-context-files`.

Continuation requires exact harness kind, model, resolved reasoning capability/value, authored ToolPolicy, resolved enforcement/profile, logical Workspace, binding, worktree, canonical root, and access equality. It never crosses a harness, Run worktree, or Worker.

## Live sessions

`AgentHarness` owns coding-agent semantics and `TerminalSessionBackend` owns terminal transport. `HarnessRegistry` hosts Pi and interactive-first Antigravity concurrently over Herdr; Herdr is not a provider. One QE lineage may span several Attempts while native conversation and terminal/process incarnation remain distinct provenance.

Herdr compatibility is capability-based. Endpoint protocol generation 1, introduced by Herdr 0.9, is the coarse floor because it is Herdr's stable endpoint-compatibility boundary; older servers require replacement. Socket protocol 22 is the newest QE-tested provenance, not an allowlist or ceiling. A newer protocol remains schedulable when native wire/endpoint status, live ping identity, API operation metadata, safely decoded session snapshot, canonical lifecycle states, and the selected harness's current Herdr integration all pass. Pi additionally requires live `ping.capabilities.agent_explicit_launch=true` and `agent.start.command` in API schema metadata. Readiness probes are side-effect free: they never create a workspace, pane, agent, prompt, or model run. Mutating operation support is proven from Herdr API metadata and its response is decoded when actual execution exercises it. Readiness evidence is tied to the observed server socket generation and discarded after replacement or transport failure.

Worker startup explicitly ensures Herdr infrastructure before harness/model discovery. The default named session combines a normalized `QE_WORKER_ID` with a stable hash suffix; `QE_HERDR_SESSION` remains an explicit override subject to the same ownership checks. QE claims a session with a primary record at `<QE_WORKER_DATA_ROOT>/herdr-session-ownership.json`, a corroborating `.qe-worker-owner.json` marker in Herdr's session directory, and non-authoritative live workspace metadata. The durable records retain the full Worker ID; IDs beyond Herdr's metadata-value bound use a collision-resistant SHA-256 token only in that live corroboration layer. Missing corroboration may be repaired only from matching durable ownership plus the same physical session directory. Any conflicting or foreign same-name evidence fails closed. Clean-slate creation generates a QE session incarnation; Worker/server reconnects preserve it, while deleted/recreated Herdr storage gets a new incarnation. Herdr server/socket generation is separate compatibility provenance and may change without changing incarnation. Normal shutdown disconnects clients but does not stop or delete the session. The default session name combines a normalized readable Worker-ID prefix with a fixed SHA-256 suffix and is dynamically shortened against both of Herdr's default Unix sockets (`herdr.sock` and the longer `herdr-client.sock`), reserving the terminating-byte boundary of macOS `sockaddr_un.sun_path`. An explicit name that exceeds the same physical path contract fails before server launch. Herdr 0.9's named-session lifecycle owns one bootstrap workspace/root shell pane; if a clean headless snapshot has not materialized it yet, infrastructure ensure initializes that same non-execution bootstrap so it can publish ownership metadata. Ensure creates no QE execution pane, agent, prompt, or model work.

The QE-facing backend contract uses semantic capabilities: backend health/identity and endpoint compatibility, session inventory and decoding, terminal topology/metadata/shell readiness, interactive agent launch, prompting, inspection and logical input, canonical lifecycle states, and integration discovery. Launch metadata must distinguish `launch_pending` acknowledgement from authoritative native materialization. Pi additionally requires server-owned agent state observation plus a current `pi` integration. Antigravity independently requires a current `antigravity_cli` integration. A missing harness-specific capability disables only that harness. Protocols newer than 22 receive a `newer_than_tested_but_compatible` diagnostic after verification and remain ready.

Pi and Antigravity share one idempotent Herdr launch state machine. It resolves the deterministic name first, accepts a full inline agent as a fast path, and otherwise reconciles the stable pane plus native kind and exact Worker/Run/Action-hash/lineage/ownership/session-incarnation tokens until the agent materializes. It adopts that exact agent after a lost response or restart. A same-name foreign agent fails closed. A nonce-bound launch/control record is written before `agent.start` without marking prompt intent or invoking the model. A second `agent.start` is allowed only when bounded inventory and shell state prove absence; unresolved outcomes become non-auto-retryable `uncertain`, and prompt submission never occurs during reconciliation.

Production Pi supplies `agent.start.command` from the exact Run lease. Herdr executes its absolute launcher directly with literal argv, cwd, environment additions, and PTY I/O; `kind=pi` remains only the managed identity. QE never installs a host `pi` wrapper or modifies `PATH`, and an SBX launch never falls back to direct host Pi. Before launch, the Worker validates guest ownership/binding/executable/workspace/control/extension paths and durably records launcher entrypoint hash, host argv digest, guest argv digest, environment/profile identity, and PhysicalLineage. Guest Pi then attests exact Worker, Run, environment UUID/incarnation, profile, lineage, private workspace/cwd, `HOME`, and required paths through the lifecycle relay. No prompt is authorized until attestation passes. `environment_launch_mismatch`, `environment_attestation_failed`, and `agent_explicit_launch_failed` are deterministic infrastructure failures.

Prompt lifecycle is durable and separates four events: provider-turn settlement, native harness idle, accepted structured result, and terminal Attempt settlement. `prompt_intent` is recorded before transport, `prompt_accepted` only after submission acknowledgement, `waiting_for_activity` follows while native evidence is absent, `working` requires harness-native evidence, `awaiting_result` means native Pi is idle while the semantic result remains pending, `blocked` requires structured attention, and only accepted completion or an authoritative failure settles the Attempt. The immutable Action freezes the typed completion contract before prompt submission, including whether a `change_set` requires physical export. Provider completion, Herdr `idle`, terminal text, quiet time, and process presence do not independently prove semantic completion.

Pi uses exact post-baseline guest lifecycle state; Antigravity uses its post-baseline native conversation handoff log. The Pi relay serializes guest publications and remains alive after semantic acceptance until the completion call is acknowledged and the guest publishes final `agent_settled` idle (bounded), so a retained attachable pane cannot remain falsely working. Success ordering is validation → physical workspace fingerprint/tree/checkpoint/export when required → durable result envelope → deterministic tool acknowledgement → terminal Worker/server report → authority retirement. Failure first persists terminal state; pending calls then receive stale-context rejection before authority retirement. Allowed failure causes are explicit process/environment/control loss, explicit cancellation, native termination that makes a result impossible, or the bounded structured-result recovery deadline. Herdr's five-second `agent_prompt_stalled` response proves submission, not semantic failure. `QE_PROMPT_ACTIVITY_STALL_MS` only changes the visible `stalled` label and never terminalizes the Attempt. Exact-lineage recovery never repeats an accepted prompt.

Every non-fake initial Attempt and human recovery is two-phase. QE first launches an unprompted native process and proves its exact launch arguments, Stop hook or Pi control bridge, descriptor context, and lack of model activity. It then persists a `needs_confirmation` session and returns without prompt intent. The initial configured recovery epoch grants scheduling allowance only; it is not paid-inference authorization. Only the separate **Authorize Builder inference** command opens the durable prompt gate; reconnect reconciliation can replay that authorization but local prompt intent prevents duplicate submission. Fake deterministic execution invokes no provider and bypasses this paid-inference gate. Writable takeover is unavailable while the gate is pending, although the dedicated inputless observer remains available. The Worker continuously checks native conversation/user-message evidence without sending input. If native input bypasses the gate, it preserves the native identity, closes the exact owned pane, reports `pre_authorization_native_activity`, leaves the canonical QE prompt lifecycle empty, and requires append-only fresh recovery. A known-bad source process is retired noninteractively by closing its exact owned pane, preserving its Attempt, conversation identity, and typed `operator_recovery_required` failure.

A `session.snapshot` timeout is inventory-observation degradation, not semantic execution evidence. The Worker keeps the accepted Action/Attempt and prompt lifecycle intact, projects the session `unavailable` then `recovering`, and uses bounded backoff. Persisted executions are reconciled by direct exact-pane inspection with incarnation and ownership provenance rather than requiring a global snapshot. A newer successful snapshot fences an older timeout callback. The exact legacy snapshot-timeout uncertainty may return to running only after exact-lineage recovery; all prompt/launch ambiguity stays sticky. Authorized settlement outranks everything, current structured HumanAttention outranks temporary observation failure, and observation exhaustion may still become genuine uncertainty when continuity cannot be proven.

Antigravity uses capability-based native readiness: executable/version provenance, required interactive/model/effort/conversation/log flags, and a non-empty authenticated model catalog. Version 1.2.2 is the human-tested provenance, not an exact gate; compatible newer versions remain ready when the deterministic capability contract passes. It pins the exact native model and any explicitly supported effort before inference, keeps an actual TUI alive for Work Yard observation and authorized takeover, and uses the generic worker-owned control bridge for semantic completion. Execution-environment admission and filesystem/tool isolation are intentionally outside the harness adapter contract.

Models that explicitly lack effort control are advertised with `reasoning_capability.kind=unsupported`; their resolved reasoning is `null` and launch omits `--effort`. The semantic-only `qe_complete_step` MCP tool and Stop hook both use the generic Worker-local control bridge. Native screen rendering and Stop `terminationReason` are not completion evidence. The retained MCP process keeps one stable descriptor path and rereads atomically rotated endpoint/generation/context contents on every call; copied old credentials remain fenced. Append-only startup evidence proves only that the still-live MCP child was launched against that exact path. Current readiness separately calls through the descriptor and verifies the active Action, Attempt, lineage, and result nonce; startup age is never treated as current authority, and a legitimate rotation does not require respawning the child. Correctable output validation, completion infrastructure failure, and true completion omission are distinct: only repeated omission consumes bounded Stop-enforcement attempts. Recovery adopts a surviving exact TUI first, otherwise resumes only a verified native conversation into a new interactive process. A terminal pre-prompt recovery may transfer an exact idle, conversation-free process to a new Attempt only after retained-work, exact launch arguments, Herdr-incarnation, pane, terminal, Stop-hook, MCP-path, and exclusive-ownership proofs. The local registry records the source and target Attempts and whether the process was adopted or replaced. Every human recovery stops at durable inference authorization before its first prompt. Herdr 0.9 `agent_pane_busy` uses the same shared launch reconciliation rather than a harness-specific retry path.

Pi advertises support for authored `ToolPolicy.exact` and maps that QE capability subset to its native `--tools` set. Antigravity advertises support for `ToolPolicy.native_permissions`; its Loadout stores no catalog. Scheduling derives `tool_enforcement` and freezes the exact QE semantic capability profile advertised by the adapter as the Attempt's `ResolvedToolProfile`, while Antigravity's allow/ask/deny engine remains authoritative for individual operations. Protocol v8 `tool_profile` and `resolved_tool_profile` contain QE semantic capability IDs, not necessarily harness-native tool identifiers.

The currently tested Antigravity capability family has neither a stable low-level native tool-catalog interface nor an arbitrary per-tool restriction interface. QE does not claim that `ResolvedToolProfile` is a complete inventory of every internal Antigravity tool. Future native identifiers must use a separate protocol field rather than overloading the QE semantic capability profile.

Herdr's actual `blocked` agent state creates provider-neutral HumanAttention; Pi's explicit `qe_request_human_assistance` tool can enrich the same episode with structured context. In `conversational_intervention` mode, Pi blocks and terminates only the current agent run, returns to its ordinary editor, permits multi-turn human chat, and resumes automation only through `/qe-resume`. The Worker keeps collecting the same dispatch across Pi's `agent_settled` boundary and persists the Product-safe checkpoint/lifecycle in the existing lineage registry. QE does not scan terminal or chat prose. Waiting retains dispatch, Member, Worker-slot, lineage and worktree occupancy. See [live-session acceptance](docs/live-session-acceptance.md) and the repository [architecture](../../docs/live-execution-sessions.md).

## Gates

```sh
bun run check
bun test
bun run integration:herdr-pi
bun run integration:worker-restart
QE_RUN_HERDR_STARTUP_LIVE=1 QE_HERDR_BIN=/absolute/patched/herdr bun test test/herdr-startup-live.test.ts
QE_RUN_SBX_HERDR_LIVE=1 QE_HERDR_BIN=/absolute/patched/herdr QE_SBX_BIN=/absolute/sbx bun test test/sbx-herdr-live.test.ts
```

Before any paid Phase-4 acceptance, start Phoenix with `QE_LOCAL_SESSION_ATTACH_ENABLED=true` and run the no-inference manifest gate. It validates the fresh Git ref/status baseline, fresh Product Workspace/binding identity, registered Worker, immutable `qe-pi-execution-v2`/Pi 0.85.1 provenance, exact Sol/medium scheduling, explicit Herdr launch, SBX/private-Git/private-Docker/OAuth/mailbox readiness, lifecycle regressions, zero counters, the control-plane attachment endpoint, and the exact idle Herdr target:

```sh
QE_LOCAL_SESSION_ATTACH_ENABLED=true bun run scripts/phase4-acceptance-preflight.ts .pi/tmp/phase4-final-preflight/manifest.json
```

The script is an acceptance harness; it does not alter the server's disabled-by-default attachment setting and submits no prompt.

The Herdr startup stress gate creates no execution agents and must report zero prompts. The Pi profile gate runs the capability contract, authenticates only the advisory metadata resource, and verifies that the complete runtime catalog is published with independent account annotations. The SBX/Herdr launch-only gate may then attest guest Pi, restart adoption/attachment, private Docker, shell restoration, and a hostile host-`pi` PATH trap. These no-inference gates require `prompts: 0` and `providerCycles: 0`. Paid acceptance remains a separate, explicitly authorized gate; rejection never causes automatic model/provider substitution or a second provider turn.
