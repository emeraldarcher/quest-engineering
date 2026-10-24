# Content-free streamed-process I/O diagnostics

## Transport gate and scope

The production path is `EnvironmentLease.spawnStreamed` →
`SbxStreamedProcessTransport` → non-PTY `sbx exec -i` → the Worker-owned Python
relay → `subprocess.Popen(shell=False, stdin=PIPE, stdout=PIPE, stderr=PIPE,
bufsize=0)`. The relay retains `process.stdin`, the **writer** of the target's
Linux stdin pipe. A provider-free physical preflight verified that exact path,
one matching retained parent writer, and writer-side `FIONREAD=37` without reading
payload. This is not host Darwin tracing or an observer in another cell.

`StreamedProcess.observeIo()` is an internal, bounded, read-only diagnostic
capability. It neither consumes target stdio nor exposes a Product API, tool,
Runtime/admission decision, or provider-specific primitive. Unsupported backends
return typed `unavailable`; there is no fallback inspection implementation.

## Facts, identity, and bounds

An available snapshot contains the exact existing process handle, Worker receipt
time, guest observation time/monotonic elapsed milliseconds, stdin pipe unread
bytes (or a typed pipe-unavailable reason), cumulative stdout/stderr bytes read
by the guest relay, and whether that relay has observed terminal exit. It may
also contain one guest sample taken immediately before its existing cancellation
action. `terminal: not_observed` is **not a liveness assertion**.

The generic manager checks the full EnvironmentRef (backend, Worker, owner,
profile, environment ID, incarnation), process generation, backend PID/start
identity, requested/observed executable, and observed executable **device:inode**.
It validates current environment authority before and after collection using a
read-only namespace path: missing/stopped/replaced sandboxes never cause ledger
reconciliation or state updates. The guest
checks its retained Popen attachment, generation and launch-marker identity, and
rechecks live PID/start/executable identity around sampling. It checks the owned
writer's pipe type and device/inode before and after ioctl. No PID-only lookup,
reattachment, arbitrary FD reopen, executable-content hash, argv, environ, stack,
memory, socket payload, or credential inspection is performed. The marker digest
is the existing launch attestation, not a fresh marker-content read by diagnostics.
Terminal samples refer to the retained Popen/counters, not a new `/proc/PID` lookup.

There is one in-flight request per attachment and a **3,000 ms diagnostic bound**,
including both namespace validations. This is not the attestation deadline and
never adds time to its unchanged 30,000 ms budget. A hung diagnostic remains single-flight. The
relay has at most one diagnostic response thread. Responses are bounded to 8 KiB
by the Worker and to one atomic `PIPE_BUF` write by the guest. The diagnostic
sender never waits for the normal output lock or pipe space: it makes one
zero-time writable-readiness check under that lock and drops the snapshot if the
Linux pipe/channel/size/readiness contract is unavailable. It never changes FD
flags. This is a single checkpoint check, not a monitoring/polling loop.

## Where the counts are owned

Immediately after each existing `os.read(target_stdout_or_stderr, 16384)`, the
relay adds `len(chunk)` **before** binary relay framing, Worker buffering, UTF-8,
JSON, protocol recognition/validation, redaction, or discard. Invalid/binary,
partial, non-newline and stderr output all count. Native SBX wrapper stderr is
not target stderr and is not counted. These are bytes actually read by this
relay; not a claim about writes still buffered elsewhere, per-syscall write
returns, total transient activity, or complete output after attachment loss.
Counter failure/unsafe integer overflow makes diagnostics unavailable, not zero.

`FIONREAD` receives only an integer output buffer on the relay's owned writer fd.
It does not read, peek, hash, sample or copy stdin payload. Non-pipe, closed fd,
unsupported ioctl and other observation errors are typed unavailability, never
zero/default success. Stdout/stderr payloads, hashes, prefixes, suffixes, lines,
provider output and arbitrary errors do not enter new diagnostic records.

## Existing checkpoints, no authority

The [owner-accurate lifecycle diagnostics](managed-harness-lifecycle-diagnostics.md)
record at most four I/O observations in their existing SQLite JSON row:

- one bounded pre-probe baseline, after stream registration and before write request;
- after the fixed probe write ACK;
- when the existing attestation timeout fires, before ordinary cleanup is invoked;
- on existing process-exit observation (best-effort final counters and the guest's
  pre-cancellation sample).

