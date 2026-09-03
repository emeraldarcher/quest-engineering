# Forge UX visual checkpoint

Deterministic local fixtures captured at DPR 1 with `bun run --cwd client screenshots:forge-ux`. No Worker, provider, model, backend, or quota is used.

## Required states

1. [Loadout browser](after/1440x900/01-loadout-list.png)
2. [Selected Coding Loadout](after/1440x900/02-selected-coding.png)
3. [Selected Review Loadout](after/1440x900/03-selected-review.png)
4. [Configured custom Loadout](after/1440x900/04-custom-loadout.png)
5. [New Loadout](after/1440x900/05-new-loadout.png)
6. [Edit Loadout](after/1440x900/06-edit-loadout.png)
7. [Custom configuration](after/1440x900/07-custom-configuration.png)
8. [Advanced technical detail](after/1440x900/08-advanced.png)
9. [Archive confirmation](after/1440x900/09-archive-confirmation.png)
10. [Dirty-state confirmation](after/1440x900/10-dirty-confirmation.png)
11. [Empty state](after/1440x900/11-empty-state.png)
12. [900×600 responsive view](after/900x600/12-responsive-forge.png)

## Before / after at 1440×900

- [BEFORE — form-first Forge](comparison/BEFORE-forge-1440x900.png)
- [AFTER — browse/detail Forge](comparison/AFTER-forge-1440x900.png)
- [Side-by-side comparison](comparison/before-after-side-by-side.png)

Execution-options are used only as authoring presets. Persisted Loadouts remain ordinary Product fields, including valid undiscovered ModelRefs and custom capability IDs.

At capture time, this milestone was intentionally limited to Forge; the other management surfaces, runtime UI, and authored town map remained unchanged.
