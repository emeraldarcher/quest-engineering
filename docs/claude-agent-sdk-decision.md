# Claude Agent SDK authentication decision

**Decision cutoff:** 2026-10-07T06:37:06Z

**QE base:** `origin/main` at `a5efd7e5224a17f292f9755c6773fa18427112b7`

**Evaluated package:** `@anthropic-ai/claude-agent-sdk@0.3.292`, bundling Claude Code `2.1.292`

## Decision

**A — Proceed with user-owned Claude subscription authentication as documented and compliant, subject to the mandatory gates in this report.**

QE can build an **additive, opt-in, structured-headless** `AgentHarness` around the TypeScript Claude Agent SDK without changing subscription economics when all of the following remain true:

1. QE runs Anthropic's **unmodified** Claude Code binary inside the user's Run-owned SBX.
2. The end user authenticates that binary with the end user's own Claude Free, Pro, Max, Team, or Enterprise account through `claude auth login` and Anthropic's own browser flow.
3. QE does not create a Claude-branded login form, receive a password, mint or print a setup token, import a Claude Desktop/host CLI token, proxy subscription bearer tokens, pool an account, pay for usage, or resell/intermediate inference.
4. Claude's native credential store remains in a per-user, per-Run private `CLAUDE_CONFIG_DIR`. It is not copied into the workspace, Product state, a QE secret service, `NativeSessionRef`, `HarnessTransportBinding`, logs, telemetry, or an external session store.
5. Subscription traffic goes directly from Claude Code to Anthropic over an SBX provider egress grant. A QE sampling proxy is **not** used for subscription credentials.
6. QE agrees to the applicable Commercial Terms for hosting Claude Code and retains all built-in authentication methods; the end user's Consumer or Commercial Terms still govern that user's plan.
7. Native and QE controls prove that model-triggered tools cannot read the private credential directory. If that proof fails on an execution backend, subscription mode fails closed on that backend.
8. The adapter verifies `claude auth status` reports `authMethod: "claude.ai"` for a subscription-selected loadout and rejects higher-precedence API/cloud credentials rather than silently changing billing.

This is a constrained engineering go, not a blanket production approval or legal opinion. The implementation plan starts with terms, privacy, and credential-isolation gates. Failure of any mandatory gate changes the deployable posture to **B** (user-owned API/cloud credentials only) until the gate is resolved; it does not authorize a workaround.

The harness must not replace Pi, the accepted Antigravity TUI adapter, or any existing adapter. It must not become a default loadout, alter model discovery for existing harnesses, refactor Herdr, or begin Phase 6.

## Evidence convention and scope

This report keeps claims separated:

- **[DOC]** official Anthropic documentation or official terms.
- **[ARTIFACT]** metadata or bytes from Anthropic's published npm artifact.
- **[SOURCE]** Anthropic's SDK repository at the exact commit below.
- **[INFERENCE]** a QE architectural conclusion from cited evidence.
- **[RECOMMENDATION]** a proposed QE control or implementation choice.

No **[INFERENCE]** or **[RECOMMENDATION]** is represented as Anthropic policy. GitHub issues are not needed for this decision; the current official legal and authentication documentation is more direct and authoritative.

No authentication, provider request, inference, bundled-runtime execution, or authenticated model discovery was performed. Static documentation, package metadata, published types, source, and the merged [feasibility spike](./agent-sdk-feasibility-spike.md) were sufficient.

### Exact material inspected

| Item | Pin or timestamp |
|---|---|
| TypeScript Agent SDK | npm `@anthropic-ai/claude-agent-sdk@0.3.292`; Node `>=18`; repository `main` commit `d4f0435765128047dbe7c99e1fc46e1fbed85357`, committed `2026-10-06T18:59:07Z` [ARTIFACT/SOURCE] |
| npm package archive | SHA-256 `967024d934865047062b5b5ed6e0d613d4454a846e9c71e1ac55ee3c6d57c168`; npm SHA-512 integrity `sha512-C5XI/19uArTg3jjgayN9CSQxJilRciBko007AdPmHXwQqbAzdUldaPUQtDp8Pm6QJg5Aw3jI1G1eIJOBrx4xKQ==` [ARTIFACT] |
| Bundled Claude Code | `2.1.292`; runtime source commit `37832d0b7cad7b40bac7c82dff58629313913edf`; manifest build timestamp `2026-10-06T05:43:35Z` [ARTIFACT] |
| Bundled Linux runtimes | ARM64 SHA-256 `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`; x64 SHA-256 `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3` [ARTIFACT] |
| Anthropic documentation | Live pages fetched on 2026-10-07, with this report's cutoff above [DOC] |
| Commercial Terms | Page effective date `2025-06-17`; page metadata identifies a `2026-03-11` formatting update [DOC] |
| Consumer Terms | Effective date `2025-10-08` [DOC] |

A future implementation must pin the npm archive, wrapper dependencies, immutable execution image, wrapper protocol, and exact platform runtime digest. Package version alone is insufficient provenance.

## Why decision A is supported

Anthropic's legal documentation now answers the ambiguity left by the feasibility spike:

