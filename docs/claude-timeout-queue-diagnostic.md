# Timeout-only probe queue-membership diagnostic

## Meaning and limits

The pinned Claude 2.1.292 [source investigation](claude-queued-started-investigation.md)
found that `queued` precedes both dequeue and several later pre-start joins.
**Queued does not imply physically still queued.** No completed Run's wait was
identified and none is reclassified by this change.

The new optional Worker-only diagnostic sends one native `cancel_async_message`
for the exact Worker-owned false-query probe at the existing **init readiness
timeout**. It mutates native cancellation state, but is **observational only in
Quest Engineering Product semantics**: it cannot recover a Run, advance readiness,
validate a NativeSessionRef, authorize inference, or make an Attempt retryable.
It does not identify a specific pre-start join.

| Response | Only permitted conclusion |
|---|---|
| `cancelled_true` | At handler time, the pinned native handler removed the exact operation-owned probe from its physical queued-work structure. |
| `cancelled_false` | At handler time, it did not remove that probe. Prior dequeue into a pre-start batch, prior removal/completion, fold/in-flight and other non-queued states remain possible. **False is not started.** |
| `response_unavailable` | No reliable correlated answer; no queue-membership conclusion. |
| `response_malformed` | A correlated reply did not satisfy the reviewed literal-success/boolean shape; no queue-membership conclusion. |

This is not a retrospective sample of enqueue/dequeue time, a general queue
inventory, proof of Mod execution, or readiness. Physical shutdown and the reply
race. A reply before cancellation ACK, no reply, and a partial frame at shutdown
are all legitimate outcomes. Terminal stdout totals and terminal lifecycle events
are not required; their absence is not cancellation failure.

## Mandatory pre-probe transport gate

The subsequent [pre-probe integration correction](claude-preprobe-integration.md)
closes PR #59's missing live feature gate and fresh-initial metadata exclusion.
The exact current attachment must expose actual negotiated relay-v2
`nonblockingDiagnosticWrite:true` **before observer/probe submission**. Unsupported
or unavailable blocks the probe with `diagnostic_capability_unavailable` and normal
physical cancellation; no fallback. Duplicate critical top-level READY fields
reject the handshake before support can be derived, including equal duplicates.
No probe does not mean no Run: a future gate failure after Run creation still
consumes/fails that Run. Supported Worker rejoin (which may reconcile assigned
ProviderAccounts) and physical convergence remain separately authorized
operational prerequisites; source/version/configuration alone is not live READY.
The guard is rechecked after the existing
baseline await and at physical write entry after lease validation. A supported
snapshot is not Claude readiness, inference authority, or a liveness lease.

## Distinct operation-owned capability

`QueuedProbeCancellation` is independent of `ManagedHarnessLifecycle`'s private,
comparison-only probe binding. It creates a fresh Worker UUID and assigns that
UUID to the outbound probe object **before serialization**. No native-provided
ID can select or replace its cancellation target. The recorder independently
receives the resulting outbound UUID for comparison only.

The capability requires:

- exact Run, Attempt, Action and physical-lineage identities;
- the Worker-reserved session and the same `StreamedProcess` object;
- an immutable captured handle, checked against the current full handle;
- the same in-memory active preparation, Dispatch object, account and session;
  scope fields must still match, and the exact fresh-initial eligibility predicate
  must hold, with no known terminal state/settlement/server ACK;
- the same current local connection and server Worker-registration generations,
  captured before any preparation await and compared in memory before creation,
  dispatch and response handling;
- explicit revocation after canonical cancellation/failure/terminal ACK and before
  the next await, plus revocation on every rebind/recovery/teardown path;
- actual live attachment support proven by the mandatory pre-probe gate;
- an acknowledged exact outbound probe write and the original deadline reached.

