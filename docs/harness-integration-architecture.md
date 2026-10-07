# Harness integration architecture

## Product principle

**Quest Engineering orchestrates subscription-bearing coding harnesses. It does not replace those harnesses as the model client.**

Phase 5 accepted Pi and Antigravity as production harnesses inside the same per-Run mixed SBX architecture. Antigravity's live-TUI transport, fresh-conversation readiness, generation and managed-input fences, phase-aware structured completion, and asynchronous private-Git export are accepted; the separate SBX teardown and procedure/evidence-hygiene deviations remain recorded in [`phase-5-closure.md`](phase-5-closure.md).

Pi, Antigravity, Claude Code, Codex, and future coding harnesses keep ownership of model access, account/subscription authentication, provider billing, native tools, and native interaction. Credentials stay in the Worker/harness environment. Product receives readiness and capability diagnostics, never raw credentials. Quest Engineering does not require provider API keys merely to orchestrate a native harness.

## Boundaries

- **Quest Engineering** is the orchestration authority. It owns Runs, Attempts, scheduling, semantic Step results, operational failure, and HumanAttention.
- **`AgentHarness` adapters** discover native readiness and models, pin execution configuration, translate lifecycle and session identity, and advertise only capabilities they actually support.
- **The QE Harness Control Bridge** is one Worker-local semantic control authority for structured completion, attention, state, yield/resume, and bounded completion enforcement.
- **Native shims** are deliberately thin. A Pi extension, an Antigravity MCP tool or Stop hook, and a future native RPC client all forward to the same control bridge. MCP is an adapter transport, not the QE harness protocol.
- **`TerminalSessionBackend` / Herdr** owns terminal creation, persistence, attachment, native terminal-state observation, and exact PTY process transport. It executes an environment-selected `HostLaunchDescriptor`; it does not select a harness executable through `PATH` and is not the harness contract.
- **`ExecutionEnvironmentBackend`** owns filesystem/HOME/Git/network/credential isolation and translates a guest command into an exact absolute host launcher. For production Pi, that launcher is the only process Herdr may execute.
- **Native coding harnesses** remain the model clients and own their UX, tools, accounts, and provider access.

## Semantic execution and optional interaction

`AgentHarness` is a coding-agent lifecycle contract, not a terminal contract. Its durable identity is a provider-neutral `HarnessExecutionHandle`: schema version, owning harness kind, opaque execution ID, optional opaque native-session reference, and optional harness-owned transport binding. Start, continuation, inspection, collection, interruption, and recovery must work without a PTY, pane, terminal, attachment target, or Herdr session. A headless harness is therefore a complete implementation rather than a degraded terminal harness.

Interactive access is an explicit optional capability. `InteractiveHarnessSession` describes whether an adapter currently has a terminal-like interaction surface and whether observation or takeover is supported. Product attachment is `null` when that capability is absent; this is ordinary headless execution, not a missing-Herdr error. Pi and Antigravity currently opt into the terminal capability through adapter-private helpers. Their exact session/workspace/tab/pane/terminal/agent topology remains mandatory for their transport and recovery fences, but those identities do not appear in the generic execution handle or inspection contract.

Durable recovery state follows these rules:

1. Generic orchestration persists and returns a versioned `HarnessTransportBinding` but does not inspect its payload.
2. The binding is owned by exactly one `harnessKind`, is bounded to 32 KiB, contains only strict JSON, and is validated on every persistence and recovery boundary.
3. Native-session references are also versioned and harness-owned. Their payload exposes only an identity shape (`id` or `path`) to the owning adapter; generic code may compare the complete opaque reference or project a safe public ID, but cannot infer provider or terminal topology.
4. A terminal adapter may encode a `HostedExecutionRef` and `HostedAgent` inside its private binding. It must validate ownership, schema, internal topology consistency, and native-session consistency before use. A non-terminal adapter must not fabricate those values.
5. Provider/backend failures crossing the generic lifecycle are represented as typed operational outcomes with classification, side-effect certainty, operation phase, and capability evidence where known. Generic APIs do not depend on provider exception classes.
6. Protocol physical-transition projections carry only semantic Action/Attempt/lineage identity and mode. Product session attachment is projected separately and only when an interactive capability exists. Headless execution omits attachment, and Product projections never publish raw adapter bindings, pane IDs as native identity, or the Worker's internal turn ledger.

