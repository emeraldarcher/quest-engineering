# Claude 2.1.292: queued to started (static investigation)

## Conclusion and limits

**F — actual native wait remains unresolved; no source-proven QE invocation or
probe defect.** The source narrows the interval substantially, but does not
identify which await the sixth failed Run actually reached. This is the
**investigation** classification; that Run remains diagnostic outcome **C**,
operational **FAILED**, without retrospective reclassification. No production
fix is justified. In particular, do not add initialize, claim, EOF, a flag, another
probe, a timeout extension, or a version upgrade as a speculative remedy.

The important correction to an intuitive lifecycle interpretation is:

> `queued → started` is not simply `enqueue → dequeue`. Native code dequeues
> a batch, then does first-command/plugin/MCP/mount joins, then commits it,
> then emits `started`.

Thus queued-only output does **not** establish that the command was still in
the queue at timeout. Nor does it prove Mod entry, false-query processing,
model initialization, or readiness.

This investigation uses the pinned executable as **data**, never as a program.
TypeScript parses/prints declarations; no extracted vendor code or SDK runtime
is imported, evaluated, or executed. Synthetic tests exercise QE's existing
writer with an in-memory write stub. No service, SBX, account, provider, or
completed-Run native-output inspection is involved.

The retained evidence is one probe-correlated queued event, no other lifecycle
state, no init, and timeout. The 198-byte relay stdout growth is aggregate
relay-read activity, not a measured per-object size. These findings do not
identify the earlier PR57 unknown object. All six failed Runs remain failed;
this investigation authorizes no further operational work or inference.

## Provenance

- Repository baseline: `78c41b9b185774bf107202188270a3d4d26c377e` (merged PR58).
- Native artifact: `.pi/tmp/claude-mods-reassessment/packages/linux-arm64/claude`.
- SHA-256: `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`.
- Claude `2.1.292`; public SDK declarations `0.3.292` are not the complete raw
  native protocol. Nothing here changes either pin.
- External working evidence:
  `/Users/kylec/.qe-investigations/claude-queued-started-20261027T062822Z`.
- Prior extraction provenance:
  `/Users/kylec/.qe-investigations/claude-attestation-20261021T065529Z-1ddfbeb76d/static-index.json`.
  Every used module is byte-compared with its indexed slice of the hashed
  executable before parsing. Module offsets below are UTF-8 bytes, not JS
  character offsets. The external `index.json` also records declaration offsets.
  `export-audit.json` independently checks unique AST-named exporters for 15
  cross-module helpers; it does not claim to reconstruct the BunFS filename table.

| Segment | Binary byte offset | Main relevant declarations |
|---|---:|---|
| 0025 | 202911669 | `LC`, `wPt`, `vPt`, spare-claim state |
| 0080 | 204125418 | `Jw`, `tr`, `m0`, `fJ`, `CF`, control schemas |
| 0149 | 206314929 | `qA`, `sx`, `zt`, `Rhe`, hook-chain budgets |
| 0320 | 210623439 | `TMe`, `Xie`, MCP budgets |
| 0384 | 210919888 | `_4r`, `Pm`, `U6`, `pK`, `Hce`, hook sites, shutdown |
| 0513 | 217944818 | `p5e`, init construction |
| 0607 | 219284037 | `K4`, Mod session-start head gate |
| 0619 | 219548119 | `$Bn`, normal completed/cancelled terminal selection |
| 0688 | 220574923 | `cxr`, conditional startup initialize/claim; `Bd` first-line parser |
| 0706 | 220845514 | CLI option declarations |
| 1488 | 230893314 | `Sn`, `ikr`, Mod session-start lifetime |
| 1510 | 231539207 | `XOr`, `zDt`, inbound shutdown/discard state |
| 1691 | 236443249 | `lue.processLine`, local incremental stdin reader |
| 1705 | 236669218 | `IF`, `Lm`, `zm`, `Vm`, `wm`, `pp`, `mp`, `Jm`, `Mp`, `Pv` |

For particularly useful exact references, segment 1705 declaration byte offsets
are: `wm` 48433; `Lm` 64523; `Vm` 90005; `uu` 95053; `zm` 96295;
`pp` 125751; `Mp` 161804; `Pv` 282507; `IF` 430670.
These offsets are relative to the module, not additional executable entry points.

## 1. Input, admission, and the exact queued producer

For this configured local stdio path:

