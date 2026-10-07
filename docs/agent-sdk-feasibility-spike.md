# Agent SDK feasibility spike

**Research cutoff:** 2026-10-07T05:42:43Z

**QE base:** `origin/main` at `217a6bd504db015934d63fa1d35feb69756d9a06`

**Candidates:** `@anthropic-ai/claude-agent-sdk@0.3.292` and `google-antigravity==0.1.20`

## Decision

| Candidate | Technical classification | Product recommendation | Replace an existing adapter? |
|---|---|---|---|
| Anthropic Claude Agent SDK | **Conditionally feasible** as a headless, process-backed `AgentHarness` | **Conditional go for a later additive prototype**, after the authentication/terms gate and an approved SBX-sidecar plan; **not production-ready from this spike** | **No.** Keep Pi, Antigravity TUI, and other native adapters |
| Google Antigravity SDK | **Feasible in principle, but a weaker current fit** because it needs a Python sidecar, is Alpha, has weaker model discovery, and documents API/Vertex credentials rather than consumer-subscription reuse | **Defer implementation.** Re-evaluate after Google documents the intended embedded authentication/economics and the SDK matures | **No.** In particular, it must not replace the accepted `agy` TUI adapter |

The SDKs are not lightweight alternatives to native harness processes. The Claude SDK supervises a bundled Claude Code subprocess over stdio. The Google SDK launches a bundled Go `localharness` process and connects to it over a localhost WebSocket. Both therefore remain subject to QE's Run-owned execution-environment, process-ownership, cancellation, recovery, credential, and SBX rules.

The current `AgentHarness` seam is deliberately headless and is a good semantic fit for either candidate. The main implementation gap is below that seam: the current `ExecutionEnvironmentBackend` exposes bounded `exec()` and a PTY launcher, but no generic long-lived bidirectional headless process channel. An implementation must either add an approved streamed-process primitive or run a small, versioned SDK sidecar inside the Run environment. Running either SDK on the Worker host would put its callback tools there and would let it spawn its native runtime outside the Run SBX; that is not acceptable.

No prototype is retained. Static package, source, type, and documentation inspection answered the spike questions without provider authentication or inference. Starting Google's bundled runtime was intentionally avoided because initialization can validate credentials and contact provider services.

## Evidence convention and scope

This report keeps evidence classes separate:

- **[DOC]** official provider documentation or official terms.
- **[ARTIFACT]** metadata or bytes in an officially published npm/PyPI artifact.
- **[SOURCE]** observation from the provider's repository at the exact commit below.
- **[ISSUE]** an open public issue; useful risk evidence, not authoritative behavior or policy.
- **[INFERENCE]** a QE architectural conclusion from the preceding evidence.
- **[RECOMMENDATION]** a proposed QE decision, not a provider promise.

No claim marked **[ISSUE]**, **[INFERENCE]**, or **[RECOMMENDATION]** should be read as official provider policy. Legal observations are engineering risk notes, not legal advice.

### Exact material inspected

| Item | Pin and integrity evidence |
|---|---|
| Claude TypeScript SDK | npm `@anthropic-ai/claude-agent-sdk@0.3.292`; Node `>=18`; repository commit `d4f0435765128047dbe7c99e1fc46e1fbed85357`; package tarball SHA-256 `967024d934865047062b5b5ed6e0d613d4454a846e9c71e1ac55ee3c6d57c168` [ARTIFACT/SOURCE] |
| Bundled Claude Code | Version `2.1.292`; runtime source commit `37832d0b7cad7b40bac7c82dff58629313913edf`; manifest build date `2026-10-06T05:43:35Z`; Linux ARM64 SHA-256 `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`; Linux x64 SHA-256 `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3` [ARTIFACT] |
| Google SDK | PyPI `google-antigravity==0.1.20`; Python `>=3.10`; repository commit `12f9a4c3becf487302dc799b0f59054f01f3ddb9`; tag `v0.1.20`; Alpha classifier; Apache-2.0 [ARTIFACT/SOURCE] |
| Google macOS ARM64 wheel sampled | SHA-256 `a9df0f117407a7d39c4a03de97f4e082e1c2f24650dcca876706c23574118159`; bundled Mach-O ARM64 `localharness` SHA-256 `d0c03177692e74d9d8647d4b8381299f6f9428e8bf5ed398e150136afbe4b9d2` [ARTIFACT] |
| Google wheel platforms observed | macOS arm64/x86_64, Linux arm64/x86_64, Windows amd64/arm64 [ARTIFACT] |

A production profile would have to pin the exact platform wheel/package, all transitive dependencies, the bundled-runtime digest, and the adapter-side protocol version. A package version alone is not sufficient provenance.

## Fit with the QE headless seam

QE already separates semantic harness ownership from optional terminal interaction:

- `HarnessExecutionHandle` contains a schema version, owning harness kind, harness-owned execution ID, optional `NativeSessionRef`, and optional opaque `HarnessTransportBinding`.
- `NativeSessionRef` and `HarnessTransportBinding` are versioned, bounded, adapter-owned values. Generic orchestration retains and validates ownership but does not decode provider state.
- `start`, `continue`, `ready`, `sendInputAndCollect`, `interrupt`, `inspect`, `recover`, `waitAndCollect`, and `close` do not require a PTY or Herdr attachment.
- `HarnessCapabilities` advertises structured results, continuation, recovery, attention, input, observation, and optional interaction independently.
- The registry converts provider failures to QE operational phases and side-effect certainty.

