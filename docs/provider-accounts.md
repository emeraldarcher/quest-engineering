# ProviderAccounts and account-owned execution environments (Phase A)

## Scope

Phase A introduces a provider-neutral Product `ProviderAccount` and one durable,
Worker-local execution environment per current account credential generation. It
is infrastructure groundwork only. The implementation performs deterministic
fake provider/account behavior and, when explicitly enabled, the existing shell
SBX lifecycle. It does **not** log in, collect or persist credentials, invoke a
provider, run inference, install provider tools, change an execution profile, or
replace the Agent SDK.

## Product identity and semantic lifecycle

`ProviderAccount.id` is the stable Product-owned identity. It is independent of:

1. `credential_generation` — a positive, monotonically increasing semantic
   epoch;
2. Worker `connection_generation` — authority for one current Worker channel;
3. physical `environment_id` and `incarnation` — exact environment identity;
4. `operation_id` — one Product request/reconciliation cycle.

The Product record stores `provider_key`, optional display name, Worker locality,
semantic lifecycle (`connected | invalid | disconnected`), the current
credential generation, layered readiness, and microsecond timestamps. It never
stores credential bytes. Advancing a credential generation retains the account
ID and replaces the old generation's physical environment.

Semantic lifecycle is not physical availability. In particular, an invalid
account may still have an available environment, and a connected account with a
pending/missing environment is not physically ready.

## Layered readiness

The API reports readiness in separate fields:

- `semantic`: `semantically_connected | semantically_invalid |
  semantically_disconnected`;
- `environment`: `unassigned | pending | available | stopped | missing |
  degraded | removing | removed`;
- `authentication`: always `not_checked` in Phase A;
- `inference`: always `not_evaluated` in Phase A.

`environment=available` proves only the exact Worker-owned environment and its
durable canary. It never means authenticated, model-eligible, or inference-ready.

## Typed environment ownership

`ExecutionEnvironmentBackend` now carries a typed owner in specs, references,
durable SQLite rows, deterministic native names, guest ownership markers, and
streamed-process events:

```text
Run(run_id)
ProviderAccount(provider_account_id, credential_generation)
```

Run specs retain their workspace materialization layout. Account specs use the
`provider-account-cell-v1` layout and do not require a Run or Run workspace.
The existing immutable `qe-coding-execution-v1/v2/v3` profiles are unchanged.
Phase A physical account cells use the existing credential-free, deny-all shell
profile.

`cleanup_run_resources` remains a Run-only entrypoint. It rejects an account
owner before inspection, stream retirement, stop, or remove. Generic backend
stop/remove still require the exact typed owner, Worker, backend, environment
ID, incarnation, and profile.

## Persistence and history

PostgreSQL owns:

- `provider_accounts` — current semantic Product state;
- `provider_account_environments` — current desired/observed physical binding;
- `provider_account_lifecycle_events` — append-only lifecycle and fencing
  evidence.

The Worker execution-environment SQLite schema is current-only version 3. It
stores typed owner type/ID/generation and rejects stale schema versions rather
than migrating them in place. Run rows and account rows share lifecycle
machinery but cannot collide because ownership is part of every key.

A deterministic, credential-free canary is written within the account
incarnation and read after adoption. Fake mode stores the same canary evidence
in Worker SQLite. `durable_canary_persisted=true` means that exact value survived
for the exact account generation/incarnation; it conveys no authentication
claim.

## Protocol and fencing

Worker Protocol v15 adds:

- Product → Worker `reconcile_provider_account_environment`;
- Product → Worker desired `provider_accounts` on `reconcile_request`;
- Worker → Product `provider_account_environment_state`;
- account environment observations in `reconcile_state`;
- capability feature `provider_account_environments_v1`.

The Product accepts a report only when all of these match current authority:

- stable ProviderAccount ID;
- credential generation;
- assigned Worker ID;
- Worker connection generation;
- operation ID;
- existing backend/physical ID/incarnation, if already bound.

Stop, remove, and same-incarnation start commands carry that current physical
identity as an expected fence; the Worker refuses to act when its durable owner
record differs. Stale reports are acknowledged without mutation. A conflicting
physical identity is rejected. On Worker reconnect, PostgreSQL assigns fresh operation
IDs fenced to the new Worker generation; the Worker reconciles its durable local
records before reporting. Local account records absent from Product desired
state are stopped and removed by exact reference. No destructive operation is
replayed after an ambiguous stop boundary; the existing durable stop intent and
read-only reconciliation rules apply.

## HTTP API

All routes are under `/api/v1`:

- `GET /provider-accounts`
- `POST /provider-accounts`
- `GET /provider-accounts/:id`
- `GET /provider-accounts/:id/events`
- `POST /provider-accounts/:id/actions/:action`

Create accepts exactly `provider_key`, `worker_id`, and optional `display_name`.
Credential/token/secret fields are rejected. Actions are:

- `invalidate` — semantic invalidation only;
- `disconnect` — semantic disconnection plus exact environment removal;
- `reconnect` — new credential generation and replacement environment;
- `rotate` — new credential generation and replacement environment;
- `start`, `stop`, `remove` — physical lifecycle only.

Mutating requests return `202 Accepted`: Product intent is durable, while Worker
availability and physical convergence remain observable separately.

## Proof boundaries

Deterministic tests cover no-Run creation, idempotence, stable account identity,
positive generation replacement, Worker-generation/operation fencing,
incarnation replacement, multi-account isolation, canary persistence across
Worker restart, stop/remove, current-schema rejection, and the hard Run-cleanup
owner guard. A live SBX test is bounded and opt-in with `QE_LIVE_SBX=1`; it
ensures, restarts/adopts, verifies the canary, then stops/removes the exact
account cell. When SBX is unavailable, that physical proof is skipped rather
than simulated as real-SBX evidence.
