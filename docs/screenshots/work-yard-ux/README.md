# Work Yard UX checkpoint

This checkpoint records the approved Work Yard operational-observability overhaul. It replaces the native Run dropdown and one-page data dump with a summary-backed Run browser and progressive Run detail.

## Baseline

- [`before/work-yard-current-1440x900.png`](before/work-yard-current-1440x900.png) — previous completed Run with Delivery attention.

## AFTER captures

### 1440 × 900

1. [`01-run-browser-history.png`](after/1440x900/01-run-browser-history.png) — recent Run cards using summary data only.
2. [`02-completed-attention-overview.png`](after/1440x900/02-completed-attention-overview.png) — concise completed execution with separate Delivery attention and Quest status.
3. [`03-running-overview.png`](after/1440x900/03-running-overview.png) — active execution with immutable named Members.
4. [`04-remediation-timeline.png`](after/1440x900/04-remediation-timeline.png) — semantic occurrences, repair cycle, and repeated Review pass.
5. [`05-artifacts-list.png`](after/1440x900/05-artifacts-list.png) — lazy artifact summaries.
6. [`06-friendly-artifact-detail.png`](after/1440x900/06-friendly-artifact-detail.png) — friendly verdict detail with Raw data fallback.
7. [`07-custom-artifact-fallback.png`](after/1440x900/07-custom-artifact-fallback.png) — arbitrary custom structured artifact.
8. [`08-preparing-review.png`](after/1440x900/08-preparing-review.png) — intentionally undifferentiated public `preparing_review` state.
9. [`09-awaiting-pull-request-review.png`](after/1440x900/09-awaiting-pull-request-review.png) — open Pull Request Delivery.
10. [`10-merged-quest-complete.png`](after/1440x900/10-merged-quest-complete.png) — merged Delivery proving Quest completion.
11. [`11-cleanup-available.png`](after/1440x900/11-cleanup-available.png) — known-positive retained-workspace cleanup eligibility.
12. [`12-member-inspector.png`](after/1440x900/12-member-inspector.png) — LaunchSnapshot-backed Member, Class, and Loadout identity.
13. [`13-technical-details.png`](after/1440x900/13-technical-details.png) — IDs, revisions, branch, issue code, and current attempts behind disclosure.
14. [`14-empty-state.png`](after/1440x900/14-empty-state.png) — no Runs.

### 900 × 600

15. [`15-responsive-work-yard.png`](after/900x600/15-responsive-work-yard.png) — constrained desktop layout with independently scrolling browser and detail.

## Comparison

- [`comparison/before-after-side-by-side.png`](comparison/before-after-side-by-side.png)
- [`comparison/BEFORE-work-yard-1440x900.png`](comparison/BEFORE-work-yard-1440x900.png)
- [`comparison/AFTER-work-yard-1440x900.png`](comparison/AFTER-work-yard-1440x900.png)

## Semantic boundaries represented

- Execution completion, Delivery outcome, Quest completion, and Run-workspace lifecycle remain separate.
- `preparing_review` is not expanded into inferred internal phases or percentages.
- Browser cards use only Run-summary fields; Project and Squad appear only in selected snapshot detail.
- No duration or completion timestamp is inferred.
- Timeline rows are semantic Step occurrences. Only the projected current attempt is shown; no attempt history is invented.
- Named Members, Classes, and Loadouts come from the immutable LaunchSnapshot.
- Artifact bodies load only after selection. Custom JSON-compatible artifacts always retain a Raw data viewer.
- `change_set` is labeled agent-reported output and is not presented as authoritative Git evidence.
- Cleanup and Run Again appear only under known-positive authoritative eligibility.

Regenerate while the fixture client is available at `http://127.0.0.1:1420/`:

```bash
cd client
bun run screenshots:work-yard-ux
```