- A product may preinstall or run Claude Code in a hosted sandbox under the Commercial Terms if the binary remains unmodified and built-in authentication methods are not removed, disabled, or restricted. [DOC]
- The host may not pay for, resell, or intermediate Claude usage for end users. Each end user must authenticate with that user's own API key, Claude subscription credentials, or supported third-party provider credentials, and usage is billed directly under that user's provider agreement. [DOC]
- Developers should normally use an API key or supported cloud provider and may not offer their own Claude.ai login, route Free/Pro/Max credentials on users' behalf, or collect/store/intermediate Claude.ai credentials or session tokens. [DOC]
- The same page expressly says this does **not** prevent an end user from signing into the unmodified Claude Code binary with that user's subscription, including when a platform hosts the binary. [DOC]
- Official CLI documentation exposes `claude auth login`, `claude auth logout`, and machine-readable `claude auth status`; container and SSH users may complete Anthropic's browser flow by pasting the returned one-time code into the unmodified CLI. [DOC]
- Official authentication documentation identifies subscription OAuth from `/login` as the default for Free, Pro, Max, Team, and Enterprise users and says the Agent SDK is one of the surfaces wrapping the CLI. [DOC]

**[INFERENCE]** The permitted line is not “an SDK may reuse any subscription token.” It is narrower: QE may host the unmodified Claude Code binary and transport its native login interaction, while Anthropic owns the identity UI and the binary owns token acquisition, refresh, storage, and use. QE must not turn that allowance into a custom OAuth integration or credential broker.

## Authentication and economics

### Provider-path comparison

| Path | Official support | Billing/economics | Credential owner | Operational posture for QE |
|---|---|---|---|---|
| Anthropic Console API key | Agent SDK quickstart accepts `ANTHROPIC_API_KEY`; Claude Code also supports `apiKeyHelper` and API gateways [DOC] | Metered API usage under the key owner's Console agreement; not subscription allowance | End user or customer's organization | Supported optional mode, but prefer external credential injection over a raw key in the agent environment |
| Claude subscription login | `claude auth login`; native credential store; Free/Pro/Max/Team/Enterprise OAuth [DOC] | Uses the user's plan limits. Pro/Max limits assume ordinary individual Claude Code and Agent SDK use; plan, model-family, and weekly/session limits still apply. User-enabled usage credits can add charges under the user's account [DOC] | Individual user or assigned Team/Enterprise seat | **Approved target mode** only through the unmodified native flow and isolated in-SBX storage |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK` plus the AWS credential chain [DOC] | Cloud account is billed per token by AWS [DOC] | User/customer AWS account | Supported in principle; requires region/model mapping, identity policy, cloud egress, and per-user attribution |
| Google Cloud Agent Platform / Vertex path | `CLAUDE_CODE_USE_VERTEX` plus Google credentials/project/location [DOC] | Google Cloud account is billed per token [DOC] | User/customer Google Cloud account | Supported in principle; requires ADC or workload identity, project/location policy, and provider-specific model IDs |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY` plus Azure credentials/deployment [DOC] | Azure Marketplace/provider billing; documented Anthropic-hosted paths use consumption units and provider pricing [DOC] | User/customer Azure account | Supported in principle; deployment identity and model mapping add complexity |
| Claude Platform on AWS | `CLAUDE_CODE_USE_ANTHROPIC_AWS` and AWS/Marketplace configuration [DOC] | Token rates converted to Claude Consumption Units and invoiced through AWS Marketplace [DOC] | User/customer AWS account | Supported enterprise path; not subscription economics |
| Anthropic profile / Workload Identity Federation | Claude Code reads named Console profiles and WIF credentials [DOC] | API/commercial account economics, not a consumer subscription | Customer organization | Strong keyless enterprise option; requires organization identity setup and profile provisioning |
| Claude apps gateway / approved LLM gateway | Claude Code documents corporate gateway sign-in and `ANTHROPIC_BASE_URL` routing [DOC] | Governed by the gateway/provider agreement; may offer attribution and spend controls | Customer organization | Valid enterprise design when the customer operates or authorizes the gateway; not a way to reuse consumer subscription tokens |

### Subscription economics do not become QE economics

**[DOC]** Advertised Pro and Max limits assume ordinary, individual use of Claude Code and the Agent SDK. Subscription limits can be shared across models and surfaces; model-specific and weekly/session limits can stop a Run. Extra usage credits, when enabled by the user or organization, can incur charges. API keys and cloud providers instead use metered provider billing.

**[RECOMMENDATION]** QE must:

- show the selected auth/billing mode before execution;
- never auto-enable usage credits, upgrade a plan, buy capacity, or accept a paid prompt;
- treat SDK `total_cost_usd` as an estimate, not an invoice or proof of subscription charging;
- surface native limit/reset conditions as typed operational/attention states rather than switch credential or model paths;
- never fall back from subscription to an ambient API key, cloud account, or shared QE credential; and
- never pool, meter, surcharge, or resell end-user inference.

### Terms, privacy, and data handling

| User plan | Governing end-user terms identified by Anthropic | Documented data posture relevant to QE |
|---|---|---|
| Free, Pro, Max | Consumer Terms | Model-improvement use follows the user's data-control setting; documented retention is 5 years when enabled and 30 days when disabled [DOC] |
| Team, Enterprise | Commercial Terms | Anthropic says it does not train on code/prompts under commercial terms unless the customer opts in; standard retention is 30 days, with qualified ZDR configurations available [DOC] |
| API and supported third-party providers | Commercial/provider agreement | API/cloud retention, region, and telemetry vary by provider and contract [DOC] |

Hosting still requires QE to agree to Anthropic's Commercial Terms, even when an end user's Pro/Max use is governed by Consumer Terms. QE must also comply with the Usage Policy and trademark restrictions: describe the integration accurately in plain text, do not use Anthropic branding as QE branding, and do not imply endorsement. [DOC]

Disable non-essential traffic and feedback submission in the immutable profile unless a separately approved product feature enables it. Structural QE telemetry must exclude prompts, source contents, auth URLs/codes, credentials, raw API bodies, and tool output by default.

