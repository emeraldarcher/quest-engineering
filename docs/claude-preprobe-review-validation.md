# Pre-probe review-fix validation boundary

Original candidate: `79f004ddbe58e07fabbaea6c60a0a79ef575b4c1` (not amended).

## Prior boundary incident (append-only review note)

The previous adversarial review mistakenly selected
`workers/bun/test/claude-code-request-boundary.test.ts`. That test executes native
Claude with query-enabled inputs against a local fake HTTP endpoint. Therefore
that review's `498 pass` result cannot certify a zero-Claude boundary. It did not
create a managed Quest/Run or consume the seventh Phase E Run allowance. This
note does not rewrite retained evidence or claim the previous review had no
Claude activity. This review-fix validation excludes that test entirely.

## Explicit allowlist — inspected before execution

Paths below are relative to `workers/bun/test/`. Selection is explicit, never a
test-directory glob. Imports and execution sites were inspected: the only launch
in the selected new relay path is intercepted with an in-memory Bun.spawn spy;
no production Worker is constructed. A preload tripwire denies Bun/node process
launchers and fetch even if an unexpected path is reached. Restoring a spy
restores the denial, not the real launcher.

| File | Reviewed execution boundary |
|---|---|
| `claude-queued-probe-cancellation.test.ts` | Synthetic processes, virtual clocks, memory SQLite, canary logging only. |
| `claude-preprobe-capabilities.test.ts` | Fake manager transports; open() uses an in-memory Bun.spawn spy; Worker callback AST bodies only. |
| `claude-code-adapter.test.ts` | Fake account lease/auth/mailbox/broker/Run manager; synthetic streams or intercepted relay input. No actual account manager or native spawn. |
| `claude-product-preprobe-wire.test.ts` | Reads freshly generated isolated Product wire JSON; actual decoder/registry; only memory-only receipt AST bodies. |
| `streamed-process.test.ts` | FakeEnvironmentBackend/FakeStreamedProcessTransport only; executable strings are data. |
| `streamed-process-io.test.ts` | Fake transports and injected validators only. |
| `harness-lifecycle-diagnostics.test.ts` | Content-free projections and memory SQLite only. |
| `claude-output-census-schema.test.ts` | TypeScript parsing of SDK declaration files; no runtime SDK import. |
| `claude-output-structure.test.ts` | Synthetic stream/parser/census and memory SQLite only. |
| `claude-output-tags.test.ts` | Structural decoder and TypeScript declaration parsing only. |
| `claude-code-protocol.test.ts` | Synthetic streams; unchanged Mod register hook with fake Engine services whose process.run throws. |
| `claude-protocol-schema-audit.test.ts` | Synthetic frames and pure invocation builder; executable path is data. |
| `claude-queued-started-source.test.ts` | Pinned artifact bytes hashed and parsed, never executed; synthetic wire writer. |
| `queued-diagnostic-transport.test.ts` | Synthetic constructors/FileSink/manager and memory-only Worker AST bodies; **exclude the Python-interpreter test named below**. |

Product allowlist: only tests tagged `preprobe_product_wire` in
`apps/quest_engineering_server/test/quest_engineering_server/launch_scheduling_test.exs`.
These use the actual Product launch/scheduler, OperationalRecovery attribution and
recovery methods, persisted execution codec, and WorkerProtocol serializer in SQL
sandbox fixtures. Background services are disabled by test configuration. No
Worker connection is activated; no dispatcher or external process is used.
Use only the dedicated `quest_engineering_preprobe_review_test` database; never
an operational database. The fixtures are test entities, not live managed Runs.
Generated JSON is private temporary test data, not historical operational data.
`QE_PREPROBE_WIRE_DIR` enables the cross-language tests in Worker-only test runs;
without it they are explicitly skipped, not replaced by manual fixtures. The
review runner always generates the files and sets this variable; missing files
then fail rather than silently skipping any required proof.

## Explicit exclusions

- `claude-code-request-boundary.test.ts`: native Claude, including query-enabled input, even with a fake provider.
- `claude-agent-sdk-adapter.test.ts`, `claude-agent-sdk-wrapper.test.ts`: outside this reviewed runtime-SDK-free allowlist.
- `queued-diagnostic-transport.test.ts` test `guest diagnostic function is nonblocking, bounded, atomic, and never sends an ACK ahead of CANCEL`: launches Python to execute an extracted helper. Excluded conservatively; static relay AST/source comparison is separate.
- `sbx-streamed-process-relay.test.ts` and `sbx-streamed-process-io-relay.test.ts`: launch Python/real target boundary fixtures; excluded.
- Relevant live/infrastructure files explicitly excluded: `claude-attestation-lifecycle-sbx-live.test.ts`, `claude-code-two-cell-sbx-live.test.ts`, `claude-effort-readiness-sbx-live.test.ts`, `claude-output-structure-sbx-live.test.ts`, `sbx-claude-agent-sdk-live.test.ts`, `sbx-streamed-process-live.test.ts`, `streamed-process-io-sbx-live.test.ts`, `provider-account-runtime-sbx-live.test.ts`, `provider-account-setup-live.test.ts`, and `historical-claude-containment-sbx-live.test.ts`.
- Other `*-live.test.ts`, `*-sbx-live.test.ts`, `sbx-*`, `herdr-*`, credential/setup/inventory and provider runtime suites are not allowlisted. Their execution boundary is not relied upon or discovered by running them. In particular `sbx-streamed-process-transport.test.ts` is conservatively outside this audited set; the new combined test exercises its necessary production path with intercepted launch instead.
- All other Product tests in the scheduling file: not selected; some intentionally use fake WorkerConnections activation or protocol delivery, unnecessary for this proof.

