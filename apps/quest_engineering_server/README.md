# Quest Engineering Server — Reusable Tactic Composition v0.9

The server resolves mutable reusable Product Tactic Definitions into immutable plain semantic Tactics before binding path-free launch snapshots to the pure Core Runtime and Worker Protocol v8.

```text
Quest + Squad + Classes + Loadouts
              ↓ atomic launch
quest_launches + runtime_runs + ordered runtime_outbox
              ↓ atomic scheduling
Member binding + logical context binding + Worker slot
              ↓
ResolvedExecution → Worker Protocol v8
```

A Worker remains infrastructure. It is not a Squad Member, Class, Loadout, semantic performer, or logical context.

## Reusable Tactics

`product_tactics` stores mutable, archivable definitions whose authoring bodies add only an authoring-time `use` node to the semantic `Step`/`Sequence`/`Parallel`/`Until` language. Each Use has an explicit local instance key and definition ID. The pure Core resolver expands Uses with deterministic slash-delimited Step keys, rewrites all local Step references, rejects missing/archived definitions and cycles, and enforces conservative depth/node/key-size limits.

Step and Use keys share one local namespace. Deep cross-boundary Step references, parameters, and composite ports are deliberately absent. Context-dependent definitions may be saved when their only standalone compiler failures are missing parent-supplied artifacts; complete Quest preview and launch must compile successfully.

A Quest explicitly selects either an inline authoring Tactic or a reusable definition. Preview and launch load the reachable graph under a repeatable-read transaction. Launch snapshots contain the fully expanded semantic Tactic, compiled plan, and lightweight definition-occurrence provenance. Compiler, Runtime, scheduling, and Worker behavior remain unaware of reusable composition.

## Launch and history

`LaunchQuest.launch/1` resolves a configured canonical Git workspace and, in one transaction, locks active Product definitions, builds and compiles a `LaunchSnapshot`, starts Core Runtime, and persists the Run, initial emission-indexed outbox Actions, and immutable `quest_launches` row. Mutable Product edits affect later launches only.

Workspace references are configured under `:quest_engineering_server, :workspaces` as `%{"workspace:ref" => "/absolute/root"}`.

## Operational recovery policy

`QE_MAX_OPERATIONAL_ATTEMPTS_PER_EPOCH` is Phoenix-authoritative and defaults to `2`. The effective value is snapshotted into each recovery epoch and governs only classified technical execution failures. It is independent of the `max_remediations` bound authored on a semantic Tactic `Until`. An `initial` epoch authorizes scheduling allowance, not provider use: every non-fake initial or human-recovery Attempt must reach a prepared `needs_confirmation` session and receive the separate durable `/execution/authorize-prompt` decision before prompt intent. See `docs/retry-and-remediation.md`.

## Deterministic scheduling

Within a Run, unscheduled Actions are scanned in `(run_revision, emission_index)` order. The first currently schedulable Action is committed, then scanning repeats. A temporarily unavailable earlier independent Action does not block later work. If Actions compete for the same available resource, the earlier emitted Action is attempted and committed first.

One transaction acquires all of:

- exact occurrence-to-Member binding;
- independent occurrence-to-logical-context binding;
- active Member and logical-context occupancy;
- a compatible connected Worker;
- a PostgreSQL-unique Worker slot;
- immutable `ResolvedExecution`;
- Worker dispatch routing.

If any temporary resource is unavailable, that candidate writes nothing. A Worker advertising `dispatch_availability: maintenance` is rejected before workspace assignment and executor matching; it may remain connected for diagnostics but can never claim an Action. Partial unique indexes enforce one active logical Member `(squad_id, member_key)` across all Runs, one active `(run_id, logical_lineage_id)`, and one nonterminal `(worker_id, worker_slot)`. The frozen launch snapshot supplies `squad_id`; mutable current Squad membership is not consulted during acquisition.

`class(key)` selects by launch-snapshot roster order. `same_as` resolves only through the exact source occurrence binding. Logical `continue_from` similarly resolves only through the exact source occurrence context binding. Physical continuation is routed to the Worker owning the source lineage and is rejected across harness kinds.

## Worker compatibility

A Loadout freezes `harness`, provider-qualified model, reasoning/effort, QE tools, and workspace permission; behavioral instructions remain exclusively on Class and task instructions on Step. A Worker is compatible only when one live harness-scoped catalog satisfies every frozen dimension exactly. Harness/model fallback is forbidden, while unavailable Product configurations remain persisted and visible.

Pi and Antigravity advertise:

- `workspace.filesystem`
- `workspace.search`
- `terminal.shell`

Unknown/custom capabilities are valid Product data but cause `waiting_for_worker` until an executor advertises them.

## Worker Protocol v8

Only protocol version 8 is accepted. `execute_action` carries a provider-neutral immutable `ResolvedExecution` with separate identity, performer, work, configuration, and logical context sections. It carries no unresolved performer/context requirement and no Pi/Herdr lineage ID.

Each advertised model carries `account_availability`: `verified_available`, `verified_unavailable`, or `unknown`. Unknown is schedulable; verified unavailable remains visible in execution diagnostics but cannot match a Loadout. This state is independent of runtime model support and optional QE scope.

Dispatch states are:

```text
claimed → dispatched → acknowledged → running → completed
                                      ├────────→ failed
                                      └────────→ uncertain
```

`uncertain` retains Member occupancy, logical-context occupancy, Worker slot, Worker affinity, and physical lineage occupancy. Disconnects never authorize reassignment.

### Deliberate v0.8b failure limitation

A **known terminal Worker execution failure** releases scheduling resources because physical execution is known to have stopped. Core Runtime nevertheless remains unresolved in its dispatched occurrence state because Core has no execution-failure event. v0.8b does not add semantic failure, retry, or reassignment behavior. This may leave a Run unable to advance and requires later operational handling.

## Completion and recovery

Accepted completion, Core Runtime transition, resulting ordered outbox Actions, scheduled-execution completion, dispatch completion, and resource release share one outer database transaction. Replays use the stable Action identity and Runtime transition ID.

PostgreSQL reconstructs launch, binding, occupancy, and Worker-slot state after control-plane restart. Worker reconciliation can advance accepted/running/completed/failed/uncertain infrastructure state, but missing or uncertain execution is never silently reassigned.

## Live execution sessions

Worker Protocol v8 reconciles Product-safe harness session and HumanAttention state under the existing connection-generation fence. PostgreSQL links each dispatch usage to a durable session while continuation may reuse that session across Attempts. Local attachment is disabled unless `QE_LOCAL_SESSION_ATTACH_ENABLED=true`; even then the endpoint requires loopback Tauri requests and returns only a 60-second exact-session descriptor. See [`../../docs/live-execution-sessions.md`](../../docs/live-execution-sessions.md).
