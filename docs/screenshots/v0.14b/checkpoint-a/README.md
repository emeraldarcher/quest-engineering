# Quest Engineering v0.14b — Sunnyside Checkpoint A

This is an isolated visual spike. It does not replace production `TownWorld` or
remove Mini Medieval.

All Sunnyside scenes use the existing deterministic density fixture:

- 12 factual Members: 5 idle, 3 working, 2 scheduled/moving, 1 failed, and
  1 uncertain;
- 2 waiting/unassigned work orders;
- 1 Quest awaiting Pull Request review; and
- a compact Run summary. The semantic-parity scene also opens one Guild Hall
  management window.

## Palette treatments — 1440×900 at 2×

| Treatment | Screenshot |
|---|---|
| A1 — Native Cozy | [`palette/A1-native-cozy.png`](palette/A1-native-cozy.png) |
| A2 — Warm Management | [`palette/A2-warm-management.png`](palette/A2-warm-management.png) |
| A3 — Soft Earthy | [`palette/A3-soft-earthy.png`](palette/A3-soft-earthy.png) |

**Recommendation: Warm Management.** Native Cozy is cheerful but the grass has
more intensity than is desirable for an all-day desktop tool. Soft Earthy is
comfortable but suppresses too much of Sunnyside's characteristic color.
Warm Management slightly calms terrain while preserving blue water, roof color,
Member contrast, and warm DOM chrome.

## Integer-scale comparison — 1440×900

| Scale | Screenshot | Assessment |
|---|---|---|
| 1× | [`scale/S1-1x.png`](scale/S1-1x.png) | Complete strategic overview; Members and state glyphs are too small for normal interaction. |
| 2× | [`scale/S2-2x.png`](scale/S2-2x.png) | Best balance of Member identity, simultaneous state, panel space, and town context. |
| 3× | [`scale/S3-3x.png`](scale/S3-3x.png) | Strong close inspection; insufficient context as the ordinary town view. |

**Provisional recommendation: 2× normal, 1× Town overview, 3× explicit focus.**
This remains a visual-checkpoint recommendation rather than a production
selection.

## Semantic-parity comparison

- Mini Medieval v0.14a:
  [`comparison/M-mini-medieval-v014a.png`](comparison/M-mini-medieval-v014a.png)
- Sunnyside semantic parity:
  [`comparison/D-sunnyside-semantic-parity.png`](comparison/D-sunnyside-semantic-parity.png)
- Direct side by side:
  [`comparison/side-by-side.png`](comparison/side-by-side.png)

Sunnyside retains the required information density. Working, moving, failed,
uncertain, waiting-work, and PR-review states remain distinguishable without a
permanent Member list. The 96×64 character canvases preserve a consistent
16-pixel visual body and composite cleanly at integer world scales.

Compared with Mini Medieval, the Sunnyside scene provides clearer character
identity, warmer world/UI relationships, a smaller Quest Board, and a much less
debug-like Work Yard. The compact HUD and spike-only shell materially reduce
non-world competition.

## Native Sunnyside composition

[`composition/B-native-sunnyside-town.png`](composition/B-native-sunnyside-town.png)

This is a new authored 640×416 settlement rather than a coordinate translation.
It includes:

- Guild courtyard and pond;
- Tavern gathering yard;
- Forge work yard with anvil, ore, cart, fire, and smoke;
- small central Quest Board and well;
- Projects arrival building and storage;
- fenced workshop district with six generic stations;
- curved, differently weighted paths;
- trees, flowers, fences, props, birds, chickens, and ducks; and
- quiet terrain around denser functional clusters.

The composition is intentionally a spike, not Checkpoint B's final town. Final
work should improve path-edge tiling, add more terrain variation near district
boundaries, and refine building silhouettes from the authored tile recipes.

## Responsive and DPR inspection

- 1280×800:
  [`responsive/1280x800.png`](responsive/1280x800.png)
- 900×600 with management window:
  [`responsive/900x600.png`](responsive/900x600.png)
- 1440×900 CSS viewport at DPR 2, producing a 2880×1800 PNG:
  [`retina/dpr2.png`](retina/dpr2.png)

At 900×600 the world, compact status, state legend, and primary window content
remain visible, but Checkpoint B still needs formal panel-aware camera modes.
DPR 2 preserves nearest-neighbor world rendering and sharp DOM text.

## Asset and animation findings

Checkpoint A uses packaged v0.07 PNG layers for real idle, walk, and generic
`doing` animation. Appearance is deterministic from `squad_key + member_key`
across six hair styles. Ambient bird, chicken, duck, smoke, fire, and glint
strips also animate from source frames.

The supplemental v1.0 Aseprite source remains uncopied and unused. If Sunnyside
is approved, a documented directional idle/walk/run export is required before
final production Member implementation. No Aseprite conversion dependency or
asset atlas pipeline was introduced.

Provenance and the owner-approved governing license summary are under
`client/src/assets/sunnyside/`.

## Checkpoint A assessment

**Recommendation: approve Sunnyside as the permanent visual direction and move
to Checkpoint B, with Warm Management and 2× as the leading candidates.**

The spike can show twelve factual Members, simultaneous work, exceptional
states, waiting orders, PR review, ambient life, and a management window while
remaining substantially warmer and more inhabitable than the v0.14a baseline.
The remaining issues are composition/camera/polish work rather than evidence
against the asset direction.

No backend or API deficiency was found. No technical blocker prevents
Checkpoint B. Directional v1.0 export remains a prerequisite for final Member
conversion, not for the composition/camera checkpoint.
