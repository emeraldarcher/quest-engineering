# Quest Engineering v0.14b — Pipeline Checkpoint

This checkpoint proves the authored Tiled-map pipeline. The checked-in town is a
modest integration reference, not the final Quest Engineering layout.

## Required proof

| Proof | Result |
|---|---|
| Authored terrain, water, path, and building | Rendered from `town.tmj` tile/object layers; no runtime layout generator |
| Authored camera anchor | Guild Hall remains in the unobscured viewport beside its real management panel |
| Authored interaction polygon | Browser pointer smoke clicked the Guild polygon and opened the Guild Hall window |
| Authored workstation | Density fixture assigns factual active Members to stable map workstations |
| Authored Member home | Idle factual Members use deterministic generic map homes |
| Authored status anchor | PR review state renders at `quest-board-status` |
| Map edit and save | Moving `pond-tree` in `town.tmj` changed the visible client and map hash |
| Malformed map | Bun tests and `validate:town` reject duplicate IDs, bad version, dangling anchors, missing paths/assets, and invalid geometry |

## Screenshots

- [01 — authored Town overview](01-authored-town-overview.png)
- [02 — Guild camera anchor with panel](02-guild-camera-anchor.png)
- [03 — factual runtime density on authored slots](03-runtime-density.png)
- [04 — Quest lifecycle status anchor](04-quest-status-anchor.png)
- [05 — development authoring overlay](05-authoring-debug-overlay.png)
- [06 — panel-aware 900×600 resize](06-responsive-guild.png)

### Edit/save proof

The only map change between these captures is moving the authored `pond-tree`
object from `x=90` to `x=130`. The tree moves from below the pond to its right,
and the debug map hash changes.

- [07 — before save](07-map-edit-before.png)
- [08 — after save](08-map-edit-after.png)
- [09 — side by side](09-map-edit-side-by-side.png)

A persistent-browser HMR smoke additionally changed the same object temporarily,
observed the diagnostics hash change from `0b298e45` to `64cb2e88`, and restored
the checked-in map. Ordinary `.tmj` edits require no atlas rebuild or backend
restart.

## Reference layout scope

The map deliberately uses simple full path/water tiles and temporary facade
objects. Its purpose is to demonstrate layers, external tilesets, semantic
objects, camera behavior, and runtime projection. Roof, path-edge, district,
and environmental polish now belong to the human Tiled authoring phase.

Open/edit instructions and the complete schema are in
[`docs/town-authoring.md`](../../../town-authoring.md).