1. `lue` incrementally reads LF-delimited JSON; `MEt` performs compatibility
   normalization, not complete input-schema validation. The local reader
   checks the user role; later intake performs a partial content check.
   `Jw/tr` describe a larger contract than the checks actually performed on
   every input frame.
2. `IF` rejects/ignores other types, malformed content, replay-only frames,
   duplicates and unclaimed-spare input as applicable. `ry` is deliberately a
   limited malformed-content check, not full schema attestation.
3. On the ordinary user branch, `Y(true)` resolves `Lo` and marks host default
   initialization. Duplicate checking can await transcript state. The local
   content path does not do remote rewriting. Origin/peer policy, attachment
   materialization and admission run before the normal enqueue.
4. `IF` reads `x.shouldQuery` for `nko`, and copies it into the command's
   `shouldQuery` field. `client_composed:true` selects skip-slash/attachment
   behavior; `isSynthetic:true` becomes `isMeta:true`. These fields do not
   make the command passive or set an alternate thread ID.
5. `Lm.acceptUserFrame` may park the frame behind the admission barrier,
   previous parked delivery, or a first-turn gate. `Lm.deliver` awaits an
   asynchronous admission result if needed and returns without enqueue when
   rejected.
6. On acceptance, `deliver` annotates timing, calls
   `messageQueue.enqueue(command)`, runs queueing/after-enqueue callbacks,
   and, when inbound `uuid !== undefined`, calls
   `io.onCommandLifecycle(uuid, "queued")`. It then records internal telemetry,
   runs `beforeKick`, and explicitly kicks the consumer.
7. The local lifecycle callback (`yF/hF`) writes a flat `command_lifecycle`
   object. `command_uuid` is the client input's `uuid`; the frame's own `uuid`
   is a distinct native event ID, and `session_id` comes from native session
   context. QE compares only the approved command operand ephemerally and
   retains the bounded result, not those emitted IDs.

On this source path, seeing queued is stronger than stdin delivery: enqueue
and admission have happened. Reading/copying `shouldQuery` before enqueue is
source-supported; **honoring its false-query execution semantics is later**.
A diagnostic event alone is not a validation of the entire input or its
session binding. Other lifecycle producers exist (including seeded summons),
but QE supplies no seeded-summon/origin envelope; those are not this probe's
configured route.

## 2. Queue eligibility, wakeup, selection, and started

`_4r` owns the queue, snapshots, subscription notifications, removals and
pending cancellations. Enqueue updates the snapshot and notifies subscribers.
`Lm.deliver` also explicitly invokes the `IF` kick:

```
So = () => Gc.run().catch(uh)
```

This local kick is **not** a use of the generic `mO` promise-chain utility.
`zm.run` synchronously tests/sets `drain.running` before awaiting entry joins,
so another kick can return while the current drain is already active. Other
queue/idle/release paths can re-kick. No new input, EOF or initialize is
required merely to wake this normally enqueued prompt.

`Pm` accepts main-thread, non-passive queue work; it does not reject
`shouldQuery:false`. The command built from QE's frame is a prompt on `Ke()`
and has no passive flag. `isMeta` is not the eligibility predicate.

Consumer order (all joins are inside native code):

```
run guards → running=true → pp.beforeDrain entry joins → openRun
→ pp.loopTop refresh → prior-turn summary join
→ uu.waitForHead (Mod session-start gate)
→ prior-turn summary / handed-off-model barrier recheck
→ Vm.take: select/dequeue, followers, cancellation check, park batch
→ first batch: pp.firstCommand (plugin refresh / MCP prewait / mount)
→ turn mount join → SDK first-query MCP join → deferred named MCP join
→ torn-down check → wire tool pool → Vm.commit (cancellation recheck)
→ host onCommitted → Vm.start → wm.startBatch → started
→ arm → afterArm → beforeTurn gate → Mp.run → engine submitMessage
```

`Gm`'s session-start bypass requires `Pm(command) && vAe(command.uuid)`:
ownership recorded by the active session-start machinery, not simply a
synthetic/meta flag. A plain Worker-originated probe does not acquire that
ownership by supplying `isSynthetic:true`.

Special queue selection handles orphaned permissions, handoffs, poll work,
followers, and task-notification coalescing. These are not required input
fields missing from QE's plain fresh probe. A removed/cancelled batch need
not start. Synchronous selection/tool wiring can also throw; observing no
started does not uniquely prove a pending promise.

