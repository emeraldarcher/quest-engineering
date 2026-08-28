# Quest Engineering Server Worker Protocol v2

`quest_engineering_server` is the PostgreSQL/Phoenix infrastructure boundary around the pure `QuestEngineering.Core.Runtime`. It provides distributed Action delivery while preserving snapshot, revision, transition-idempotency, and transactional-outbox guarantees.

## Boundary

```text
Core Runtime Action
        ↓
runtime_outbox (durable intent)
        ↓
Dispatcher
        ↓
Phoenix Channel / JSON protocol v2
        ↓
Worker
```

A **Worker** is a long-lived infrastructure execution node. It is not a Squad Member, agent, semantic performer, Class, Loadout, provider, or session.

The protocol intentionally contains no Bun, Herdr, Pi, PTY, process, repository-ownership, or model-selection concepts. The v0.7 production adapter remains:

```text
Bun Worker → Herdr mux → Pi provider adapter
```

## Identity and connection fencing

`workers.id` is a stable, externally supplied string. It is never converted to a BEAM atom. A Worker presents the same ID after reconnecting.

A WebSocket connection has a separate ephemeral UUID. Every successful registration increments persisted `workers.connection_generation`. The generation fences all heartbeats, acknowledgements, state reports, completions, failures, and reconciliation. A late message from a superseded connection is rejected with `stale_connection_generation`.

The duplicate live-connection policy is **newest accepted connection wins**. The local connection registry pushes `connection_superseded` to the older channel and closes it. PostgreSQL generation fencing—not process termination—is the correctness boundary.

Disconnect updates Worker infrastructure status only. It never fails a Runtime Run, advances a semantic retry, or implies that external execution stopped.

## Transport, authentication, and versioning

The endpoint hosts a Phoenix Channel at:

```text
/worker/websocket
worker:control
```

Phoenix supplies connection framing; every application message is an explicit JSON-compatible object. The join payload is `worker_hello`. Post-registration messages use the channel event `protocol`, keeping channel callbacks thin.

The server supports exactly:

```json
{"protocol_version": 2}
```

Protocol v2 adds the required provider-neutral `instruction` field to every `execute_action`. Protocol v1 Workers are rejected so no production Worker can execute an instruction-less Action.

Unsupported versions and malformed messages receive structured machine-readable errors. Incoming types, IDs, capability fields, dispatch identity, local state, output names, and artifact values are validated without creating atoms from open-ended wire strings.

Authentication is deliberately limited to a configurable static token (`QUEST_ENGINEERING_WORKER_TOKEN`, defaulting to a development token outside production and required in production). This is infrastructure scaffolding, not production worker identity/authentication.

### Worker to server

- `worker_hello`
- `worker_heartbeat`
- `dispatch_accepted`
- `dispatch_state`
- `step_completed`
- `step_failed`
- `reconcile_state`

### Server to Worker

- `worker_welcome`
- `execute_action`
- `reconcile_request`
- `connection_superseded`
- structured protocol/message results

## Capabilities and capacity

Registration persists this generic serialization-safe shape:

```json
{
  "os": "macos",
  "arch": "arm64",
  "max_concurrency": 8,
  "tags": ["local"],
  "capabilities": ["git"]
}
```

`workers.max_concurrency` is the advertised limit. `workers.active_dispatches` is reconstructed from authoritative dispatch rows in `acknowledged` or `running`. Completed and failed dispatches consume no active capacity. Claimed and sent-but-unacknowledged rows reserve capacity during selection, preventing the server from flooding an uncertain Worker.

There is no scheduler yet. Every `Dispatcher.dispatch/2` call requires an explicit `worker_id`.

## Outbox versus dispatch

`runtime_outbox` is immutable durable runtime intent. It stores the Action ID, run/revision provenance, type, and encoded core Action. It contains no Worker ID and no worker delivery state.

`worker_dispatches` is authoritative for per-Worker delivery. One Action ID has at most one dispatch row and therefore one accepted Worker provenance.