The clean run total must be computed from this validation only, not the earlier
498 result. Separate reruns of adversarial subsets must not be double-counted.
Python relay auditing is static AST parsing/source comparison only. Pinned Claude
verification is hash/static-source parsing only, never executable invocation.

## Authority and lifetime audit

- Worker `freshDiagnosticActions` contains only canonical Action IDs and local /
  server epoch strings, at most 4096 entries. The actual production acceptance
  branch requires `acceptance.created`, Claude Code, current readiness and current
  connection. The consuming constructor callback deletes before returning. No
  database/wire field restores the map. Reopening a real registry and duplicate
  acceptance do not mint receipts. A receipt can establish local fresh eligibility,
  not a native target, active-process ownership or inference permission.
- Harness `diagnosticPreparations` is a separate at-most-4096 identity map: Action
  key → fresh object containing its canonical lineage ID. The closure checks object
  identity, not merely IDs. It is established before `runManager.prepare` awaits,
  replaced/revoked by lineage lifecycle operations, deleted on matching Action
  revocation, cleared globally, and removed in `finally` without deleting a newer
  entry. Unrelated Action cancellation cannot delete it.
- Worker disconnect/supersession clears receipts and calls synchronous harness
  revocation before asynchronous retirement. Captured epochs are compared again
  after suspension and at writer entry; a newer epoch cannot lend authority to an
  old marker. Terminal hooks revoke matching authority before their cleanup await.
- Deferred preparation/Promise callbacks may retain normal JS references to
  dispatch/account/process/session until they settle. Revoked map identity and
  current-epoch checks prevent their use as diagnostic authority. Failed
  preparation clears the marker but cannot remint its consumed receipt.
- The gate's process/handle/current/publish operands and timeout capability operands
  are ECMAScript-private and cleared by invalidation. Existing clone/JSON/inspection
  canaries pass. The new marker/receipt maps contain no native probe operand;
  their canonical IDs are ordinary existing Product/Worker identity, not new
  diagnostic evidence. Only closed capability/cancellation enums enter evidence.
- On late pre-probe failure the observer's mutable binding becomes null before
  cleanup awaits. Its queue is closed and cleared; census comparison is retired
  and cannot rebind. Deferred output/exit callbacks cannot update it or authorize
  anything. The owned iterator continues draining without parsing to avoid early
  disconnect ahead of physical cancellation. If backend cancellation rejects,
  ordinary stream/queue references can remain until transport settlement; this
  is temporary reference retention, not live observation or operation authority.
  There is no secure/cryptographic memory-erasure claim.

## Product-produced versus hostile matrices

| Actual Product producer exercised | Representation / eligibility |
|---|---|
| Claude first fresh scheduling | Initial/fresh, epoch 0, first attribution, configured allowance, null source/request/retained references, fresh decoded aliases: eligible with exact new acceptance/current receipt/no prior local session. |
| Same-epoch operational retry | Same initial epoch, later attribution: ineligible. |
| Human fresh recovery after failure | New human/fresh epoch with real source Attempt/request: ineligible. |
| Retained recovery authorization | Real persisted retained session and lineage carried into the new Attempt: ineligible. This fixture uses the generic fake harness, not a claim of live Claude resumption. |
| Pre-prompt prepared-process adoption recovery | Actual Antigravity retained-recovery producer; native session absent, retained lineage/source/request present: ineligible. No invented `resume`/`rebind` wire enums. |
| Semantic logical continuation | Actual sequence completion and `continue_from` resolution, shared logical lineage/source occurrence: ineligible even with initial/first operational metadata. |

Hostile cases are explicitly separate: malformed retry/resume/rebind enums and
zero attempt/allowance reject in the real decoder; representable contradictory
retained/request references reject in the predicate. Synthetic stale receipt,
restored lineage/prior session, human source and prior-attempt mutations reject.
Worker restart/reconstruction is tested with a reopened registry, not relabeled
as a Product-generated fresh physical operation.

## Cleanup outcomes

Every covered blocked path asserts zero physical fake-transport probe bytes,
zero timeout diagnostics, zero query/prompt authorization, one spawn at most and
no retry. Malformed/duplicate READY cannot return a process: launcher cleanup
ends/kills the intercepted child once. Valid unsupported/unavailable READY and
post-baseline/epoch/marker/writer revocation invoke normal cancellation once.
Already-observed exit can reject cancel validation before transport submission.
The explicit rejected-cancellation case records requested but no ACK, retires the
observer anyway, and does **not** claim target termination. Final fake fixture
shutdown is separate from the harness's cleanup attempt.

