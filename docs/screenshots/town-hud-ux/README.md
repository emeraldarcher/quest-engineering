# Town HUD UX checkpoint

This checkpoint replaces the persistent top navigation toolbar with a compact, passive RTS-style operational HUD. The authored town remains the primary building-navigation surface, with keys 1–7 available for the seven current locations.

## Counter semantics

- **Quests:** active, non-archived Quests whose canonical lifecycle is not `complete`.
- **Working Quests:** active, non-archived Quests whose lifecycle is exactly `working`. This is deliberately not labeled as a Member count because global distinct running Members are unavailable without loading every Run detail.
- **Attention:** active, non-archived Quests whose lifecycle is exactly `needs_attention`.
- **Reviews:** active, non-archived Quests whose lifecycle is exactly `awaiting_review`; `preparing_review` is excluded and appears only in the Quests tooltip.
- **Online:** successful Product API reachability or an open realtime socket confirms server availability. If only the API is reachable, the tooltip truthfully notes that live updates are reconnecting; reconnect/failure remains prominent when neither signal is healthy.

No execution-host count is shown because the current Product projection does not expose a truthful distinct connected-host aggregate.

## Captures

- `before/top-toolbar-current-1440x900.png` — formal legacy toolbar baseline.
- `after/1440x900/01-normal-active.png`
- `after/1440x900/02-working.png`
- `after/1440x900/03-attention.png`
- `after/1440x900/04-reviews.png`
- `after/1440x900/05-mixed.png`
- `after/1440x900/06-idle-zero.png`
- `after/1440x900/07-disconnected.png`
- `after/1440x900/08-first-quest.png`
- `after/900x600/09-responsive.png`
- `comparison/before-after-side-by-side.png`

The fixtures use existing Product, Quest lifecycle, Run summary, and realtime client shapes. They add no backend-only fields.
