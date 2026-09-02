# Quest Board UX checkpoint

## Scope

Quest Board-only lifecycle and command-surface overhaul. The checkpoint preserves the existing Quest CRUD, LaunchSnapshot, Run, Delivery, completion, and archive semantics. It does not add War Room authoring, Terminal attachment, diff/change browsing, cancellation, or Work Yard redesign.

## Formal baseline

- `before/quest-board-current-1440x900.png` — production-style Create Quest screen before implementation.
- `comparison/BEFORE-quest-board-1440x900.png`
- `comparison/AFTER-quest-board-1440x900.png`
- `comparison/before-after-side-by-side.png`

## AFTER captures

All desktop captures are 1440×900:

1. `after/1440x900/01-empty-first-quest.png`
2. `after/1440x900/02-quest-list-ready.png`
3. `after/1440x900/03-new-quest.png`
4. `after/1440x900/04-project-picker.png`
5. `after/1440x900/05-squad-picker.png`
6. `after/1440x900/06-tactic-picker-preview.png`
7. `after/1440x900/07-ready-to-launch.png`
8. `after/1440x900/08-working-quest.png`
9. `after/1440x900/09-preparing-review.png`
10. `after/1440x900/10-awaiting-review-pr.png`
11. `after/1440x900/11-needs-attention.png`
12. `after/1440x900/12-execution-complete-quest-incomplete.png`
13. `after/1440x900/13-complete-merged.png`
14. `after/1440x900/14-run-again-eligible.png`
15. `after/1440x900/15-dirty-state-confirmation.png`
16. `after/1440x900/16-project-offline-launchable.png`
17. `after/1440x900/17-invalid-squad.png`
18. `after/1440x900/18-contextual-tactic-error.png`
19. `after/1440x900/19-launching.png`

Responsive:

- `after/900x600/20-responsive-quest-board.png`

## Semantic notes

- Quest cards use only loaded Product lifecycle summaries.
- `ready` is presented as **Ready to launch**, not attention.
- Project readiness remains separate from launch eligibility: offline/preparing Projects explain that a launched Run may wait, while the server-authoritative Launch action remains available.
- Runtime completion remains separate from Delivery integration and Quest completion.
- Only persisted merged-Delivery completion is shown as **Complete**.
- Run Again comes only from the authoritative Quest lifecycle action.
- The reusable Tactic catalog is integrated into the Approach picker and semantic preview; the disconnected bottom catalog is removed.
- Inline Tactics are preserved without introducing War Room authoring.
- Archive removes the Quest from active Product lists and explicitly does not cancel active Runs, Delivery, or Pull Requests.
- Open Work Yard carries the authoritative current/latest Run selection.

## Reproduce

With the client dev server at `http://127.0.0.1:1420/`:

```sh
bun run --cwd client screenshots:quest-board-ux
```