## Authentication UX and credential boundaries

### UX options

| UX option | Policy support | Exposure boundary | Persistence and revocation | User experience | Decision |
|---|---|---|---|---|---|
| U1. Reuse an existing host Claude CLI/Desktop session | Native reuse works only when Claude Code can read the same native credential store [DOC] | Mounting host `~/.claude`, copying `.credentials.json`, or extracting a macOS Keychain item exposes unrelated settings/transcripts and turns QE into a credential copier | Host logout/revocation applies, but guest copies can survive independently | Lowest apparent friction | **Reject.** Host-native credential import is unnecessary and violates the intended SBX and credential boundary |
| U2. Direct native login inside SBX | Explicitly supported for the unmodified hosted binary [DOC] | Anthropic browser page handles identity; one-time callback/code returns to the exact native auth process; token is written by Claude Code under Run-private `CLAUDE_CONFIG_DIR` | Reused only while that private environment state exists; `claude auth logout` revokes/removes it; environment replacement requires login again | Browser sign-in once per retained auth environment; container code flow is documented | **Preferred subscription path** |
| U3. User API-key handoff | Official and recommended for developers [DOC] | Raw environment handoff exposes the key to the Claude process and potentially model-triggered shell inspection | User revokes in Console; QE must delete its grant | Simple but changes economics to API billing | Supported fallback, but raw env injection is not preferred |
| U4. External API credential injection, WIF, or customer gateway | Official secure-deployment and enterprise paths [DOC] | A proxy can inject an API key outside the agent namespace; WIF/cloud identity can avoid static keys | Provider vault/identity controls rotation and revocation | More setup; best enterprise separation | Preferred for API/cloud modes; **not** a subscription-token proxy |
| U5. `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` | Technically documented for CI and scripts [DOC] | Prints a one-year subscription OAuth token for manual copying into another environment | Long-lived token must be tracked and revoked; environment variable outranks native subscription login | Headless-friendly | **Reject for QE.** It creates exactly the copying/storage/intermediation boundary QE does not need |

### Proposed subscription boundary

```text
user browser
    |
    | Anthropic-owned sign-in page and redirect/code
    v
transient no-log QE auth stream  --->  unmodified `claude auth login`
                                        (inside exact Run SBX)
                                                   |
                                                   | writes/refreshes
                                                   v
                          Run-private CLAUDE_CONFIG_DIR/.credentials.json
                          mode 0600; outside workspace; never exported
                                                   |
                                                   | native auth only
                                                   v
                     unmodified Claude Code child -> Anthropic TLS endpoint
                              ^
                              |
                    Agent SDK wrapper in same SBX
                              ^
                              |
             incarnation-fenced QE streamed-process channel
```

The transient auth stream may relay terminal bytes needed by Anthropic's documented container flow, but it must not parse, retain, index, replay, or emit the auth URL, one-time code, redirect, credential, email, or token. The durable `HumanAttention` record contains only “complete Anthropic sign-in” plus a random QE attention ID; sensitive bytes use a separately marked, no-log, expiring channel bound to the exact auth-process epoch. A Worker restart expires an incomplete login attempt rather than replaying auth input.

On Linux, Claude Code documents native credentials at `~/.claude/.credentials.json` with mode `0600`; `CLAUDE_CONFIG_DIR` relocates that file and partitions accounts. [DOC] QE should map it to a per-user/per-Run directory under the environment's private state path, never `paths.workspace` or a host home directory.

### Preventing model access to the native credential

The model-triggered shell normally runs under the Claude Code process's operating-system identity, so file mode `0600` alone is not a sufficient model boundary. The mandatory layered control is:

1. QE outer SBX remains authoritative for host/workspace/network/process isolation.
2. Claude's inner command sandbox is enabled with `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, no excluded commands, a strict command-network allowlist, and `filesystem.denyRead`/`denyWrite` for the auth/config/control state paths. [DOC/RECOMMENDATION]
3. Built-in `Read`, `Glob`, `Grep`, `Edit`, and `Write` receive absolute deny rules for every private state path; `PreToolUse` independently rejects any resolved path outside the authorized workspace. [DOC/RECOMMENDATION]
4. The execution profile denies ptrace, process-memory inspection, `/proc` credential leakage, unsafe Unix sockets, and symlink/hard-link escapes. [RECOMMENDATION]
5. Provider credentials are absent from the wrapper and Claude process environment in subscription mode. [RECOMMENDATION]
6. Canary tests must prove Bash and every enabled file/search tool cannot read, copy, link, print, or exfiltrate a dummy credential at the exact configured path before authenticated testing is allowed. [RECOMMENDATION]

If the inner sandbox is unavailable in a nested execution backend, or any canary succeeds, subscription mode is unavailable there. QE must not compensate with command-string filtering.

### Credential proxy feasibility

- **API key:** yes. Anthropic's secure-deployment guidance documents an external credential-injecting proxy and `ANTHROPIC_BASE_URL`. This can keep a user-owned API key outside the agent namespace. [DOC]
- **Cloud credentials:** yes, through the provider's documented workload identity, instance identity, ADC, or customer gateway patterns, subject to provider policy. [DOC]
- **Subscription OAuth:** no supported credential-provider or token-injection proxy was found. Routing subscription traffic through a QE proxy would expose or intermediate the bearer token, conflicting with the documented boundary. Native direct egress is required. [DOC/INFERENCE]
- **`apiKeyHelper`:** supported for API credentials, but its output reaches Claude Code; it is weaker than an external injecting proxy when the goal is to keep the secret entirely outside the agent namespace. [DOC/INFERENCE]

