# Claude pre-probe diagnostic integration

This patch closes two integration gaps in merged PR #59 (`8b71616`): its feature
negotiation was private and checked only at timeout, and its eligibility guard
mistook every `operational_recovery` object for recovery. The earlier review's
fixtures omitted Product's ordinary initial-epoch metadata. No seventh Run was
created to discover either gap; no historical evidence is repaired/reclassified.

## Live attachment capability

`StreamedProcess.negotiatedCapabilities()` is a synchronous, read-only snapshot:

```ts
{ readonly nonblockingDiagnosticWrite: "supported" | "unsupported" | "unavailable" }
```

- **supported:** that attachment's actual READY had compatible protocol **2** and
  literal `nonblockingDiagnosticWrite:true`, with retained executable identity.
- **unsupported:** valid READY observed but feature absent/false or protocol not
  compatible. In particular v2 alone is insufficient; old relays block probes.
- **unavailable:** no usable negotiation, malformed feature/version, missing API,
  changed handle/identity, retired/closed/exited/cancelled attachment.

No arbitrary READY payload, version value, identifier, or frame is returned.
Snapshots are frozen observations, not transferable authority or liveness leases.
The manager rechecks its exact retained process-map entry, full handle, transport
identity and lifecycle on each read. Each target/relay instance parses its own
READY. No global feature cache, PID adoption, reattachment or guest query exists.
The adapter independently fences the current local connection **and** server
registration epochs, exact active process/preparation, Action/Attempt/Run/lineage,
account/session and canonical terminal/ACK state. Revocation clears the gate's
private operands as well as the timeout capability. Support on A cannot qualify B.

READY authority is derived from the exact raw frame. Duplicate top-level
`protocolVersion`, `nonblockingDiagnosticWrite`, `pid`, `startIdentity`,
`observedExecutable`, `observedExecutableIdentity`, or
`environmentMarkerSha256` rejects the handshake even if values agree. Escaped
spellings of the same key count as duplicates; nested names and key-like string
values do not. The bounded READY-only scanner preserves duplicate information;
ordinary strict JSON parsing still validates grammar. Rejection exposes only the
existing fixed launcher failure, never payload text or a supported snapshot.

Startup lacking/malformed READY still fails through existing bounded launcher
handling: there is no new startup timer/poll, no returned usable process and no
probe. A valid returned attachment without supported metadata fails the specific
`diagnostic_capability_unavailable` preparation gate. Its bounded evidence says
`unsupported` or `unavailable`; no exception/native text is copied.

## Product metadata semantics and producers

Source chain:

1. `SchedulingStore.persist_acquisition!` attributes **every** newly scheduled
   Action through `OperationalRecovery.attribute_scheduled_attempt!`.
2. `current_or_initial_epoch!` creates epoch **0**, authorization **initial**,
   continuation **fresh**, configured allowance; optional source/retained/request
   identities are null. Attribution numbers Attempts within that epoch from **1**.
3. `execution_metadata` is the common producer consumed by scheduling claim and
   redelivery. Dispatcher/WorkerProtocol serialize it without dropping initial
   epochs; Worker codec preserves it. The wire field is optional for legacy
   callers, not evidence of first-attempt execution when absent.
4. Same-epoch retries reuse the epoch/authorization but increment
   `attempt_in_epoch`. Thus initial/fresh alone is insufficient.
5. Human fresh recovery and retained resume/adoption create later epochs with
   authorization **human**, continuation **fresh** or **retained**, a source
   Attempt/request and possibly a retained lineage. Retained-process fallback is
   still human/retained metadata, not a new initial execution. Replayed requests
   reuse their existing metadata; metadata never proves a new physical operation.
6. QE semantic `continue_from` context is separate from operational continuation.
   Adapter continuation/recovery flags, prior native/generic execution records,
   Worker restart/rejoin, backend re-entry and duplicate delivery also matter.

