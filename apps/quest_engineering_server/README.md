# Quest Engineering Server — Reusable Tactic Composition v0.9

The server resolves mutable reusable Product Tactic Definitions into immutable plain semantic Tactics before binding path-free launch snapshots to the pure Core Runtime and Worker Protocol v4.

```text
Quest + Squad + Classes + Loadouts
              ↓ atomic launch
quest_launches + runtime_runs + ordered runtime_outbox
              ↓ atomic scheduling
Member binding + logical context binding + Worker slot
              ↓
ResolvedExecution → Worker Protocol v4
```

A Worker remains infrastructure. It is not a Squad Member, Class, Loadout, semantic performer, or logical context.

## Reusable Tactics

`product_tactics` stores mutable, archivable definitions whose authoring bodies add only an authoring-time `use` node to the semantic `Step`/`Sequence`/`Parallel`/`Until` language. Each Use has an explicit local instance key and definition ID. The pure Core resolver expands Uses with deterministic slash-delimited Step keys, rewrites all local Step references, rejects missing/archived definitions and cycles, and enforces conservative depth/node/key-size limits.

Step and Use keys share one local namespace. Deep cross-boundary Step references, parameters, and composite ports are deliberately absent. Context-dependent definitions may be saved when their only standalone compiler failures are missing parent-supplied artifacts; complete Quest preview and launch must compile successfully.

A Quest explicitly selects either an inline authoring Tactic or a reusable definition. Preview and launch load the reachable graph under a repeatable-read transaction. Launch snapshots contain the fully expanded semantic Tactic, compiled plan, and lightweight definition-occurrence provenance. Compiler, Runtime, scheduling, and Worker behavior remain unaware of reusable composition.

## Launch and history

`LaunchQuest.launch/1` resolves a configured canonical Git workspace and, in one transaction, locks active Product definitions, builds and compiles a `LaunchSnapshot`, starts Core Runtime, and persists the Run, initial emission-indexed outbox Actions, and immutable `quest_launches` row. Mutable Product edits affect later launches only.

Workspace references are configured under `:quest_engineering_server, :workspaces` as `%{"workspace:ref" => "/absolute/root"}`.

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

If any temporary resource is unavailable, that candidate writes nothing. Partial unique indexes enforce one active logical Member `(squad_id, member_key)` across all Runs, one active `(run_id, logical_lineage_id)`, and one nonterminal `(worker_id, worker_slot)`. The frozen launch snapshot supplies `squad_id`; mutable current Squad membership is not consulted during acquisition.

`class(key)` selects by launch-snapshot roster order. `same_as` resolves only through the exact source occurrence binding. Logical `continue_from` similarly resolves only through the exact source occurrence context binding. Pi continuation is additionally routed to the Worker owning the source physical lineage.

## Worker compatibility

`Loadout.tools` is an open namespace of well-formed Quest Engineering capability identifiers. Product validation does not depend on current adapters. A Worker is compatible when at least one advertised executor satisfies the exact model provider/name, reasoning, QE capability set, workspace reference/root, and access level. The server does not require `adapter == "pi"`, and Product has no executor field.

The initial Pi adapter advertises:

- `workspace.filesystem`
- `workspace.search`
- `terminal.shell`

Unknown/custom capabilities are valid Product data but cause `waiting_for_worker` until an executor advertises them.

## Worker Protocol v4

Only protocol version 3 is accepted. `execute_action` carries a provider-neutral immutable `ResolvedExecution` with separate identity, performer, work, configuration, and logical context sections. It carries no unresolved performer/context requirement and no Pi/Herdr lineage ID.

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
