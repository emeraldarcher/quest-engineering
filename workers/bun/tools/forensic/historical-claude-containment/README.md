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

The authority query corroborates one setup authorization, acknowledged
invocation and complete process identity, the exact existing cancellation
request, exactly one matching cancellation event, zero later semantic events,
and zero HumanAttention rows. The Product request is the only cancellation
authority; the Worker v2 row is required to remain at its historical
pre-delivery `invocation_acknowledged / acknowledged` truth and is not expected
to contain the later cancellation request.

## Product read outcomes and Gate-1 ordering

Product evidence has four non-overlapping outcomes:

- `product_evidence_read_unavailable`: connection, read-only transaction, or
  safe read access could not be established;
- `product_evidence_missing`: the selected and validated Product database was
  read successfully but contains no exact target attempt;
- `product_evidence_mismatch`: database/schema identity, query shape, or an
  existing authority row violates an exact predicate; and
- valid evidence: all identity and authority predicates pass.

Only valid evidence permits any physical call. Gate 1 always parses immutable
Worker-v2 evidence first, validates Product authority second, validates the
environment third, and only then inspects the process. Missing, mismatched, or
unavailable Product evidence produces no SBX lookup, `/proc` read, pidfd open,
journal operation, or identity digest.

Product-only validation of the retained database after fixing the SQL read path
classifies the existing row as `product_evidence_mismatch`, not missing: Product
retains `cancellation_requested / requested`, no invocation acknowledgement,
and no Product process identity. Worker-v2 acknowledgement evidence does not
weaken the separately required Product predicates. This finding does not run
Gate 1 or authorize physical inspection.

## Default dry-run

The CLI defaults to inspect-only. After Worker and Product authority pass, it:

1. validates the environment forensic evidence;
2. creates or validates the separate append-only operation journal;
3. inventories the exact SBX identity;
4. validates the ownership-marker digest;
5. opens a pidfd and reads only `/proc/<pid>/stat` and `/proc/<pid>/exe`;
6. reports exact-live, authoritative absence, mismatch, or unavailable; and
7. emits the physical-identity digest required by a later destructive command.

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
not exist. Process generation is independently corroborated between the Worker
handle and Product process evidence; the pidfd/start/executable tuple binds that
handle to the current kernel process.

After acknowledgement or ambiguity, only bounded read-only settlement
observation occurs. Slow settlement never causes a second signal. Authoritative
absence records no fabricated exit status and never rewrites Product history.

## Execution interlock

The failed Gate-1 diagnostic operation
`15428ed9-f6df-4b6d-bfcd-379c7c855eb4` was never journal-bound and must never
be reused. A future authorized Gate 1 must use a new explicit operation UUID.

Destructive mode is not documented as a ready-to-run command. After a separately
approved successful dry-run, a human must review its journal and returned
identity digest.
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