## In-SBX runtime and process topology

Official hosting documentation says every Agent SDK query spawns and supervises a Claude Code subprocess over stdio. The subprocess owns shell execution, cwd, provider traffic, and local transcripts. SDK callbacks and in-process custom tools execute in the SDK host process. [DOC]

Therefore the SDK host cannot run in the QE Worker merely for convenient credentials or callbacks. The required topology is:

```text
QE Worker / AgentHarness adapter
  `-- incarnation-fenced bidirectional streamed-process transport
        `-- pinned QE Claude wrapper (Bun/Node, inside Run SBX)
              |-- @anthropic-ai/claude-agent-sdk@0.3.292
              |-- in-process QE completion tool and permission/attention callbacks
              `-- bundled, unmodified Claude Code 2.1.292 child
                    `-- sandboxed Bash/file tool subprocesses
```

All child processes, callbacks, custom tools, auth state, transcripts, and provider egress stay inside the exact `EnvironmentLease`. The wrapper receives only opaque credential-grant descriptors and resolved non-secret configuration. It must use an allowlisted environment rather than spread the Worker's or host's `process.env`.

### Generic streamed process versus Claude-specific sidecar

**Preferred infrastructure:** add a generic, incarnation-fenced, long-lived bidirectional process primitive to `ExecutionEnvironmentBackend`, then launch a small Claude-specific wrapper over it.

The generic primitive should provide bounded stdin/stdout/stderr frames, half-close, signal/interrupt, exit observation, process-group ownership, reconnectable epoch identity, backpressure, timeouts, and an optional no-log auth mode. It should not understand Claude, credentials, or harness semantics.

The wrapper is necessarily Claude-specific because the SDK callbacks are in-process, but it need not be a separately deployed daemon. It is an ephemeral command in the Run environment with a narrow, versioned JSON protocol. This gives QE the useful generic infrastructure while keeping provider logic out of `ExecutionEnvironmentBackend`.

A versioned in-SBX sidecar remains an acceptable short-term experiment only if it has the same environment/incarnation fencing and no host execution. Reusing hidden PTY pipes through Herdr is rejected: this is a headless harness, and PTY topology is not semantic authority.

## Mapping to the existing `AgentHarness` seam

### Identity and durable state

| QE value | Claude mapping |
|---|---|
| `harnessKind` | Proposed `claude-agent-sdk` |
| `integrationStrategy` | `structured_headless` |
| `executionId` | Adapter-generated identity for one wrapper/query process epoch |
| `NativeSessionRef` | `identityKind: "id"`, `opaqueId: <session_id>` from Claude's init/result message |
| `HarnessTransportBinding` | Wrapper protocol version, package/runtime/image digests, environment incarnation, process epoch, config identity hash, transcript-store identity, exact tool/model/effort policy digests, and accepted-turn ledger cursor |
| Never persisted in either | Credential/token, auth URL/code, email, raw environment, host/config path, transcript, prompt, tool output, or bare PID as authority |

Claude sessions preserve conversation history, not filesystem state. QE workspace materialization, private Git/checkpointing, and Run environment ownership remain authoritative for code and side effects. `SessionStore` may mirror transcripts later, but it must not become credential storage or workspace recovery.

### Lifecycle mapping

| `AgentHarness` operation | SDK/native mapping | QE rule |
|---|---|---|
| `discover()` | Verify immutable pins; run `claude auth status` without inference; authenticated `startup()`/`supportedModels()` may discover account models later | Report `auth_required` until exact selected auth mode is verified; do not equate installed with authenticated or discovered with entitled |
| `start()` | Launch wrapper and SDK `startup()`/streaming `query()` with exact cwd/config/tools/model/effort | No user prompt until readiness, ownership, control bridge, auth mode, and init assertions pass |
| `ready()` | Validate init `claude_code_version`, cwd, model, tool list, MCP server list, permission mode, settings posture, and session ID | Mismatch is terminal before prompt submission |
| `sendInputAndCollect()` | Send one authorized streaming-input message; consume structured SDK messages and result | Record intent, accepted message/session IDs, model/effort evidence, completion receipt, and result; native “success” alone is insufficient |
| `continue()` | Continue live query or start a new `query({ resume: session_id })` | Revalidate Action/Attempt/lineage/environment/workspace/tool/model/effort authority on every turn |
| `inspect()` | Wrapper/process health, query state, last structured event, pending callbacks, native session | Project native waits into typed `HumanAttention`; never infer state from a terminal screen |
| `interrupt()` | `Query.interrupt()`, then abort/close and exact process-group escalation | Preserve whether the prompt was not submitted, accepted, or ambiguous; interruption does not roll back tool effects |
| `recover()` | Reconnect only to the same live wrapper epoch; otherwise resume the persisted native session in a new process | Transcript resume is a new process/turn and cannot prove an ambiguous prior side effect; never auto-replay a prompt |
| `waitAndCollect()` | Reattach to an exact live wrapper epoch and continue consuming its event ledger | A new process cannot collect an old in-flight result without durable provider evidence |
| `close()` / `retire()` | Close SDK input, wait for child, signal process group, then environment-level stop if needed | QE owns convergence; optional user-requested logout occurs before state destruction, not as an implicit account action |

Initial capabilities remain conservative: structured result, continuation, interrupt, native blocking, structured event observation, and retained-session recovery become true only after deterministic tests. Terminal attachment, conversational takeover, and generic literal input remain false.

## Structured completion and tool policy

