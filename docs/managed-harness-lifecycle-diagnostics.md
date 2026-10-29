# Owner-accurate managed-harness lifecycle evidence

## Scope and identities

The Claude Code adapter records bounded, **Worker-local diagnostic evidence** for
one zero-query preparation. It does not instrument Claude, introduce a second
handshake, add a logging channel, or change the authority of native attestation.
The diagnostic change left the native init validator, fixed probe bytes and
production **30,000 ms** init deadline unchanged.

The independent pinned-runtime effort omission is now handled by the separate
[exact effort readiness check](claude-effort-readiness.md): native `get_settings`
proves applied effort when init omits it. This does not extend lifecycle diagnostics,
change its evidence semantics, or identify the historical frame-timeout cause.

This is deliberately Worker-only. Immutable `qe-account-cell` 1.0.0,
`qe_claude_account_cell_v1`, account profiles v1/v2, all their asset hashes and
full profile digests, managed settings and broker-Run profile remain unchanged.
No ProviderAccount is migrated, rebound, recreated or authenticated. No Worker
Protocol or Product/Core schema/domain interface changes.

## Observation is not authority

`ManagedHarnessLifecycle` in `workers/bun/src/harnesses/lifecycle-diagnostics.ts`
projects only a closed stage vocabulary and allowlisted metadata. Its stdout
[census](claude-output-structure-diagnostics.md) inspects parser units transiently
and projects only reviewed fixed tags, counts, booleans and observer timestamps;
it never retains arbitrary native payloads, strings or error messages.

Evidence distinguishes:

- `observed`: the owning Worker layer positively recorded the operation/result;
- `not_observed`: no positive breadcrumb was recorded, **not nonexecution**;
- `unobservable_at_this_layer`: the unchanged interface has no suitable producer;
- `unknown`: for example, process liveness at the timeout without a terminal
  observation, native processing between pipe delivery and a candidate init, or
  evidence-sink completeness after a write failure.

The current Mod emits no entrypoint/ready diagnostic control signal. Thus
`modExecution` is `unestablished` and `modEntrypoint`/`modReady` are
`unobservable_at_this_layer`. Native plugin metadata, arbitrary `ui_status`,
model text, and a string claiming `mod_ready` do not upgrade those conclusions.
The real-Mod provider-free fixture executes its unchanged `register` and
`session.start` code and confirms its eight registrations and absence of an
emitter; it is **not** proof that any retained production Mod executed.

Adding a genuine Mod signal later would require a separate immutable
Mod/protocol/profile decision. This minimal Worker-only implementation does not
invent such a producer just to make a positive-Mod test pass.

## Worker-owned stages

Progress stages, in protocol order:

1. `process_launch_requested`: immediately before invoking `spawnStreamed`;
2. `process_spawned`: that call returned an exact supervised attachment;
3. `stream_observation_registered`: stdout pump and terminal observer attached;
4. `probe_write_requested`: serialized message is about to be written;
5. `probe_write_acknowledged`: the exact process write returned its receipt;
6. `protocol_frame_observed`: stdout parser saw a candidate `system/init` with
   the reserved native session ID on that attachment;
7. `protocol_frame_validated`: the **existing** production validator returned.

Additional observations are `protocol_frame_rejected`,
`protocol_observation_failed`, `attestation_timeout_fired`,
`cancellation_requested`, `cancellation_acknowledged`, and
`process_exit_observed`.

A cancellation call is only a request until acknowledged. An acknowledgment
positively proves submission; it does not timestamp the guest signal syscall.
No extra **physical** cancellation, escalation, liveness probe or inspection
command is added. The separate [timeout queue diagnostic](claude-timeout-queue-diagnostic.md)
can attempt one nonblocking native `cancel_async_message` immediately before
normal physical cancellation; neither its dispatch nor its response gates that
cancellation. Exit and cancellation acknowledgment can arrive in either order.

Timestamps are UTC first-observation instants and monotonic elapsed milliseconds,
not invented guest-side execution times. Each stage records at most once.
Progress is frozen when the timeout fires: a late init cannot rewrite what was
proven at the deadline. Cancellation/terminal observations may still follow.
`lastProvenStage` is the highest observed progress stage, not a root-cause label
and not the later cleanup event. Actual event ordering remains in `events`.