`started` itself is still not init, model execution or inference. It precedes
arm/after-arm/turn-gate waits and actual engine processing.

## 3. Gate matrix and what remains possible

“Applicable” below means reachable in the configured path, not observed in the
failed process. Internal state was not captured. Native telemetry/debug text
is not retained or proposed as an approved capture channel.

| Boundary/gate | Resolution/failure behavior | Applicability and evidence limit |
|---|---|---|
| CLI startup/config/profile/plugin loading, initial session/history setup | Startup routines finish or error before this intake producer is available. Some startup work remains deferred. | The initial path needed to expose `IF/Lm` was reached; not proof all deferred work finished. |
| `--await-initialize` first-line gate | Only enabled by that option; `cxr/Bd` then require initialize as the first line. | QE does not enable it. Adding it would create a prerequisite, not repair a proven missing prerequisite. |
| `--await-claim` spare state | Only spare mode requires `claim_session`; unclaimed input is rejected before normal enqueue, with an error result/completion path. | QE does not enable it; observed normal queued contradicts being stopped at that rejection on this path. |
| Input duplicate/content/origin/attachments/admission parking | `IF/Lm` checks and promises finish before normal queued. Refusal can produce terminal acknowledgement without normal enqueue. | Already passed for this enqueued command, subject to the producer/path qualification above. |
| Kick/run guards | `zm.run` returns when another drain is running, stopping/shutdown is active, or end-session has no eligible end-session head. | Queued does not prove its explicit kick passed these guards. Another active drain can own an earlier unresolved join. This is not an additional input prerequisite. |
| `pp.beforeDrain`: deferred commands / parked-permission retirement | Await stored joins/retirement confirmation if present. | The same initial `Wa` is awaited before the input loop, so its initial unresolved state cannot explain a later queued frame. Fresh non-resume QE does not intentionally restore a parked permission. Other runtime state is not measured. |
| Entry SDK-MCP update | Local path still calls/awaits `updateSdkMcp()`. SDK transport has different bounded/retry policies. | No SDK URL does **not** eliminate the local update call. Empty declared MCP configuration avoids assuming a required external server, but is not a receipt that the helper returned. |
| Claim/new-plugin session-start hooks | Await the returned hook promises when present. | Spare claim path absent; plugin-added hooks/deferred work remain source-level possibilities. Distinct from the Mod `session.start` event below. |
| Skills synchronization / commands refresh | Await sync and command refresh, conditionally fold with plugin rescan. | Skills disabled/no skills reported is not a runtime observation of each helper. Source flags narrow branches; they do not prove completed promises. |
| Deferred plugin startup | Resolve pending plugin sync, refresh plugin state/commands/MCP differences as needed. | Source has a plugin install synchronization budget (default 30s), but it is not QE's 30s budget nor a bound on every subsequent refresh. |
| `pp.loopTop` refresh | Conditional plugin/background refresh and newly installed plugin hooks; catches/logs failures on that refresh path. | Background refresh is not requested by QE's allowlist. Deferred initial/plugin synchronization may still set refresh state. |
| Mod `session.start` queue-head gate | `K4 = () => pK.get() ? U6.get() : undefined`; `uu` waits on it while ordinary work exists and no permitted bypass head exists. `TC` races the promise with queue notifications, unsubscribes, then rechecks. | A concrete source-supported **pre-dequeue** wait, not proven to be the actual stall. `ikr` sets the set/promise; `Sn` awaits module registration/loading then raises `RZ().session.start`. `pK` is cleared in `finally`. |
| Earlier-turn summary / handoff-model barrier | Await outstanding summary or `YO.tail` for handed-off run work. | Not an initialize handshake. No prior authorized turn or handoff is configured for this fresh probe; do not invent hidden runtime state to select this cause. |
| Pending plugin registry refresh after `Vm.take` | Join `pendingPluginRefresh()` if present, then note joined state. | A concrete possible **post-dequeue/pre-started** wait. |
| First-command MCP prewait | Wait initial prewait or recalculate for changed/pending/required server sets, then mount join. `nl` uses state subscriptions/deadlines. | False-query does not bypass this first-command routine. Default `Xie` is 2s; connect helper `TMe` defaults to 5s. Different settings/required/permission-server cases exist. No new QE timeout is implied. |
| First-command/project mounts and grants | Await only when mount/host join objects exist; helper-specific bounds apply. | Projects/remote host features are not requested by the QE invocation. Must not enable them as a guessed fix. |
| `mp.join` SDK first-query server join | Skips without SDK URL, when joined, or when `shouldQuery === false`; otherwise bounds server wait. | Excluded by both relevant QE conditions. This skip does not bypass the earlier local update or first-command prewait. |
| `Jm.join` deferred/named MCP wait | No-op for no relevant names/no pending work/expired deadline or applicable request-start conditions; otherwise bounded named-server wait. | Exact empty QE server declarations remove a known required named server; dynamic internal state was not sampled. |
| Wire tool pool / commit / callbacks | Synchronous build/registration and cancel-pending filtering before ledger start. | Could reject/throw/remove work; not another required wire field. A queue-only observation does not exclude these alternatives or output/observer loss. |
| After-arm Mod retirement / worker-directory / before-turn gate | Await existing joins or fail; occurs **after** ledger started. | Not a normal explanation of an intact ordered queued-only stream. Missing observations are not absolute proof these instructions never ran. |
| Engine input/system prompt/transcript/init construction | `Pv` can await cwd, prompt construction, user processing, persistence, tool refresh and init helpers. | Also after started on the audited path. No init alone would not localize a stall here; the missing started narrows the source interval. |

