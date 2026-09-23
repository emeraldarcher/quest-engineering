# Quest Engineering Product API v1 — v0.13

The JSON API is under `/api/v1`, uses `snake_case`, and exposes Product-safe harness/model catalogs but never exposes raw Worker capability documents, bridge credentials, descriptor paths, auth material, source paths, Run-worktree paths, or Git remote URLs.

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

Classes, Loadouts, Squads, reusable Tactics, and Quests retain CRUD and archival. A Loadout contains only `harness`, provider-qualified `model`, nullable `reasoning`, authored `tool_policy`, and `workspace_access`; behavior remains on Class and task instructions on Step. `tool_policy` is either `{kind: "exact", tools: [...]}` or `{kind: "native_permissions"}`. `tool_enforcement` is not authored. `reasoning: null` asserts that the selected model explicitly does not support effort control. `/execution-options` returns harness-scoped model labels, `reasoning_capability`, supported policy, resolved enforcement guarantee, read-only current QE semantic capability profile, and availability. Per-Attempt provenance freezes the authored policy, resolved enforcement, and exact QE semantic capability profile resolved by the adapter. The `tool_profile` and `resolved_tool_profile` IDs are QE semantic capabilities, not necessarily a raw inventory of every internal native harness tool. Preview remains side-effect free.

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
POST /runs/:id/execution/authorize-prompt
POST /runs/:id/attempts/:attempt_id/cancel
POST /runs/:id/delivery/retry
POST /runs/:id/worktree/cleanup
GET  /runs/:run_id/artifacts/:artifact_id
```

`delivery` is independent of Core Runtime and projects `preparing_review | awaiting_review | merged | closed_unmerged | no_changes | attention_required`, authoritative change counts, exact base/head revisions, safe issue data, and canonical GitHub review metadata. Delivery creation is server-gated: a Run whose Tactic produces `verdict` artifacts is eligible only when the latest completed verdict-producing semantic occurrence emitted `{ "status": "accepted" }`.

Run detail keeps semantic occurrences separate from operational attempts. Each Step projection includes an ordered `attempts` list with Product-safe state, timing, retry/cancellation resolution, cancellation provenance, and output references; artifact summaries include both producing occurrence and producing attempt IDs. `review_gate` reports `not_required | accepted | rejected | missing | invalid` and points to the latest relevant semantic Review occurrence and artifact without discarding older verdicts.

Cancellation is an authorized local-desktop Product operation. `POST /runs/:id/attempts/:attempt_id/cancel` requires the same loopback Tauri boundary as Open Session and a body containing exact `occurrence_id`, unique `request_id`, and optional `reason`. Acceptance returns `cancellation_requested` with `sent | pending` delivery; this is not terminal success. Phoenix persists intent before sending one generation-fenced Worker Protocol v9 `cancel_dispatch`. The existing Worker executor interrupts the exact lineage and reports `execution_cancelled`; only then does the Run/Step project `cancelled`, release capacity, retain the Run worktree/private Git history, and retire result authority. Retries return the original provenance, disconnected Workers receive the command during reconciliation, uncertain Attempts require their existing recovery flow, and an already-terminal Attempt is a non-mutating `already_terminal` result.

`Retry Publishing` resumes the same Delivery and runs no model work. Cleanup accepts `{ "acknowledge_unmerged": true }` when applicable, removes only a clean managed worktree non-forcibly, and retains branches/history.

The central control plane reconciles open PRs every ten seconds. Before completion it verifies repository, base branch, head repository, head branch, and exact published head OID. Fork/cross-repository PR publishing is not supported in v0.13.

## Realtime

Clients subscribe to selected `run:<run_id>` invalidations and global `product:all` invalidations. Payloads are small refetch signals; Delivery patches and raw diffs are not broadcast.
