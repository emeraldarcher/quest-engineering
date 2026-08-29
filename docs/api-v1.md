# Quest Engineering Product API v1

The Product API is a conventional JSON API under `/api/v1`, with `snake_case` fields and opaque IDs. It is separate from Worker Protocol v3 and has no authentication in v0.10.

Product definitions expose CRUD plus explicit archival for Classes, Loadouts, Squads, reusable Tactics, and Quests. Lists exclude archived definitions unless `?include_archived=true` is supplied. Quest tactic sources are explicit `inline` or `definition` unions, and tactic bodies use the existing `step`, `sequence`, `parallel`, `until`, and `use` codec.

`POST /tactics/preview`, `POST /tactics/:id/preview`, and `POST /quests/:id/preview` never create execution state. `POST /quests/:id/launch` invokes the established launch service and returns a run reference.

`GET /runs`, `GET /quests/:id/runs`, and `GET /runs/:id` expose immutable-snapshot-backed Product projections. Step states are `pending`, `waiting`, `scheduled`, `running`, `completed`, `failed`, and `uncertain`. Artifact values are available only through `GET /runs/:run_id/artifacts/:artifact_id`; run projections contain summaries.

Configured, currently valid Quest workspaces are discoverable through `GET /api/v1/workspaces`. It returns only `{ref, name}` and never reveals local roots or Worker data.

Realtime clients connect separately at `/client` and join `run:<run_id>`. The join reply contains the current run projection. `run_changed` is an invalidation notification; clients must refetch `GET /runs/:id` after reconnect or notification. Notifications may duplicate or be missed and are published only after durable transactions commit.

Errors use `{error: {code, message, details, meta}}`. Expected request validation, preview, archive-reference, conflict, and not-found failures never expose Ecto, SQL, provider, Herdr, or Pi internals.
