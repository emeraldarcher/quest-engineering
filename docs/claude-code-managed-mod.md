# Claude Code managed-Mod production architecture (Phase D)

## Status

`claude_code` is the canonical production Claude harness. It pins unmodified
Claude Code `2.1.292` (`@anthropic-ai/claude-agent-sdk` `0.3.292`) and exact
model `anthropic/claude-opus-4-6` at effort `high`. The older
`claude_agent_sdk` adapter is retained only as an explicitly selected,
deprecated fallback. There is no automatic fallback or model substitution.

Phase D intentionally performed no real login, credential entry, paid turn,
external provider request, Agent SDK query, or production operation.
Deterministic local fake-boundary and physical local-SBX proofs are described
below.

## Two physical cells

### ProviderAccount cell

`qe-claude-account-v2` is the current persistent, ProviderAccount-owned SBX
with narrowly scoped Anthropic runtime egress. It differs from immutable
historical v1 only by profile identity/version and the exact
`platform.claude.com` login token-exchange grant; see
[`claude-account-profile-v2.md`](claude-account-profile-v2.md). It owns:

- the exact Claude Code Linux binary and native transcript/config directory;
- ordinary Claude.ai subscription authentication created by `claude auth login`;
- root-owned `/etc/claude-code/managed-settings.json`;
- the root-owned managed marketplace and `qe-account-cell` Mod;
- the fixed root-owned `/opt/qe/claude/qe-account-cell-bridge`;
- a per-execution mode-0700 mailbox below `/qe/control/claude`.

The account cell has no Run workspace authority. The fixed bridge knows only a
random mailbox path, a random 256-bit token, a bounded request ID, and one
finite operation. It has no network client and no workspace path. The Worker
removes and recreates the mailbox for each attached Claude process.

### Run cell

`qe-claude-broker-run-v1` is Run-owned, credential-free, and deny-all network.
It contains no Claude runtime, managed settings, Mod, subscription state, or
account config. `WorkspaceToolBroker` launches each operation in a fresh
network namespace as UID/GID 1000 with no capabilities, `no-new-privs`, a
cleared environment, and the exact lineage workspace as cwd.

The cells have distinct environment IDs, incarnations, ownership markers,
private filesystems, HOME directories, Docker daemons, policy identities, and
lifecycle authority. Account and workspace canaries are not mutually visible.

## Managed Mod and preventive policy

Managed settings install one organization Mod and retain Claude Code's built-in
`cc-plugin-sec-default` guard with `allowManagedModsOnly`. User Mods and hooks,
sideload flags, MCP, Claude.ai connectors/plugins/skills, bundled skills,
remote control, Artifact, agent view, native subagents, Git instructions, fast
mode, fallback models, and bypass permissions are disabled.

Claude is launched with `dontAsk`, no permission prompts, and an exact
`--tools` inventory:

1. `qe_workspace_read`
2. `qe_workspace_list`
3. `qe_workspace_write`
4. `qe_workspace_edit`
5. `qe_workspace_search`
6. `qe_run_shell`
7. `qe_complete_step`
8. `qe_request_human_assistance_and_wait`

The Mod denies unapproved `plugin.register`, `agent.offer`, `agent.spawn`,
`tool.call`, `tool.check`, `command.run`, and prompt/model drift. It uses only
`$.env`, `$.session`, `$.tool`, and the fixed `$.process` bridge; it does not use
`$.fs`, `$.http`, `$.model`, MCP calls, nested tool calls, prompt submission, or
agent spawning. Mods are unsandboxed code, so these restrictions are backed by
immutable root-owned bytes and startup provenance rather than treated as a
sandbox.

Provider/server tools are prevented at request construction. Exact `--tools`
and managed settings omit native and server tools. A pinned-binary localhost
capture matrix inspects complete fresh, multi-turn, retry, high-context compaction, and exact-resume/recovery request bodies and headers. Every request
contains only the eight custom tools and omits advisor, web-search, agent
Toolset, and native tool definitions and beta identifiers. Post-execution
`turn.step.serverToolUses` rejection remains defense in depth, not the primary
claim.

## Authority and dispatch order