The [pre-probe baseline](claude-output-structure-diagnostics.md) awaits one best-effort
collection, bounded at 3,000 ms before submission; failure never gates submission.
Later checkpoints remain **fire-and-forget**. Readiness after ACK and cancellation
do not await them. A request made at timeout can race cancellation or be unavailable; its
actual guest timestamp is not relabeled the exact timeout instant. Guest wall
clock/relay elapsed time and Worker checkpoint/receipt clocks are separate domains;
clock synchronization is not assumed. The guest's
optional pre-cancellation sample is captured locally before its unchanged signal
action and never gates that action. Missing observations remain `not_observed` or
typed `unavailable`; loss of a response, observer or persistence sink cannot fail
valid attestation, extend a deadline, repeat input, retry cancellation, or upgrade
readiness. Lifecycle progress remains frozen at timeout.

The persisted allowlist includes no executable paths; those are held privately
for fencing. Existing process identity includes device:inode when available.
Unknown native fields and backend errors are reconstructed into fixed categories,
not copied or redacted. No SQLite schema/migration is added.

**Interpretation:** N unread bytes followed by zero, on the same retained pipe,
proves drainage by a reader in the child process tree only. Partial drainage
proves the sampled remainder. It does not identify the reader, prove Claude
parsing, recognize `shouldQuery:false`, prove Mod loading/execution, or prove init
construction/submission. Positive output counts prove activity only, not a valid
frame. Zero/missing counts do not establish nonexecution. No I/O sample upgrades
`nativeProbeParsed`, `nativeInitConstructed`, `nativeInitSubmitted`,
`modExecution`, or `processStateAtTimeout`.

## Protocol and immutable artifact audit

The generic relay control protocol is explicitly **v2** (previously unversioned):
READY advertises `protocolVersion:2`, the relay launch receives a process
generation, and `OBSERVE_IO=23` / `IO_SNAPSHOT=14` carry versioned, nonce-correlated,
content-free control records. Existing byte/ACK/cancel/exit frames retain their
meaning. A missing/unsupported diagnostic version makes only diagnostics
unavailable; it is not a new spawn prerequisite or protocol downgrade/retry.

The changed Python relay is a separately shipped **Worker artifact**, read from
`src/execution-environment/sbx-streamed-process-relay.py` at launch, not embedded
in an immutable SBX profile/native-agent image. Deploy the Worker source/relay
atomically; the new relay bytes have a new artifact digest and v2 identity. The
previous bytes remain in Git/history. No native-agent executable, profile spec,
profile asset, base-image digest, capability grant, settings, Mod, bridge, Claude
binary, SDK pin, auth/environment policy, Worker Protocol v19, Product/Core
contract or immutable historical identity changes. No retained process/profile
is upgraded or rewritten by this change.

## Provider-free proof

Unit tests cover exact identity fences, malformed/foreign/oversized control
records, unsupported/failed ioctl, closed/non-pipe descriptors, counters before
framing, overflow, bounded requests, throwing/hung collectors, persistence loss,
canaries, and unchanged write/cancel/readiness/timeout settlement.

`QE_LIVE_SBX=1 bun test test/streamed-process-io-sbx-live.test.ts` creates a fresh
credential-free, deny-all-network broker-Run-profile infrastructure fixture. Ten
Python targets cover no/full/partial stdin reads, zero output, 17 stdout bytes,
23 stderr bytes, fragmented 17/11 totals, invalid protocol output with no frame,
validated synthetic init, sensitive canaries, and closed stdin. Local FIFO/socket
rendezvous synchronize fixtures without sleeps, monitoring, providers or Claude.
New fixtures are retained; the client guard refuses old-environment exec,
credential operations and stop/remove. Optional `QE_IO_PROOF_ROOT` places proof
outside source. Diagnostic data contains zero canary occurrences and no canary
payload hashes.

Merging this change authorizes **no** Claude execution, login, attestation retry,
provider traffic, inference, retained-state mutation, or privileged tracing. A
separately authorized fresh post-merge zero-query diagnostic preparation could
answer pipe-drainage and relay-output-activity questions when samples are
available. It would not resolve native semantic milestones by itself.
