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

The discriminator review is pinned to Agent SDK **0.3.292**, Claude Code
**2.1.292**, `sdk.d.ts`'s documented newline-delimited `StdoutMessage` union.
`claude-output-census-schema.test.ts` statically derives the union using the
TypeScript AST and requires exact parity; it never imports/executes SDK runtime
or Claude. Runtime classification uses a closed code allowlist, not reflection
or values learned from native/provider output:

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

Unknown root tags collapse to `unknown`; unknown/missing `system`/`result`
subtypes collapse to `system/unknown` or `result/unknown`. **Recognized
Discriminator is not complete schema validation**, native origin proof, model
activity proof, or attestation. Only root tags/subtypes are read; nested control
request/response fields, errors, IDs, model, effort, tools, plugins, cwd, URLs,
account/provider data and arbitrary fields are never copied.

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

## Bounds, fences and persistence

One census belongs to one existing preparation/context and bound attachment:
full EnvironmentRef/typed owner/profile/incarnation, process generation, PID,
start identity, requested/observed executable identity and device:inode, plus
Worker-reserved session. Foreign attachments cannot accumulate into it.

There are at most **53 fixed category buckets**, 18 fixed integer counters, and
first/last timestamps. Counts are bounded at **2,147,483,647**; overflow becomes
fixed `unavailable:counter_overflow`, not a wrapped/default count. Observer
failure is a fixed category. No payload object/string is retained by the census.
One pending `setImmediate` coalesces persistence; there is no per-frame row,
unbounded event log, monitor, output file, payload hash, snippet or sample.

The existing `managed_harness_lifecycle.evidence_json` gains `outputCensus`,
`probeIoDelta` and one additional I/O checkpoint (at most four). There is no DDL,
new database/table, migration, Product field/API, Worker Protocol change or
relay-control change (still v2). Historical rows are not rewritten; absent new
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

## Provider-free validation

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