Some gates have no end-to-end bound in the immediate caller. Others delegate
to bounded helpers. Neither fact establishes that a promise was actually
pending. A thrown error in `beforeDrain` is handled by the enclosing kick's
`uh` error path; do not invent a silently swallowed `mO` error as this cause.
There is no source-established global guarantee that all these joins plus
init complete within QE's post-ACK 30 seconds.

### The QE Mod specifically

`ikr/Sn` raises a Mod `session.start` event separately from SDK initialize and
from configured shell `SessionStart` hooks. The pinned QE handler:

- marks itself not ready;
- awaits protocol/model/effort environment reads and native session ID;
- validates the environment;
- awaits eight tool registrations;
- marks ready, then delegates with `$.next`.

The source therefore supplies real awaits that could delay the native gate;
it does **not** show a necessary dependency on a future user turn, initialize,
claim, EOF, provider request, or a queued tool invocation that would form a
proven circular wait. API calls/registrations here are not model tool uses.
The handler being registered, entered, finishing an API call, becoming ready,
and returning through the rest of the hook chain are distinct milestones.
None was measured in the failed process.

The native hook runner has a default 10,000ms per-handler budget (`Rhe`),
per-handler overrides, paused downstream accounting and separate abort/grace
handling. Core handlers can have budget zero. It is incorrect to infer an
end-to-end Mod/startup wall-clock bound of ten seconds from that constant.
`Sn` catches/logs event failure; loading and the surrounding chain are also
part of its lifetime. Internal logs/failures do not guarantee an allowed stdout
frame at the exact pre-start wait. This is a candidate gate, not a Mod defect.

## 4. Init, false-query, and lifecycle ordering

`Mp.run` calls the engine only after the ledger emits started. In `Pv.sa`,
`shouldQuery:false` skips model-facts admission, is passed into user processing,
and makes `Ur = processed.shouldQuery && options.shouldQuery !== false` false.
On the normal fresh route, native code awaits `us → kv → p5e`, yields
`system/init`, and only then takes the `!Ur` branch. That branch emits a
zero-turn success and returns **before** `be.enqueue` into the model engine.
There are startup/prompt/transcript awaits before init, not a promise of
immediate init upon receiving the user frame.

Normal successful ordering for this route is therefore:

```
queued → [all pre-start work] → started
→ [after-arm/turn/engine preparation] → system/init
→ zero-turn success → normal completed settlement
```

Lifecycle schema descriptions are not a universal state-machine enforcement.
Duplicates or malformed/dropped inputs can be acknowledged as completed
without started; cancellation/removal can end work before started; seeded,
peer, workflow and engine-forwarded producers have their own contexts.

| Lifecycle state | Relevant producer/meaning |
|---|---|
| queued | Normal `Lm.deliver`: enqueued admitted frame with inbound UUID. Other configured routes can also produce it. |
| started | `Vm.start → wm.startBatch`: selected/committed batch begins; not init or model progress. |
| completed | `wm.settleBatch` normal terminal selection; delivered poll bookkeeping can force completed. Duplicate/malformed/workflow acknowledgements can emit completion independently of normal turn execution. |
| cancelled | Pending cancellation consumed during selection/commit; host queued-message cancellation; interrupt queue clearing; aborted/cancellation terminal settlement or forwarded engine lifecycle. Not every signal/shutdown must emit it. |
| discarded | `_F` awaits inbound shutdown (`zDt`) then `XS` drains matching `Tp` queue work and emits discarded for each defined UUID. `ud/oT → _T` also chooses discarded when `XOr()` reports inbound shutting down. Not evidence that a model ran. |
| refused | `ud/oT → _T` chooses refused when inbound is not shutting down; called on policy/receive/admission rejection or dropped peer work. Not a guaranteed next transition from every queued command. |

