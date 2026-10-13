# ProviderAccounts, account environments, and setup (Phases A–B)

## Scope

Phase A introduced a provider-neutral Product `ProviderAccount` and one durable,
Worker-local account environment. Phase B adds account-scoped setup authority,
append-only setup-attempt history, blocking HumanAttention, ephemeral process
interaction, side-effect certainty, cancellation, restart reconciliation, and
post-setup authentication validation.

Phase B intentionally uses only QE's deterministic fake provider/login process.
In physical mode that process is local Python inside the existing account SBX;
it performs no network request and writes only deterministic fake state. The
implementation does **not** invoke Claude Code, Agent SDK login, a real provider
process, provider authentication/network, a model, inference, Claude v4, a Mod,
or a tool broker. Existing Run-bound setup remains a separate legacy adapter.

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
stores credential bytes.

Credential generation and environment ownership generation are now deliberately
distinct. Explicit account replacement/rotation may replace the physical account
environment. Successful setup advances the semantic credential generation only
after exact local validation, while retaining the same environment ID,
incarnation, account-cell disk, and environment-owner generation. This prevents
the newly created fake authentication state from being destroyed by the success
transition. Future environment commands use the environment row's owner
generation rather than assuming it equals the account's current credential
generation.

Semantic lifecycle is not physical availability. In particular, an invalid
account may still have an available environment, and a connected account with a
pending/missing environment is not physically ready.

## Layered readiness

The API reports readiness in separate fields:

- `semantic`: `semantically_connected | semantically_invalid |
  semantically_disconnected`;
- `environment`: `unassigned | pending | available | stopped | missing |
  degraded | removing | removed`;
- `authentication`: `not_checked | setup_authorized | setup_in_progress |
  interaction_required | validating | authenticated | authentication_required |
  inspection_unavailable | invalid`;
- `inference`: always `not_evaluated` in Phase B.

`environment=available` proves only the exact Worker-owned environment and its
durable canary. It never means authenticated, model-eligible, or inference-ready.

## Typed environment ownership

`ExecutionEnvironmentBackend` now carries a typed owner in specs, references,
durable SQLite rows, deterministic native names, guest ownership markers, and
streamed-process events:

```text
Run(run_id)
ProviderAccount(provider_account_id, environment_owner_generation)
```

The Worker `EnvironmentOwner` field remains named `credentialGeneration` for
Phase-A storage compatibility, but Phase B commands source it from the durable
environment row; it is the environment-owner generation and does not advance on
successful in-place setup.

Run specs retain their workspace materialization layout. Account specs use the
`provider-account-cell-v1` layout and do not require a Run or Run workspace.
The existing immutable `qe-coding-execution-v1/v2/v3` profiles are unchanged.
Phase A/B physical account cells use the existing credential-free, deny-all
shell profile. No execution profile was added or changed.

`cleanup_run_resources` remains a Run-only entrypoint. It rejects an account
owner before inspection, stream retirement, stop, or remove. Generic backend
stop/remove still require the exact typed owner, Worker, backend, environment
ID, incarnation, and profile.

## Persistence and history

PostgreSQL owns:

- `provider_accounts` — current semantic Product state;
- `provider_account_environments` — current desired/observed physical binding. Its durable `desired_environment_state` (`available | stopped | removed`) is independent from `physical_state`; pending or intermediate observations never erase operator intent;
- `provider_account_lifecycle_events` — append-only lifecycle and fencing
  evidence;
- `provider_account_setup_attempts` — retained account-scoped attempts, exact
  environment/process fences, invocation certainty, validation class, and safe
  terminal outcome;
- `provider_account_setup_authorizations` — one immutable explicit
  `provider_account_setup` authorization per attempt/request ID;
- `provider_account_setup_events` — append-only safe state/side-effect history;
- `provider_account_human_attention_requests` — account-scoped blocking
  attention and delivery metadata with no response value.

The Worker execution-environment SQLite schema remains current-only version 3.
The separate ProviderAccount setup SQLite ledger is current-only version 1. It
stores safe authorization identity, exact account/environment/process identity,
invocation state, input-delivery certainty, validation class, and append-only
safe events. Neither SQLite database accepts sensitive interaction bytes. Stale
setup schemas fail startup and require explicit Worker-state recreation. Run rows
and account rows cannot collide because ownership is part of every environment
key.

A deterministic, credential-free canary is written within the account
incarnation and read after adoption. Fake mode stores the same canary evidence
in Worker SQLite. `durable_canary_persisted=true` means that exact value survived
for the exact account generation/incarnation; it conveys no authentication
claim.

## Protocol and fencing

Worker Protocol v16 retains the Phase-A environment messages and adds:

- Product → Worker `reconcile_provider_account_environment`;
- Product → Worker desired `provider_accounts` on `reconcile_request`;
- Worker → Product `provider_account_environment_state`;
- account environment observations in `reconcile_state`;
- capability features `provider_account_environments_v1` and
  `provider_account_setup_v1`;
