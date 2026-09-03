# War Room UX checkpoint

## Before

There was no War Room window and no human-facing reusable-Tactic authoring surface. The authored town contains only a noninteractive `war-room` reserved site, so there is intentionally no fabricated BEFORE screenshot.

## After

The checkpoint establishes a browse-first reusable-Tactic library and a purpose-built semantic tree editor. Humans author Steps, Sequence, Parallel, bounded Until remediation, and TacticUse composition. The server remains authoritative for resolution, cycles, artifact inference, and contextual validity.

### Desktop · 1440×900

1. `after/1440x900/01-empty-war-room.png`
2. `after/1440x900/02-tactic-browser-detail.png`
3. `after/1440x900/03-new-tactic.png`
4. `after/1440x900/04-simple-sequence-editor.png`
5. `after/1440x900/05-step-inspector.png`
6. `after/1440x900/06-artifact-flow.png`
7. `after/1440x900/07-parallel-editor.png`
8. `after/1440x900/08-until-remediation-editor.png`
9. `after/1440x900/09-performer-affinity.png`
10. `after/1440x900/10-context-continuation.png`
11. `after/1440x900/11-tactic-use.png`
12. `after/1440x900/12-contextual-tactic-warning.png`
13. `after/1440x900/13-cycle-validation-error.png`
14. `after/1440x900/14-shared-tactic-usage.png`
15. `after/1440x900/15-archive-confirmation.png`
16. `after/1440x900/16-dirty-state-confirmation.png`

### Responsive · 900×600

- `after/900x600/17-responsive-editor.png`

### Comparison marker

- `comparison/AFTER-war-room-1440x900.png`

This AFTER reference is copied from the selected Tactic detail. There is no side-by-side image because no prior War Room UI existed.

## Reproduce

With the client dev server running at `http://127.0.0.1:1420/`:

```sh
bun run --cwd client screenshots:war-room-ux
```

Set `QE_CAPTURE_BASE_URL` to use another local client origin.
