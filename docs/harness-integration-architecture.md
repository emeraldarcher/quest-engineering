# Harness integration architecture

## Product principle

**Quest Engineering orchestrates subscription-bearing coding harnesses. It does not replace those harnesses as the model client.**

Pi, Antigravity, Claude Code, Codex, and future coding harnesses keep ownership of model access, account/subscription authentication, provider billing, native tools, and native interaction. Credentials stay in the Worker/harness environment. Product receives readiness and capability diagnostics, never raw credentials. Quest Engineering does not require provider API keys merely to orchestrate a native harness.

## Boundaries

- **Quest Engineering** is the orchestration authority. It owns Runs, Attempts, scheduling, semantic Step results, operational failure, and HumanAttention.
- **`AgentHarness` adapters** discover native readiness and models, pin execution configuration, translate lifecycle and session identity, and advertise only capabilities they actually support.
- **The QE Harness Control Bridge** is one Worker-local semantic control authority for structured completion, attention, state, yield/resume, and bounded completion enforcement.
- **Native shims** are deliberately thin. A Pi extension, an Antigravity MCP tool or Stop hook, and a future native RPC client all forward to the same control bridge. MCP is an adapter transport, not the QE harness protocol.
- **`TerminalSessionBackend` / Herdr** owns terminal creation, persistence, attachment, and native terminal-state observation. It is not the harness contract.
- **Native coding harnesses** remain the model clients and own their UX, tools, accounts, and provider access.

## Control and trust

The bridge is a loopback-only Worker process service. Before each native execution, the Worker binds an opaque, random, short-lived control capability to the exact Worker controller generation, Action, Run, StepOccurrence, Attempt, physical lineage, and result nonce. The harness process receives only a mode-0600 descriptor path through its launch environment.

Native operations do not supply QE identity. For example, `complete_step` supplies only semantic outputs. The Worker authority adds and validates execution identity, declared outputs, nonce, lineage occupancy, and current Attempt state. A new Attempt rotates the capability even when it retains the same physical conversation. Old generations, stale Attempts, replayed requests, and cross-lineage capabilities are rejected.

The loopback endpoint is not exposed through Phoenix, has no database credentials, and never exposes the Worker control-plane token. There is no mutable global “current run.” Concurrent Pi and Antigravity sessions each receive a distinct bound capability.

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

Pi remains `native_extension`; it is not migrated to MCP. Antigravity is finalized as interactive-first `hooks_plus_structured_tool`: every active Attempt owns an always-live native Antigravity TUI under Herdr, the semantic-only `qe_complete_step` MCP tool transports outputs, and the Stop hook enforces bridge-authorized completion. The proven headless → interactive → headless transition remains a secondary recovery/diagnostic capability, never the default. A terminal-only adapter may be observable and attachable, but cannot be advertised for QE execution without structured completion.

## State authority

Structured bridge state is completion authority. Herdr terminal state remains authoritative for a native visible block where its integration supports that observation, but neither Antigravity screen rendering nor its Stop `terminationReason` proves whether completion occurred. The Worker correlates native blocked state into one provider-neutral HumanAttention episode.

Antigravity readiness combines exact static MCP registration, MCP child startup/liveness evidence, bridge authentication, exact merged hook configuration, native hook-manager discovery, and synthetic hook execution. `/mcp` and `/hooks` screens are optional corroboration only under Herdr 0.9.

Physical continuation is adapter-specific and is valid only within the same harness kind and immutable physical configuration. Artifact handoff remains valid across harnesses because artifact identity and hash provenance are independent of native conversation identity. Recovery first adopts a surviving exact TUI, then may resume a verified native conversation in a new interactive process; inability to verify identity fails closed.

## Reasoning and effort capabilities

Each discovered model reports a capability rather than an assumed global enum:

- `enumerated` carries the model's exact native values. A Loadout freezes one advertised value and the adapter passes the corresponding native launch option.
- `unsupported` means the model has no configurable reasoning/effort dimension. The Loadout and LaunchSnapshot freeze `null`, and the adapter omits the native option.
- Unknown or conflicting discovery evidence is not equivalent to `unsupported` and is not advertised as schedulable.

The values are harness-discovered strings, so Pi may expose native levels that differ from Antigravity. Unsupported is exact, not a wildcard.

## Tool guarantee levels

Four related concepts remain separate:

1. **Availability** — capability IDs exposed by an executor.
2. **Selection** — the tool set or complete native profile frozen in a Loadout.
3. **Enforcement** — whether the adapter guarantees an exact selected subset.
4. **Operation authorization** — whether a concrete native operation is allowed, denied, or requires the user.

`tool_enforcement` has two states:

- `exact`: the adapter mechanically restricts native tool availability to the frozen subset. Pi maps QE capability IDs into its exact `--tools` set while preserving mandatory QE control tools.
- `native_permissions`: the frozen `tools` identify the complete advertised native capability profile, not an allow-list. The scheduler requires exact profile identity. Antigravity uses this state because 1.2.2 has no deterministic arbitrary-subset switch; Antigravity's native allow/ask/deny engine remains the sole operation-authorization authority.

QE does not copy, parse, approve, or infer native permission decisions. Native blocked-state observation remains HumanAttention evidence, not a second permission engine.