- Product → Worker `prepare_provider_account_setup`,
  `respond_provider_account_setup`, and `cancel_provider_account_setup`;
- Product → Worker desired `provider_account_setups` on `reconcile_request`;
- Worker → Product `provider_account_setup_state` and
  `provider_account_setup_input_delivery`;
- safe setup-attempt reconciliation in `reconcile_state`.

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

## Setup lifecycle and certainty

A setup is eligible only when the semantic account is connected, the durable
desired environment target is `available`, the observed environment is exactly
`available`, the canary is present, all physical identity fields are complete,
and the assigned Worker generation is connected and ready. Setup has no Run,
Action, Runtime Attempt, PhysicalLineage, workspace, private Git state, or
inference authorization.

The ordering is strict:

1. persist exact setup authorization and append-only attempt identity;
2. persist `invocation_requested` immediately before spawn;
3. record the exact acknowledged process handle;
4. expose only a safe account-scoped HumanAttention message;
5. relay bounded process output/input through an in-memory, five-minute,
   setup-generation + attention + process-generation-bound channel;
6. persist input-delivery metadata before the streamed write and classify it as
   acknowledged or uncertain without storing the input;
7. observe process settlement;
8. run deterministic local status validation in the same exact environment;
9. only then mark authentication ready and advance credential generation.

A crash after invocation intent but before an acknowledged process handle is
`uncertain` and is never replayed. An acknowledged process with lost stream
attachment is inspected by exact handle. Restart never restores ephemeral I/O;
it uses only exact process/environment evidence and local validation. Ambiguous
input or cancellation is terminally uncertain and not repeated. One partial
unique index plus Worker account tails admits one active setup per account;
physical lifecycle mutations are rejected while setup is active. Different
accounts remain independent.

Sensitive output/input, auth-like URLs/codes, raw provider output, and response
values are absent from PostgreSQL, Worker SQLite, lifecycle/setup events, API
projections, logs, telemetry, reconciliation, and evidence. Immediately after
JSON parsing, the endpoint removes response `value` from the telemetry-visible
connection and carries only an opaque reference through the request; a
30-second in-memory sidecar transfers the value once to the controller.
Worker output is hybrid-sealed to an ephemeral Product RSA public key before it
enters the Phoenix channel; channel telemetry can observe only AES-GCM
ciphertext, and the in-memory relay alone holds the private key and plaintext.
Interaction responses use `no-store` cache controls. The only durable
interaction facts are safe IDs, byte length, timestamps, delivery certainty,
and the non-secret public key; any transport-observed ciphertext cannot reveal
interaction plaintext without the memory-only private key.
Expiration, process replacement, cancellation, terminal state, or Product
restart makes the ephemeral channel unavailable.

## HTTP API

All routes are under `/api/v1`:

- `GET /provider-accounts`
- `POST /provider-accounts`
- `GET /provider-accounts/:id`
- `GET /provider-accounts/:id/events`
- `POST /provider-accounts/:id/actions/:action`
- `GET /provider-accounts/:id/setup-attempts`
- `POST /provider-accounts/:id/setup-attempts`
- `GET /provider-accounts/:id/setup-attempts/:attempt_id/interactions/:attention_id`
- `POST /provider-accounts/:id/setup-attempts/:attempt_id/respond`
- `POST /provider-accounts/:id/setup-attempts/:attempt_id/cancel`

Create accepts exactly `provider_key`, `worker_id`, and optional `display_name`.
Credential/token/secret fields are rejected. Actions are:

- `invalidate` — semantic invalidation only;
- `disconnect` — semantic disconnection plus exact environment removal;
- `reconnect` — new credential generation and replacement environment;
- `rotate` — new credential generation and replacement environment;
- `start`, `stop`, `remove` — physical lifecycle only.

Environment mutations return `202 Accepted`: Product intent is durable, while
Worker availability and physical convergence remain observable separately.
Setup authorization requires `{request_id, confirmed: true}`. Setup
interaction/respond/cancel routes require a direct loopback Tauri header. The
interaction GET additionally requires an ephemeral client RSA public key and
returns only hybrid-sealed expiring-memory output; the typed client decrypts it
in memory. Respond accepts a bounded string but stores no value and never
replays it after uncertain delivery.

## Proof boundaries

Deterministic tests cover no-Run creation/setup, idempotent exact authorization,
eligibility and generation/incarnation fencing, intent-before-spawn, known and
ambiguous side-effect outcomes, stale input, acknowledged input, cancellation,
restart non-replay, Product reconstruction, account serialization,
multi-account isolation, post-login validation, generation advancement without
environment replacement, zero durable sensitive payloads, stop/remove, stale
schema rejection, and the hard Run-cleanup owner guard.

Two bounded opt-in tests use `QE_LIVE_SBX=1`: Phase A proves account-cell
lifecycle/canary adoption; Phase B runs only deterministic local Python login and
status programs in the exact account SBX, proves process and environment
identity retention, and removes the cell. The Phase-B test timeout is 120
seconds. SBX absence skips physical proof rather than presenting simulation as
real-SBX evidence.