## Native interval and process state

Protocol-frame observations depend on the same native stdout/relay attachment
under investigation. They are not an independent signal of earlier emission;
silence cannot distinguish "not emitted" from "emitted but not delivered".

A stdin receipt proves delivery to the process pipe. It does **not** prove native
parsing, acceptance, init construction or submission. Those three native
operations stay `unobservable_at_this_layer` even after a response is seen.

`nativeAttestationInterval` is `unknown` until a matching candidate init is
observed (or the validator positively returns), then `response_observed`. This
latter value alone is not validation success;
a separate `protocol_frame_validated` event requires the real validator.

A missing terminal event does not prove a live process. `processStateAtTimeout`
is `unknown` unless an actual terminal observation preceded the timer;
`observation_unavailable` is not terminal proof. A later
cancellation/exit does not retroactively provide a scheduler-state snapshot.
Safe exit categories, exit code and allowlisted signal names are retained;
unknown backend error prose/codes are not copied.

## Fencing and durability

Each preparation has its own random diagnostic ID and reserved native session
ID, harness/protocol identity, optional physical lineage ID and canonical
EnvironmentRef: Worker, typed owner/provenance generation, environment ID,
incarnation and immutable profile ID/digest. Semantic credential generation
continues to be independently fenced by existing runtime/broker authority;
diagnostics do not conflate it with historical environment ownership.

The pre-launch observation has no invented process generation. Once spawn
returns, its exact PID, start identity and process generation are bound once to
that preparation. All subsequent observations must match that attachment and
EnvironmentRef. A foreign-session init is not recorded as this preparation's
candidate init; it still follows normal protocol validation/rejection. The separate
output census can count its init shape and failed session comparison without
retaining or hashing its native session identity.

A bounded snapshot is stored in **`managed_harness_lifecycle` in the existing
`claude-code-sessions-v1.sqlite`**, keyed by `preparation_id`. No new database is
introduced. This additive Worker-local table contains `evidence_json` only from
the closed metadata projector. Use `context.lineageId` or
`context.reservedNativeSessionId` to correlate it with existing session records.
A reserved UUID is not relabeled an attested `NativeSessionRef` on failure.

For example, read the retained Worker DB **read-only** after a separately
approved diagnostic attempt:

```sql
SELECT preparation_id,
       json_extract(evidence_json, '$.context.lineageId') AS lineage,
       json_extract(evidence_json, '$.lastProvenStage') AS last_stage,
       json_extract(evidence_json, '$.nativeAttestationInterval') AS native_interval,
       json_extract(evidence_json, '$.modExecution') AS mod_execution,
       evidence_json
FROM managed_harness_lifecycle;
```

Do not instantiate a runtime/session manager against retained evidence merely to
read it: its existing startup reconciliation is stateful. Read SQLite directly
in read-only mode instead. Diagnostic persistence is best-effort; sink failure
cannot fail successful attestation. Incomplete/missing evidence stays unknown.
No Product-domain fields are added. The existing failure message for a timeout
names only the safe last proven stage and unknown native interval; detailed
identity/event evidence remains Worker-local.

## Sensitive-data and correctness boundary

No stdout, stderr, frames, prompts, auth fields, provider text, URLs, codes,
credentials or arbitrary errors enter diagnostic persistence/logging/telemetry.
Only known fields are constructed from Worker-owned identities and receipts.
The fixed probe command UUID is now held only in an attachment-fenced private
runtime field for aggregate comparison; new `probe_write_requested` events omit
its operationId. Native command/event/session IDs are never copied from
command_lifecycle. Existing independent write/cancellation receipt IDs and the
Worker-owned reserved-session context remain unchanged. Historical evidence is
not rewritten. Root/system/result tags use the shared structural decoder;
recognition and probe comparison remain diagnostics, never validator authority.
Native JSON/UTF-8 parser failures are converted to constant error categories
before they can reach failure reporting. Unknown native fields are discarded,
not serialized as diagnostic details. The existing stdout frame buffering is
still ephemeral; no native-output file or stderr classifier is added.

