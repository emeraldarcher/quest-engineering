# Safe Claude output-structure diagnostics

These Worker-local diagnostics resolve **observation windows and output structure**,
not native semantics. They neither authorize Claude execution nor establish paid
readiness. Authentication, environment ownership, broker admission, HarnessControl,
[positive lifecycle evidence](managed-harness-lifecycle-diagnostics.md),
[applied-effort readiness](claude-effort-readiness.md), and the
[generic I/O primitive](streamed-process-io-diagnostics.md) retain their authority.

## One pre-probe baseline

For the fixed zero-query probe, `sendMessage` invokes
`ManagedHarnessLifecycle.capturePreProbeIo` after stream-observer registration
and before `probe_write_requested`. It awaits one existing `observeIo()` operation,
not output activity. There are no sleeps, activity waits, retries or fallback
inspection. The whole pre-probe diagnostic has the existing **3,000 ms bound**,
including namespace validation. Unsupported, throwing, hung or lost observations
cannot reject/suppress the probe; an expired baseline is typed `unavailable` and
late results cannot overwrite it or masquerade as pre-probe measurements.

This is an explicitly bounded **pre-probe** diagnostic wait, not a second
attestation budget. The original **30,000 ms post-ACK** budget, its shared native
`get_settings` readback, frame validation, ordinary cancellation and later
fire-and-forget I/O checkpoints remain unchanged. Cancellation never waits for
this collection. Only the dedicated bounded method can own `before_probe_write`.

An available lifecycle baseline records actual guest observation and Worker request
timestamps (the generic primitive also carries Worker receipt time),
stdin unread observation (or its typed unavailability), and cumulative relay-read
stdout/stderr totals. The existing asynchronous post-ACK snapshot records its own
actual observation time, **not the exact ACK instant**. Worker and guest clocks
remain separate domains. Neither observation is an exact child emission time;
bytes can arrive after the baseline and before the actual write.

`probeIoDelta` subtracts available pre-probe totals from available post-ACK totals:

- positive: additional bytes reached the relay between those observations;
- zero: no additional relay-read bytes between those observations;
- unavailable endpoint or counter/elapsed regression: typed unavailable, never 0.

No causal claim ("the probe produced these bytes") follows. Buffered bytes may
have been emitted earlier. A future fresh diagnostic preparation can distinguish
its own pre-existing activity from additional observed activity, when snapshots
are available. It cannot retroactively timestamp the historical 198 bytes.

## Closed census at the existing stdout parser

`pump` still decodes UTF-8 incrementally and parses exactly one JSON unit per LF,
with its existing 2 MiB buffer and 64-frame attestation bounds. A best-effort
callback projects structure at those **same** production boundaries, before
normal frame forwarding. An observer exception cannot drop a frame, change its
validation/error, or replace readiness. No new stderr parser is introduced;
stderr remains byte totals and discard, never retained content.

`output-tags.ts::decodeClaudeOutputTag` is the shared, pure structural decoder
for already-parsed JSON. Census, lifecycle observation, init waiting/validation,
collection and applied-state readback all use it. It returns only reviewed
literals and JSON kinds, never arbitrary strings, payload references or IDs.
It does not unwrap envelopes, validate payloads or establish readiness.

Public schema membership, raw-native membership and invocation reachability are
separate. The public catalog below is pinned to SDK **0.3.292**, Claude Code
**2.1.292**. The declaration AST parity test locks only that public subset;
it never imports SDK runtime or claims to exhaust raw native stdout. The
[source investigation](claude-protocol-schema-investigation.md) records the
pinned raw schema review. Catalogs are closed source constants, not runtime
reflection or values learned from native/provider output:

- 14 simple top-level tags: `active_goal`, `assistant`, `user`, `stream_event`,
  `auth_status`, `prompt_suggestion`, `rate_limit_event`, `tool_progress`,
  `tool_use_summary`, `conversation_reset`, `control_request`, `control_response`,
  `control_cancel_request`, `keep_alive`;
- `system` with 28 reviewed subtypes: `api_retry`, `background_tasks_changed`,
  `commands_changed`, `compact_boundary`, `control_request_progress`,
  `elicitation_complete`, `files_persisted`, `hook_progress`, `hook_response`,
  `hook_started`, `informational`, `local_command_output`, `memory_recall`,
  `mirror_error`, `model_refusal_fallback`, `model_refusal_no_fallback`,
  `notification`, `permission_denied`, `plugin_install`, `session_state_changed`,
  `status`, `init`, `task_notification`, `task_progress`, `task_started`,
  `task_updated`, `thinking_tokens`, `worker_shutting_down`;
- `result` with `success`, `error_during_execution`, `error_max_turns`,
  `error_max_budget_usd`, `error_max_structured_output_retries`.