Adapter authors should begin with semantic start/collect/inspect/recover behavior, add a stable execution ID, and declare capabilities conservatively. Add terminal transport only when the native harness actually requires it; keep topology parsing and fencing in the adapter/terminal backend, implement attachment only for a verified interactive surface, and include headless restart-recovery tests even if the first production adapter is interactive.

## Control and trust

The bridge is a loopback-only Worker process service. Before each native execution, the Worker binds an opaque, random, short-lived control capability to the exact Worker controller generation, Action, Run, StepOccurrence, Attempt, physical lineage, and result nonce. The harness process receives only a mode-0600 descriptor path through its launch environment.

Native operations do not supply QE identity. For example, `complete_step` supplies only semantic outputs. The Worker authority adds and validates execution identity, declared outputs, nonce, lineage occupancy, and current Attempt state. A new Attempt rotates the capability even when it retains the same physical conversation. Old generations, stale Attempts, replayed requests, and cross-lineage capabilities are rejected.

The loopback endpoint is not exposed through Phoenix, has no database credentials, and never exposes the Worker control-plane token. There is no mutable global “current run.” Concurrent Pi and Antigravity sessions each receive a distinct bound capability.

Production Pi adds a pre-prompt physical-attestation gate below this semantic capability. The Worker verifies the Run-owned environment and required guest paths before launch; the guest extension then attests exact Worker, Run, environment UUID/incarnation, profile, PhysicalLineage, private workspace/cwd, `HOME`, ownership marker, launch-binding marker, and immutable extension/control paths. Pi cannot become promptable until that attestation matches. A wrong launcher, stale environment, host Pi process, or mismatched guest fails closed as infrastructure and cannot authorize inference.

## Correctness and liveness

A production-capable adapter must advertise `structuredResult` and produce a valid `StructuredStepResult`. Native idle, exit, terminal prose, or a model claim is never sufficient for successful Attempt completion.

This is a correctness invariant, not a liveness promise. A model can fail to invoke its structured result channel. An adapter may use supported native lifecycle enforcement to remind or continue a bounded number of times. Exhaustion becomes a typed `harness_contract_violation`; existing operational retry and recovery policy then decides what happens next.

## Integration strategies

Adapters describe their implementation strategy internally:

- `native_extension`
- `native_rpc`
- `hooks_plus_structured_tool`
- `structured_headless`
- `terminal_only`

Pi remains `native_extension`; it is not migrated to MCP. Pi and its extensions execute inside the Run-owned environment. Antigravity is interactive-first `hooks_plus_structured_tool`, but its TUI, lineage-private HOME, profile-owned MCP command, Stop hook, logs, and conversation state now execute in that same Run VM. Herdr generic explicit launch carries the exact SBX descriptor for either harness; integration names never select executables. The semantic-only `qe_complete_step` MCP tool transports outputs, and the Stop hook enforces Worker bridge authority. The proven headless → interactive → headless transition remains a secondary recovery/diagnostic capability, never the default. A terminal-only adapter may be observable and attachable, but cannot be advertised for QE execution without structured completion.

## State authority

Structured bridge state is completion authority. Herdr terminal state remains authoritative for a native visible block where its integration supports that observation, but neither Antigravity screen rendering nor its Stop `terminationReason` proves whether completion occurred. The Worker correlates native blocked state into one provider-neutral HumanAttention episode.

Antigravity readiness combines immutable guest runtime capability/provenance, profile-owned static MCP registration, guest MCP-child startup/liveness evidence, current mailbox/bridge binding, lineage-private hook configuration, native hook-manager discovery, guest log relay, environment attestation, and synthetic guest hook execution. `/mcp` and `/hooks` screens are optional corroboration only under Herdr 0.9.

Physical continuation is adapter-specific and is valid only within the same harness kind and immutable physical configuration. Artifact handoff remains valid across harnesses because artifact identity and hash provenance are independent of native conversation identity. A headless adapter recovers from its own validated execution handle/binding without terminal discovery. A terminal adapter first adopts its exact surviving process and may then resume a verified native conversation in a new interactive process; inability to verify its private identity or topology fails closed.

