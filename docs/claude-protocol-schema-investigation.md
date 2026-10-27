# Claude 2.1.292 protocol/schema investigation (source only)

Baseline: `bd993e0af714f20e80e977b2da8410da780baf4b` (merged PR #57).
No Claude/SDK runtime execution, account operation, Run, login, model request or
inference is needed or authorized by this document. Sections 1–6 preserve the
original investigation: “current” there means the PR #57 baseline, not the
subsequent implementation. Section 7 documents the separately authorized
production **diagnostic-only** hardening. Readiness behavior remains unchanged.

## Findings

1. QE requests the pinned CLI's **flat, local, non-PTY, newline-delimited
   stream-json print mode**, not JSON single-result, interactive, MCP-server,
   cloud/hosted transport, or a wrapped SDK return-value protocol.
2. The current census exactly covers the installed SDK's **public declared**
   `StdoutMessage`: **16 roots / 28 system subtypes / 5 result subtypes**.
   Static expansion of the same pinned binary's **raw native** `ylo/co` schema
   instead gives **19 roots / 51 system subtypes / 5 result subtypes**.
   The local-stdio `command_lifecycle` schema and producer are source-proven;
   that tag is absent from the public declaration used by the census.
3. That is a concrete **diagnostic schema coverage gap**, not proof of the
   failed Run's unknown object's identity or a cause of the missing init.
4. Native source still supports init on a successfully processed false-query
   path, before its zero-turn result. No invocation/attestation correction that
   would fix this timeout is source-proven. Accepting an unknown/lifecycle frame
   instead of init would be wrong.

## Evidence and version equivalence

Repository citations below refer to this baseline. Vendor evidence was read as
source/data only; no CLI `--help`/`--version`, SDK import/query, bundle import,
extracted-function evaluation, guest execution or retained-state access.

Pinned local Linux ARM64 artifact:

`.pi/tmp/claude-mods-reassessment/packages/linux-arm64/claude`

SHA-256: `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`.
The extracted module headers and init producer identify **2.1.292**. Installed
`workers/bun/node_modules/@anthropic-ai/claude-agent-sdk/package.json` identifies
SDK **0.3.292**, `claudeCodeVersion:2.1.292`; the cached SDK package agrees.
This demonstrates version association, **not completeness of its .d.ts union**.
No current/latest web documentation was substituted.

Verified static module excerpts/index are outside source at:

`/Users/kylec/.qe-investigations/claude-protocol-source-20261025T045154Z-e64f9b6147/`

They are derived from the prior static extraction at
`/Users/kylec/.qe-investigations/claude-attestation-20261021T065529Z-1ddfbeb76d/static/`.
Twelve relevant modules were byte-compared directly against their recorded offsets
in the pinned artifact (without executing it). Minified symbols are module-local:

| Reference | Pinned artifact source / concrete evidence |
|---|---|
| N1 | `segment-0706.js`, CLI option registration and print launch: supported formats, flags, `runHeadless` options |
| N2 | `segment-1705.js`, `fbe` (exported `runHeadless`): local transport setup, verbose stream writer, JSON/text alternatives |
| N3 | `segment-1705.js`, `zF`: absent `sdkUrl` selects `new lue(...)`; remote URL selects `d9` |
| N4 | `segment-1691.js`, class `lue`: `processLine`, `structuredInput`, `write`; `persistsOutboundFrames=false`, local transport |
| N5 | `segment-1503.js`, `cue`: JSON stringify plus U+2028/U+2029 escaping, **no envelope or discriminator renaming** |
| N6 | `segment-1705.js`, `hF`/`yF`: local command-lifecycle forwarder; `IF` installs it before reading input |
| N7 | `segment-1705.js`, `IF`: user-frame intake, first-message initialization, command queue/start gates, UI/control/status emitters |
| N8 | `segment-1705.js`, `Pv.sa`: false-query path still builds/yields init before the `!Ur` zero-turn success branch; `kv` builds init arguments |
| N9 | `segment-0513.js`, `p5e`: actual flat `system/init` producer and version literal |
| N10 | `segment-0414.js`, `Nbr/Mxt/Dxt/m4`, plus `segment-0253.js` `AH`: opt-in stream-json startup failure **result/error_during_execution**, not an untyped generic error object |
| N11 | `segment-0080.js`, `fJ/ylo/co/CF`: raw native stdin/stdout schema; optional initialize; CF explicitly defines command_lifecycle with six fixed states and describes local -p/SDK emission |
| N12 | `segment-0361.js`, `EVt`: system/session_state_changed and private system/task_summary/session_metadata emitters |
| N13 | `segment-0168.js`, `sar`: `{type:"event",data:{type:"control_request",...}}` exists in a **cloud HTTP event** path, not the configured local stdout serializer |
| N14 | `segment-1705.js` Lm.deliver → zm.run → Mp.run/fS forwards shouldQuery into engine submitMessage; `segment-0384.js` Pm checks main-thread agent and !passive, not shouldQuery. False-query is not by itself an unconditional queue exclusion. |

`static-evidence.json` records module binary offsets, hashes, and symbol-relative
UTF-8 offsets; `verified-static/` contains readable excerpts. These hashes identify
static source/artifacts, never native output, payloads or session IDs.

## 1. Invocation, environment and transport

Production path: `ClaudeCodeHarness` obtains separately admitted account/runtime
and Run authority, starts its account mailbox relay, reserves its own session
UUID, then calls `account.lease.spawnStreamed(claudeCodeCommand(...))`.

Sources: `workers/bun/src/harnesses/claude-code/adapter.ts:540-695,835-875`;
`workers/bun/src/execution-environment/provider-account.ts:837-919`.

Fresh argv, with placeholders for Worker-generated identities only:

```text
/opt/qe/claude/claude
-p --input-format stream-json --output-format stream-json --verbose
--restricted --strict-mcp-config --permission-mode dontAsk
--permission-prompts none --model claude-opus-4-6 --effort high
--session-id <Worker-reserved UUID> --tools <comma-joined exact eight QE tools>
```

A durable/continuation launch substitutes `--resume <same owned UUID>` for
`--session-id`; it does not add `--continue`, fork, or select by recency.

Exact tools have prefix `mcp__qe-account-cell__` and suffixes:
`qe_workspace_read`, `qe_workspace_list`, `qe_workspace_write`,
`qe_workspace_edit`, `qe_workspace_search`, `qe_run_shell`, `qe_complete_step`,
`qe_request_human_assistance_and_wait` (`adapter.ts:80-91`).

Account cwd is `/qe/state/claude/empty-cwd`, not the credential-free Run workspace.
The account profile installs the binary, managed settings and immutable QE Mod;
the Run's separate launch-binding `/bin/true` fence is not Claude's executable.

### Exact target environment policy

`provider-auth.ts:163-200` and `provider-account.ts:1825-1851` construct the
allowlist, not a dump of any process environment:

| Names | Configured values |
|---|---|
| `HOME`, `CLAUDE_CONFIG_DIR` | `/qe/state/claude/config` |
| `TMPDIR` | `/qe/state/claude/config/tmp` |
| `PATH`, `LANG`, `BROWSER`, `GIT_TERMINAL_PROMPT` | `/usr/bin:/bin`, `C.UTF-8`, `/bin/false`, `0` |
| `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_FEEDBACK_COMMAND` | `1` |
| `ENABLE_CLAUDEAI_MCP_SERVERS`, `ENABLE_TOOL_SEARCH` | `false` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `CLAUDE_CODE_DISABLE_AGENT_VIEW`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, `CLAUDE_CODE_DISABLE_ARTIFACT`, `CLAUDE_CODE_DISABLE_FAST_MODE` | `1` |
| `QE_ACCOUNT_CELL_MOD_PROTOCOL` | `qe_claude_account_cell_v1` (QE Mod identity, **not vendor stream schema version**) |
| `QE_CLAUDE_MODEL`, `QE_CLAUDE_EFFORT` | `claude-opus-4-6`, `high` |
| `QE_ACCOUNT_CELL_MAILBOX` | Worker-generated account-control mailbox path |
| `QE_ACCOUNT_CELL_BRIDGE_TOKEN` | Fresh control secret; value never read or reproduced here |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | `1` |

The optional `sdkClientApp` addition in the common environment builder is not
passed by this adapter. No remote/hosted entrypoint, `CLAUDE_CODE_REMOTE`, SDK URL,
provider selector, API key, host proxy, or inherited SDK session selector is added.
The SDK-named disable flag is not an SDK query/launch.

`SbxStreamedProcessTransport.open` (`sbx-streamed-process.ts:106-143`) passes
literal argv through `sbx exec -i` **without a TTY** to Python. The relay rebuilds
`target_environment` from the explicit sorted name allowlist, then
`Popen(argv, shell=False, stdin=PIPE, stdout=PIPE, stderr=PIPE, bufsize=0,
cwd=..., env=target_environment)` (`sbx-streamed-process-relay.py:370-424`).
Ambient host/wrapper environment does not become target environment.

Spawn uses 1 MiB output buffering and a 30,000 ms acknowledgement timeout;
readiness keeps its original 30,000 ms post-probe-ACK attestation budget, shared
with applied-state readback. The authorized pre-probe observation wait remains
capped at 3,000 ms, not an output-activity wait or extra attestation budget.

Guest stdout/stderr counters belong to target pipe reads. Binary relay v2 frames
are demultiplexed; only STDOUT data becomes parser bytes
(`sbx-streamed-process.ts:230-246`). READY/ACK/I/O/ownership metadata are not JSON
stdout frames. Stderr is separate, discarded/count-only, not a second parser.

Managed settings (`profiles/qe-claude-account-v2/.../managed/managed-settings.json`)
select the pinned QE/security plugins, managed-only hooks/MCP restrictions, exact
model/high, no model fallback, no remote control/agent view/sideloads. They do not
choose a different output format. `--restricted` explicitly retains managed
policy while ignoring user/project/local settings (N1).

### Input and initialization

`protocol.ts:176-214` writes one LF-terminated user object with:
`type:"user"`, `message:{role:"user",content:<fixed probe>}`,
`parent_tool_use_id:null`, Worker-reserved `session_id`, fresh Worker `uuid`,
`client_composed:true`, `shouldQuery:false`, `isSynthetic:true`.
Expected encoding is 301 bytes; this investigation neither sends nor hashes it.

No SDK `initialize` request precedes the probe. This is **supported**, not a
proven missing handshake: N11 explicitly says initialize is optional and the
first user message initializes defaults. QE does not set `--await-initialize` or
`--await-claim`. Native `IF` handles later initialize controls, but the normal
first-user path is valid (N7). An MCP `initializeResult.protocolVersion` elsewhere
is not the Claude stdout/init version contract.

N8 preserves `shouldQuery` through intake and computes query admission with the
explicit false override. On the normal successful path it yields `us`→`kv`→`p5e`
init **before** the no-query branch yields a success result with `num_turns:0`
and `duration_api_ms:0`, then returns before the model-engine enqueue.
This is conditional flow, not a guarantee of init within 30 seconds: startup,
input admission, session hooks, configuration, MCP/tool/plugin preparation,
context/prompt construction and persistence still contain awaits before init.
A missing init does not locate any one of those waits. N14 additionally traces
the input-to-engine handoff: queueing can emit command_lifecycle before native
first-command/turn-mount/MCP/turn-gate joins, then engine submitMessage carries
shouldQuery. Neither a queued nor a started command alone proves a model turn,
Mod execution, or validated readiness.

## 2. What is actually centralized

There is **no native stdout schema-v2 decoder**:

| Version/contract | Meaning |
|---|---|
| Ownership marker schema **2** | `decodeOwnershipMarkerV2` in `execution-environment/ownership-marker.ts:86`; account/Run ownership and launch paths, not stdout |
| Relay protocol **2** | Worker-owned binary stdio/control transport, not Claude JSON discriminator schema |
| Lifecycle/census schema **1** | Worker-local closed metadata projections |
| Worker Protocol **19** | Product/Worker communication |
| Native version **2.1.292**, SDK **0.3.292** | Vendor version association, not an asserted universal numeric JSON wire version |

The single `pump` (`protocol.ts:99-172`) owns incremental fatal UTF-8 decode,
LF framing, JSON parsing and the 2 MiB buffer bound. It passes the **same parsed
object** to census, lifecycle and the existing frame queue. Partial fragments
are not complete invalid units. No envelope unwrap is performed.

But these predicates are **separate**, not one shared authoritative schema:

- `output-census.ts:233`: closed discriminator-only classification;
- `lifecycle-diagnostics.ts:440`: matching type/subtype/session observation;
- `protocol.ts:217`: wait returns any top-level system/init candidate, then
  adapter validation rejects wrong identity/policy; it also rejects server-tool
  evidence and error results;
- `adapter.ts:878`: exact init validator;
- `effort-readiness.ts`: independent correlated applied-state validation.

The existing AST parity test proves census parity with the SDK **declarations**,
not all native writers, readiness field checks, or synchronization among those
independent predicates. No current literal spelling conflict was found for
system/init; the coverage gap below exists despite the declaration test passing.

### Complete current classification table

Every parsed non-null, non-array JSON object is eligible. Classification does
**not** require valid fields beyond the listed exact discriminator comparisons.

| Root discriminator(s) | Classification requirement | Result |
|---|---|---|
| `active_goal`, `assistant`, `user`, `stream_event`, `auth_status`, `prompt_suggestion`, `rate_limit_event`, `tool_progress`, `tool_use_summary`, `conversation_reset`, `control_request`, `control_response`, `control_cancel_request`, `keep_alive` | Exact case-sensitive root `type` string; no subtype/payload validation | Same reviewed simple category |
| `system` | Exact root type plus one subtype below | `system/<reviewed subtype>` |
| `result` | Exact root type plus one subtype below | `result/<reviewed subtype>` |
| Anything else: missing/null/number/boolean/array/object/new string/case mismatch | No reviewed root match | `unknown` |
| `system`, missing/non-string/unreviewed subtype | Family known, subtype not matched | `system/unknown` |
| `result`, missing/non-string/unreviewed subtype | Family known, subtype not matched | `result/unknown` |

**All 28 recognized system subtypes:** `api_retry`, `background_tasks_changed`,
`commands_changed`, `compact_boundary`, `control_request_progress`,
`elicitation_complete`, `files_persisted`, `hook_progress`, `hook_response`,
`hook_started`, `informational`, `local_command_output`, `memory_recall`,
`mirror_error`, `model_refusal_fallback`, `model_refusal_no_fallback`,
`notification`, `permission_denied`, `plugin_install`, `session_state_changed`,
`status`, `init`, `task_notification`, `task_progress`, `task_started`,
`task_updated`, `thinking_tokens`, `worker_shutting_down`.

**All 5 recognized result subtypes:** `success`, `error_during_execution`,
`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.

Non-object JSON is counted separately then rejected by the production parser;
empty LF units, complete non-JSON, fatal UTF-8, bound errors and incomplete EOF
have separate bounded counters. They are not root unknown object cases.

### Init: classification versus authority

| Consumer | Required facts |
|---|---|
| Census init candidate | Only `type=="system" && subtype=="init"` |
| Census comparisons | Own `session_id` field presence; string equality to Worker-reserved ID; missing is separate, present null/non-string counts mismatch; actual ID never retained/hashed |
| PR #54 matching-init milestone | Exact type/subtype and expected session equality on bound attachment |
| `waitForInit` | Candidate shape only; returns foreign/missing-session candidate for authoritative rejection, not a validated session |
| `attestClaudeInit` | Exact type/subtype, reserved session, version2.1.292, OAuth source, cwd, model, dontAsk, exact sorted eight-tool inventory; mcp_servers/skills arrays empty; exact two QE/security plugins with QE path; optional effort if present must be high |
| Optional checks in current validator | An agents array, if present, must be empty; plugin_errors array, if present, must be empty. Non-array values for those optional fields are not explicitly rejected by these checks. No schema hardening is silently introduced here. |
| PR #55 / final validated lifecycle stage | Fresh correlated successful native get_settings proves applied.model and applied.effort high, in the original remaining post-probe budget; no flag/config/default echo substitution |

Unknown category values, missing/non-string types, new tag spellings and nested
objects are deliberately indistinguishable today within `unknown`. A standard
system with a new subtype **is distinguishable** as `system/unknown`; likewise
result. Version drift and alternate modes are not inferred by these buckets.
An embedded `message.type` or `data.type` is never recursively searched/unwrapped.

## 3. Source-supported output catalog

The **public SDK declared envelope families** are the 16 roots above. The pinned
native **raw stdout schema** (N11 `ylo` → `co` and control/internal members) has
these additional roots: **command_lifecycle, transcript_mirror,
autocompact_state**. The native result subtypes are the same five. Native system
subtypes add these **23** to the census's 28:

`code_change_published`, `vcs_state_changed`, `feedback_draft_queued`,
`ui_invalidate`, `ui_log`, `ui_toast`, `ui_status`, `cloud_session_delta`,
`dev_intent`, `session_title_changed`, `turn_handoff_available`, `turn_preempted`,
`peer_message_hold`, `per_turn_effort_changed`, `permission_check_status`,
`ui_panes`, `ui_scroll`, `ui_focus`, `instruction_size_warning`,
`file_attachments_missing`, `post_turn_summary`, `task_summary`, `session_metadata`.

An AST-only expansion is saved as `native-output-catalog.json` (74 schema leaves,
including the two user variants; 73 distinct type/subtype combinations). It does
not execute the vendor Zod builders. Each row records its literal discriminator
schemas and field names; descriptions/producer conditions remain the authority
for mode applicability. This is a **raw CLI vs public SDK declaration gap**, not
unproven version drift. Among the three extra roots, command_lifecycle has a
verified local path under QE flags; the other two need modes not configured here.

Payload fields can be open/variable, especially control responses. Even the raw
schema is not an exhaustive runtime enforcement mechanism: N4 only *samples*
schema checks for telemetry and does not gate writes on schema validity.

| Phase / shape | Concrete source and applicable conditions | Current census |
|---|---|---|
| Local command lifecycle `{type:"command_lifecycle",command_uuid,state,uuid,session_id}` | N6: yF installs hF for **non-d9 local transport** before intake; callback enqueues each lifecycle state. No model turn required to report command intake/admission. QE supplies a command UUID. | **root unknown**; concrete gap |
| Flat init `{type:"system",subtype:"init",...}` | N8/N9: successful input/start path, including shouldQuery:false; native may perform pre-init work first | system/init, conditional session aggregate |
| Zero-query result `{type:"result",subtype:"success",is_error:false,num_turns:0,...}` | N8: after init when effective query admission false | result/success; not init |
| Control request `{type:"control_request",request_id,request:{subtype,...}}` | N4 sendRequest and N11; loop→client RPCs, potentially during startup/control work; not each request implies a query | control_request |
| Control response `{type:"control_response",response:{subtype:"success"|"error",request_id,...}}` | N11; N7 control handling; N10's common pre/CH constructors | control_response; nested subtype not classified |
| Cancellation / heartbeat | N4 enqueueCancelRequest; N7 keep-alive machinery; N11 | control_cancel_request / keep_alive |
| System status, hook/plugin/MCP/permission/task messages | N7 (including direct plugin_install), N9, N12, plus pinned SDKMessage declarations | reviewed system subtype or system/unknown |
| Startup failure result with optional startup_failure_reason/result_index | N10: configured env switch and print/stream-json gate; AH constructs result/error_during_execution, zero turns | **recognized result/error_during_execution**, not root unknown |
| User/assistant/stream/result traffic | Pinned SDKMessage declarations and N8 query/no-query generator; echo requires replay option, assistant/model traffic is not authorized here | reviewed respective root |
| Private `system/ui_status`, `ui_log`, `ui_toast`, `ui_invalidate`, `ui_panes`, `ui_scroll`, `ui_focus`, `peer_message_hold`, `task_summary`, `session_metadata` | Explicit N7/N12 producers, gated by surfaces/hooks/metadata/peer conditions. Existence does not establish a trigger in QE. | **system/unknown**, cannot by itself explain root unknown |
| Other private system labels anticipated by native bF filter | N2/N6 filter also names feedback_draft_queued, post_turn_summary, code_change_published, tool_host_result, permission_check_status, vcs_state_changed, dev_intent, session_title_changed, turn_preempted, per_turn_effort_changed, instruction_size_warning, file_attachments_missing. A filter reference alone is not proof a producer ran/reachable here. | system/unknown if emitted |
| `{type:"transcript_mirror",filePath,entries}` | N1/N7: **sessionMirror** flag/SDK session-store mode; QE does not set it | root unknown, but this mode not configured |
| `{type:"autocompact_state",value,...}` | N7 Ly installation under **CLAUDE_CODE_REMOTE**; unset in QE target allowlist | root unknown, but this branch not configured |
| `{type:"event",data:{type:"control_request",...}}` | N13 cloud HTTP send path, not N3/N4 local stdout | root unknown if wrongly fed to QE parser; no local wrapping evidence |
| `{ok,session_id,url,...}` / text cloud CLI output | N1 cloud-session create/send commands, with their own format restrictions | missing-type root unknown if received, but no such command/flag is configured |

This catalog separates declared envelopes, verified producers, filter-only
references, and other-mode shapes. It does not pretend static inspection can
enumerate every dynamically generated payload, plugin behavior or reachable
state in the entire executable. It is sufficient to disprove the assumption
that declared SDK discriminators exhaust pinned local native stdout.

The native local enqueue/verbose print writer/serializer path (N2/N4/N5)
preserves root field names and adds LF;
it does not turn system/init into a nested/missing/non-string tag. Input nested
user-message repair exists only in a **remote input** branch (N4), not as a
local stdout envelope or readiness decoder feature.

## 4. Mismatch matrix and evidence limits

PR #57 facts supplied for this investigation: baseline0, post198, timeout198;
one complete valid JSON object classified root unknown; no known system/result
or init/non-JSON observations. The actual unknown value/presence was not kept.
No new runtime observation was made, nor was the observed object's size/content
reconstructed or attributed to the 198-byte relay total or synthetic encodings.

| Explanation | Source-supported status | Relation to recorded facts |
|---|---|---|
| Legitimate local private command_lifecycle omitted by census | **Established possible family**, N6; same pinned version, not latest-doc speculation | Compatible with root unknown; **NOT identified as the actual object** |
| SDK .d.ts/native implementation coverage mismatch | **Proven** by N6 versus StdoutMessage and passing AST parity test | Explains why a valid native object can be unknown; does not explain missing init |
| Missing/non-string/unreviewed root discriminator | Current classifier demonstrably collapses all three | Indistinguishable retrospectively; no particular one source-proven as runtime cause |
| Startup/admission/configuration/hooks/MCP/prompt/persistence wait before init | Source contains awaits before N8's init | Genuinely possible location space, no causal attribution or native-state proof |
| Native command queued/held/refused/cancelled/discarded rather than reaching init | N6/N11 lifecycle/admission branches and documented state meanings | Source-supported diagnostic branches; neither root nor state was observed, so no policy-refusal or queue-state conclusion |
| Ordinary system/init with wrong/missing session | Would count system/init plus mismatch/missing | **Not an explanation of the sole root-unknown unit** if unchanged parser received that shape |
| Init optional effort omitted | Native kv legitimately omits optional effort; PR #55 readback handles it | Not root unknown and not this timeout's demonstrated cause |
| New system/result subtype or ordinary startup result error | Would be system/unknown, result/unknown, or known error result | Not sole root unknown under current classifier |
| Missing mandatory SDK initialize negotiation | N11 permits first user defaults; await-initialize/await-claim absent | **Not a source-proven configuration defect**; adding a new handshake unjustified |
| Stdin must reach EOF before native can process the probe | N4 incrementally yields complete input lines while stdin stays open; N7 consumes them bidirectionally | **Not supported**; closing stdin as a remedy would alter the intended session/control channel |
| Text / single-result JSON / remote SDK / cloud / MCP-server mode requested | Exact argv, env isolation, N1-N5 select local verbose stream-json | **Ruled out as configured modes**; no claim about hypothetical vendor corruption |
| Normal QE relay envelope/ownership schema accidentally treated as Claude | Counters are target stdout only; control frames demuxed; marker v2 separate | Not supported by configured data path; no ordinary envelope transformation found |
| Vendor/declaration version mismatch | Binary SHA/version and SDK metadata agree | No source evidence of version drift; same-version coverage gap remains real |
| Native Mod loaded / query parsed / init constructed from drainage/census | No owning positive milestone in these observations | **Unknown**, not established by source compatibility or missing evidence |

Root cause remains unproven. No alternative object may satisfy readiness. The
Worker-reserved UUID stays a reservation until validated native ownership/init
and all existing model/effort/policy gates pass.

## 5. Smallest proposed correction / next diagnostic (not implemented)

### Proven correction: diagnostic coverage, not a readiness workaround

Review and add **command_lifecycle as a fixed diagnostic-only native-private
category**, with a pinned-source synthetic fixture. Update the declaration-only
parity test to check the public catalog separately from a source-reviewed raw
native catalog; merely appending the tag to the current array would break that
existing test without fixing its incomplete authority assumption. Do not broaden from arbitrary
observed strings. Distinguish SDK-declared from reviewed native-private catalog
entries. Mode-gated mirror/remote/UI families can be documented/added separately;
there is no reason to enable those modes for acceptance.

Current native unknown objects are already forwarded unchanged to waitForInit;
classification did not consume the missing init. Therefore this correction
improves diagnosis only and is **not a source-proven timeout fix**. No argv,
30-second budget, init acceptance, effort proof, profile/Mod or ownership change
is proposed as a remedy.

### Minimum additional content-safe distinction

If another diagnostic is separately approved, at the existing pump callback:

- Count **own type presence and JSON kind** using only fixed kinds:
  missing/null/string/number/boolean/array/object.
- For system/result, analogously count subtype presence/kind and reviewed value
  bucket; do not store unknown strings or string hashes/length samples.
- Add the source-reviewed command_lifecycle category. If needed, separately
  review a finite lifecycle-state allowlist (unknown fallback) and a boolean
  comparison of command_uuid to the **already Worker-owned probe UUID**.
  Never retain/hash the native UUID, event UUID or native session ID. Lifecycle
  state is not itself a model turn, Mod execution, init or readiness success.
- Keep counts/timestamps bounded, Worker-local, best-effort/non-authoritative,
  same attachment/session fences and original diagnostic/attestation bounds.

The pinned native CF schema fixes lifecycle states to `queued`, `started`,
`completed`, `cancelled`, `discarded`, `refused`; new values must still collapse
to unknown. In particular, these states describe command fate, not necessarily
a model turn or result delivery.

These additions distinguish missing/non-string/other-string/private-reviewed
cases without needing a raw discriminator. No general recursive parser or
key enumeration should be added. A nested-envelope probe, if later justified,
would inspect only separately reviewed fixed paths and produce structural
booleans, never unwrap into readiness or infer a mode. There is no supported
local stdout envelope requiring it now.

For centralization, design a **single ephemeral structural decoder** used by
census, matching-init observation, waitForInit and the validator's tag guard.
It should expose a safe metadata projection separately from the transient raw
object. Share exact type/subtype predicates and a reviewed catalog; retain
independent full native attestation and applied-state checks. Do not create a
second JSON parser, serialize the raw object, or confuse transport/ownership
version2 with this contract. Tests must enforce parity across consumers.

Another execution would be necessary to determine which unknown subcase occurred
in a *future* Run; no source-only inspection can recover the discarded historical
value. **No Run, diagnostic deployment, source behavior change, tracing, login or
paid inference is authorized by this investigation.** Raw discriminator retention
is not necessary for the proposed distinctions and is not proposed.

## 6. Deterministic tests and files

New `workers/bun/test/claude-protocol-schema-audit.test.ts` uses synthetic objects
through the real pump, census, queue, init waiter and production init validator:
known init/non-init/result/control tags; missing/non-string/new/case-different
root/subtype; all three extra native roots and all 23 extra system subtypes; negative
nested/enveloped input-to-parser shapes; session present/match/mismatch/missing;
matching tags without required policy; canary discard; pure argv/env builder.
All six native lifecycle states are covered. Bare census snapshots carry no
frameValidated flag: the enclosing lifecycle projection adds it only from
protocol_frame_validated. The census snapshot boolean means observer registered,
not validation. Classification cannot supply that milestone. These tests execute
no vendor code, native process, SDK or environment lease.

Existing tests identified: `claude-output-census-schema.test.ts` (declared union
parity), `claude-output-structure.test.ts` (fragmentation, bounds, canaries and
fail-open diagnostics), `claude-code-protocol.test.ts` (serialization/parser/init),
`harness-lifecycle-diagnostics.test.ts`, and PR #55 effort/readiness regressions.
No live/SBX or query-enabled boundary test is appropriate for this task.

### Validation

- **104 passed / 0 failed**, 424 expectations across the five explicitly listed
  synthetic/static test files (6.64 s). No full/live suite or query-enabled
  request-boundary test was run; no live opt-in was enabled.
- Worker TypeScript `tsc --noEmit`: passed.
- Biome: 248 files checked, passed; the new test was formatted.
- `git diff --check`: passed.
- A newly added fixture assertion initially assumed the bare census snapshot
  had the enclosing lifecycle's frameValidated property. Corrected to assert
  its absence and observer-registration semantics; the synthetic failure log
  is retained as `focused-census-projection-assumption.log`. No production
  behavior was changed to satisfy a test.

Only this document and the new synthetic test are repository changes, uncommitted.
Production source, immutable artifacts, timeout, readiness and all runtime state
are untouched. Static extraction/index/catalog scripts, verified source excerpts
and validation logs live only in the investigation directory, outside source.

## 7. Implemented diagnostic hardening (separate authorization)

The historical coverage gap above is now addressed by `output-tags.ts`, not by
changing native invocation or treating a different message as init.

- **Public SDK schema:** unchanged 16 roots / 28 system subtypes / 5 result
  subtypes, independently locked by the declaration-only AST parity test.
- **Pinned raw-native schema:** those public tags plus three native-private
  roots and 23 system subtypes, centrally source-reviewed. No private result
  subtype is established. Membership is not full frame validation.
- **Current-QE source reachability:** command_lifecycle has a local-stdio path;
  transcript_mirror requires an unconfigured mirror mode; autocompact_state
  requires an unconfigured remote branch. Private system-subtype producer
  conditions are not generally established. Catalog metadata preserves these
  distinctions; no mode is enabled by recognizing its tag.
- **Structural classification:** one pure already-parsed-JSON decoder provides
  missing/non-string/public/private/unknown root and system/result subtype
  interpretation. It returns only reviewed literals/kinds, never raw values,
  IDs, payload references or recursively unwrapped objects.
- **Full readiness:** census, lifecycle observer, init waiter, adapter and effort
  readback consume the shared decoder. Only system/init is a candidate; unchanged
  init policy/session checks and subsequent correlated applied-model/high proof
  must still pass. Collection's assistant/result guards use the same decoder.
  Nested RPC success/request_id/settings validation deliberately remains in the
  authoritative readback validator, not the structural tag decoder.

`outputCensus.structure` adds fixed root/subtype and JSON-kind counts.
`commandLifecycle` adds total, six reviewed states, unknown_or_malformed, and
comparison-only probe match/mismatch/missing_or_invalid/unavailable aggregates.
There are 79 possible categories and 60 capped aggregate counters, with unchanged
best-effort/coalesced Worker-local persistence, attachment fences and overflow
semantics. Old rows are not rewritten; absent new fields mean missing evidence.

Recognizing this family does not establish that PR #57's historical unknown object was command_lifecycle and does not explain the missing system/init.

The owned probe UUID is generated at the existing serializer, bound immutably to
its observed attachment before the write, and kept only in a private runtime
field. Native command_uuid is shape-checked/compared transiently and discarded.
Future probe-write-request events no longer persist their command operationId;
no native UUID/session/extra field, arbitrary state/discriminator, identifier hash
or raw JSON is retained. Other existing independent Worker receipt IDs remain.
Neither a matching probe comparison nor any lifecycle state changes native
parsing/Mod claims, frameValidated, session authority, model/effort proof or
execution state. There is no additional await, activity wait, fallback or retry.
The 30,000 ms budget, fixed probe bytes and pinned artifacts are unchanged.

The original investigation test file is incorporated, not discarded: its
synthetic native-private fixtures now assert reviewed diagnostic categories and
unchanged rejection as readiness substitutes. Additional decoder/privacy/bounds
and full fake-harness tests exercise every private family alone and followed by
separate legitimate init plus applied-state proof. All execution and persistence
in these tests is synthetic/fixture-local. No live Phase E run is authorized.

Implementation validation: **330 passed / 0 failed**, 10,024 expectations across
8 explicitly selected local unit/static files; TypeScript and Biome (250 files)
passed, as did whitespace checks. The source audit verified 1,450 protected files
unchanged and 18 function/check comparisons, including the unchanged preparation
body/budget, invocation builder, identity fences and non-tag init/applied-response
checks. Initial compiler typing/lint issues and an audit-script normalization
issue were corrected locally; no native/live proof was attempted. Validation
scripts/logs and the PR draft are outside source under
`/Users/kylec/.qe-investigations/claude-native-structure-20261025T062311Z/`.
