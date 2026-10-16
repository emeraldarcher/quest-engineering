# One-time historical Claude process containment

> **IMPLEMENTATION ONLY. DO NOT EXECUTE.** Building, testing, reviewing, or
> merging this utility does not authorize a dry-run or a signal. A future
> dry-run requires a human-approved plan. A physical cancellation additionally
> requires the exact future instruction `EXECUTE HISTORICAL CONTAINMENT`.

This directory contains a one-target forensic utility for the acknowledged
historical ProviderAccount setup attempt named in `types.ts`. It is not a
Worker recovery path. Production code does not import it, and it does not
provide setup, login, stdin, credential, authentication-status, provider, or
inference capabilities.

## Inputs and isolation

The utility requires explicit absolute paths for:

- the original ProviderAccount setup SQLite schema-2 ledger;
- the original execution-environment SQLite ledger;
- a separate containment-journal SQLite database; and
- an absolute SBX executable.

Historical SQLite files without a WAL are opened with SQLite `READONLY | URI`
and `mode=ro&immutable=1`. If durable state is present in a WAL, the utility
reads the database and WAL as raw files into a temporary, mode-`0600` snapshot
beside the separate journal, verifies before/after digests of the original
database/WAL/SHM, and opens only that disposable snapshot with `query_only`.
This avoids both ignoring acknowledged WAL state and allowing SQLite to write an
original SHM file. The temporary snapshot is removed after parsing. Exact
schemas and required records are validated; unknown or missing fields fail
closed. The journal path must differ from both inputs. No row is copied into
current Worker persistence.

Product evidence is queried directly using one PostgreSQL repeatable-read,
server-enforced read-only transaction. Its URL is read only from the explicitly
named environment variable and is never accepted on the command line, emitted,
or journaled. The separately required `--product-database-name` must equal the
reviewed historical database `qe_phase_e_fresh_16f44656_v3`; the transaction
then proves that name, the `public` schema, explicit local connection host,
local/private server locality, port `5432`, and the exact `20261017000000`
migration head/count before reading authority.
Credentials are not included in evidence or identity digests.

The Product query proves semantic authority only: the exact setup attempt and
account, one setup authorization, the historically truthful
`cancellation_requested / requested` state, the exact existing cancellation
request and event, valid Product-local chronology, zero later semantic events,
and zero HumanAttention rows. It deliberately does not select or synthesize an
invocation acknowledgement, PID, start identity, executable, or process
generation.

The immutable Worker-v2 row and events separately prove one
`login_invocation_requested` intent, one `login_invocation_acknowledged` event,
its `invocation_acknowledged / acknowledged` state, complete historical process
and environment identity, and no Worker-side cancellation submission or event. The Product
request remains the sole semantic cancellation authority. Neither source can
replace the other.

## Product read outcomes and Gate-1 ordering

Product evidence has four non-overlapping outcomes:

- `product_evidence_read_unavailable`: connection, read-only transaction, or
  safe read access could not be established;
- `product_evidence_missing`: the selected and validated Product database was
  read successfully but contains no exact target attempt;
- `product_evidence_mismatch`: database/schema identity, query shape, or an
  existing authority row violates an exact predicate; and
- valid evidence: all identity and authority predicates pass.

Worker evidence independently reports `worker_evidence_missing` when the exact
attempt is absent and `worker_evidence_mismatch` when schema-2 or its mandatory
acknowledged physical evidence is contradictory. If independently valid
Product and Worker evidence disagree on any shared identity,
`corroboration_mismatch` is reported. These are distinct from Product failures.

Only full corroboration permits any physical call. Gate 1 parses immutable
Worker-v2 evidence first, validates Product semantic authority second, validates
the immutable environment ledger, compares every shared identity, and only then
inspects the current SBX/process. Any earlier failure produces no SBX lookup,
`/proc` read, pidfd open, journal operation, or physical identity digest.

The retained asymmetry is expected and is not repaired:

1. Product authorized setup and the Worker began the authorized login.
2. Worker physically spawned it and durably recorded acknowledgement plus the
   process handle.
3. delivery of that acknowledgement report to Product was interrupted.
4. Product therefore truthfully remained `invocation_requested / requested`.
5. a human later requested cancellation, while the old Worker could not submit
   detached cancellation.

The corrected semantic model therefore expects the known Product shape to be
Product-valid when its cancellation predicates pass, while Worker-v2 proves
physical acknowledgement. This conclusion is based on reviewed/synthetic
history shape only; updating this code does not run Gate 1 or authorize physical
inspection.

## Evidence responsibility