There is no schema continuation value `resume`, `retry` or `rebind`; those are
workflow semantics represented by the fields above. Malformed/conflicting values
fail closed. No new wire field or Product/Core/Worker Protocol change is needed.

### Exact eligibility predicate

One centralized `isFreshInitialProbeExecution` predicate requires **all**:

- a one-use receipt from **new** canonical acceptance in the current Worker epoch;
- not adapter continuation/recovery and no prior session/execution/transport record;
- both QE context aliases fresh, with null source-occurrence/lineage-occurrence;
- metadata present, `authorization_kind:"initial"`, `continuation_mode:"fresh"`;
- `epoch_number:0`, `attempt_in_epoch:1`;
- allowance null or a positive safe integer;
- `retained_lineage_id`, `source_attempt_id`, `request_id` all null.

Current accepted/running canonical Action/Attempt/Run/lineage must match exactly,
with no ACK, settlement, prompt authorization/intent/acceptance or native activity.
The captured epochs and exact process/session/handle must remain current.

The Worker keeps bounded, one-use new-acceptance receipts in memory only. They
are not restored from SQLite or wire metadata, not reissued for duplicate
acceptance, and cleared on connection loss/supersession. Preparation consumes a
receipt **before any await**; backend re-entry and restart/replay cannot recreate
it. Terminal revocation consumes a still-pending receipt too. These receipts
only establish fresh eligibility; they contain no native probe operand and never
select a cancellation target. A separate bounded, revocable per-invocation marker
exists before preparation's first await and is removed in `finally`. Action/global
revocation and lineage close/interrupt/recovery/disconnect invalidate it even
while spawn is pending and no active process entry exists. This closes the
pre-creation cancellation gap before durable cancellation can finish; a consumed
fresh receipt's local boolean cannot resurrect authority. No marker is restored,
serialized or used as a native target or proof of nonexecution.
Missing receipts/metadata, retry, human recovery,
resume, rebind, restored attachment, old lineage/context and different identity
cannot create the timeout capability. An otherwise initial-first-fresh execution
without its current-epoch receipt also fails the pre-probe gate (replay is not a
new acceptance). Existing legacy/recovery readiness may still proceed with
supported transport, but the timeout diagnostic is ineligible.

The review-fix Product wire tests additionally generate fresh, later-Attempt,
human-fresh, retained recovery, prepared-adoption recovery and logical-continuation
Actions with the actual Product scheduler and recovery producers in an isolated
SQL sandbox. They pass persisted execution/metadata through WorkerProtocol JSON
and the real Worker decoder. The fresh Claude representation is also used by
the combined raw-READY → real transport → manager → adapter tests. Receipt tests
execute only the production memory-only mint/consume AST bodies against the real
registry's acceptance result; they never construct or activate a Worker.
See [validation provenance and exclusions](claude-preprobe-review-validation.md).

The structural sixth-Action regression fixture is synthetic initial/0/first/fresh
metadata, not an imported historical database row. Its historical Run remains C /
FAILED. A fresh Action with that shape is now eligible after all other fences.

## Actual ordering and race closure

```
capture current connection/registration epoch; consume new-acceptance receipt
→ existing preparation/auth/ownership/broker/security checks
→ exact target spawn; relay READY parsed by the real transport
→ bind existing diagnostic/session context and read canonical dispatch once
→ mandatory exact-attachment live capability gate
→ construct inert timeout capability when fresh-initial eligible
→ register existing PR58 observer/census
→ existing bounded fail-open pre-probe I/O baseline
→ recheck capability/attachment/epoch immediately before constructing probe
→ assign Worker-owned outbound probe UUID, independently bind census comparison
→ existing ordinary write-tail/lease validation
→ recheck guard synchronously at physical writer entry, before any target bytes
→ one unchanged 301-byte false-query probe; exact byte-count ACK
→ retire pre-probe gate; arm original 30,000ms shared readiness deadline
→ existing init + applied model/high proof, or existing timeout cancellation
```