### Completion authority

The Agent SDK's official custom-function mechanism is an **in-process SDK MCP server** created with `tool()` and `createSdkMcpServer()`. It runs in the wrapper process, not as a separate MCP daemon. [DOC]

**[RECOMMENDATION]** Use that native mechanism for one `mcp__qe__qe_complete_step` tool because it is superior to parsing assistant text or relying on output-schema completion:

1. The model supplies semantic result fields only.
2. The in-SBX handler sends them to the existing Run-local QE control authority.
3. QE binds authoritative Action/Attempt/lineage/nonce/output context outside model input.
4. The handler waits only for the idempotent semantic acknowledgement and immediately returns a small success/failure tool result.
5. Private-Git export and later orchestration remain outside the tool's latency path.
6. The adapter accepts completion only when the QE acknowledgement ledger and SDK tool/result correlation agree. A normal SDK result without that receipt is not success.

This introduces no separately operated MCP service or general Product MCP dependency. It uses the SDK's documented in-process custom-tool transport because the SDK exposes no equally authoritative non-MCP function callback. `outputFormat` may validate final content but cannot replace control-authority acknowledgement.

### Tool availability and permissions

The initial tool-policy classification is **Exact** for QE semantic capabilities, with native permissions as a second layer.

| QE semantic capability | Claude tool mapping |
|---|---|
| `terminal.shell` | `Bash` |
| workspace read/search | `Read`, `Glob`, `Grep` |
| workspace edit | `Edit`, `Write` |
| structured completion | `mcp__qe__qe_complete_step` |
| clarification | `AskUserQuestion` only when the loadout supports typed HumanAttention |
| Not in an initial profile | `Agent`, workflows, teams, web tools, browser/computer tools, schedules, arbitrary MCP servers, plugins, skills, connectors, artifact publishing, or cross-session messaging |

The adapter must use `tools` for the exact built-in inventory, exact `mcpServers` with `strictMcpConfig`, `settingSources: []`, no plugins/skills/agents, and bare-name `disallowedTools` as defense in depth. `allowedTools` is not an availability list; it only auto-approves matches, so it must never be treated as the exact policy. [DOC]

Every tool call passes a `PreToolUse` hook for universal adapter policy and correlation. `canUseTool` handles calls that native permission evaluation leaves for a human. Do not use `bypassPermissions`, `acceptEdits`, or auto mode. The completion tool may be auto-approved because its handler independently validates QE authority and is idempotent; all other auto-approval is profile-specific and minimized.

Claude's own sandbox and permissions are defense in depth. QE's outer SBX still enforces workspace access, network grants, resources, process ownership, and credentials.

## HumanAttention

### Native mapping

| Claude condition | QE projection | Response path |
|---|---|---|
| Tool permission callback | `needs_permission` / confirmation or choice | Bound `canUseTool` response for exact native request ID |
| `AskUserQuestion` | `needs_input` / choice, text, or multiline | Validate question schema and return answers to the exact callback |
| MCP elicitation | `needs_input`, `needs_confirmation`, or `blocked_external` | Bound `onElicitation` response; unknown modes decline |
| Auth required | `needs_authentication` | Separate transient auth process/channel, never generic agent input |
| Deferred tool | retained `waiting_for_human` | Resume exact session and re-evaluate exact tool-use ID |
| Unknown dialog/notification | `unknown_interactive_block` | Fail closed; do not synthesize terminal keystrokes |

Official guidance allows `canUseTool` to remain pending indefinitely. For longer waits, a `PreToolUse` hook may return `defer`, ending the process with `stop_reason: "tool_deferred"`; resume re-fires the same hook and the pending tool remains in the transcript. There is no defer timeout, subject to transcript retention. [DOC]

Important limitation: `defer` is ignored when the model emits multiple parallel tool calls in one turn because only one call can be resumed. [DOC] Therefore:

- persist every attention request before exposing it;
- make callback responses idempotent by native request/tool-use ID;
- keep the in-SBX wrapper alive across ordinary Worker reconnects;
- use defer for a proven single pending call and treat a deferred result as a retained wait, not completion;
- if the wrapper dies with one or more non-deferred callbacks pending, cancel those QE attention records as stale and fail the turn safely; do not inject the old answer into a different callback or replay the tool; and
- do not advertise durable attention recovery across wrapper loss until provider behavior for every enabled shape is deterministically tested.

The SDK's initialize/reinitialize protocol redelivers pending permission requests after a transport gap and requires idempotence by request ID. [DOC] This supports Worker-to-wrapper reconnection while the same Claude process lives; it does not prove recovery after the whole wrapper/process dies.

## Sessions, cancellation, and recovery

- Claude emits `session_id` in init and result messages. Specific sessions can be resumed or forked after process restart. [DOC]
- Transcripts are local JSONL under the Claude config tree by default. They preserve conversation, not filesystem state. [DOC]
- A `SessionStore` can mirror transcripts across hosts, but writes are best-effort after local writes. A failed append emits `mirror_error` and the query continues; a resumed-from-store run may then have no surviving complete local copy. [DOC]
- Session-store hydration copies credentials/settings from the currently available native config into a temporary config directory; it does not make credentials portable to a new SBX that has none. [DOC]
- `Query.interrupt()` targets a turn; close/abort owns the process. Cancellation does not undo shell, filesystem, network, or completion side effects. [DOC/INFERENCE]

**[RECOMMENDATION]** Maintain a durable QE turn ledger containing prompt intent, environment/process epoch, native acceptance evidence, session ID, message UUIDs, tool-use IDs, completion acknowledgement, result subtype/terminal reason, and side-effect certainty. It contains no prompt/tool content or credentials.

