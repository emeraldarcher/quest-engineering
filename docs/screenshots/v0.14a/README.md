# Quest Engineering v0.14a visual artifacts

- `density-checkpoint/` records the required scale decision.
- `comparison/` contains the v0.13 Kenney town canvas and v0.14a Mini Medieval
  density canvas at the same 1440×900 viewport. The old Kenney source assets are
  not retained in production.
- `1440x900/` contains the complete deterministic visual-regression scene set.
- `900x600/` contains representative minimum-desktop views.
- `retina/` contains a 1440×900 CSS viewport captured at DPR 2 (2880×1800 PNG).

All v0.14a scenes use development fixtures and consume no Worker/model quota.
The capture implementation is documented in `client/scripts/capture-scene.ts`.