The supported actual Product/current-READY path submits one 301-byte false-query
probe to the in-memory transport. Its timeout regression proves exactly one
operation-correlated diagnostic submission immediately before cancellation, no
query, and no inference authorization. These are simulated transport operations,
not native preparation, provider calls, or consumption of an operational Run.

## Clean validation result for the review-fix tree

Reproducer: `workers/bun/scripts/validate-claude-preprobe-review.sh`.
Final clean artifacts: `/tmp/qe-preprobe-review-release-candidate/`.

- Product: **4 passed**, 53 unrelated tests excluded; six actual Product wire
  fixtures generated in the dedicated SQL sandbox database.
- Worker: **556 passed**, zero failed, 11,786 expectations, 14 explicitly listed
  files; one intentionally filtered Python-interpreter test, no artifact skips.
- Unique clean total: **560 tests passed** (556 Worker + 4 Product). No prior
  review result is included.
- Original five PR #59 safe adversarial regressions: **5 passed** separately
  (three generation handoffs, canonical cancellation before HumanAttention await,
  and actual memory-only Worker disconnect/supersession bodies).
- Five new review-fix adversarial regressions: **5 passed** separately. Both
  five-test runs are subsets of the 556, not extra unique tests.
- Raw READY combined matrix: **27 passed**, including all required duplicate,
  escaping/nesting and malformed cases. Six further combined revocation races
  and the exact Product-probe timeout/cancellation regression passed.
- Full Worker TypeScript and Biome checks passed: 261 files, no warnings/fixes.
  Whitespace and Product formatting checks passed.
- Thirteen protected authority/wire AST declarations equal the production
  baseline; relay, timeout capability, effort validator, structural tags/census,
  and profile assets compare unchanged byte-for-byte against that baseline.
- Python relay: AST parse only, SHA-256
  `fa832fd2ced81295a762c2fb8695ca5d1dbfc7c53c384d4f5e7c7e5218b7ae91`.
- Pinned Claude Linux ARM64: static hash/source parse only; 250,798,072 bytes,
  SHA-256 `24caa9e6ff13bf227049a2626f1c816fc895023050f0ec3b12dbf14d897367e0`.
- Pinned Claude Linux x64: static hash only; 251,456,696 bytes,
  SHA-256 `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3`.

This task used no native Claude/Agent SDK execution, provider/model/login or
inference activity, real SBX, live native preparation/probe/diagnostic, Worker
activation/restart/rejoin, account reconciliation/inventory or seventh managed
Run. Isolated Product fixture Quests/Runs are not live operational entities.
The six failed Runs and retained operational evidence were not accessed/modified.
No push or merge occurred. This is a reviewable implementation result, not
permission for operational use; a new adversarial review is still required.

## Final adversarial review: synchronous error-revocation correction

The final review found another concrete race in `30b748a4`: the relay could
observe an unexpected control frame or frame-reader failure and then await
asynchronous error publication while `negotiatedCapabilities()` still returned
`supported`. With writer validation suspended and error publication held, both
error paths permitted **one fake-transport probe write** on the old source. This
was reproduced using the actual parser, transport, manager and adapter; no native
process was launched. Historical frozen snapshots were not the cause: even a new
live capability read was stale during this publication window.

The narrow correction retires negotiation synchronously before either transport
error-publication await. It changes no timeout, cancellation, wire, readiness,
receipt or Product policy. Two transport tests hold error publication and require
unavailable support/zero diagnostic writes; two combined Product/READY/manager/
adapter tests hold both validation and publication and require zero probe bytes.
The prior original candidate and review-fix commits are not amended.

The safe allowlist and exclusions above remain unchanged. Additional read-only
review experiments live under `/tmp/qe-preprobe-final-adversarial/`, outside the
repository: `scanner-review.test.ts` covers 38 escaping/structure/boundary cases;
`adapter-review.test.ts` runs nine new cases for individually revoked writer
operands, delayed validation after teardown, and simultaneous Action-keyed
receipts/swapped Attempt conflicts. Only their `^final-review` tests are selected;
all copied baseline adapter tests are filtered out. They use the same no-native
preload. The negative `transport-error-review.test.ts` and
`before-fix-adapter.test.ts` reproductions are defect evidence, not clean PASS
counts. The latter loads an immutable `30b748a4` transport source copy and confirms
one prohibited fake probe in each of the two error-publication races.

Post-correction validation: **560 Worker + 4 Product = 564 unique tests passed**;
47 additional temporary review cases passed, for **611 unique clean tests**.
Both five-test adversarial subsets and the four focused defect regressions are
already included in those totals, not counted again. Full TypeScript, Biome,
formatting/whitespace, authority/wire AST, unchanged relay/profile source, Python
AST-only and pinned-artifact static checks passed again. The earlier accidental
native-Claude history above remains explicit; this final review executes no
native Claude/SDK/provider/model/login/inference or operational activity.