Recovery rules:

1. Reconnect only when the exact environment incarnation and wrapper epoch are still alive and the event sequence is continuous.
2. If the process failed after native acceptance but before an authoritative terminal result, classify the turn `uncertain`; inspect durable transcript/control receipts, but never resend automatically.
3. Resume a native session only against the same validated workspace lineage. Resume continues conversation; it does not restore or roll back files.
4. An environment replacement requires direct reauthentication through Anthropic's flow. Do not restore a subscription credential from QE storage.
5. Treat `mirror_error`, missing transcript entries, model/effort mismatch, stale attention IDs, and completion-ledger disagreement as recovery-integrity failures.
6. On retirement, stop the exact process group and preserve standard QE environment convergence rules. Account logout/revocation is user-controlled and must not be inferred from deleting a local environment.

## Exact model and effort scheduling

### Model

The SDK accepts a model alias or full model name, exposes `supportedModels()` entries with `value`, optional `resolvedModel`, and effort capability, and reports the initialized model plus the model on every assistant API message. Result `modelUsage` is keyed by model. `fallbackModel` is separately configurable and can be omitted. [DOC]

The adapter can fail closed on exact model selection:

1. Discovery admits a loadout only when a current `supportedModels()` row resolves to the required full model ID.
2. Launch passes that full model ID, never `default`, `auto`, or a family alias.
3. `fallbackModel` is absent; environment/settings that can select fallback are scrubbed; `settingSources: []` disables user/project/local settings.
4. Init `model` must match before a user prompt is sent.
5. `PreModelSwitch` denies requested changes; `PostModelSwitch` marks the execution failed for automatic/resume changes.
6. Every assistant `message.model` and every new `modelUsage` key must equal the exact allowed ID. This catches one-turn fallback-chain substitutions that do not emit `PostModelSwitch`.
7. Subagents, workflows, prompt suggestions, and other optional model-using features are disabled. Any unexpected auxiliary model key fails the result.
8. Unsupported/unentitled exact models fail; the adapter never silently chooses another model.

### Effort

The SDK option supports `low`, `medium`, `high`, `xhigh`, and `max`. `ModelInfo.supportedEffortLevels` exposes the accepted levels for a discovered model. Hook inputs expose the effort level actually in effect; official hook documentation says that when a requested level is unsupported or constrained, the hook reports the level Claude Code actually ran. [DOC/ARTIFACT]

The adapter can therefore request and attest exact effort:

1. Require the selected full model's discovery row to list the exact requested effort.
2. Pass `thinking: { type: "adaptive" }` where required and the exact `effort` option; omit legacy numeric thinking controls.
3. Remove ambient effort settings and never mutate effort during a turn.
4. Register in-process `PreToolUse`, `Stop`, and `StopFailure` hooks and compare every present `effort.level` with the requested value.
5. Reject a missing effort attestation for a model/loadout that requires it, and reject any downgrade or change before accepting completion.
6. Reassert the same pair on session resume.

The public app-facing init message does not expose usable effort attestation, so QE cannot prove a downgrade before the first provider call. It can detect the actual level during/at the end of the turn and fail rather than silently accept it. This satisfies fail-closed result semantics but does not erase an already consumed mismatched request. If QE later requires a guarantee that **no request at all** may execute at a downgraded effort, the current SDK surface is a production blocker and that loadout must remain unavailable.

## Policy and operational risk matrix