The additional reviewed **raw-native** catalog has three private roots:

| Root | Current QE invocation status (source, not runtime evidence) |
|---|---|
| `command_lifecycle` | Local-stdio source-supported |
| `transcript_mirror` | Session-mirror mode not configured |
| `autocompact_state` | Remote-mode branch not configured |

The 23 additional system subtypes are `code_change_published`, `vcs_state_changed`,
`feedback_draft_queued`, `ui_invalidate`, `ui_log`, `ui_toast`, `ui_status`,
`cloud_session_delta`, `dev_intent`, `session_title_changed`, `turn_handoff_available`,
`turn_preempted`, `peer_message_hold`, `per_turn_effort_changed`,
`permission_check_status`, `ui_panes`, `ui_scroll`, `ui_focus`,
`instruction_size_warning`, `file_attachments_missing`, `post_turn_summary`,
`task_summary`, `session_metadata`. Their individual producer conditions under QE
are not established by schema membership. No additional private result subtype
is source-established. Native modes are **not enabled** by classification.

Thus the reviewed raw catalog has 19 roots / 51 system subtypes / 5 result
subtypes versus the public 16 / 28 / 5. Recognition does not validate the rest of
an object, prove origin/version, establish Product support, or grant readiness.
For example, system/private-subtype has a public **root** but a private **subtype**;
it is not thereby a public-SDK message.

`structure.roots` distinguishes non-object, missing type, non-string type, known
public root, known private root and unreviewed string root. `nonObjectKinds` and
`nonStringTypeKinds` split null/boolean/number/string/array/object; `not_json` is a
defensive kind for non-JSON direct callers, never a JSON.parse result.
`systemSubtypes` and `resultSubtypes` separately count missing, non-string,
known public, known private and unknown-string subtype cases. Decoder tags
also report the non-string subtype's kind. Neither unknown strings nor their
hashes/lengths/fragments are retained. Fixed fallback categories remain
`unknown`, `system/unknown`, `result/unknown`; the new aggregates disambiguate
those without rewriting old evidence.

The census retains counts and first/last **Worker observer** timestamps per fixed
category. It includes all complete units: JSON objects, non-object JSON, empty LF
units and complete non-JSON units. Non-JSON retains only unit count and decoded
UTF-8 size including LF; this is labeled separately from raw relay byte totals
(the decoder may strip a BOM). The same original parser still fails malformed
JSON/objects. No prose regex or permissive alternate parser is added.

Fragments do not become invalid units before LF. Incomplete EOF, fatal UTF-8 and
buffer-limit failures have separate fixed counts; an EOF tail is **not** a
complete non-JSON unit. The original framing/error behavior is preserved.

For `system/init` candidates, counters encode presence of the own `session_id`
field, equality with the Worker-reserved session, mismatch or absence. Present
non-string/null values count as present but not matching. The actual native
session ID is **never persisted or hashed**, matching or not. The existing
Worker-reserved identity already belongs to the lifecycle context. No native
protocol-version field is invented. `frameValidated` reflects only the existing
Worker validator's progress event; census observations cannot set it. A foreign
init is classified but cannot become the required matching/validated init.

## Diagnostic-only command lifecycle and probe comparison

`command_lifecycle` has its own fixed category. `commandLifecycle.total` and
`states` count queued/started/completed/cancelled/discarded/refused plus
unknown_or_malformed. State counts describe reported command fate, not a model
turn, Mod execution, delivered result or validated init. They cannot advance any
lifecycle progress stage or session/execution state.

Recognizing this family does not establish that PR #57's historical unknown object was command_lifecycle and does not explain the missing system/init.

Probe correlation uses the Worker-owned UUID on the exact outbound false-query
command. When enabled, the separate operation-owned cancellation capability
assigns that fresh UUID before `sendMessage` serializes it. The recorder's
binding remains independent and comparison-only. `bindProbeCommand` accepts it once, before the write request,
only for the exact bound/observed process and reserved Worker session; timeout,
exit, foreign identity, late binding or rebinding cannot install it. It is held
in an ECMAScript private field, never in a snapshot, log, row or identifier hash.
New `probe_write_requested` events omit their formerly recorded command
operationId; historical events are not rewritten. ACK/cancellation receipt IDs
remain independent existing Worker-owned operation evidence.

Only `match`, `mismatch`, `missing_or_invalid`, `unavailable` aggregates escape
an ephemeral native command_uuid comparison. Invalid means unsuitable for
comparison with the Worker's canonical v4 UUID, **not rejection of the native
message**. A valid ID without a bound probe counts unavailable, never mismatch.
No command_uuid, event uuid, native session_id, state prose, extra fields or
identifier hash is copied. Existing reserved-session context is Worker-owned,
not copied from this family. State and correlation counts are separate
aggregates, not a per-command timeline. Neither side's probe identifier enters
new diagnostic artifacts. Correlation failure cannot suppress a write, add a
wait, affect cancellation or contribute to native/session/readiness authority.