| Fact / project fields | Product | Worker v2 | Current physical observation |
| --- | --- | --- | --- |
| Setup authorization (`authorization_id`, `authorized_at`) | authority | corroborates accepted command | — |
| Cancellation authority (`cancellation_request_id`, state/event) | authority | not a source | — |
| Setup attempt (`setup_attempt_id`) | authority | authority | — |
| Account (`provider_account_id`) | authority | authority | corroborates environment owner |
| Invocation intent | records pending `requested` state | one `login_invocation_requested` event is authoritative | — |
| Invocation acknowledgement | not a source | one `login_invocation_acknowledged` event plus `invocation_acknowledged / acknowledged` row is authoritative | — |
| PID, start identity, executable | not a source | historical authority from `process_json` | current PID/start/executable observed through pidfd |
| Process generation | not a source | historical authority from `process_json` | bound to the current process by the exact pidfd/PID/start/executable tuple; not invented as a kernel field |
| Profile/runtime identity | auth configuration where shared | historical profile identity | environment marker/SBX corroboration |
| Current liveness | not a source | historical only | authority |
| Cancellation submitted | Product request only | proves not submitted historically | authority if later submitted |
| Current exact-process match | not a source | expected identity | authority |

Shared comparisons are exact for setup attempt, authorization identity/time,
account, setup/credential/environment/Worker generations, environment operation,
Worker/backend/environment/incarnation, and authentication
configuration/policy/evidence/time. Product did not persist profile, PID, start
identity, executable, or process generation after the interrupted report, so
Worker-v2 is the sole historical source for those fields; exact attempt,
authorization, account, generations, Worker, and environment identities bind
that handle uniquely to Product authority. No Worker field is copied into the
Product evidence object.

Chronology uses ordering within a defensible timestamp domain: Product
authorization precedes Product invocation request, which precedes Product
cancellation; Worker row creation does not follow its acknowledgement update.
The utility does not impose nanosecond ordering between Product and Worker
clocks.

## Default dry-run

The CLI defaults to inspect-only. After Worker and Product authority pass, it:

1. validates the environment forensic evidence;
2. creates or validates the separate append-only operation journal;
3. inventories the exact SBX identity;
4. validates the ownership-marker digest;
5. opens a pidfd and reads only `/proc/<pid>/stat` and `/proc/<pid>/exe`;
6. reports exact-live, authoritative absence, mismatch, or unavailable; and
7. only for exact-live, emits the physical-identity digest required by a later
   destructive command.

The internal corroborated-evidence object retains three attributed components:
`semanticAuthority` from the Product read-only transaction,
`historicalPhysicalEvidence` and `historicalPhysicalIdentity` from the immutable
Worker-v2 snapshot, and `sharedIdentityMatches`. Environment-ledger evidence is
also retained with its source digest. The final physical identity digest commits
the versioned Product semantic digest, Worker physical digest, environment
digest, explicit shared-match contract, and current exact SBX/pidfd
PID/start/executable observation. It contains no credentials or provider
output.

It never reads stdout/stderr, stdin, process environment, account files,
credentials, OAuth material, or provider state. It sends zero signals.

## Journal and destructive boundary

The journal is current-only schema 1. Database triggers reject operation/event
updates and deletes, while the application exposes only transactional appends.
It contains immutable operation identity plus safe events. It stores no provider
output, credentials, OAuth material, or raw environment data.

One journal uniquely binds this historical target and cancellation request to
one containment-operation UUID; changed evidence or a second operation is
rejected. The reviewed
journal path is itself part of the execution procedure and must never be
replaced with a fresh journal. Before the physical boundary, destructive mode
durably appends `cancellation_intent_recorded`. Any later invocation that sees
that event is read-only reconciliation only, regardless of whether
acknowledgement was recorded. There is no automatic replay.

The physical helper revalidates the exact SBX identity and ownership marker,
opens the exact PID as a pidfd, rechecks start identity and executable, and
submits one `SIGTERM` with `pidfd_send_signal`. PID-only and shell signalling do
not exist. Process generation remains mandatory Worker-v2 historical evidence; Product is
not its source. The pidfd/start/executable tuple and exact SBX environment bind
that Worker handle to the current kernel process.

After acknowledgement or ambiguity, only bounded read-only settlement
observation occurs. Slow settlement never causes a second signal. Authoritative
absence records no fabricated exit status and never rewrites Product history.

## Execution interlock

The failed Gate-1 diagnostic operation
`15428ed9-f6df-4b6d-bfcd-379c7c855eb4` was never journal-bound and must never
be reused. A future authorized Gate 1 must use a new explicit operation UUID.

Destructive mode is not documented as a ready-to-run command. After a separately
approved successful exact-live dry-run, a human must review its journal and
returned identity digest. Destructive mode requires that same journal operation
to contain the dry-run digest; a caller-supplied digest alone is insufficient.
A future command must then include all of:

- the exact historical setup-attempt ID;
- the same explicit containment-operation UUID;
- `--execute-cancellation`;
- the exact existing cancellation-request ID; and
- the exact physical-identity digest returned by the reviewed dry-run.

There is no `--force` option.

## Production boundary

Normal Worker code remains ProviderAccount setup schema-3-only and rejects
schema 2. No production source imports this directory, and this directory does
not import the ProviderAccount setup store or coordinator. Removal of this
one-time directory after historical settlement is a separate human decision.