| Risk | Evidence class | Severity / likelihood | Mandatory control | Residual decision |
|---|---|---|---|---|
| QE presents its own Claude.ai login or handles passwords/session tokens | DOC | Critical / low if design is followed | Launch only unmodified `claude auth login`; Anthropic browser UI; no Product credential form or token API | Block release on any custom OAuth/token handling |
| QE uses `setup-token` or copies host/Desktop credentials | DOC/INFERENCE | Critical / medium | Explicitly reject token import, Keychain extraction, host config mounts, and `CLAUDE_CODE_OAUTH_TOKEN` | Reauthentication after SBX loss is intentional |
| Shared QE account, subscription, API key, or cloud identity | DOC | Critical / low | Per-user credential ownership and provider billing; no pooled fallback | Any shared inference credential blocks the harness |
| QE intermediates subscription bearer traffic | DOC/INFERENCE | Critical / medium | Direct TLS egress from Claude Code; no sampling proxy for subscription mode | Network policy may allowlist destinations but must not terminate provider TLS |
| Ambient API key/cloud variables silently override subscription | DOC | High / medium | Allowlisted environment; selected auth profile; `claude auth status` must report `claude.ai` | Mismatch is `auth_required`/configuration failure, never fallback |
| Model-triggered tools read native credential file | DOC/INFERENCE | Critical / medium | Inner sandbox deny-read, exact path denies, no unsandboxed commands, ptrace/proc controls, canary escape suite | Backend unavailable until all canaries fail to read the secret |
| Credential leaks into workspace, Git, transcript, session store, logs, or telemetry | DOC/INFERENCE | Critical / medium | Private state path, no content telemetry, secret scanners, bounded redaction, no config export | Incident response/revocation required on any leak |
| Hosted-product terms are not accepted or change | DOC | Critical / medium | Human legal/product gate before auth testing; pin effective/access dates; re-review on upgrade | Suspend authenticated mode until approved |
| Binary is modified or built-in auth is restricted | DOC | High / low | Verify published binary digest; no patches; keep native auth capabilities available | Package/runtime mismatch fails startup |
| Subscription use becomes automated account sharing or non-ordinary abuse | DOC | High / low | One user/seat per isolated auth profile; opt-in interactive Runs; rate/limit surfacing; Usage Policy review | No evasion, rotation, or account pooling |
| Extra usage credits create unexpected user charges | DOC | High / medium | Do not enable/approve credits or paid actions; disclose selected mode and native limits | User's pre-existing provider settings remain their responsibility |
| API/cloud mode changes economics | DOC | High / medium | Explicit mode label and consent; provider-owned credential; no silent auth fallback | API/cloud modes are separate loadouts |
| User settings/plugins/MCP expand tools or alter model | DOC | High / medium | `settingSources: []`, exact built-ins/MCP, no plugins/skills/agents, init assertions | Endpoint-managed policy can still apply; mismatch fails closed |
| Permission callback is bypassed by an allow rule/mode | DOC | High / medium | Universal `PreToolUse`; no bypass/auto mode; minimal `allowedTools` | QE SBX remains outer authority |
| Human answer is applied to the wrong callback after restart | DOC/INFERENCE | High / medium | Exact request/tool-use ID, process epoch, expiring response, idempotence, stale cancellation | Wrapper-loss durability remains conservative |
| `defer` is ignored for parallel tool calls | DOC | High / medium | Detect batches; keep callbacks live; fail safely on wrapper loss; do not claim unsupported durability | Durable wait support is capability-gated by tested shape |
| Transcript resume is mistaken for workspace/process recovery | DOC | High / medium | Separate `NativeSessionRef`, workspace lineage, process epoch, and turn ledger | Ambiguous accepted turns never auto-replay |
| Silent model fallback or switch | DOC | High / medium | Full model ID, no fallback, switch hooks, assistant/result model checks | Wrong model consumes a request but cannot yield accepted QE success |
| Silent effort downgrade | DOC | High / medium | Discovery check plus actual hook effort attestation | Wrong effort consumes a request but cannot yield accepted QE success |
| SDK/package auto-update changes policy/runtime | ARTIFACT/SOURCE | High / low | Immutable package/archive/runtime/image pins and explicit upgrade review | No floating semver or startup download |
| Sensitive provider/QE telemetry | DOC | High / medium | Structural metrics only; disable non-essential traffic and feedback; redact auth and content | Provider processing still follows the user's plan/terms |
| Misleading branding or endorsement | DOC | Medium / low | Plain-text factual naming; no Anthropic/Claude logo or partnership implication | Product/legal review of copy |

## Implementation plan for decision A

This plan is additive and opt-in. It does not authorize implementation in this decision spike.

### Stage 0 — human policy gates

1. Record human confirmation that QE's intended hosted-sandbox use agrees to the Commercial Terms, Usage Policy, privacy obligations, and branding constraints cited here.
2. Approve the exact native-login presentation: Anthropic-owned browser flow, transient no-log terminal relay, no custom login form, and no setup-token/import path.
3. Approve data disclosures separately for consumer subscription, commercial subscription, API, and cloud modes.
4. Define the emergency credential-exposure response: stop affected Runs, notify the user, direct native logout/account revocation, and destroy affected private environment state.

No authenticated test proceeds before these gates.

### Stage 1 — generic execution infrastructure

1. Add an `ExecutionEnvironmentBackend` streamed-process primitive with exact environment-incarnation ownership, bounded frames, process-group identity, reconnectable epoch, signal/close/exit semantics, backpressure, and no-log auth mode.
2. Keep the primitive provider-neutral; credential material never crosses its durable descriptors.
3. Add fake-process tests for Worker reconnect, duplicate frames, gap detection, close races, interrupt, stale epochs, process exit, and redaction.
4. Do not route this through Herdr or make a terminal attachment part of the semantic harness handle.

### Stage 2 — immutable in-SBX wrapper, without provider access

1. Package a small Bun/Node wrapper with the exact SDK archive and bundled runtime hashes listed above in an immutable execution profile.
2. Verify package, runtime, wrapper, image, and protocol digests before launch; disable package/runtime downloads.
3. Implement the versioned JSON event protocol against fake Claude subprocess fixtures only.
4. Keep callbacks, custom tools, native process, config, transcript, temp, and cache in environment paths; ensure the Worker cannot accidentally spawn the runtime locally.

### Stage 3 — credential isolation and native auth, still without inference

1. Allocate a private auth/config directory per user and Run lineage, outside the workspace and export paths.
2. Launch `claude auth status` and `claude auth login` as unmodified runtime commands in the SBX; map auth-required state without storing sensitive terminal content.
3. For subscription mode, require `authMethod: "claude.ai"`; reject `oauth_token`, `api_key`, `api_key_helper`, `third_party`, and `none` rather than changing economics.
4. Build the inner sandbox and absolute path-deny policy. Run dummy-secret tests through every enabled tool, shell encoding, symlink/hard-link, `/proc`, child process, and network route.
5. Verify logout/revocation UX and environment-destruction behavior. Never copy a credential to preserve it across environment replacement.

Authentication itself requires a later explicitly approved human test, but this decision work performs none.

### Stage 4 — headless adapter contract

1. Add `claude-agent-sdk` as a new `structured_headless` harness kind behind an opt-in feature/loadout gate.
2. Implement `discover`, `start`, `continue`, `ready`, pre-authorization observation, send/collect, inspect, interrupt, recover, wait/collect, close, and retirement against fake wrapper fixtures.
3. Store only the Claude `session_id` in `NativeSessionRef`; store versioned non-secret transport/process/config policy identities in `HarnessTransportBinding`.
4. Implement the accepted-turn ledger and uncertainty semantics before any provider test.
5. Advertise only capabilities proven by deterministic tests.

