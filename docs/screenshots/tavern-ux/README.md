# Tavern / Squads UX visual checkpoint

Deterministic client-fixture captures for the Tavern-only management overhaul.

## Baseline

- `before/tavern-current-1440x900.png` — legacy form-first Tavern with exposed keys and raw roster controls.

## Approved-shell implementation states

All desktop captures are 1440×900:

1. `after/1440x900/01-squad-list-selected.png` — Squad browser with selected Backend Team.
2. `after/1440x900/02-engineering-pair-roster.png` — Engineering Pair read-only roster detail.
3. `after/1440x900/03-new-squad.png` — explicit Create Squad mode.
4. `after/1440x900/04-edit-squad.png` — explicit whole-roster Edit mode.
5. `after/1440x900/05-add-member.png` — intentional Member composition flow.
6. `after/1440x900/06-edit-member.png` — persisted Member edit with stable identity.
7. `after/1440x900/07-class-picker.png` — friendly active-Class picker.
8. `after/1440x900/08-loadout-picker.png` — friendly active-Loadout picker.
9. `after/1440x900/09-reordered-roster.png` — changed roster order with accessible controls.
10. `after/1440x900/10-archived-reference-warning.png` — faithful archived Class/Loadout references and blocking configuration warning.
11. `after/1440x900/11-advanced.png` — immutable Squad key under Advanced.
12. `after/1440x900/12-archive-confirmation.png` — exact active-Quest and Run-history consequences.
13. `after/1440x900/13-dirty-confirmation.png` — shared Keep Editing / Discard / Save guard.
14. `after/1440x900/14-empty-state.png` — intentional no-Squads state.
15. `after/900x600/15-responsive-tavern.png` — compact responsive read view.

## Comparison

- `comparison/before-after-side-by-side.png`
- `comparison/BEFORE-tavern-1440x900.png`
- `comparison/AFTER-tavern-1440x900.png`

## Reproduce

With the client dev server available at `http://127.0.0.1:1420/`:

```sh
bun run --cwd client screenshots:tavern-ux
```

Set `QE_CAPTURE_BASE_URL` to use another client origin.