**[INFERENCE]** Both SDKs should use `integrationStrategy: "structured_headless"`. Neither should fabricate `HostedExecutionRef`, terminal topology, nor an attachment. A diagnostic terminal could be added only if a future provider surface truly supports one; it is not needed for semantic execution.

### Durable identity design

| QE value | Claude mapping | Google mapping |
|---|---|---|
| `harnessKind` | Proposed `claude-agent-sdk` | Proposed `google-antigravity-sdk` |
| `executionId` | Adapter-generated ID for one supervised SDK/query process epoch | Adapter-generated ID for one Python-agent/localharness process epoch |
| `NativeSessionRef` | `identityKind: "id"`, `opaqueId: <Claude session_id>` | `identityKind: "id"`, `opaqueId: <conversation_id>` |
| `HarnessTransportBinding` | Versioned sidecar protocol, package/runtime pins, process epoch, durable transcript-store key/config identity, exact model/effort policy, and workspace/environment ownership digests | Versioned Python-sidecar protocol, package/runtime pins, process epoch, Run-private `save_dir` identity, exact model/thinking policy, and workspace/environment ownership digests |
| Never persist here | OAuth/API secrets, raw environment, transcript content, a bare PID as authority, or host paths | API keys/ADC tokens, raw environment, transcript content, WebSocket API key, a bare PID as authority, or unvalidated host paths |

A session ID is conversation state, not workspace state. QE's Run filesystem/private-Git/checkpoint mechanism remains authoritative for code artifacts for both candidates.

### Lifecycle mapping

| `AgentHarness` operation | Claude SDK mapping | Google SDK mapping | Required QE behavior |
|---|---|---|---|
| `discover()` | Verify package and bundled manifest; an authenticated `startup()`/initialization can report account and supported models without a user prompt [DOC/ARTIFACT] | Verify Python package/wheel/runtime; the SDK exposes configured targets and defaults, not an authoritative account-specific model catalog [SOURCE] | No inference; do not turn defaults into entitlement; exact pin/integrity and credential readiness remain separate facts |
| `start()` | Start a sidecar and `startup()`/streaming `query()` in the exact Run workspace; retain the `Query` in the sidecar [DOC] | Start Python `Agent`/`Conversation`, whose local strategy launches `localharness` and completes its WebSocket handshake [SOURCE] | Sidecar and every child must run inside the leased Run environment |
| `continue()` | Use streaming input on a live `Query`; otherwise `resume: session_id`, optionally with `SessionStore` [DOC] | Send another turn on the live `Conversation`; otherwise configure `conversation_id`, `save_dir`, and explicit continuation mode [SOURCE] | Revalidate Action/Attempt/lineage/environment/model authority before every turn |
| `ready()` | Initialization complete, exact cwd/config/model policy accepted, control bridge reachable, no user message sent | Agent entered, conversation connected, exact config accepted, reported sandbox status checked, control bridge reachable, no user message sent | Readiness is not authorization and must not submit a prompt |
| `observePreAuthorizationActivity()` | Reject unexpected user/result messages before prompt intent | Reject unexpected steps/turn count before prompt intent | Preserve QE's no-bypass gate |
| `sendInputAndCollect()` | Feed one authorized user message, stream SDK messages, hooks, tool decisions, and result records | `Conversation.send()` then consume `receive_steps()`/`ChatResponse` until idle/finish | Emit QE events, correlate one native turn, and return only after authoritative structured completion or typed failure |
| `interrupt()` | `Query.interrupt()` for a turn; `AbortController`/`close()` for session/process escalation [DOC/SOURCE] | `ChatResponse.cancel()` or `Conversation.cancel()`/`Connection.cancel()`; then disconnect/process escalation [SOURCE] | Cancellation does not undo tool side effects; preserve side-effect certainty |
| `inspect()` | Query/sidecar state, last SDK activity, deferred tool/permission wait, process health, session ID | Connection idle state, step/interaction state, usage, process/reader health, conversation ID | Do not infer success from native idle or process exit |
| `recover()` | A new subprocess may resume a persisted transcript. The SDK does not provide Worker-restart reattachment to a lost stdio pipe | A new Python/localharness process may resume `conversation_id` from `save_dir`. The SDK does not provide Worker-restart reattachment to a lost WebSocket | Prove the previous owned process inactive before a fresh process; never replay an ambiguously accepted prompt |
| `waitAndCollect()` | Reconnect to the adapter sidecar only while its identity/epoch remains live; otherwise transcript resume begins a later turn, not collection of the old one | Same principle for the Python sidecar; a newly resumed conversation cannot prove the old in-flight turn's outcome | Sidecar epoch and native-acceptance ledger must fence collection |
| `close()` / `retire()` | Close input/query and supervise child exit, then environment-level escalation if needed | Close WebSocket/stdin, wait, terminate on timeout, and cancel background tasks [SOURCE] | QE owns final retirement and must observe exact-process/environment convergence |
| adoption helpers | Initially return no live candidates across Worker restart; later adopt only a still-connected sidecar with exact epoch/ownership evidence | Same | Session resumability is not live-process adoptability |