### Stage 5 — exact tools, completion, and HumanAttention

1. Resolve each QE semantic tool profile to an exact built-in inventory and exact in-process MCP inventory; assert the SDK init tool/server lists.
2. Implement universal `PreToolUse` enforcement and bound `canUseTool`, `AskUserQuestion`, and elicitation handling.
3. Implement the in-process `qe_complete_step` tool and idempotent Run-local control acknowledgement; reject SDK-only completion.
4. Test Worker restart with a live wrapper, duplicate callback redelivery, stale responses, wrapper loss, deferred single-tool resume, multi-tool defer limitation, cancellation, and completion retries.
5. Keep terminal attachment and conversational takeover disabled.

### Stage 6 — exact model and effort

1. Discover models without inference after approved authentication; admit only full IDs with exact resolved identity and requested effort support.
2. Omit fallback, disable optional auxiliary model features, and assert init/assistant/result/switch evidence.
3. Attest actual effort through hook inputs and reject missing/mismatched evidence.
4. Test all mismatch paths with fake protocol fixtures before one minimal provider acceptance Run.

### Stage 7 — explicitly approved staging acceptance

With a human-owned test subscription and explicit permission to consume a minimal amount of inference:

1. Confirm native login and `auth status` select subscription rather than API/cloud billing.
2. Run one minimal read-only fixture for each approved model/effort pair.
3. Verify exact provider-reported model, actual hook effort, tools, completion acknowledgement, attention, interrupt, transcript resume, usage-limit behavior, and no credential/content leakage.
4. Confirm the user's provider account shows the expected subscription usage path and no QE/provider API credential was used.
5. Stop on any unexpected authentication, billing, model, effort, tool, telemetry, or credential event.

### Stage 8 — opt-in canary and release

1. Enable only for named canary users/backends with per-user auth profiles and a kill switch.
2. Keep all existing adapters and loadouts unchanged; never auto-select this harness.
3. Monitor structural operational metrics, limit/auth failures, model/effort mismatches, credential canaries, and recovery ambiguity without content telemetry.
4. Re-review Anthropic docs/terms and package/runtime integrity on every upgrade.

### Acceptance gates

All are required:

- Commercial Terms/product/privacy approval is recorded.
- Unmodified runtime and every immutable digest verify.
- Subscription login is Anthropic-owned and no credential/token is copied or durably relayed by QE.
- `auth status` proves the explicitly selected auth mode; conflicting credential precedence fails closed.
- Every credential-isolation canary is unreadable and unexfiltratable by every enabled model-triggered tool.
- SDK host and all children execute only inside the exact Run SBX.
- Exact tool inventory, universal permission hook, and outer SBX controls pass.
- `qe_complete_step` is acknowledged by QE control authority and remains idempotent under retries.
- HumanAttention responses are exact-request bound; unsupported restart shapes fail safely.
- Accepted results prove exact model and actual effort, with no silent fallback.
- Accepted-turn recovery never replays ambiguous input.
- Credentials, auth interaction, prompts, source, and tool output are absent from QE logs/telemetry/durable handles.
- Existing harness tests and repository gates pass unchanged.

### Rollback

Disable the opt-in registration/loadout and stop new Claude SDK Runs. Do not touch existing adapters. Let users invoke the unmodified `claude auth logout` in surviving environments when they choose, then destroy the Run-private config/state during normal environment retirement. If an environment is already gone or exposure is suspected, direct the user to Anthropic account-level revocation. Never claim local deletion alone revoked a server credential. Preserve only non-secret audit evidence and the QE workspace according to normal retention policy.

## Residual questions that do not change decision A

1. Has QE's legal entity already agreed to the Commercial Terms version required for hosted Claude Code, or must that occur before Stage 3?
2. Which execution backends can run Claude's inner sandbox with `failIfUnavailable: true` while preserving QE's outer isolation?
3. What is the shortest acceptable lifetime for Run-private auth state before reauthentication becomes too disruptive?
4. Does QE want API/cloud auth in the first canary, or only keep those built-in paths technically available while validating subscription mode?
5. Which exact full model/effort pairs should the first explicitly paid staging acceptance validate?

These are human/product/implementation gates, not permission to guess. None justifies token import, provider inference during this spike, or moving the SDK to the Worker host.

## Sources

Official sources accessed on 2026-10-07:

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Host the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Model configuration](https://code.claude.com/docs/en/agent-sdk/model-config)
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Claude Code costs](https://code.claude.com/docs/en/costs)
- [Data usage](https://code.claude.com/docs/en/data-usage)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [npm package metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/0.3.292)
- [TypeScript SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript/tree/d4f0435765128047dbe7c99e1fc46e1fbed85357)

QE architecture sources:

- [Agent SDK feasibility spike](./agent-sdk-feasibility-spike.md)
- [Harness integration architecture](./harness-integration-architecture.md)
- [Antigravity SBX architecture](./antigravity-sbx.md)
- `workers/bun/src/harnesses/types.ts`
- `workers/bun/src/harnesses/native-session.ts`
- `workers/bun/src/harnesses/transport-binding.ts`
- `workers/bun/src/execution-environment/types.ts`

## Execution statement

This decision spike added documentation only. It did not authenticate to Claude, run `claude auth status` or `claude auth login`, send a provider request, consume inference, execute the bundled Claude Code runtime, register a harness, change a loadout, alter model discovery, modify production infrastructure, refactor Herdr, or begin Phase 6.