The delivery state machine is:

```text
claimed → dispatched → acknowledged → running → completed
                                      └────────→ failed
```

- `claimed`: a durable dispatcher claim exists; no network send is proven.
- `dispatched`: an `execute_action` push was attempted.
- `acknowledged`: the Worker durably recorded the Action ID.
- `running`: the Worker reports local execution in progress.
- `completed` / `failed`: terminal worker-local knowledge.

Worker-local `failed` is infrastructure state only. It does not fail the core Run because the pure runtime has no compatible external failure event or retry policy yet.

The greenfield persistence migration was squashed for v0.6. The obsolete v0.5 `delivered` status was removed; semantically those rows are pending durable intents because v0.5 could not prove Worker acceptance.

## Claiming and crash recovery

`DispatchStore.claim_next/3`:

1. locks the explicitly selected Worker row;
2. enforces connected status and reserved capacity;
3. reclaims an expired `claimed`/`dispatched` row for that Worker, or selects an outbox row without a dispatch;
4. uses `FOR UPDATE SKIP LOCKED` for multi-node-safe Action selection;
5. persists `claim_owner`, random claim token, expiration, Worker provenance, and payload hash;
6. commits before network I/O.

The dispatcher never waits for a network ACK in a database transaction. If it crashes before send, the claim expires and is reclaimable. If it crashes after send but before persistence/ACK, the same Action is redelivered. An Action accepted by Worker A remains affined to Worker A; the control plane never silently reassigns it to Worker B.

Transport routing is currently local-node only: `WorkerConnections` locates a Channel process on the same BEAM node. PostgreSQL claiming and fencing are multi-node safe, but clustered Phoenix routing is deferred.

## At-least-once delivery and Worker deduplication

Database claim and WebSocket send cannot be atomic. Delivery is therefore explicitly **at least once**, never exactly once.

The deterministic core `Runtime.Action.id` is the dispatch identity on initial delivery, retries, reconnect, and reconciliation. The fake worker keeps:

```text
known_dispatches[action_id] = accepted | running | completed | failed
```

Receiving the same Action ID returns the known state and never starts a second logical execution. Correctness follows from stable Action ID + worker deduplication + reconciliation.

## Completion and transition idempotency

A completion is validated against the persisted Action's Worker, Action ID, occurrence ID, attempt ID, declared outputs, and artifact values. `CompletionAdapter` then calls `RuntimeStore.apply_transition/3`; transport never mutates snapshots directly.

The stable transition ID is collision-free and URL-safe:

```text
worker-completion/v1/<base64url(worker_id)>/<base64url(action_id)>
```

A repeated completion with the same payload returns the original v0.5 transition result without incrementing the Run revision. Reusing that ID with different outputs returns `transition_id_conflict` and changes nothing.

## Reconnect and reconciliation

After registration, the server redelivers that Worker's claimed/dispatched Actions and sends `reconcile_request`. The Worker responds with Action ID, occurrence ID, attempt ID, local state, and terminal outputs/failure where applicable.

Reconciliation may:

- advance stale server metadata to acknowledged/running;
- apply a completion discovered after disconnection through `RuntimeStore`;
- reconstruct active capacity;
- persist `dispatch_missing_on_worker` when the server expects an acknowledged Action the Worker forgot;
- persist `dispatch_unknown_to_server` for the inverse inconsistency.

A missing acknowledged dispatch is never silently re-executed. The Elixir control plane remains authoritative for what work should exist; the Worker is authoritative only for what Action IDs it previously accepted and their local state.

## Runtime persistence remains unchanged

`runtime_runs.snapshot` remains the authoritative versioned JSONB snapshot. Run rows are locked with `SELECT ... FOR UPDATE`; revisions remain monotonic. `runtime_transitions` remains the idempotency/audit record. Runtime transition + resulting outbox Actions still commit atomically.

Worker Protocol v2 is paired with core snapshot format v2. Semantic Steps now carry a required provider-neutral instruction propagated unchanged through the execution plan and Runtime Action.