## 5. Field-by-field QE probe comparison

The existing `sendMessage` test builds this shape using only synthetic IDs;
no historical probe operand or emitted native identifier is read or stored.
Compact UTF-8 JSON is 300 bytes plus one LF = **301 bytes**, with the existing
60-byte fixed text. Both UUID-shaped input fields are 36 ASCII characters.

| QE field | Pinned native contract / configured processing | Finding |
|---|---|---|
| `type: "user"` | `Jw` user discriminator; local intake selects user branch. | Match. No outer RPC/event envelope. |
| `message.role: "user"` | User-message role checked by local parser and represented by `m0`. | Match. |
| `message.content` fixed text string | Native permits string content (also block-array variants). Local non-remote input preserves it. | Match; not a slash command, attachment or model request. |
| `parent_tool_use_id: null` | Required nullable parent field in `Jw`. | Match; not a tool-result/subagent reply. |
| `session_id` Worker-reserved session UUID | Optional input field in `tr`; native output uses current native session context. QE also supplies the owned CLI `--session-id`. | No missing prerequisite. Echo/input presence is not readiness/session attestation. |
| `uuid` fresh Worker-owned v4 UUID | Optional input identity in `tr`; normal queued/started refer to it as output `command_uuid`. | Correct field name; do not send `command_uuid` as a substitute input field. |
| `client_composed: true` | Optional true literal; maps to no slash dispatch and skipped attachment expansion. | Match; does not suppress queue eligibility or init. |
| `shouldQuery: false` | Optional boolean, explicitly documented for transcript-only input. Copied through command/engine options; used in the `!Ur` guard. | Supported; not proven honored merely by queued. |
| `isSynthetic: true` | Optional boolean; translated to meta input. | Supported; meta is not passive. |
| one final LF, stdin remains open | One JSON object per line; local reader delivers complete lines incrementally. | Match. EOF is session finish/drain/exit, not a prerequisite for dispatch. |

No protocol version, initialize request, claim, acknowledgement response,
priority, origin, tool list, or extra marker is mandatory on this ordinary
user frame. Security/model/tool configuration comes from the existing pinned
invocation/settings/Mod and is still separately attested by QE. Full native
schema validity and runtime input admission are not interchangeable claims.

`fJ` explicitly documents optional initialize/default initialization on first
user input. The concrete `IF` default path agrees. Later initialize can answer
current state but does not replay all one-time startup configuration. An
initialize carrying launch-only plugins requires the conditional startup mode;
QE already configures its pinned plugin through managed settings. Claim is
only for a process deliberately launched as an unclaimed spare. A successful
zero-query route needs neither handshake in the configured ordinary mode.

## 6. Cancellation and why no terminal lifecycle was observed

QE readiness failure calls `cancelClaudePreparation → process.cancel` while
stopping its relay/broker; the production SBX cancellation path requests
SIGTERM. This is **not** the native `cancel_async_message` control request.
The native `IF` SIGTERM handler aborts its read/shutdown controller and calls
`Qn(143)`. `zm.teardown` freezes terminal forwarding and aborts a current turn
controller if one exists. Pre-start work may not yet have a turn controller.
`wm` suppresses completed/cancelled forwarding once frozen. Normal teardown,
output closure and physical cancellation can race.

Therefore an exit of 143 with no cancelled/discarded/completed observation is
consistent with normal physical cancellation; it does not prove a lost
cancellation, queue removal, receipt by an internal control handler, or exact
location of an unresolved await. Exit I/O remained unavailable:busy; do not
invent terminal byte totals or a final pre-cancel census.

## 7. Original smallest diagnostic proposal — source-investigation record

This section records the original docs/tests-only proposal. Its subsequent
Worker implementation is documented in [timeout queue diagnostics](claude-timeout-queue-diagnostic.md).
That implementation does not establish the actual wait of any retained Run.

