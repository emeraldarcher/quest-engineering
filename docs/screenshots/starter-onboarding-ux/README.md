# Starter onboarding UX checkpoint

This checkpoint records the replacement of the legacy six-request **Raise a starter crew** utility with a Product-state-driven first-run experience backed by one atomic, reconciling server command.

## BEFORE

- [`before/starter-current-1440x900.png`](before/starter-current-1440x900.png) — legacy developer-facing prompt.

## AFTER — 1440 × 900

1. [`01-fresh-no-project.png`](after/1440x900/01-fresh-no-project.png) — welcoming first step with no Project.
2. [`02-add-project-entry.png`](after/1440x900/02-add-project-entry.png) — onboarding opens the approved Projects repository picker directly.
3. [`03-project-preparing.png`](after/1440x900/03-project-preparing.png) — Project added and repository preparation in progress.
4. [`04-project-needs-attention.png`](after/1440x900/04-project-needs-attention.png) — Project problem routed back to Projects.
5. [`05-ready-starter-preview.png`](after/1440x900/05-ready-starter-preview.png) — compatible Project and exact starter crew preview.
6. [`06-creating-starter-crew.png`](after/1440x900/06-creating-starter-crew.png) — one stable atomic loading state.
7. [`07-starter-setup-complete.png`](after/1440x900/07-starter-setup-complete.png) — deliberate completion before Quest Board navigation.
8. [`08-atomic-failure-retry.png`](after/1440x900/08-atomic-failure-retry.png) — safe transaction failure and retry.
9. [`09-recoverable-legacy-partial.png`](after/1440x900/09-recoverable-legacy-partial.png) — exact legacy partial setup can be completed safely.
10. [`10-canonical-starter-conflict.png`](after/1440x900/10-canonical-starter-conflict.png) — conflicting canonical identity is never overwritten.

## AFTER — 900 × 600

11. [`11-responsive-starter-preview.png`](after/900x600/11-responsive-starter-preview.png) — compact preview with primary action visible.

## Comparison

- [`comparison/before-after-side-by-side.png`](comparison/before-after-side-by-side.png)
- [`comparison/BEFORE-starter-onboarding-1440x900.png`](comparison/BEFORE-starter-onboarding-1440x900.png)
- [`comparison/AFTER-starter-onboarding-1440x900.png`](comparison/AFTER-starter-onboarding-1440x900.png)

## Reliability represented

- One `POST /api/v1/starter-crew` application command owns the user intent.
- Missing canonical entities are created in one Ecto transaction.
- Exact canonical matches are reused, including legacy partial state.
- Different or archived canonical identities produce typed conflicts and no writes.
- Repeating a completed request returns the same effective starter set.
- The client refetches starter status after an ambiguous command response.
- Manual ordinary Product configuration suppresses forced onboarding.
- No starter entity, marker column, migration, or special Runtime semantics were added.

Regenerate while the fixture client is available at `http://127.0.0.1:1420/`:

```bash
cd client
bun run screenshots:starter-onboarding-ux
```