### Capability posture for a first implementation

**[RECOMMENDATION]** Advertise conservatively. Both could eventually set `structuredResult`, `continuation`, `retainedSessionRecovery`, `structuredAttention`, `nativeBlocking`, `canSendInput`, `canInterrupt`, `canDetectAttention`, `canResume`, and `canObserveStructuredEvents` only after deterministic tests. Both should initially set terminal attachment and conversational takeover capabilities to `false`.

Structured confirmation/text/choice/multiline capabilities depend on a complete QE response round trip, not merely on a provider callback existing. The present inspection model can represent `HumanAttention`; the adapter/bridge must also bind the human response to the exact pending provider callback or durable deferred request. Until each response kind is tested, advertise it as unsupported.

## Claude Agent SDK findings

### Runtime and process ownership

- Official hosting documentation says each `query()` spawns and supervises a separate Claude Code subprocess, communicates over stdio, and gives that subprocess ownership of the shell, cwd, and local JSONL transcripts. One active session maps to one process. [DOC]
- The TypeScript package supports a custom process-spawn abstraction and passes cwd, environment, stdio, exit observation, kill, and a graceful-close-aware abort signal. `startup()` can pre-initialize a subprocess; streaming input keeps a multi-turn query open. [ARTIFACT]
- The package bundles platform-specific Claude Code `2.1.292` binaries through exact optional dependency versions. [ARTIFACT]

**[INFERENCE]** TypeScript aligns with the Bun Worker better than Google's Python API, but it still cannot run directly in the Worker process under QE's SBX rule. There are two acceptable future designs:

1. run a Node/Bun Claude SDK sidecar in the Run environment and expose a narrow versioned QE protocol; or
2. extend `ExecutionEnvironmentBackend` with a generic, incarnation-fenced streamed subprocess and use the SDK's custom spawner.

The sidecar is lower risk because SDK callbacks, SDK MCP tools, hooks, and the Claude Code child all stay inside the same Run boundary. Reusing Herdr merely to obtain hidden PTY pipes would wrongly make a headless harness terminal-dependent.

### Authentication and economics

Official Claude Code authentication includes:

- Anthropic API key or bearer token;
- `apiKeyHelper`;
- Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry credentials;
- Anthropic profiles/federation;
- Claude subscription OAuth for Pro, Max, Team, and Enterprise; and
- a one-year `CLAUDE_CODE_OAUTH_TOKEN` created by `claude setup-token` for subscription-backed scripts/CI. [DOC]

Credential precedence is provider/cloud settings, bearer token, API key, helper, setup token, profiles/federation, then subscription OAuth. A present `ANTHROPIC_API_KEY` can therefore silently select API billing instead of a subscription if QE does not build a deliberate environment. [DOC]

The legal documentation draws a critical distinction: developers building products should normally use an API key or supported cloud provider and may not offer Claude.ai login, collect/intermediate Claude.ai credentials, or route Free/Pro/Max credentials for users. Separately, a product may host the **unmodified** Claude Code binary and allow each end user to sign in through Anthropic's own flow with that user's own supported credential, provided the host agrees to Commercial Terms, does not disable built-in authentication, and does not pay for/resell/intermediate usage. [DOC]

The npm package license itself says use is subject to Anthropic's Commercial Terms rather than an open-source software license. [ARTIFACT]

**[INFERENCE]** Claude can preserve QE's subscription-harness principle only in a narrowly compliant end-user-owned-credential design. QE must not implement its own Claude OAuth UI, import a Desktop credential, suppress built-in auth choices, or pool one person's subscription across users. API-key/cloud-provider operation is technically simpler but changes economics to metered provider billing.

**[RECOMMENDATION]** Before even an authenticated prototype, obtain a product/legal decision for the intended deployment mode:

- internal/single-user unmodified-binary use with that user's subscription;
- customer-provided API/cloud credential; or
- a separately negotiated commercial arrangement.