There is no source-proven production correction. A full native phase snapshot
would be more informative, but no reviewed existing local read-only control
returns `turnStartClock`/`runPhase` with the individual pending join. Raw debug
logs, arbitrary metadata, telemetry, tracing and signal stacks are not safe
substitutes. A simple settings response would prove only control-loop
responsiveness, not locate this boundary.

A smaller **separately reviewed diagnostic cancellation** can partition the
interval without patching the native executable or changing any profile pin:

- At the *existing* readiness-timeout cancellation boundary, best-effort send
  **one** native `cancel_async_message` control targeting the Worker-owned
  probe UUID, alongside—not instead of or delaying—the existing physical
  cancellation. No new probe or retry; no additional response wait/budget.
- The exact existing request schema is `message_uuid` under
  `request.subtype:"cancel_async_message"`; response payload is
  `{cancelled:boolean}`. `IF`'s local host handler calls `Bp` synchronously.
- `Bp` removes matching physical queue entries. When none exists (and no
  fold-in-flight exists), host cancellation only marks cancellation pending;
  it returns false. `Vm.commit` consumes that pending cancellation before
  ledger started. It does not release startup gates or initiate a model turn.
- Correlate the response only to a fresh Worker-owned control request and the
  exact still-owned preparation/process. Keep approved booleans/counters only:
  write ACK/unavailable, correlated response true/false/unavailable, and any
  newly observed reviewed lifecycle states. Never retain operands, raw frames,
  request IDs, native IDs, hashes or response prose. No persistent event field
  may contain the probe UUID.
- A correlated **true** proves matching work was physically queued at handler
  time. A correlated **false** proves this handler did not remove such queued
  work; it is compatible with a dequeued pre-start batch, prior removal,
  completion, or fold-in-flight—not a unique gate diagnosis. No reply means
  unavailable, not false. Handler time is after timeout, not a retrospective
  sample of every earlier instant.
- SIGTERM may win the race, making the result unavailable. This must not delay
  cancellation, extend readiness, add a second budget, or change failure/uncertain
  settlement. Without permission for this best-effort additional stdin write,
  do not send it. A later bounded response observation is not a reason to keep
  a process alive.

This diagnostic **does not identify every individual await**. It is the
smallest existing-control partition of “still enqueued” versus “not removed
from the queue.” Further exact phase localization would need separately
reviewed native instrumentation/support; QE-side lifecycle counts cannot
manufacture that information.

Crucially, the current lifecycle recorder's private probe binding is
**comparison-only, non-authoritative**. Do not repurpose that diagnostic
binding as cancellation authority. Any future implementation needs a distinct
operation-scoped owned-command capability held by the protocol/preparation
owner, existing physical authority checks, and deterministic negative tests
for stale/mismatched ownership. This design was not implemented in the original
source-only commit and provides no execution authorization.

## 8. Deterministic validation and unchanged authority

`workers/bun/test/claude-queued-started-source.test.ts` adds:

- always-on synthetic exact wire/301-byte and invocation-mode assertions;
- optional-local-artifact static source assertions, pinned by full executable
  SHA and exact module byte slices;
- source order checks for enqueue/queued/kick, dequeue/joins/commit/started,
  default initialization, Mod head-gate lifetime, false-query init/return,
  pending cancellation and shutdown behavior.

Native-source checks explicitly skip when the optional cached artifact is
absent; a mismatch fails, not skips. All native-source checks were exercised
in this investigation. They test **source facts**, not execution of vendor
logic or successful native readiness. Existing deterministic parser, census,
privacy, init/effort and adapter tests remain the executable behavior checks.
No source-only test can establish the failed process's actual stack/wait.

In the original source-investigation commit, only this document and its new
test changed. The subsequent diagnostic implementation is separately reviewable.
The original investigation left production adapter/protocol,
Mod/profile/settings/binary/SDK/image pins, auth/provenance, Worker protocol,
ownership/relay versions, 30,000ms shared readiness budget, 3,000ms fail-open
pre-probe capture, full init/model/high-effort proof, Product confirmation and
inference gates unchanged. Historical evidence is not reclassified,
repaired, zero-filled, migrated or cleaned up. No seventh Run is authorized.

Related: [protocol investigation](claude-protocol-schema-investigation.md),
[structural diagnostics](claude-output-structure-diagnostics.md),
[managed lifecycle diagnostics](managed-harness-lifecycle-diagnostics.md),
[effort readiness](claude-effort-readiness.md).
