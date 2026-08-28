# Quest Engineering Core v0.5

`quest_engineering_core` is the dependency-free semantic orchestration and pure execution-state-machine boundary. It contains no processes, scheduler, persistence, networking, clocks, provider integration, or executable callbacks.

## Semantic definitions and runtime identity

A compiled semantic step exists exactly once. It carries a required, non-empty, provider-neutral work instruction that is propagated unchanged to every emitted Action. The semantic step key `"review"` remains stable even when an `Until` executes it repeatedly.

A `Runtime.StepOccurrence` is one control-flow occurrence of that definition. Its deterministic identity, control path, region occurrence, phase, and remediation cycle distinguish review cycle 0 from review cycle 1. Completed occurrences remain in `Run.occurrences`; repetition never resets an old occurrence.

An `Runtime.ExecutionAttempt` is one concrete try to execute an occurrence. Repeated control flow and retry are therefore separate concepts: review cycle 1 is a different occurrence, while a hypothetical retry of review cycle 1 would be another attempt on that occurrence. The runtime creates exactly one attempt when it dispatches an occurrence and implements no retry policy. `Assignment` is intentionally unused because no member or worker has been selected yet. v0.5's only core change is deterministic Action identity; persistence remains entirely in the server application.

## Pure runtime

The public model is:

```text
runtime state + runtime event -> new runtime state + requested actions
```

```elixir
{:ok, run, actions} = QuestEngineering.Core.Runtime.start(plan)
{:ok, run, actions} = QuestEngineering.Core.Runtime.transition(run, event)
```

`Runtime.Action` with `type: :execute_step` asks an outside layer to perform work. Its deterministic `id` is `<attempt_id>/action/execute-step`, requiring no clock or randomness and remaining stable under replay. It carries deterministic run, occurrence, and attempt identities; the semantic step key and explicit work instruction; performer and context requirements; provider-independent resolved lineage/affinity occurrence references; concrete input artifact instances; and declared output types. Emission moves the occurrence from `:pending` to `:dispatched`, so normal advancement cannot emit the same action twice.

`Runtime.Event` with `type: :step_completed` identifies both occurrence and attempt and provides exactly the declared outputs. Invalid or stale events return a structured `Runtime.Error` without changing the run. A valid event can instead produce a terminal structured `Runtime.Failure`, currently `:until_exhausted`.

No runtime function starts processes, executes a step, reads time, generates randomness, or performs I/O.

## Static Sequence and Parallel

The runtime reads `ExecutionPlan.control_dependencies`; it does not reinterpret the tactic AST. A sequence dispatches each step only after its predecessor completes. Parallel entries dispatch together, may complete in either order, and gate downstream work until every branch endpoint completes.

Each activated root or region phase has a serializable `Runtime.Scope`. A scope records its direct steps, nested regions, dependency set, source environment, and guaranteed semantic lineage. Nested `ControlSubtree` values are interpreted recursively, so static `Sequence`, `Parallel`, and nested `Until` composition work inside either phase.

## Until interpretation

An `Runtime.RegionOccurrence` captures one runtime entry into a compiled `UntilRegion`:

1. Snapshot the entering artifact sources and guaranteed lineage.
2. Initialize each compiled artifact carry from its entering source.
3. Activate a fresh check scope for cycle 0.
4. After the complete check subtree, resolve its condition artifact and compare the named string-keyed field using `:equals`.
5. On success, expose final check outputs and current carried artifacts.
6. On failure with budget remaining, activate a fresh otherwise scope for remediation cycle 1, 2, and so on.
7. After remediation, replace each current carry with its compiled remediation output and activate a new check scope.
8. If the check remains false after `max_remediations`, mark the region `:exhausted` and the run `:failed` with a deterministic `:until_exhausted` failure.

`max_remediations: 3` permits four checks and exactly three otherwise executions. Check and otherwise scope IDs are retained, as are all step occurrences, attempts, and artifacts, so an in-progress region can be inspected and reconstructed.

## Runtime artifacts

A static artifact declaration or binding names a string type and source. A `Runtime.ArtifactInstance` is the actual immutable value produced by one completed occurrence:

```text
id + type + producer occurrence + value
```

Values are restricted to serialization-friendly maps with string keys, lists, strings, numbers, booleans, and `nil`. All declared outputs are required and undeclared outputs are rejected.

Input resolution happens before an execute-step action is emitted. Fixed compiled bindings read the active scope's source environment; `RegionArtifactBinding` reads the region's current carried value. Outside executors receive concrete artifact instances and do not interpret static bindings.

When an `Until` succeeds, its `UntilOutput` entries resolve to existing artifact instances rather than copying values. Check outputs point to the final successful check artifacts; carried outputs point to the latest remediation artifacts, or to the original entering artifacts after immediate success. Downstream static bindings consume those resolved outputs normally.

## Context and performer references

The semantic requirements remain unchanged on every action:

- `fresh()` remains fresh on every repeated occurrence.
- `continue_from("implement")` remains a provider-independent semantic request and additionally resolves to the visible runtime occurrence of `"implement"`.
- `same_as("implement")` remains a scheduler-facing semantic affinity and additionally resolves to that visible runtime occurrence.

The runtime does not fabricate workers, members, sessions, or provider identifiers.

## Determinism and infrastructure boundary

Run, scope, region-occurrence, step-occurrence, attempt, and artifact identities are derived from the caller-supplied/default run ID and run-local counters. There are no timestamps, UUIDs, PIDs, functions, ports, references, or opaque resources in runtime state. Starting the same plan and applying the same event sequence recreates equal state and action sequences.

The state records active/completed scopes and regions, every emitted attempt (`:dispatched`), concrete artifacts, current carries, current check/remediation scope IDs, entering source snapshots, and all historical occurrences. This is sufficient to identify already emitted work and recover the logical position of an in-progress `Until` through the server's authoritative v0.5 snapshot without replaying transitions.

Workers, Herdr, Pi, dispatch transport, PostgreSQL, and OTP supervision must wrap this model later; none belongs inside it. The recommended next milestone is persistence and recovery before worker protocol integration, so infrastructure can host and restart the deterministic control state safely.
