# Quest Engineering Product API v1 — v0.12

The JSON API is under `/api/v1`, uses `snake_case`, and never exposes Worker IDs, executor adapters, Herdr/Pi identities, source paths, or Run-worktree paths.

## Logical Workspaces

```text
GET    /workspaces
GET    /workspaces/:id
POST   /workspaces
PATCH  /workspaces/:id
POST   /workspaces/:id/archive
```

Workspace fields are `id`, immutable `key`, `name`, `source_kind`, optional credential-free `source_fingerprint`, and `archived_at`. Workspaces are logical/path-free. Quests reference `workspace_id`.

`GET /workspace-sources` asks connected Workers to refresh bounded authorized-root discovery and returns cached Product-safe candidates. `POST /workspaces/:id/bindings` with `{candidate_id}` requests a Worker-local binding. Candidates contain no path or Worker identity.

## Product definitions

Classes, Loadouts, Squads, reusable Tactics, and Quests retain CRUD plus explicit archival. Lists exclude archived rows unless `?include_archived=true` is supplied. Quest tactic sources are explicit `inline` or `definition` unions.

Preview routes remain pure and never inspect source repositories or provision worktrees:

```text
POST /tactics/preview
POST /tactics/:id/preview
POST /quests/:id/preview
```

`POST /quests/:id/launch` creates the immutable path-free LaunchSnapshot, Runtime Run, Actions, and one stable Run Workspace assignment. Physical provisioning happens asynchronously through Worker Protocol v4.

## Execution options

`GET /execution-options` returns coherent model/reasoning/tool profiles and logical `workspace_id` access combinations. Root-specific shell policy is applied before a combination is advertised. No capacities or physical details are exposed.

## Runs

```text
GET /runs
GET /quests/:id/runs
GET /runs/:id
GET /runs/:run_id/artifacts/:artifact_id
```

Run projections include `execution_environment` with safe Workspace identity, `waiting_for_host | preparing | ready | attention_required | retained | removed`, a safe message, base revision, branch name, and dirty-source exclusion flag. They omit assignment/worktree/Worker/binding IDs and paths.

Step states remain `pending`, `waiting`, `scheduled`, `running`, `completed`, `failed`, and `uncertain`. Artifact values remain behind the artifact detail route.

Clients subscribe to one selected Run through `/client` and `run:<run_id>`; committed changes invalidate that projection.