Missing or contradictory identity is unavailable. Rebind, continuation/recovery,
interrupt, close, metadata retirement, disconnect, relay failure, stdout closure,
process exit, physical cancellation ACK/failure and preparation retirement revoke
capabilities. A capability cannot be rebound/rearmed or moved to another Attempt.
`DispatchExecutor.acknowledgeTerminal` invokes the optional synchronous
`revokeDiagnosticCapabilities` hook after its existing durable ACK write, before
any further await; Claude revokes only the matching Action's diagnostic authority.
A one-time canonical dispatch lookup establishes eligibility before the probe;
it rejects terminal/ACKed/recovered/mismatched operations, including ACKs that
preceded capability creation. The same synchronous turn installs the capability,
so a later ACK cannot miss it. Product's ordinary initial Actions carry
`operational_recovery`; its presence alone is not recovery. Eligibility requires
initial/fresh epoch 0, first Attempt, null source/retained/request references,
valid allowance, fresh QE context and no prior session/continuity. A bounded
one-use current-Worker new-acceptance receipt excludes restart/replay/backend
re-entry; metadata never grants cancellation authority.
Canonical cancellation/failure also revokes before
awaiting HumanAttention cleanup. Worker disconnect/supersession synchronously
revokes every transient diagnostic capability without changing ordinary shutdown.
Missing lookup or current-generation support blocks the probe. Missing fresh
eligibility leaves timeout authority unavailable, without manufacturing initial
semantics for legacy or recovery execution. Missing the current receipt for an
otherwise initial-first-fresh execution blocks its probe too. A new
activation cannot lend its generation to an old in-flight preparation.
There are no new ownership tombstones or unbounded revocation histories.
The timeout callback does **not** query a database or revalidate credentials:
those initial checks established the preparation and attachment, and this
capability only cancels its already-owned command. It cannot acquire another
operation or revive a revoked attachment. No stateful store is opened to
manufacture authority, and no new blocking DB lookup precedes physical cancellation.

Operands and callbacks are ECMAScript-private and cleared on revocation. The
object is frozen; JSON/string conversion and direct crypto-hash conversion reject
with fixed errors, structured clone rejects via an own non-transferable function,
and inspection/logging exposes no operands. An opaque object can of course be
used as a JavaScript collection key; that is not an exported identifier/digest or
a transferable cancellation capability. There is no target-ID/hash accessor.

## Exact timeout integration

The adapter retains the existing `waitForInit(frames, 30_000, onTimeout)` and the
shared applied-state deadline. Its existing timeout callback only additionally
sets a local timeout flag. The catch path invokes:

```
existing readiness timeout
→ cancelClaudePreparation
    → one synchronous best-effort diagnostic submission (or unavailable)
    → existing cancellation_requested observation
    → existing process.cancel() immediately, with no diagnostic await
→ existing failure/uncertain settlement
```

The optional argument is passed only for that actual init-timeout callback, not
for init rejection, valid init/applied-state failure, EOF, continuation readback,
normal close, retry or recovery. Receiving an init first revokes the capability
before the unchanged full init/applied-model/high-effort checks.

There is no diagnostic timer, response waiter, sleep, grace period, poll, retry,
ordinary asynchronous write-tail task, or second probe. Physical cancellation
is unconditional for true, false, malformed, unavailable and exceptions.
The diagnostic projection schedules no new persistence task. Existing
cancellation-request/ACK, exit and census checkpoints save its fixed in-memory
state; the diagnostic adds no database round-trip ahead of physical cancellation. Fixed CPU work to construct/check/submit
the request is not a new waiting budget or a guest signal timestamp claim.

## Native wire and correlation

The native request is exactly:

```json
{
  "type": "control_request",
  "request_id": "<fresh Worker-owned correlation UUID>",
  "request": {
    "subtype": "cancel_async_message",
    "message_uuid": "<exact Worker-owned outbound probe UUID>"
  }
}
```

It is one LF-delimited control frame, not a user message. The 301-byte probe,
its fields/content, Claude flags/version, settings, Mod, plugins/MCP and profile
pins do not change.

A reply must have `type:control_response`, an own nested
`response.request_id` exactly matching this request, `response.subtype:success`,
and literal boolean `response.response.cancelled`. Present session/command or
additional request-correlation fields must also match ephemerally. Arrival order
never establishes correlation. Missing/wrong correlation stays unavailable; a
later genuinely correlated reply may still be classified. The first reliably
correlated valid/malformed answer wins. Revoked capabilities classify nothing.

Only these closed scalars are projected, prospectively:

```text
queuedProbeCancellation.request:
  queued_cancel_request_sent | queued_cancel_request_unavailable
queuedProbeCancellation.response:
  cancelled_true | cancelled_false | response_unavailable | response_malformed
```

`queued_cancel_request_sent` means the current host transport accepted the
best-effort submission, **not target delivery, a write ACK, or handler execution**.
A synchronous complete encoded-frame count is required; partial/pending host
write outcomes stay unavailable. FileSink's existing ordered buffering owns the
whole submitted chunk; there is no remainder replay. Async write/flush rejection
is contained without awaiting it or logging raw errors. A full pipe, shutdown,
identity loss or flush failure can lose it. Only a reliably
correlated native response supports the corresponding handler-time conclusion.
No response always remains unavailable, never false.