A lost breadcrumb or unavailable sink cannot consume/drop a real init, weaken
its validator, fail an otherwise valid preparation, or assert that the Mod did
not execute. The production 64-frame/2 MiB bounds and timeout remain unchanged.
A native-specific startup stall can still require separately reviewed native
instrumentation. Such instrumentation is **not** included or automatically
recommended here.

## Content-free pipe and output observations

The additive [streamed-process I/O diagnostics](streamed-process-io-diagnostics.md)
record one bounded pre-probe snapshot after stream registration and before the
write request, then snapshots at probe ACK, timeout, and exit without awaiting
these later checkpoints in readiness or cancellation. The pre-probe wait is bounded
at the existing 3,000 ms, fail-open, and outside the unchanged post-ACK budget. The generic guest relay owns FIONREAD on its retained
stdin writer and stdout/stderr counters before framing/parsing. These samples do
not advance lifecycle stages or establish native parsing, Mod execution, init
construction, or exact timeout-time liveness. Their actual observation timestamps
and typed unavailability remain distinct from the checkpoint that requested them.
No new SQLite table/schema or Product field is added.

## Timeout queue-membership partition

`queued` is not proof that a probe remained physically queued: native dequeue
precedes some pre-start joins. The optional prospective `queuedProbeCancellation`
object contains only closed request/result enums, as specified in the
[timeout diagnostic](claude-timeout-queue-diagnostic.md). `cancelled_true` proves
removability at handler time; `cancelled_false` proves no removal then, **not
started**; unavailable/malformed permit no membership conclusion. It cannot
identify the particular join, advance progress, or grant readiness/recovery.
Native cancellation state is mutated, but Product failure and normal physical
termination remain unchanged. Reply/termination races and partial/missing frames
are valid. No terminal totals are required. Historical rows get no new defaults.
The recorder's comparison-only binding is never cancellation authority.

## Mandatory pre-probe capability check

The [integration correction](claude-preprobe-integration.md) requires actual
live attachment support before Claude's zero-query probe. Optional prospective
`probeDiagnosticCapability` is the last closed gate result: `supported`,
`unsupported`, or `unavailable`. It is transport/ownership evidence, not native
init or continuous liveness. Failed gates submit no physical probe bytes and
use normal cancellation. Logical write intent can precede a late writer-entry
gate failure; intent is not delivery. Existing checkpoints save this scalar;
there is no new persistence task, DDL, migration or historical default filling.
Late pre-probe failure retires the observer/frame queue and clears the private
comparison binding before cleanup awaits; a failed backend cancellation is not
reported as proof of termination. A Run already created by Product is still
consumed/failed despite zero probe bytes. Supported Worker rejoin and account
convergence are separate operational prerequisites, not granted by these tests.
See the [review validation boundary](claude-preprobe-review-validation.md) for the
prior accidental native test execution and this task's explicit exclusions.

## Provider-free validation

- Lifecycle tests cover every progress stage, first-observation bounds, exact
  attachment/session fencing, safe exits, dropped-event/non-proof semantics,
  frozen timeout evidence, canaries and persistence failure.
- Protocol tests exercise the production serializer, stream parser/queue,
  validator, zero-query receipt, fragmentation, timeout, cancellation, early
  exit and successful attestation with all diagnostics absent or throwing.
- The real unchanged Mod is loaded under deterministic Engine services only;
  no native Claude/SDK execution, `prompt.submit` or `turn.step` is used.
- `QE_LIVE_SBX=1 bun test test/claude-attestation-lifecycle-sbx-live.test.ts`
  uses a disposable **shell** SBX, no credential grants and no provider egress.
  Real streamed Python targets cover healthy/fragmented init, silence, ignored
  self-asserted Mod text, early exit and foreign-session rejection. It exercises
  the same observation/parser/write/wait/cancel functions as production and
  reopens the Worker evidence DB after process settlement.

No real Run acceptance, login, credential operation, inference authorization or
query-enabled Claude turn is authorized by these tests or by merging this PR.
The separate native request-boundary test executes real Claude with query-enabled
input against a fake HTTP endpoint; it must not be run under this task's strict
no-native/no-model-turn validation authorization. Any exclusion is reported
explicitly rather than counted as a passing test.
