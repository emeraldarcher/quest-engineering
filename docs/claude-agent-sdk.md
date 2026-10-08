# Claude Agent SDK production harness

## Status and scope

`claude_agent_sdk` is QE's third additive production `AgentHarness`. It does not replace Pi or Antigravity, change Herdr, or become a default loadout. Enable it explicitly with `QE_WORKER_HARNESSES=claude_agent_sdk` or add it to the existing comma-separated loadout.

The implementation follows [`claude-agent-sdk-decision.md`](claude-agent-sdk-decision.md) and keeps the task's validation path at zero Claude authentication and zero provider inference.

| Component | Immutable provenance |
|---|---|
| QE profile | `qe-coding-execution-v2`, `sha256:836fb88e0b1431f6e86618ee6865b0792db4ad7b9b404db4b995745c7d88ec24` |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.292` |
| SDK npm integrity | `sha512-C5XI/19uArTg3jjgayN9CSQxJilRciBko007AdPmHXwQqbAzdUldaPUQtDp8Pm6QJg5Aw3jI1G1eIJOBrx4xKQ==` |
| SDK research tar SHA-256 | `967024d934865047062b5b5ed6e0d613d4454a846e9c71e1ac55ee3c6d57c168` |
| Claude Code | `2.1.292`, source commit `37832d0b7cad7b40bac7c82dff58629313913edf` |
| Linux ARM64 runtime | SHA-256 `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`; npm integrity `sha512-ziGXVP0Kjjg531fUNZh/1lkT8MQKc77qFinqvQ7N7ZbR7Kr/wVRhs3kSb2s7A1+z/3TNsPiQJManEmbw61U+Hw==` |
| Linux x64 runtime | SHA-256 `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3`; npm integrity `sha512-dnMVyLxpg8mUzEqAtxhv+5oBxdiYjCLIBHLPFM4z7cuk+Se6SwgyHPRGipp8rOociJBS8yyB7QXJh+RO41y+Kg==` |
| QE wrapper protocol | `claude_agent_sdk_stream_v1`, protocol `1`, wrapper `1.0.0`, source SHA-256 `c25e087b0855812d320f9385078cb3e6c11c85ecbee51913f325db2fceb4dafb` |

`qe-coding-execution-v1` remains byte-for-byte unchanged and retains its original identity digest `sha256:09dc17e0b2270441ba4af01d3e59f803c0514bfedb82356f8849017a76e2cc2b`.

## Process and isolation architecture

The adapter is headless. It calls `EnvironmentLease.spawnStreamed()` with the absolute profile-owned wrapper `/opt/qe/claude/wrapper.mjs`, literal argv, the private-Git workspace, and an allowlisted environment. It never calls `TerminalSessionBackend`, creates a Herdr object, opens a PTY, or advertises a terminal attachment.

The generic streamed-process contract provides:

- one exact environment UUID/incarnation and profile ID/digest;
- one backend process ID, process-start identity, executable identity, and QE process generation;
- bounded stdout/stderr and stdin acknowledgements;
- explicit EOF, process exit, cancellation, transport loss, and detached-process reconciliation;
- `attached_only` stream recovery: another Worker process never fabricates stdio reattachment.

Wrapper stdout is strict bounded NDJSON. Stderr bytes are drained but never logged because native diagnostics can contain prompts, repository content, provider bodies, or credentials. Events carry only bounded lifecycle, model, effort, tool decision, HumanAttention, completion, session, and structured usage data. Duplicate IDs, stale generations, unknown fields, malformed JSON, oversized frames, and queue overflow fail closed.

The adapter persists only the existing generic seams:

- `transport_binding_json`: wrapper/process/environment generation, immutable configuration hashes, and submission cursor/state;
- `native_session_json`: the SDK session ID as a harness-owned opaque ID;
- `interactive_json`: `null`.

No new generic terminal topology or Claude-specific registry columns were added.

## Authentication and economics

Discovery verifies installed profile artifacts and `process.streamed`, but reports `auth_required` and does not advertise a schedulable executor. Disposable discovery intentionally has no Claude credential state.

The only future setup operation is:

```text
/opt/qe/pi/node_modules/@anthropic-ai/claude-agent-sdk-linux-<arch>/claude auth login
```

It may be launched only after an explicit current human setup authorization, inside the exact Run-owned SBX, with Run/lineage-private `HOME` and `CLAUDE_CONFIG_DIR`. The command is unmodified. Setup output remains on the bounded private stream and is not copied into diagnostics.

QE does not:

- execute login during startup, discovery, tests, or the live zero-inference gate;
- copy a host `~/.claude`, keychain entry, browser profile, or credential file;
- read, extract, proxy, log, or persist a Claude access/refresh token;
- accept `ANTHROPIC_API_KEY`, bearer-token, Bedrock, Vertex, Foundry, or other cloud fallback;
- terminate provider TLS or place a QE sampling proxy in subscription traffic;
- infer Terms, Data Use, billing, or account consent.

An authenticated subscription execution must report `claude auth status` method `claude.ai`, and the SDK init must report no API-key source. Any other method is `auth_required`/`permission_denied`, never an economic fallback.

## Model and effort contract

After authentication, the wrapper uses the SDK initialization model catalog. It requires the exact scheduled model to exist and the exact scheduled effort to be in that model's supported effort levels. It then checks the same values in SDK init, assistant messages, hook inputs, usage attribution, and terminal settlement.

A model switch is denied before the switch and checked again afterward. Fallback models are not configured. Missing or downgraded effort is `effort_unavailable`; alias or model drift is `model_unavailable`. Neither condition retries with another model.

## Tool authority and security

QE's resolved semantic tools map mechanically:

| QE capability | Native tools |
|---|---|
| `workspace.filesystem` | `Read`; plus `Edit`/`Write` only for `read_write` |
| `workspace.search` | `Glob`, `Grep` |
| `terminal.shell` | `Bash` |
| structured HumanAttention | `AskUserQuestion` callback path |
| structured completion | in-process `mcp__qe__qe_complete_step` only |

The wrapper combines SDK `tools`, `canUseTool`, `PreToolUse`, and exact path/access checks. Unknown tools, web tools, agents/subagents, skills, notebooks, undeclared semantic capabilities, workspace escapes, and writes under non-writable access are denied. `settingSources`, skills, and plugins are empty; connectors, bundled skills, auto-memory, optional traffic, telemetry, error reporting, feedback, marketplace autoinstall, and auto-update are disabled.

Claude's inner sandbox is required with `failIfUnavailable: true`, no unsandboxed command mode, strict deny-all tool network, and sensitive path denies. Those denies cover Claude config/control state, Pi and Antigravity credential locations, SSH state, `/root`, and `/proc`. The child environment is allowlisted and excludes host/Worker variables and API/cloud credentials. The outer SBX remains authoritative for filesystem namespace, private Git, source access mode, provider-only egress, process ownership, and host-mount isolation.

The composed VM necessarily contains the other installed harnesses so one Run can change harnesses without recreating the VM. Claude tools cannot read their credential/state paths. Host Git configuration, SSH agents, cloud credentials, Docker sockets, and host filesystem mounts are not exposed.

## Completion and Product authority

`qe_complete_step` accepts only an `outputs` JSON object. It carries no Worker, Run, Action, Attempt, occurrence, lineage, generation, nonce, result-directory, or workspace authority. The adapter forwards it into the existing attempt-bound `HarnessControlAuthority`.

A tool acknowledgement means semantic acceptance only. The existing authority still validates exact declared keys, current identity/generation, one-call semantics, private-Git checkpoint/export, and nonce-bound result publication. Terminal prose, a successful SDK result, provider idle, or process exit is never a QE result.

At SDK settlement the adapter calls the existing native-stop authority:

- `allow`: collect the one physically exported result;
- `continue`: submit only the bounded QE-generated completion correction to the same native session;
- `contract_violation`: fail without inventing output.

Corrective continuation remains bounded by the existing authority. Usage events preserve per-model input, output, cache-read, cache-write, reasoning tokens, result count, and SDK-estimated USD cost. Estimated cost is diagnostic, not provider billing authority.

## HumanAttention

Native permission and `AskUserQuestion` callbacks are blocking promises. The wrapper emits a bounded request with the native request ID, wrapper attention ID, interaction kind, and safe message. The adapter asks `HarnessControlAuthority` to create the Product-safe QE attention ID and stores the exact correlation.

The local Product UI renders confirmation, text, bounded multiline, and sanitized choice forms. Its local-only endpoint sends a Worker-generation-, Action-, Attempt-, session-, attention-, and request-correlated response; an exactly-once Worker ledger routes it through `respondToAttention()`. The wrapper emits a correlated callback-acceptance event before QE resolves the attention. Stale, duplicate-conflicting, cross-request, malformed, and out-of-schema responses are rejected. There is no terminal takeover and no claim of conversational attachment.

## Cancellation and recovery

Cancellation authority is persisted before native interruption. The adapter first sends `Query.interrupt()` through the wrapper, waits a bounded interval for correlated cancelled settlement, and then uses exact physical-process cancellation as fallback. Lost fallback acknowledgement is `cancellation_uncertain`; cancellation does not claim to undo filesystem, shell, network, completion, or provider side effects.

Recovery uses the durable submission state:

| Durable state/evidence | Automatic action |
|---|---|
| `not_submitted`, old process authoritatively gone/exited | replace wrapper; no provider work is replayed |
| `submitted` | `submission_uncertain`; never replay |
| `native_accepted` | `submission_uncertain`; never replay |
| authoritative QE result exists | collect it; provider settlement is not required |
| provider `settled`, result absent | reopen the exact native session and ask existing completion authority whether one bounded correction is allowed |
| `cancelled` or `terminal` | immutable terminal history; no adoption |
| detached process still running or unavailable | `stream_lost`; attached-only stdio cannot be invented and replacement is forbidden |
| process start identity mismatch | terminal `ownership_mismatch` |

The process handle, environment ref, profile digest, workspace/configuration identities, exact model/effort/tool-policy hash, request/turn IDs, continuation count, and event cursor are validated before recovery. A Worker restart may replace only after physical absence evidence. Same-lineage continuation is rejected by the existing physical-configuration equality check if model, effort, tools, workspace, or harness changes.

## Typed failures

Important adapter codes include:

- `auth_required`
- `model_unavailable`
- `effort_unavailable`
- `tool_policy_violation`
- `provider_unavailable`
- `permission_denied`
- `runtime_incompatible`
- `stream_lost`
- `submission_uncertain`
- `cancellation_uncertain`
- `completion_export_timeout`
- `harness_contract_violation`
- `ownership_mismatch`
- `stale_generation`
- `stale_human_attention`
- `malformed_frame` / `oversized_frame`

Each carries the existing operational classification, phase, side-effect certainty, and `process.streamed` capability context.

## Deterministic and physical validation

Deterministic tests execute the real wrapper process in fake mode. They cover session discovery, exact tools, structured usage/cost, HumanAttention round trips, custom completion, settlement, cancellation, unauthenticated setup readiness, forbidden tools, model/effort mismatch, duplicate/stale requests, malformed/oversized frames, adapter completion authority, headless persistence, auth command construction, and the recovery-state matrix.

The physical gate is:

```sh
cd workers/bun
QE_LIVE_SBX_CLAUDE=1 QE_SBX_BIN=/absolute/sbx \
  bun test test/sbx-claude-agent-sdk-live.test.ts
```

It creates the real `qe-coding-execution-v2` SBX, installs the lockfile-pinned artifacts, independently verifies SDK/Claude versions and runtime SHA-256, proves no Claude credential file, host `/Users` mount, or SSH agent is present, launches the real wrapper through production `EnvironmentLease.spawnStreamed()`, and receives `authentication_required` before the wrapper loads the SDK or constructs `query()`. It then shuts down and removes the exact environment.

The final accepted local proof completed on 2026-10-08 against profile `sha256:836fb88e0b1431f6e86618ee6865b0792db4ad7b9b404db4b995745c7d88ec24` with:

- Claude auth-login invocations: **0**
- Claude credential imports/extractions: **0**
- SDK `query()` constructions: **0**
- Claude prompt submissions: **0**
- Claude provider/model requests: **0**
- provider inference turns: **0**
- Product Actions: **0**

The dependency audit has no critical advisory and no advisory introduced by the pinned Claude SDK/MCP path. Three pre-existing Pi-tree advisories remain (`@earendil-works/pi-coding-agent`/`undici` and its nested `brace-expansion`) and are reported separately rather than changing the accepted Pi pin in this additive work.
