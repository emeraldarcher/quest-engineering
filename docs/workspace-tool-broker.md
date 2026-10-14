# Account-to-Run workspace tool broker

**Status:** ProviderAccount Phase C infrastructure, integrated by Claude Phase D

**Date:** 2026-10-14

`WorkspaceToolBroker` is provider-neutral Worker infrastructure. It lets one
trusted process in an exact ProviderAccount environment request a finite coding
operation against one exact Run/PhysicalLineage workspace. It does not carry
provider authentication, provider HTTP, model prompts, completion, or
HumanAttention.

## Authority and admission

Product owns semantic authority. `WorkspaceToolBrokers.prepare/2` derives one
binding from current PostgreSQL state; the account client never supplies QE
identity. Preparation requires:

- a current active `ScheduledActionExecution` and `WorkerDispatch`;
- exact `ResolvedExecution` identity and immutable `ResolvedToolProfile`;
- current `OperationalAttemptAttribution` and recovery epoch;
- a ready `RunWorkspaceAssignment`;
- a connected Worker with `workspace_tool_broker_v1`;
- a current ready ProviderAccount generation and exact account environment;
- a current Worker generation.

The binding covers ProviderAccount and account generation/environment,
Run/Action/occurrence/semantic Attempt, operational epoch/attempt,
workspace/worktree/binding/access, Worker generation, resolved tools, and a
server-derived authorization digest. Preparation is deliberately unusable. `WorkspaceToolBrokers.admit/1` re-derives the binding from current state. Admission now precedes prompt authorization: for `claude_code`, Product persists admitted session/generation activity and makes that exact record a hard prerequisite to the prompt gate. Other callers retain the physical account-client transport. A session ID or authorization ID is a fence/lookup value, not bearer authority: Worker-local account and Run environment ownership plus the exact in-memory session capability are also required.

Worker Protocol 17 adds prepare, admit, retire, and safe activity frames. The
local account protocol is independently versioned as
`workspace_tool_broker_v1`; it is strict JSONL over one Worker-attached streamed
process. It is not exposed through Product HTTP or Harness Control.

## Exact operation inventory

| Broker operation | Resolved semantic tool | Effect |
| --- | --- | --- |
| `filesystem.read` | `workspace.filesystem` | bounded stable UTF-8 regular-file read |
| `filesystem.list` | `workspace.filesystem` | bounded no-follow directory metadata |
| `filesystem.stat` | `workspace.filesystem` | bounded no-follow entry metadata |
| `filesystem.write` | `workspace.filesystem` | atomic contained write |
| `filesystem.edit` | `workspace.filesystem` | replacement-count and metadata-CAS edit |
| `search.grep` | `workspace.search` | bounded regex search |
| `terminal.shell` | `terminal.shell` | non-PTY `/bin/sh` in the exact Run workspace |

Claude-native names remain absent from the provider-neutral broker. Phase D's immutable managed Mod maps its six workspace tools to these seven operations. The Mod's completion and HumanAttention tools bypass the workspace broker and use exact Harness Control authority. Canonical Claude uses Worker-local relay admission, so no generic broker client process is spawned in the credential cell.

The central broker admission layer revalidates account and Run authority,
worker/broker generation, immutable profile digest, exact workspace permission,
operation vocabulary, and request identity before every physical spawn.
`read_only` denies writes, edits, and shell; `none` denies all workspace use.
Denied and unknown operations are `not_submitted` and start no Run process.

## Bounds and containment

The local protocol accepts exact fields only. Current bounds are:

- frame: 320 KiB;
- relative path: 1,024 bytes;
- file/read/write/edit text: 256 KiB;
- search query: 4 KiB;
- shell command: 32 KiB;
- stdout and stderr: 64 KiB each;
- metadata/search response: 64 KiB;
- search results: 100 across at most 2,048 files and depth 32;
- shell timeout: 100 ms through 30 seconds;
- active requests per session: 8.

Filesystem operations use directory file descriptors and `O_NOFOLLOW` rather
than host path strings. Reads require a stable regular-file identity/size/mtime
before and after the bounded read. Writes use a same-directory temporary file,
`fsync`, and atomic replacement. Edits additionally compare the original file
metadata immediately before replacement. Traversal, absolute paths, backslash
paths, symlink traversal, special files, oversized payloads, and changed entries
fail closed. Search never follows symlinks and has file, byte, result, depth, and
duration bounds.

Shell cwd is exactly the PhysicalLineage workspace root (`cwd` must be `.`).
The shell receives only the Run workspace, Run HOME, and a fixed system PATH;
ProviderAccount variables, HOME, paths, and canaries are absent. Shell is
non-PTY with bounded settled stdout/stderr. Streaming to the account protocol is
not part of Phase C.