At the existing parser boundary the census can still count the control-response
shape. Timeout diagnostic control replies are consumed separately and not kept
in the authoritative frame queue. Init/result frames and all pre-timeout behavior
remain on their original paths. No raw body, operand, event/request/session ID,
extra field, exception text, snippet or identifier hash enters the new evidence.
Existing canonical reservation/context and independent receipt records are not
removed or rewritten; this diagnostic makes no new copy of their identities.

## Nonblocking transport is necessary

Using ordinary `process.write()` would be incorrect: it can wait on a write tail,
namespace validation and ACK, and the existing relay WRITE loop can block on
child stdin **ahead of CANCEL**.

The optional `tryWriteDiagnostic` instead:

- is current-attachment-only, at most 512 bytes, and refuses closed/retired/busy
  writes, cancellation already requested, missing support or changed handles;
- performs no inventory, lease acquisition, reattachment or asynchronous
  validation. The operation owner independently checks current authority; the
  manager fences its retained attachment and the target is only its existing fd;
- uses a feature-advertised additive relay-v2 opcode `TRY_WRITE_DIAGNOSTIC=24`;
  absent `READY.nonblockingDiagnosticWrite:true` means unavailable, not fallback;
- creates no write ACK timer/waiter and never awaits host flush;
- checks the retained Popen PID/start/executable and exact writer pipe inode;
- does **one** Linux nonblocking `os.write` of at most `PIPE_BUF`, restoring the
  owned writer's blocking flag in `finally`. There is no guest retry, flush,
  output-lock acquisition or ACK write that could wait ahead of physical CANCEL.

This fd is the existing Popen pipe writer, not an arbitrary fd/PID reopen. Full,
closed, unsupported or replaced targets lose only diagnostics. Relay CANCEL=22,
its SIGTERM action, normal WRITE sequencing and ACK-only receipt authority remain
unchanged. Shared ACK-request and I/O submissions contain async FileSink write
rejection using their existing ambiguous/observation-failed error outcomes; they
add no wait or retry and never infer ACK from a host write count.
Deploy Worker/relay source together; old live attachments are not
upgraded. Relay protocol remains v2; Worker protocol v19 and ownership v2 remain
unchanged. This additive feature is not a new native Claude protocol.

| Deployment combination | Behavior |
|---|---|
| New Worker / old relay | Actual READY lacks required feature: **pre-probe block**, zero probe writes; no opcode 24/fallback. |
| Old Worker / new relay | Extra READY field is ignored; ordinary operations remain unchanged. |
| Surviving old-generation attachment | No capability transfer, serialization, upgrade or rebind. |
| Preparation crossing activation | Captured generation is stale: fail closed before probe; after probe, timeout authority is unavailable. |
| New Worker / new relay | Live feature + exact current operation permit probe; fresh-initial eligibility separately permits one timeout attempt. |

## Persistence and validation

Only optional closed objects/scalars (`queuedProbeCancellation` and the last
pre-probe `probeDiagnosticCapability` check) enter existing Worker-local lifecycle
JSON. There is no DDL, Product field, migration, historical default filling or
reclassification. Old rows return unchanged. Missing evidence is unavailable,
not a measured false/zero.

Deterministic tests cover operation/attachment/terminal fencing, missing identity,
single-use dispatch, failure/unavailable transport, literal/correlated replies,
partial/no/late responses, clone/inspection/log/error/SQLite privacy and unchanged
failure/readiness/session/prompt authorization. Virtual scheduler tests run the
production timeout/wait/cancel functions without real sleeps. Full fake-lease
preparation tests exercise true and false answers, including valid init arriving
**after** timeout: the Run still fails without any prepared/ready return. Existing
independent valid-init/applied-state fixtures still succeed without this diagnostic.

Host transport tests use in-memory relay frames and unresolved flush promises.
The owned Python helper is extracted by AST and tested against fake OS/Popen
objects; relay main/Popen and vendor code are never executed. This is not a live
SBX, Claude, SDK, account, Run, provider or inference test. Native helper shape is
supported by the separate pinned static investigation, not a new live observation.

Implementation/merging grants no Phase E execution permission. The six failed
Runs and retained evidence remain untouched. No seventh Run, reconciliation,
login, inference, retry, cleanup or live validation is authorized.