## Model support and account availability

Pi's immutable execution runtime is the model-support authority. QE publishes every runtime-supported `openai-codex` model and then applies the optional exact QE scope. Host `enabledModels`, `defaultModel`, and `defaultThinkingLevel` remain UX preferences, not scheduler policy. The authenticated ChatGPT models resource is advisory diagnostics only: empty, nonempty, malformed, or unavailable metadata cannot establish model entitlement and never narrows the runtime catalog.

Account availability is a separate three-state fact on each exact model: `verified_available`, `verified_unavailable`, or `unknown`. Unknown remains schedulable. Only direct successful execution marks the exact account/auth-generation/profile/provider/model tuple available; only an exact provider `unsupported/no access` result marks it unavailable. Evidence is durable, expires after a bounded interval, and becomes inapplicable after account, OAuth generation, or immutable execution-profile changes. Explicit recheck clears the exact tuple. Provider metadata cannot overwrite direct evidence.

A verified-unavailable model remains visible for diagnostics but is rejected by capability matching. The already-frozen Attempt fails without another turn, model substitution, provider fallback, or automatic retry. Direct success records availability for future discovery. Optional QE scope still distinguishes omitted (all runtime-supported models), explicit empty (deny all), and a nonempty exact allowlist.

## Reasoning and effort capabilities

Each eligible model reports a capability rather than an assumed global enum:

- `enumerated` carries the model's exact native values. A Loadout freezes one advertised value and the adapter passes the corresponding native launch option.
- `unsupported` means the model has no configurable reasoning/effort dimension. The authored value is explicitly `null`, the resolved execution also freezes the matching `unsupported` capability evidence, and the adapter omits the native option.
- Unknown or conflicting discovery evidence is not equivalent to `unsupported`, never becomes `null`, and is not advertised as schedulable.

The values are harness-discovered strings, so Pi may expose native levels that differ from Antigravity. Protocol and constructor validation reject `enumerated + null` and `unsupported + value`.

## Canonical tool semantics

Four values remain separate:

1. **`ToolPolicy`** — authored Loadout intent: either `exact(tools)` or `native_permissions`.
2. **`ToolEnforcement`** — a harness guarantee resolved from Worker capability evidence, never an authored knob.
3. **`ResolvedToolProfile`** — the exact QE semantic capability profile resolved by the adapter for one scheduled Attempt. It is adapter-advertised QE capability evidence, not necessarily a raw inventory of every internal native harness tool.
4. **Native permission system** — per-operation allow/ask/deny authorization owned by the harness.

Workers advertise `supported_tool_policies`, `tool_enforcement`, and a current read-only `tool_profile`. Both `tool_profile` and `resolved_tool_profile` contain QE semantic capability IDs, not necessarily harness-native tool identifiers. The scheduler resolves this evidence into each immutable `ResolvedExecution`; changing an adapter's advertised profile does not mutate the Loadout or an earlier Attempt's provenance. Any future native identifiers require a distinct field rather than overloading these profiles.

Pi supports `ToolPolicy.exact`, resolves `ToolEnforcement.exact`, and maps the authored QE subset into its native `--tools` set while preserving mandatory QE control tools. Example: `exact([workspace.filesystem, workspace.search])` resolves the same profile.

Antigravity supports the protocol's `ToolPolicy.native_permissions` marker and freezes its QE semantic capability profile in `ResolvedToolProfile`; it still exposes no stable native tool catalog. In production it runs `--dangerously-skip-permissions` inside SBX. Root-owned workspace modes, private Git, exact egress, disabled ambient credentials, and the Worker control boundary are operation authority. The optional native inner sandbox is not enabled. Host command parsing, user `.git` mounts, and host path-containment policy are not part of the adapter.

Antigravity 1.2.7 exposes neither a stable low-level native tool-catalog interface nor an arbitrary per-tool restriction interface. QE therefore does not claim that `ResolvedToolProfile` completely enumerates every internal Antigravity tool; it records exactly the semantic capability profile advertised by the Antigravity adapter for that execution.

QE completion tools and bridge readiness are adapter/control-plane requirements, not user policy entries. QE does not copy, parse, approve, or infer native permission decisions. Native blocked-state observation remains HumanAttention evidence, not a second permission engine.
