# Quest Engineering Bun Worker v0.7

The Bun Worker is a long-lived execution node for Worker Protocol v2:

```text
Elixir control plane → Bun Worker → Herdr → Pi
```

It owns transport, durable local dispatch acceptance, provider execution, the configured workspace boundary, structured-result validation, and reconciliation. It does not own semantic control flow, retries, review acceptance, scheduling, performers, Classes, Loadouts, Squads, or Quests.

## Configuration

Required:

```text
QE_CONTROL_PLANE_URL=ws://127.0.0.1:4000/worker/websocket
QE_WORKER_ID=stable-worker-id
QE_WORKER_TOKEN=...
QE_WORKSPACE_ROOT=/absolute/path/to/a/git/worktree
```

Optional:

```text
QE_WORKER_DATA_ROOT=.quest-engineering-worker
QE_HERDR_SESSION=quest-engineering-worker
QE_MAX_CONCURRENCY=1
QE_WORKER_TAGS=local,git
QE_PI_MODEL=provider/model
QE_PI_THINKING=medium
QE_HEARTBEAT_MS=10000
QE_RECONNECT_MS=1000
QE_RESULT_TIMEOUT_MS=21600000
```

The Herdr session must not be `default`. The official integration must be installed manually:

```sh
herdr integration install pi
```

The deterministic fake provider is test-only and requires both:

```text
QE_WORKER_PROVIDER=fake
QE_ENABLE_TEST_PROVIDER=1
```

## Durability

SQLite stores one dispatch per stable `action_id`. `occurrence_id` is indexed but deliberately not unique because an occurrence may have multiple execution attempts in a future runtime.

Acceptance ordering is:

```text
receive execute_action
→ BEGIN IMMEDIATE
→ insert accepted dispatch and result identity
→ COMMIT
→ send dispatch_accepted
→ touch Herdr/Pi
```

Completed outputs are validated and committed before `step_completed` is sent. A lost control-plane acknowledgement leaves the dispatch completed and eligible for resend.

`provider_lineages.active_action_id` is physical Pi occupancy. The same transaction that persists a valid completed result clears occupancy. Server acknowledgement is tracked separately and never blocks a later valid continuation.

## SessionHost and Herdr

`HerdrSessionHost` wraps the verified Herdr 19/20 socket operations. Herdr owns the terminal and Pi process, so Worker or control-plane shutdown only disconnects controller sockets.

Fresh context creates a new lineage, tab, Pi process, and native Pi session. Herdr pane metadata stores opaque Worker, lineage, active Action, and result provenance. Recovery checks exact pane/terminal/agent identity and ownership tokens; labels are never identity.

A live terminal remains directly attachable:

```sh
herdr --session <session> agent attach <agent-name>
```

## Pi provider and context lineage

`PiProvider` composes only:

- the provider-neutral `Step.instruction`
- resolved input artifacts
- exact declared output names
- workspace safety boundaries
- the structured result-tool requirement

It does not infer work from semantic step keys.

A fresh lineage owns one stable result-control path. `continue_from` resolves the prior runtime occurrence to its unambiguous completed provider lineage, reuses the same Pi agent and stable control path, and atomically updates that file with the new Action identity, nonce, declared outputs, and Action-specific result directory before prompting.

## Structured results

Pi must call `qe_step_result` exactly once. The extension atomically publishes a versioned envelope outside the worktree. The Worker requires exact Worker/Action/Run/occurrence/attempt/nonce identity, exactly one result, all declared outputs, no undeclared outputs, and recursively JSON-compatible values. Terminal prose and Herdr `idle`/`done` never become implicit outputs.

## Reconciliation

At startup the Worker reconciles SQLite against Herdr before registering with Elixir:

- running + exact agent: observe the same process
- temporary Herdr outage: retain local running state
- running + available Herdr + missing agent: fail as infrastructure; never replace it
- settled + valid result: persist completion and resend
- settled + no result after prompt intent: mark uncertain/failed; never reprompt
- safe Herdr provenance + matching lineage control file + missing dispatch: adopt
- ambiguous provenance: leave the session alive and refuse to guess

Herdr `agent.prompt` has no submission idempotency key. The Worker therefore chooses safety over liveness in an irreducibly ambiguous settled-without-result crash window.

## Checks

```sh
bun test
bun run typecheck
bun run check

# Opt-in, uses real Herdr/Pi and may consume model quota:
bun run integration:herdr-pi
bun run integration:worker-restart
```

The live integration retains its repository-local `.pi/tmp` fixture and prints exact native attach descriptors. The restart harness kills the Bun controller while Pi is working, then proves the same lineage, agent, pane, and single logical execution complete after recovery.
