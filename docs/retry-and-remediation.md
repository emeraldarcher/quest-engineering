# Semantic remediation and operational recovery

Quest Engineering has three independent mechanisms. Recovery always appends history.

## Semantic remediation

A Tactic `Until` owns `max_remediations`. It counts executions of the authored `otherwise` subtree, not checks and not provider Attempts. `max_remediations: 3` means an initial check followed by at most three Repair opportunities and therefore at most four Reviews. The compiler stores the bound in the immutable launch snapshot. Editing a reusable Tactic affects future launches only.

War Room calls a verdict-based Review/Repair bound **Maximum repairs**. Other Until shapes use **Maximum iterations**. The canonical Implement & Review starter remains an ordinary authored Tactic with three repairs. Exhaustion is the semantic `until_exhausted` outcome, surfaces as Review/remediation exhaustion, blocks Delivery, and never triggers an operational retry.

## Operational Attempts

Each StepOccurrence has recovery epoch 0. PostgreSQL snapshots the server-owned `QE_MAX_OPERATIONAL_ATTEMPTS_PER_EPOCH` value when an epoch is created; the default is 2. An Attempt is attributed only when scheduling reserves its normal Worker slot, Member, context, and worktree. Its global number never changes. The epoch-local position is displayed independently.

Only explicitly classified `auto_retryable` failures receive another Attempt in the same epoch while allowance remains. `operator_recovery_required` failures wait for a human even if allowance was unused. `terminal_not_recoverable` failures cannot be recovered. Missing legacy classification is conservatively treated as operator recovery required. `uncertain` executions are never automatically duplicated.

A successfully executed Review with verdict `rejected` is not an operational failure. Runtime advances through the authored Repair/Review loop; it does not create another Attempt for that Review occurrence.

## Human recovery epochs

`/qe-resume` returns control to automation inside the same still-running Attempt after conversational takeover. It creates no Attempt or epoch.

`/qe-retry` applies only after an operational Attempt is terminal. Pi atomically writes a stable local request; the Worker validates Action, Run, occurrence, Attempt, Member, lineage, Pi session, worktree provenance, and its current generation, then submits the request through Worker Protocol. Phoenix transactionally appends a human recovery epoch and asks Runtime for a new Attempt under the same StepOccurrence. Duplicate request IDs resolve to the same epoch.

A human epoch snapshots a fresh full operational allowance. It does not reset an Until region, remediation count, artifacts, semantic occurrence, or historical Attempt. There is no lifetime cap on human epochs.

When a retained Pi/Herdr session is still exact and compatible, the new Attempt reuses that physical lineage and receives only a short instruction to continue from session state and existing human guidance. If validation fails, QE does not silently substitute a new session. Work Yard offers an explicit **Retry with fresh session** recovery instead.

Opening **Inspect Session** or **Help & Retry**, and ordinary conversation inside Pi, do not authorize execution. Only `/qe-retry` or the explicit fresh-session Product command does. Chat, replies, terminal text, and keystrokes are never copied into Product persistence.

## Worked example

With `Maximum repairs = 3` and operational allowance 2:

```text
Review 1, epoch 0, Attempt 1 succeeds → rejected
Repair 1, epoch 0, Attempt 1 transiently fails
Repair 1, epoch 0, Attempt 2 succeeds
Review 2, epoch 0, Attempt 1 succeeds → rejected
Repair 2, epoch 0, Attempts 1 and 2 fail
Human recovery 1 authorized
Repair 2, epoch 1, global next Attempt / epoch Attempt 1 succeeds
Review 3 succeeds → accepted
```

The semantic result is two of three repairs used. Every technical Attempt and the human recovery boundary remains visible.

## Historical migration

Existing scheduled Attempts are deterministically attributed to epoch 0 from immutable Action IDs and scheduling order. Because no operational allowance existed historically, migrated epoch-0 rows use `policy_source: legacy_unknown` with no fabricated allowance. Migration fails if an existing Action ID cannot provide a deterministic global Attempt number.