The separate [timeout queue-membership diagnostic](claude-timeout-queue-diagnostic.md)
is attempted only after the original init deadline fails. Its native control
reply is observed transiently and consumed outside the readiness frame queue;
the census can still count its reviewed `control_response` structure. Its
bounded boolean result cannot identify a pre-start join or validate readiness.
It uses a distinct operation capability, never the comparison-only binding.
It does not change this census's catalog, bounds, framing, or authority.

## Bounds, fences and persistence

One census belongs to one existing preparation/context and bound attachment:
full EnvironmentRef/typed owner/profile/incarnation, process generation, PID,
start identity, requested/observed executable identity and device:inode, plus
Worker-reserved session. Foreign attachments cannot accumulate into it.

There are at most **79 fixed category buckets**, **60 fixed aggregate counters**
(18 existing, 30 structure, 12 command-lifecycle/correlation), and
first/last timestamps. Counts are bounded at **2,147,483,647**; overflow becomes
fixed `unavailable:counter_overflow`, not a wrapped/default count. Observer
failure is a fixed category. No payload object/string is retained by the census.
One pending `setImmediate` coalesces persistence; there is no per-frame row,
unbounded event log, monitor, output file, payload hash, snippet or sample.

The existing `managed_harness_lifecycle.evidence_json` carries `outputCensus`,
`probeIoDelta` and at most four I/O checkpoints. This hardening adds only fixed
`structure`/`commandLifecycle` aggregates and reviewed categories to the census. There is no DDL,
new database/table, migration, Product field/API, Worker Protocol change or
relay-control change for the census itself. The timeout diagnostic separately
adds a feature-advertised nonblocking submission on relay v2. Historical rows
are not rewritten; absent new
fields mean missing evidence, not zero output. Read retained SQLite directly in
read-only mode, never by constructing a stateful runtime/session manager.

Missing census is not no output; zero complete units is not zero native bytes;
unknown is not nonexecution. Census does not establish native probe parsing,
false-query recognition, Mod execution, init construction/submission, exact
emission time, liveness, or root cause. Timeout progress remains frozen. Sink
loss cannot fail valid readiness. No auth, effort, tool-policy or admission gate
reads census or I/O values.

No profile, Mod, settings, bridge, binary/SDK/image pin, immutable artifact,
auth/environment policy or retained environment changes. This is a Worker-only
artifact change; it authorizes no native execution, login, provider traffic,
inference, cleanup, retry or tracing.

## Deterministic implementation validation

`claude-output-tags.test.ts` covers all reviewed public/private tags, malformed
root/subtype kinds, modes, fixed bounds, overflow, canaries and consumer AST
checks against copied predicates. The investigation's synthetic audit fixtures
are retained with diagnostic-only recognition expectations updated. Parser and
lifecycle/SQLite tests prove probe IDs/canaries do not serialize, binding is
fenced/immutable, unavailable remains distinct, and diagnostic loss is fail-open.
Full fake-lease harness tests cover every private root/system subtype both alone
(no init validation, ready handle/session authority or applied-state request)
and followed by separate legitimate init plus applied-model/high proof.

Only explicitly selected local unit/static tests are authorized for this
implementation. No Claude/SDK/SBX execution, provider request, Product Run,
login, reconciliation, live test or model inference is authorized.

## Historical provider-free physical validation (not rerun by this change)

`QE_LIVE_SBX=1 bun test test/claude-output-structure-sbx-live.test.ts` creates one
new credential-free, deny-all-network broker-Run-profile infrastructure fixture
and only Python targets. Its client refuses old-environment exec, credentials,
stop and remove. `QE_OUTPUT_STRUCTURE_PROOF_ROOT` puts evidence outside source.

Nine targets cover 198→198 startup output (delta 0), 0→198 post-probe output,
matching and mismatching init with the unchanged production init validator,
other reviewed frames, unknown-discriminator canaries, complete non-JSON,
fragmented JSON/split UTF-8, and JSON/stderr canaries. Fixture-only FIFO/socket
rendezvous and controlled receipt return make observation windows deterministic;
a non-JSON parser gate permits a byte snapshot before the unchanged failure.
Production does not gain those fixture activity waits/gates. All counters and
frames still traverse real `EnvironmentLease.spawnStreamed`, relay, I/O primitive,
parser and census. Every file in the owned diagnostic/proof directory, including
SQLite files, is searched for canaries without hashing them.

Synthetic init validation is not real Claude, applied native effort, production
Run readiness or a paid candidate. Physical success authorizes no acceptance.
Privileged/native tracing is not required for these next evidence questions.