Do not treat issue reports as permission. Open issues [#355](https://github.com/anthropics/claude-agent-sdk-typescript/issues/355) (reported model mismatch with `subscription_oauth`) and [#382](https://github.com/anthropics/claude-agent-sdk-typescript/issues/382) (request for subscription-auth clarification in an open-source app) are compatibility/risk signals only. [ISSUE]

### Sessions and persistence

- Results carry a `session_id`; later calls can `resume` it, continue the newest session, or fork it. A live TypeScript `Query` supports multiple turns. [DOC]
- Default transcripts are JSONL under `~/.claude/projects/`, or under `CLAUDE_CONFIG_DIR`. A per-tenant config directory and cwd are necessary to prevent settings, memory, and transcript leakage. [DOC]
- `SessionStore` mirrors ordered transcript entries to caller-owned storage and can hydrate another host. It is a dual write: the subprocess writes locally first, then the SDK mirrors. Mirror delivery is best-effort and emits `mirror_error` after retry exhaustion while the agent continues. [DOC]
- `SessionStore` stores transcripts, not working-directory artifacts or memory files. File checkpointing conflicts with a session store and is not a replacement for QE workspace/private-Git state. [DOC]

**[RECOMMENDATION]** Put `CLAUDE_CONFIG_DIR`, cwd, temp, and transcript state inside the Run-private environment. If an external store is later used, treat `mirror_error` as a recovery-integrity fault and keep QE's workspace checkpoint separate. Resume only against the same validated workspace identity. Never claim that transcript resume rolls back or restores tool side effects.

### Tools, permissions, and structured completion

- `tools`, `allowedTools`, and `disallowedTools` control availability/auto-approval; permission modes and rules add native decisions. [DOC/ARTIFACT]
- `canUseTool` is the SDK replacement for an interactive permission prompt, but it only runs when earlier permission evaluation reaches the ask path. It does **not** gate calls already auto-approved. A `PreToolUse` hook is required for a universal adapter policy. [DOC]
- `PreToolUse` can allow, deny, ask, modify, or defer. `defer` ends the turn with `terminal_reason: "tool_deferred"` and a typed deferred call that can be surfaced and handled after session resume. [DOC/ARTIFACT]
- In-process SDK MCP tools and JSON-schema structured output are supported. [DOC]

**[INFERENCE]** The native permission system is defense in depth, not QE's SBX boundary. Shell and file tools still execute in the Claude Code process environment. The outer execution environment must enforce filesystem mode, network grants, credential boundaries, resource limits, and process ownership.

**[RECOMMENDATION]** A future adapter should:

1. expose only the exact built-in tools required by the resolved QE tool profile;
2. add a fail-closed `PreToolUse` hook for universal policy/correlation;
3. use `canUseTool` for short permission prompts and durable `defer` for waits that must survive process shutdown;
4. expose `qe_complete_step` as an SDK MCP tool with only semantic result fields;
5. let the QE control bridge add and validate Action/Attempt/lineage/nonce/output authority; and
6. use structured output as validation/corroboration, never as a substitute for bridge authority.

Because SDK MCP callbacks execute in the SDK host process, they must be inside the Run environment. A Worker-hosted custom tool would move model-triggered code execution out of SBX.

### HumanAttention

Claude offers several typed pause surfaces:

- `canUseTool` for permission decisions and `AskUserQuestion` response data;
- `PreToolUse` `ask` or `defer`;
- hooks for permission requests, elicitation, notifications, and user dialogs; and
- abort signals while callbacks wait. [DOC/ARTIFACT]

A callback may remain pending indefinitely. Official guidance recommends `defer` when a human may take longer than the process should remain alive. [DOC]

**[INFERENCE]** These map naturally to QE categories:

| Native condition | QE projection |
|---|---|
| permission prompt | `needs_permission` + confirmation/choice |
| `AskUserQuestion` | `needs_input` + text/choice/multiline |
| authentication/elicitation URL | `needs_authentication` or `blocked_external` |
| unknown dialog/notification | `interactive_prompt` or `unknown_interactive_block` |
| deferred tool call | retained `waiting_for_human`, correlated to session ID + tool-use ID |

The human answer must return through a bound, expiring QE bridge operation to the exact callback/deferred tool. It must not become generic terminal input. Unknown callback kinds fail closed.

### Cancellation, failures, and recovery

- `Query.interrupt()` targets the active turn while a streaming session may remain open. Closing/aborting follows a graceful stdin-close path before the forwarded process signal fires; hard teardown remains available through the spawned-process owner. [ARTIFACT]
- Result messages report explicit success/error subtype and `terminal_reason`, including aborted tools/streaming, deferred tools, budget exhaustion, max turns, and model/API errors. [ARTIFACT]
- Process/transport failure can occur without a final result. Resuming a transcript starts a later process; it does not reconnect to a lost stdio channel or prove whether an external side effect completed. [DOC/INFERENCE]

**[RECOMMENDATION]** Keep a durable turn ledger with intent, SDK send/accept evidence, session ID, message/result IDs, result status, and completion-tool acknowledgement. On ambiguity, return QE `uncertain`; never automatically resend. Interrupt, wait for bounded native convergence, close, then escalate through exact Run-owned process/environment authority. Cancellation never implies rollback.

### Models, effort, cost, and telemetry

- The SDK accepts an exact `model`, optional `fallbackModel`, effort/thinking configuration, and exposes initialized supported-model/account information. [DOC/ARTIFACT]
- Result and assistant messages carry token/model usage. `total_cost_usd`/`costUSD` are client-side estimates from a bundled price table, not billing authority; resumed-session totals and subagent accounting have special rules. [DOC]
- Claude Code, not the wrapper, emits opt-in OpenTelemetry metrics, logs, and beta traces. It can propagate W3C trace context from the host. Prompt text, tool details/content, and raw API bodies require separate opt-ins and can be highly sensitive. [DOC]

**[RECOMMENDATION]** Omit `fallbackModel`, pin one exact model and native effort value, reject model-switch events, and verify observed model metadata on every turn. Discovery must not equate `supportedModels()` with proven account entitlement; retain QE's `unknown` state until direct evidence satisfies the existing policy. Use SDK cost only for diagnostics and budgets, not billing. Export structural telemetry by default, leave content flags off, and add QE lifecycle/ownership spans around provider spans.

## Google Antigravity SDK findings

### Runtime and process ownership

The public API is layered as `Agent` -> `Conversation` -> `Connection`. `Agent.__aenter__()` constructs hooks/tools, creates a connection strategy, and enters a conversation. The local strategy:

1. resolves the platform-specific `localharness` bundled in the wheel;
2. selects a localhost port;
3. generates a random local API key;
4. starts the Go binary;
5. drains stderr in a background thread; and
6. connects over WebSocket with `x-goog-api-key`. [SOURCE]

Shutdown closes the WebSocket and stdin, waits for the process, escalates termination after timeouts, and cancels reader/background tasks. [SOURCE]

**[INFERENCE]** The local API key only authenticates the loopback Python-to-Go transport; it is not a model-provider credential and must not be reused as QE authority. The Python wrapper and Go child must run in the same Run environment. A Bun adapter therefore needs a Python sidecar protocol; reimplementing the private protobuf/WebSocket protocol in TypeScript would unnecessarily couple QE to internal transport.

### Authentication and economics

Documented modes are:

- Gemini Developer API with `GEMINI_API_KEY` or an explicit API key;
- Vertex Express mode with an API key; and
- Vertex project/location with Application Default Credentials. [DOC/SOURCE]

No authoritative documentation inspected for `0.1.20` says the SDK can reuse a consumer Google account, Google One/AI subscription, Antigravity Desktop state, `agy` login, or another CLI credential. Open issue [#20](https://github.com/Google-Antigravity/antigravity-sdk-python/issues/20), “Support Google Account OAuth and reuse of CLI authentication file,” is evidence that users want this feature, not evidence that it exists. [ISSUE]

**[INFERENCE]** Today this is an API-billed agent SDK, not a demonstrated replacement for QE's subscription-bearing Antigravity TUI harness. Vertex ADC can support enterprise/workload identity, but that is a different credential/economic model.

The repository/package is Apache-2.0, but model-service use remains subject to the Gemini API/Google Cloud terms. Gemini API Additional Terms effective 2026-03-23 include age 18+, professional/business rather than consumer use, regional restrictions, paid-only API-client availability in the EEA/Switzerland/UK, and materially broader content-use language for unpaid services. They state Google does not claim ownership of generated content, while the user remains responsible for it. [DOC]

**[RECOMMENDATION]** Do not register this as a production harness until product/legal/security explicitly choose a paid Gemini or Vertex credential model and data-use posture. Do not scrape or import existing `agy`, Desktop, browser, or Google One credentials. Prefer a narrowly scoped dynamic API/Vertex grant or workload identity; do not mount a developer's ambient `gcloud` home. Verify whether command tools inherit provider credentials and use proxy/token injection or scrubbed child environments so model-controlled commands cannot read them.

### Sessions and persistence

- `Conversation` accumulates structured `Step` history, turn boundaries, compaction markers, last response, and cumulative/per-trajectory usage. [SOURCE]
- `conversation_id` plus Run-private `save_dir` supports explicit `RESUME`, `CREATE_OR_RESUME`, and `CREATE_ONLY` behavior. [SOURCE]
- History retained by the Python object is bounded by default; runtime compaction affects model context while full received history can remain available to the wrapper. [SOURCE]

**[INFERENCE]** `conversation_id` is the correct `NativeSessionRef`. The validated `save_dir` belongs in adapter-owned transport state and the Run state path. It is not a filesystem snapshot. Destroying the Run without exporting that state loses native continuation even if QE retained the ID.

**[RECOMMENDATION]** Require explicit `CREATE_ONLY` for a fresh Attempt and exact `RESUME` for recovery; avoid an implicit create-or-resume fallback that could silently create a new conversation. Test crash consistency and runtime-version compatibility before advertising retained recovery. Keep workspace/private-Git persistence separate.

### Tools, policies, and structured completion

- Custom Python functions, MCP servers, built-in tools, hooks, policy rules, and response schemas are supported. [DOC/SOURCE]
- The default high-level config is read-only. Enabling write tools or MCP without a policy/decision hook is rejected. [SOURCE]
- Capability configuration removes disabled tools from the model context. Policy denial leaves a tool visible but rejects it at execution time. [DOC/SOURCE]
- `confirm_run_command()` denies `run_command` when no handler is supplied but allows other tools; it is not a blanket write deny. [SOURCE]
- Configured `workspaces` constrain file tools. Optional command sandboxing reports availability, but when requested and unavailable it warns and still permits `run_command` to execute unsandboxed. [SOURCE]

**[INFERENCE]** Google's capability and policy system is useful defense in depth, but configured workspace roots and optional OS command sandboxing do not replace QE SBX. `run_command` is a host command relative to the Python/Go runtime; placing that runtime on the Worker host would be a direct boundary violation.

**[RECOMMENDATION]** Run the sidecar inside SBX, set one exact Run workspace, use an explicit enabled-tool set, deny by default with narrow allows, and treat unavailable native sandbox status as a readiness failure whenever the resolved profile requires it. Expose `qe_complete_step` as a custom Python tool that forwards only semantic fields to the control bridge. Validate `FINISH`/structured output, but do not accept it without current QE authority.

### HumanAttention

The SDK has:

- `policy.ask_user()` and pre-tool decision hooks;
- question hooks for model questions;
- interaction states including `ASK_QUESTION` and `WAITING_FOR_USER`; and
- custom tool-result routing back to the native loop. [SOURCE]

**[INFERENCE]** Short-lived callbacks can map to QE confirmation/text/choice attention while the exact sidecar is alive. Unlike Claude's documented deferred-tool/session-resume path, no equally explicit durable “park this pending tool and resume it in a new process” contract was found. A Python callback lost during Worker/sidecar failure should therefore be considered unresolved/ambiguous, not recreated from UI state.

**[RECOMMENDATION]** Start with bounded in-process attention only. Persist attention correlation before exposing it, abort it on cancellation, and do not advertise durable structured response capabilities until a crash/restart test proves exact once-only routing. For long waits, end the turn under an explicit QE protocol and continue with a new user turn only if product semantics accept that it is not resuming the original callback.

### Cancellation, failures, and recovery

- `ChatResponse.cancel()` cancels the response's native async task and calls conversation cancellation; `Conversation.cancel()` delegates to `Connection.cancel()`. [SOURCE]
- The event processor exposes typed steps, stop reasons, finish state, errors, and idle state. [SOURCE]
- Connection teardown supervises WebSocket, stdin, child wait/termination, stderr collection, and background tasks. [SOURCE]

Cancellation cannot roll back completed file, command, MCP, or custom-tool effects. A resumed `conversation_id` cannot prove the outcome of an in-flight turn whose WebSocket was lost. [INFERENCE]

**[RECOMMENDATION]** Use the same durable intent/accept/result ledger and uncertain-outcome rule as Claude. On cancel: send native cancellation, wait for idle/typed terminal evidence, disconnect, then escalate to exact child/environment retirement. Never resend after ambiguous acceptance.

### Models, thinking, usage, and telemetry

- Source defaults are `gemini-3.8-flash` for text and `gemini-3.1-flash-lite-image` for image generation. `ThinkingLevel` enumerates `minimal`, `low`, `medium`, `high`, and `extra_high`; model endpoints also expose service tier. [SOURCE]
- Configuration can contain multiple purpose-specific model targets. The SDK validates credential shape but does not provide an authoritative account-specific catalog equivalent to QE model discovery. [SOURCE]
- Budgets cover model calls, tool calls, and input/output/total tokens. Retry configuration can alter API and malformed-output retries; the benchmark preset is intentionally extremely tolerant and is inappropriate for ordinary QE execution. [SOURCE]
- Usage metadata includes prompt, candidate, thought, cached, and total token counts, both cumulative and by trajectory. It does not expose an authoritative currency cost. [SOURCE]
- Optional OpenTelemetry hook classes create session, turn, step, subagent, and tool spans when the `otel` extra is installed. [SOURCE]

**[RECOMMENDATION]** Never advertise source defaults as verified availability. Require a configured exact allowlist/capability manifest until Google adds trustworthy discovery, use exactly one text target, disable image generation and model routing for coding Attempts, and pin one supported thinking level. Disable unbounded benchmark retries and let QE own attempt retry. Export SDK spans beneath QE lifecycle spans with prompt/tool content excluded by default.

## Comparison matrix

| Area | Claude Agent SDK `0.3.292` | Google Antigravity `0.1.20` | QE conclusion |
|---|---|---|---|
| API language | TypeScript, Node `>=18` | Python `>=3.10` | Claude is closer to Bun; both should run in-environment |
| Native process | Bundled Claude Code `2.1.292`, stdio | Bundled Go `localharness`, loopback WebSocket | Both are process-backed harnesses |
| Package maturity | Official SDK with extensive hosting docs; package is not open-source licensed | Alpha classifier; Apache-2.0 SDK | Google carries higher churn risk |
| Subscription reuse | Official Claude Code subscription auth exists, but embedded-product restrictions are material | No authoritative consumer-subscription/Desktop/`agy` reuse found | Google does not preserve the current subscription proposition |
| API/cloud auth | Anthropic key/token, helper, Bedrock, Google cloud, Foundry, federation | Gemini key, Vertex Express key, Vertex project/location + ADC | Both can use customer/workload credentials |
| Session identity | `session_id` | `conversation_id` | Both fit `NativeSessionRef` |
| Durable conversation | JSONL and optional best-effort `SessionStore` mirror | `save_dir` + conversation ID | Both require separate workspace persistence |
| Live process reattach | No reattach to a lost stdio pipe found | No reattach to a lost WebSocket found | Recovery means new process + native resume, not adoption |
| Structured result | JSON schema and SDK MCP tools | response schema, FINISH steps, custom tools | Both can bridge to `qe_complete_step` |
| Permission control | tool sets, permission modes, `canUseTool`, hooks, durable defer | capability removal, policies, hooks, interaction states | Claude has the stronger documented durable-attention story |
| Built-in shell risk | Child owns shell/cwd | `run_command` executes where localharness runs | Entire runtime must be inside SBX |
| Native sandbox | Claude Code sandbox support, still not a QE substitute | optional command sandbox may warn and fall back unsandboxed | Outer QE SBX remains decisive |
| Cancellation | interrupt, abort, close, process signal escalation | response/conversation/connection cancel + process teardown | Neither offers side-effect rollback |
| Model selection | exact model, effort/thinking, supported-model initialization; optional fallback must be disabled | explicit model targets/thinking, but defaults are not discovery | Google model discovery is a production blocker |
| Usage/cost | tokens plus estimated USD; authoritative billing elsewhere | detailed tokens, no authoritative currency cost observed | QE needs provider billing systems for money |
| Telemetry | CLI OTEL metrics/logs/beta traces; content opt-in | optional hook-based OTEL spans | Both need QE wrapper spans and privacy defaults |
| SBX integration effort | Medium: Node sidecar or streamed custom spawner | High: Python sidecar plus Go child and sidecar protocol | Claude is the better first experiment |
| Existing adapter replacement | No | No | Additive only |

## SBX and credential architecture

A compliant topology for either SDK is:

```text
Worker / AgentHarness adapter
  -> Run-owned, incarnation-fenced sidecar channel
  -> exact Run environment
       -> SDK sidecar (Node/Bun or Python)
            -> bundled native runtime
                 -> built-in file/shell tools in Run workspace
                 -> approved provider/MCP egress only
            -> QE semantic control bridge via mode-0600 capability
```

Mandatory properties:

1. The package, sidecar, runtime, and entrypoint are digest-pinned and non-writable.
2. cwd, HOME/config, transcript/save directory, cache, and temp are private to the Run/lineage.
3. The sidecar verifies Worker, Run, Attempt, PhysicalLineage, environment ID/incarnation, workspace, package/runtime version, and model configuration before accepting input.
4. Provider credentials are delivered through `CredentialGrantDescriptor`/a dynamic resolver or an external injection proxy, never through Product state or durable transport bindings.
5. Built-in commands cannot inherit broader Worker or developer credentials.
6. Runtime egress is provider- and tool-purpose scoped; dependency registries/update endpoints are absent after profile creation.
7. The SDK's own localhost/stdio channel is not treated as QE control authority.
8. The QE control descriptor is bound to one current execution and rotates with Attempt/controller generation.
9. Native session state and workspace state are retained/exported independently.
10. Exact child retirement is subordinate to QE cancellation and environment teardown.

## Recommendation and staged gates

### Claude: conditional additive prototype

Proceed only under a new approved plan, and only in this order:

1. **Terms/auth gate:** choose and approve one end-user-owned credential model; confirm Commercial Terms obligations and unmodified-binary/auth-method requirements.
2. **No-inference packaging gate:** build an immutable Linux SDK-sidecar profile; verify package, Claude Code manifest/runtime digest, private HOME/cwd, no updater, and zero prompt/provider cycles.
3. **Sidecar contract gate:** test start/readiness, exact identity, malformed frames, backpressure, process exit, cancellation, and secret redaction with a fake spawned process.
4. **Semantic gate:** test structured completion, every advertised HumanAttention response kind, model/effort pinning, no fallback, and no terminal dependency against fakes.
5. **Recovery gate:** test pre-send failure, native acceptance, lost transport before result, deferred tool resume, transcript-store failure, old process inactivity proof, and no automatic replay.
6. **SBX gate:** prove shell/file/custom tools execute only in the Run environment and cannot read Worker/developer credentials or escape network/filesystem policy.
7. **Human-authorized paid gate:** only then perform one bounded staging inference with explicit cost/data authorization and evidence capture.
8. **Production gate:** require a separate review and registration change; do not alter existing loadouts or discovery as part of the prototype.

### Google: defer

Do not implement now. Re-open the decision when all of these are true:

1. Google documents the supported embedded authentication and billing model, including whether any end-user subscription flow is intended;
2. product/legal accepts Gemini/Vertex terms and paid/unpaid data handling;
3. exact account-aware model/thinking discovery or an approved immutable capability manifest exists;
4. sidecar/runtime protocol and persistence compatibility are stable enough to pin;
5. durable attention/recovery semantics are documented or can be proven without replay; and
6. the benefit over the already accepted `agy` TUI adapter justifies a second Antigravity process stack.

A future Google experiment should still be additive. It must not import `agy` credentials, replace the current TUI path, or assume that identical “Antigravity” branding implies identical auth, models, terms, or session formats.

## Unanswered questions

### Anthropic

1. Which exact QE deployment pattern does Anthropic consider compliant: internal tool, hosted end-user binary, customer API key, or another arrangement?
2. Can QE support user-owned Pro/Max/Team/Enterprise credentials without becoming a prohibited login or credential intermediary?
3. What compatibility promise covers SDK package, bundled Claude Code version, transcript schema, and `SessionStore` entries across upgrades/downgrades?
4. Can a custom streamed spawner be made subordinate to the current `ExecutionEnvironmentBackend` without a provider-specific environment escape hatch?
5. What exact event proves a streaming input was natively accepted before a transport loss?
6. Which model identifier is authoritative after aliases, account policy, and provider routing, and how should QE reject a silent model switch?
7. Can all required permission/question flows use durable `defer`, or do some require a live callback?
8. What retention/data-governance requirements apply to transcripts, tool data, and optional OTEL content for the selected account type?

### Google

9. Is consumer Google OAuth, Google One/AI subscription, `agy`, or Desktop credential reuse an intended supported SDK feature?
10. Is `localharness`'s protobuf/WebSocket contract public and versioned, or explicitly internal to the Python package?
11. What is the compatibility policy for `save_dir` and `conversation_id` across SDK/localharness versions?
12. Which event is the authoritative proof that a sent user message was accepted, especially across a WebSocket loss?
13. Can a pending `ASK_USER`/question/tool callback be durably resumed in a fresh process exactly once?
14. Is there an account-aware supported-model and thinking-level discovery API, including deprecations and regional availability?
15. Can provider credentials be withheld from `run_command` children by supported configuration, especially with ADC?
16. What telemetry and service-side data-retention controls apply to paid Gemini, Vertex, and unpaid Gemini separately?
17. Under what exact conditions does optional command sandboxing fall back, and can configuration require fail-closed startup rather than warning?
18. Does the runtime ever contact update, eligibility, analytics, or other non-inference endpoints during startup, and can those be completely enumerated for egress policy?

### QE seam

19. Should QE add a generic streamed-process lease or standardize a language-neutral in-environment harness-sidecar protocol?
20. What generic operation settles structured HumanAttention responses without adding provider concepts to Product APIs?
21. What durable turn-ledger fields are sufficient to distinguish not submitted, submitted, native accepted, completed, and ambiguous for headless SDKs?
22. How should sidecar liveness and old-process absence be proven across Worker restart without treating PID reuse as identity?
23. Should a transcript mirror failure immediately stop execution or only disable retained recovery?
24. Which structural telemetry fields are allowed, and what provider-native content flags must be forcibly disabled by profile policy?

## Sources

All sources were retrieved or inspected by the research cutoff above.

### Anthropic official documentation and artifacts

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) [DOC]
- [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting) [DOC]
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) [DOC]
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) and [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage) [DOC]
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks), and [handle user input](https://code.claude.com/docs/en/agent-sdk/user-input) [DOC]
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) and [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) [DOC]
- [Model configuration](https://code.claude.com/docs/en/agent-sdk/model-config), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), and [observability](https://code.claude.com/docs/en/agent-sdk/observability) [DOC]
- [Claude Code authentication](https://code.claude.com/docs/en/authentication) and [legal/compliance](https://code.claude.com/docs/en/legal-and-compliance) [DOC]
- [npm package `0.3.292`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.292) [ARTIFACT]
- [Repository at `d4f0435765128047dbe7c99e1fc46e1fbed85357`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/d4f0435765128047dbe7c99e1fc46e1fbed85357) and its [license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/d4f0435765128047dbe7c99e1fc46e1fbed85357/LICENSE.md) [SOURCE]
- Public issues [#355](https://github.com/anthropics/claude-agent-sdk-typescript/issues/355) and [#382](https://github.com/anthropics/claude-agent-sdk-typescript/issues/382) [ISSUE]

### Google official documentation, source, artifacts, and terms

- [Google Antigravity SDK repository at `v0.1.20`](https://github.com/Google-Antigravity/antigravity-sdk-python/tree/12f9a4c3becf487302dc799b0f59054f01f3ddb9) and [README](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/README.md) [DOC/SOURCE]
- [`Agent`](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/agent.py), [`Conversation`](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/conversation/conversation.py), and [connection contract](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/connections/connection.py) [SOURCE]
- [Local connection/process implementation](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/connections/local/local_connection.py) and [event processor](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/connections/local/event_processor.py) [SOURCE]
- [Policies](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/hooks/policy.py), [types](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/types.py), [models](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/models.py), and [OTEL hooks](https://github.com/Google-Antigravity/antigravity-sdk-python/blob/12f9a4c3becf487302dc799b0f59054f01f3ddb9/google/antigravity/utils/otel.py) [SOURCE]
- [PyPI package `0.1.20`](https://pypi.org/project/google-antigravity/0.1.20/) [ARTIFACT]
- [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) (effective 2026-03-23) [DOC]
- Public issue [#20](https://github.com/Google-Antigravity/antigravity-sdk-python/issues/20) [ISSUE]

### QE architecture consulted

- [`docs/harness-integration-architecture.md`](harness-integration-architecture.md)
- [`docs/antigravity-sbx.md`](antigravity-sbx.md)
- `workers/bun/src/harnesses/types.ts`
- `workers/bun/src/harnesses/native-session.ts`
- `workers/bun/src/harnesses/transport-binding.ts`
- `workers/bun/src/harnesses/registry.ts`
- `workers/bun/src/execution-environment/types.ts`

## Spike execution statement

This spike sent no request to Claude, Gemini, Vertex, or Antigravity; performed no provider authentication; did not execute either bundled native runtime; did not register a harness; and did not change production code, loadouts, model discovery, Herdr, or Phase 6 work.
