# Quest Engineering Bun Worker v0.8b

The Bun Worker executes immutable Worker Protocol v3 `ResolvedExecution` values:

```text
Elixir scheduler → Bun Worker → executor adapter → Herdr → Pi
```

It owns durable local acceptance, exact capability enforcement, physical provider lineage, structured results, and reconciliation. Product and Core Runtime remain provider-neutral.

## Configuration

Required:

```text
QE_CONTROL_PLANE_URL=ws://127.0.0.1:4000/worker/websocket
QE_WORKER_ID=stable-worker-id
QE_WORKER_TOKEN=...
QE_WORKSPACE_REF=workspace:project
QE_WORKSPACE_ROOT=/absolute/path/to/a/git/worktree
QE_EXECUTOR_MODELS=openai-codex/model-name,other-provider/model-name
```

Optional:

```text
QE_WORKSPACE_MAX_ACCESS=read_write       # none | read_only | read_write
QE_REASONING_LEVELS=low,medium,high
QE_WORKER_DATA_ROOT=.quest-engineering-worker
QE_HERDR_SESSION=quest-engineering-worker
QE_MAX_CONCURRENCY=1
QE_WORKER_TAGS=local,git
QE_HEARTBEAT_MS=10000
QE_RECONNECT_MS=1000
QE_RESULT_TIMEOUT_MS=21600000
```

The fake executor is test-only and requires:

```text
QE_WORKER_PROVIDER=fake
QE_ENABLE_TEST_PROVIDER=1
```

The official Herdr Pi integration must be installed manually:

```sh
herdr integration install pi
```

## Capabilities and per-execution configuration

The Worker advertises executor records containing exact models, reasoning levels, QE capability keys, workspaces, and maximum workspace access. It defensively rejects any v3 execution not supported by the same advertisement.

The initial Pi mappings are:

| QE capability | Pi tools |
|---|---|
| `workspace.filesystem` / read-only | `read` |
| `workspace.filesystem` / read-write | `read`, `edit`, `write` |
| `workspace.search` | `grep`, `find`, `ls` |
| `terminal.shell` / read-write | `bash` |

`qe_step_result` is mandatory infrastructure, not a Product capability. Model and reasoning are passed to Pi from each immutable execution rather than Worker-global defaults.

## Workspace enforcement

- `none`: Pi runs in a lineage-specific Worker-data directory with only `qe_step_result`; no workspace tools are active.
- `read_only`: mutation tools and shell/user-shell are mechanically blocked; path-bearing read/search calls are constrained to the canonical root.
- `read_write`: only explicitly mapped tools are active; path-bearing filesystem calls remain root-checked and shell is present only with `terminal.shell`.

Read-write shell path confinement remains limited by Pi's shell interception API and is supplemented by the mandatory workspace policy. Restricted `none` and `read_only` modes do not expose shell.

## Durable identity and continuation

SQLite canonical-hashes the complete normalized v3 payload. Receiving the same Action ID with different payload is an identity conflict and never starts another execution.

Each fresh logical context creates one Worker-local physical provider lineage. SQLite persists its server logical lineage ID and canonical configuration. Continuation resolves by logical lineage ID and requires exact equality of:

- model provider/name;
- reasoning;
- order-independent QE tool set;
- canonical workspace root;
- workspace access.

Mismatch fails explicitly with `incompatible_continuation_configuration`; it never creates or partially reconfigures another Pi.

## Uncertainty and restart

`uncertain` is nonterminal for occupancy. Bun retains physical lineage `active_action_id`, reports `uncertain` during reconciliation, and does not reprompt or clear Herdr active metadata. Worker or control-plane restart recovers the exact Herdr/Pi process when provenance is available.

Known terminal adapter failure may clear physical occupancy and report `failed`. The server can release scheduling resources, but Core Runtime remains dispatched in v0.8b because semantic execution-failure/retry behavior does not yet exist.

## Checks

```sh
bun test
bun run typecheck
bun run check

# Opt-in and may consume model quota:
bun run integration:herdr-pi
bun run integration:worker-restart
```