The final writer precondition matters: a pre-baseline check alone would permit
replacement during the observation await or the ordinary write validation await.
`write(data, beforeWrite?)` adds only a synchronous precondition after existing
validation; it adds no wait or retry and changes no ordinary wire/ACK sequencing.
A late failed gate can have a logical probe-write intent breadcrumb but **zero
physical probe bytes**. Intent is not delivery. The optional lifecycle field
`probeDiagnosticCapability` copies only the last closed pre-probe check; no DDL,
historical default filling or schema migration. It is not continuous liveness or
Claude init evidence.

After observer registration, a pre-probe gate failure synchronously retires the
observer binding and frame queue before awaiting cleanup. It clears the private
census comparison operand and prevents rebinding. Deferred pump/exit callbacks
become inert even when backend cancellation rejects; an iterator may temporarily
retain ordinary JS stream references until the transport settles. No secure
memory erasure or guaranteed physical termination is claimed. Cleanup still
attempts the original physical cancellation; rejected/unavailable cancellation
is not an ACK or proof of target death. Exit racing teardown needs no terminal
I/O totals.

Gate failure sends no probe, never arms a probe-owned cancellation capability and
never attempts opcode 24. The existing unconditional physical cancellation,
relay/broker close and uncertain reservation handling still run once. The bounded
failure is preparation-phase, terminal-not-recoverable, coding input not submitted;
it is distinct from post-probe init timeout, authentication and physical-readiness
failure. No second spawn, reconciliation, recovery loop or inference permission.

Only the operation owner generates the fresh outbound probe UUID. Neither
Product recovery metadata, a negotiation snapshot nor native output supplies its
target. At timeout the original at-most-once, synchronous best-effort diagnostic
still immediately precedes normal physical cancellation, with no response/ACK
wait, new timer, persistence task, retry, grace or deadline extension.

## Operational prerequisites and Run consumption

**No probe does not mean no Run.** If a future live preparation discovers
`diagnostic_capability_unavailable` after Product has already created its Run,
that Run is still consumed/failed even though no zero-query probe was submitted.
This gate does not preserve or refund an operational Run allowance.

Merged code must first be activated through the supported Worker rejoin path.
That rejoin may perform normal assigned-ProviderAccount reconciliation.
Activation/rejoin and physical convergence remain separate operational
prerequisites to any future seventh-Run sequence; neither is authorized or
performed by this implementation or its deterministic validation.

Only the exact target's **live READY frame** establishes capability. Merged
source, relay version, expected configuration, or a historical supported snapshot
is not proof. The six existing failed Runs/evidence are not modified.

## Corrected deployment matrix

| Combination | Behavior |
|---|---|
| New Worker / old relay | Actual READY lacks required feature: **pre-probe block**, zero probe writes. |
| Old Worker / new relay | Extra READY field ignored by old Worker; legacy behavior unchanged. |
| New Worker / new relay | Live feature + current ownership permit probe; exact fresh eligibility separately governs timeout authority. |
| Activation/replacement crossing preparation | Captured epoch/attachment fails closed before probe; after probe timeout authority becomes unavailable. |
| Restored/rebound/recovered execution | No transferred fresh receipt/capability; newly spawned targets need their own READY. |

Transport support is not `system/init`, applied model/effort, NativeSessionRef
validation, `needs_confirmation`, success, retry/resume eligibility or inference
authorization. All full readiness/inference checks remain independent. The probe,
Claude/SDK/Mod/settings/plugins/MCP/tools/profile/image pins, census, init/model/
effort validators, 30s budget and 3s observation bound are unchanged.

Validation uses deterministic fake leases/transports/READY frames and the actual
adapter/manager path, including late epoch replacement at physical write entry,
unsupported/unavailable metadata, two preparations, retries/recovery, privacy and
canonical terminal revocation. Vendor artifacts are parsed as data only. No
Worker activation, account/SBX operation, Run, native preparation, Claude/SDK,
provider request, login or inference is part of this implementation task.
