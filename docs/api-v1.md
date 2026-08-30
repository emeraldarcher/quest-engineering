# Quest Engineering Product API v1 — v0.13

The JSON API is under `/api/v1`, uses `snake_case`, and never exposes Worker IDs, executor adapters, Herdr/Pi identities, source paths, Run-worktree paths, Git remote URLs, or credentials.

## Projects / logical Workspaces

```text
GET    /workspaces
GET    /workspaces/:id
POST   /workspaces
PATCH  /workspaces/:id
POST   /workspaces/:id/archive
GET    /workspace-sources
POST   /workspaces/:id/bindings
```

The domain and API retain `Workspace`; ordinary UI calls it a **Project**. Workspace binding projection is `unbound | preparing | ready | attention_required | offline`. A binding request is durable before Worker delivery, and failure details are bounded Product-safe values.

## Product definitions and Quest lifecycle

Classes, Loadouts, Squads, reusable Tactics, and Quests retain CRUD and archival. Preview remains side-effect free.

`POST /quests/:id/launch` creates an explicit new immutable Launch/Runtime Run/worktree. Launch is rejected while Runtime or Delivery is active, while publishing needs a recoverable retry, or after merge completion. `Run Again` is allowed after Runtime failure, `closed_unmerged`, and `no_changes`.

Quest projection adds:

```json
{
  "completion": { "completed_at": null, "completed_by_run_id": null },
  "lifecycle": {
    "state": "awaiting_review",
    "label": "Awaiting Review",
    "current_run_id": "...",
    "primary_action": "open_pull_request"
  }
}
```

Quest completion is written only after an exact expected same-repository GitHub PR is observed merged.

## Runs and Delivery

```text
GET  /runs
GET  /quests/:id/runs
GET  /runs/:id
GET  /runs/:id/changes
POST /runs/:id/delivery/retry
POST /runs/:id/worktree/cleanup
GET  /runs/:run_id/artifacts/:artifact_id
```

`delivery` is independent of Core Runtime and projects `preparing_review | awaiting_review | merged | closed_unmerged | no_changes | attention_required`, authoritative change counts, exact base/head revisions, safe issue data, and canonical GitHub review metadata.

`Retry Publishing` resumes the same Delivery and runs no model work. Cleanup accepts `{ "acknowledge_unmerged": true }` when applicable, removes only a clean managed worktree non-forcibly, and retains branches/history.

The central control plane reconciles open PRs every ten seconds. Before completion it verifies repository, base branch, head repository, head branch, and exact published head OID. Fork/cross-repository PR publishing is not supported in v0.13.

## Realtime

Clients subscribe to selected `run:<run_id>` invalidations and global `product:all` invalidations. Payloads are small refetch signals; Delivery patches and raw diffs are not broadcast.