Product selects exactly one eligible authenticated Anthropic ProviderAccount on
the selected Worker. Zero or multiple accounts fail closed. The selected
account ID and credential generation plus the broker authorization are durable
`WorkerDispatch` authority, protected by completeness and uniqueness
constraints.

`dispatch_accepted` first commits acknowledgment, then Product emits broker
prepare/admit commands. The Worker waits, bounded by the physical provisioning
horizon, for the Run context created by `executor.start`. This avoids requiring
a Run before dispatch acknowledgment while preserving broker admission as a
hard prompt prerequisite. Worker broker activity is generation- and
authorization-fenced and persists the admitted session and broker generation.

The broker binds Worker generation, account generation and physical identity,
Run/action/occurrence/attempt/epoch, physical lineage, workspace/worktree,
workspace access, and exact resolved tools. Claude uses local Worker relay
admission, so no account-cell broker client is spawned. Completion and
HumanAttention are not workspace broker operations and retain their existing
Harness Control authority.

## Zero-inference readiness

The process is launched with stream-JSON input/output and receives one synthetic
message with `shouldQuery: false`. Before readiness, `system/init` must attest:

- Claude Code `2.1.292`;
- `apiKeySource: "oauth"` and separately validated `authMethod: "claude.ai"`;
- exact native session UUID and account-cell cwd;
- model `claude-opus-4-6`, effort `high`, and `dontAsk`;
- exactly the QE managed Mod plus built-in managed-Mod guard;
- no plugin load errors, MCP servers, skills, or agents;
- exactly the eight QE tools.

Only then can the generic staged-dispatch lifecycle publish
`needs_confirmation`. Product additionally requires the exact admitted broker
record before `authorize_dispatch_prompt` is sent. Cancellation at this stage
terminates the process and mailbox without a model request.

Every assistant frame and result is checked for exact model provenance.
Completion must arrive through `qe_complete_step`; bounded correction may run
at most twice. Durable HumanAttention blocks on the existing request/wait/
acknowledge/resolve authority.

## Owner-accurate preparation diagnostics

[Managed-harness lifecycle evidence](managed-harness-lifecycle-diagnostics.md)
records Worker-owned launch, stream registration, stdin delivery, candidate-init
observation/validation, timeout and cleanup stages in the existing Worker session
SQLite database. Missing breadcrumbs never prove nonexecution. The unchanged Mod
has no entrypoint/ready signal, and native probe parsing/init construction/init
submission remain unobservable at this layer. Diagnostics do not authorize work,
change attestation, add raw-output persistence or advance immutable profiles.
The independently identified native-init effort omission remains a separate
follow-up; it is not fixed or diagnosed as the timeout cause here.

## Native sessions and recovery

`claude-code-sessions-v1.sqlite` records native session, physical/logical
lineage, ProviderAccount and credential generation, account environment ID and
incarnation, model, effort, state, and timestamps. Active or prepared sessions
become `uncertain` on Worker restart. `--resume <uuid>` is used only when that
exact QE record and current broker/account binding match. Closed sessions are
never resumed and a fresh execution never reuses any prior record.

A lost attached stream after durable prompt intent is not recoverable. QE does
not resubmit or infer provider outcome. Pre-prompt recovery may retire stale
account-cell process attachments and resume the exact owned native session;
account status, process retirement, and inference are serialized per account.

## Evidence

Deterministic default gates include:

- adapter zero-inference and OAuth/init trap tests;
- managed settings, Mod source, immutable profile-asset, and exact command tests;
- durable native-session transition/restart tests;
- local broker admission and authority tests;
- Product acknowledgment/admission/prompt-gate tests;
- pinned Claude request-boundary capture across fresh, multi-turn, retry,
  high-context compaction, and exact resume/recovery paths;
- the complete Worker suite and relevant server suite.

`QE_LIVE_SBX=1 bun test test/claude-code-two-cell-sbx-live.test.ts` builds the two
production profiles and proves immutable account assets, separate physical
identity, reciprocal canary isolation, local Worker relay admission, bridge to
Run-only read/shell operations, UID/network/credential isolation, traversal
rejection, zero provider requests, and cleanup. This physical proof uses no real
Claude authentication and performs no inference.