## Physical directionality

Both broker endpoint processes use `networkIsolatedWorkspaceToolCommand`. A
fixed observed Python supervisor starts a root-owned Linux `unshare --net`
namespace and then drops the actual account client or Run tool process back to
UID/GID 1000. The child retains only its Worker-attached stdin/stdout/stderr and
has no generic provider or cross-SBX network route. The Worker remains the sole
broker between the two independently owned SBXs. This does not change any
immutable execution profile.

Run operations use `EnvironmentLease.spawnStreamed()` in the current Run
context. The account fake client is started in the exact ProviderAccount lease.
No host shell, Herdr PTY, shared mount, account-to-Run socket, or reverse
Run-to-account endpoint is created.

## Concurrency, certainty, and cancellation

Read-only requests may run concurrently. Writes, edits, and shell commands share
one per-session mutation tail and execute serially. Queued and active work both
count toward the eight-request bound.

Durable Worker-local request state distinguishes `not_submitted`, `submitted`,
`completed`, `cancelled`, `rejected`, and `uncertain`; protocol certainty is
`not_submitted`, `acknowledged`, `completed`, or `uncertain`. Request IDs are
unique within a session and bind a digest of the exact semantic request.
Completed in-memory results may be replayed for the same request/digest.
Ambiguous mutations are marked uncertain and are never replayed. A conflicting
request ID is rejected.

Cancellation records intent before process cancellation, rechecks cancellation
after a racing spawn, and preserves a settled cancellation/closure state instead
of overwriting it with a later process error. Exact execution cancellation,
terminal execution reports, Run cleanup, ProviderAccount generation/lifecycle
change, environment replacement, Worker disconnect/generation replacement, and
account-client loss retire matching sessions. Broker close does not itself own
or delete either environment.

Worker restart closes persisted open sessions. Submitted mutations become
uncertain; no transport or tool request is fabricated or replayed. A new current
Product authorization is required for a new physical session.

## Persistence and observability

`workspace-tool-broker.sqlite` is a dedicated current-schema Worker database.
It stores only binding identities/digests, generations, request IDs/digests,
operation names, state/certainty, safe process identity, byte counts, duration,
and typed error codes. It does not store paths, queries, commands, file content,
stdout/stderr, or results. Stale schema versions are rejected rather than
converted.

Product receives bounded activity metadata only. Product/PostgreSQL gains no
BrokerSession entity and no raw tool payload. Harness Control remains the
separate authority for lifecycle, `qe_complete_step`, and blocking
HumanAttention.

## Deterministic and physical evidence

Focused deterministic tests cover strict codecs, forbidden authority fields,
all seven operations, policy and workspace denial, symlink/traversal
containment, request limits, read concurrency, mutation serialization,
cancellation races, duplicate/replay behavior, ambiguous mutation fencing,
account/Run/Worker generation fences, two-account/two-Run binding isolation,
restart closure, and safe SQLite contents.

The explicit physical command is:

```sh
cd workers/bun
QE_LIVE_SBX=1 bun test test/workspace-tool-broker-sbx-live.test.ts
```

The 2026-10-14 proof passed with simultaneous disposable Linux SBXs and no
provider activity. The retained run reported these exact ephemeral identities
before cleanup:

- ProviderAccount SBX/environment `69b7cfd8-7f61-42db-9a91-44bfdb72efea`,
  incarnation `9f74c444-f2c1-4871-b627-ceed9fdcf59c`;
- Run SBX/environment `add1a178-506a-4dbd-975f-cb9d44461fd5`, incarnation
  `3b76e136-48ed-4961-bc51-b3fd076006b8`;
- PhysicalLineage fixture `physical-lineage-live`.

The proof established distinct environment identities and namespaces, account
and Run canary separation, seven-operation account-client → Worker → Run
routing, Run-only shell cwd/HOME/canary visibility, bounded write/edit/search,
network-isolated broker subprocesses in both directions, safe activity records,
Worker/backend restart reconciliation, rejection of the stale session, a new
binding after restart, Run removal while the account environment and canary
remained live, and separate final account cleanup. The test uses the repository's
credential-free disposable SBX fixture profile so it cannot authenticate or
contact a provider; production authority resolution and current Run-context
binding are covered separately by deterministic Product and Worker tests.

## Phase-D integration

Phase D adds the immutable managed Mod, exact Claude-native mapping, dispatch/account admission authority, startup attestation, durable native-session ownership, fake-provider request capture, and a production-profile physical two-cell proof. See [`claude-code-managed-mod.md`](claude-code-managed-mod.md). The broker itself remains provider-neutral. No real authentication, external provider request, or model turn was used for acceptance.
