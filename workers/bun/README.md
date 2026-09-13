# Quest Engineering Bun Worker v0.12

The Bun Worker is the sole filesystem authority for Worker Protocol v7. Phoenix schedules logical Workspaces; Bun discovers authorized source repositories, persists bindings, provisions one managed Git worktree per Run, and executes every filesystem-enabled Action in that Run worktree.

## Required configuration

```text
QE_CONTROL_PLANE_URL=ws://127.0.0.1:4000/worker/websocket
QE_WORKER_ID=stable-worker-id
QE_WORKER_TOKEN=...
QE_ALLOWED_ROOTS_JSON=[{"key":"code","path":"/absolute/code","max_access":"read_write","discover_depth":4,"allow_unconfined_shell":false}]
QE_WORKER_HARNESSES=pi,antigravity
```

Optional:

```text
QE_WORKER_DATA_ROOT=.quest-engineering-worker
QE_WORKTREE_ROOT=/durable/managed/worktrees
QE_WORKSPACE_BINDINGS_JSON=[{"binding_id":"...","workspace_id":"...","authorized_root_key":"code","source_repository_root":"/absolute/code/repo","max_access":"read_write","allow_unconfined_shell":false}]
QE_EXECUTOR_MODELS=openai-codex/optional-pi-scope
QE_REASONING_LEVELS=low,medium,high
QE_MAX_CONCURRENCY=1
QE_HERDR_SESSION=quest-engineering-worker
```

Bindings created through control-plane discovery are stored in `workspace-bindings.json`. Physical Run mappings and Git provenance are stored with SQLite `synchronous=FULL` in `run-worktrees.sqlite`. Dispatch, harness-neutral QE lineage, harness kind, native conversation identity, Herdr terminal/process incarnation, activity, and unresolved HumanAttention are stored in `dispatches.sqlite`.

`QE_MAX_CONCURRENCY` is the number of simultaneous execution slots advertised by this long-lived host; it defaults conservatively to `1`. Set `QE_MAX_CONCURRENCY=2` explicitly on a development/staging Worker to allow two otherwise-eligible Actions to execute at once. Worker slots are independent of Product Member occupancy: with an Engineering Pair, Run A's reviewer and Run B's builder may use two slots concurrently, while the same `{squad_id, member_key}` builder may not execute for both Runs at once.

## Long-lived host and binding recovery

A Worker is a long-lived execution host, not a process created per Run. A Workspace binding is the durable mapping between a logical Product Project owned by PostgreSQL and a physical repository reachable by that Worker. A Run is isolated execution provisioned on the Worker using that mapping.

Startup registers Worker identity and base capabilities before reconciling bindings independently. Unreconciled bindings are unavailable for new scheduling. Accepted bindings become available; one rejected binding does not affect other bindings or Worker connectivity.

If Product storage no longer contains a binding's logical Workspace, the server returns a definitive `stale_workspace` outcome. Worker-owned bindings move atomically from the active set to the retired set in `workspace-bindings.json` and are not advertised again. Retired metadata remains available to identify historical retained worktrees; reconciliation never deletes worktrees, branches, dispatch SQLite data, harness lineage, or native session state. The physical repository remains discoverable and can be intentionally added as a new Project with a new Workspace ID without restarting the Worker.

`QE_WORKSPACE_BINDINGS_JSON` remains explicit operator configuration. A stale configured binding is fenced for the current Worker process and logged, but the environment is never rewritten. Update that configuration before the next process restart. Socket, server, timeout, and unexpected persistence failures do not retire local bindings; only a definitive semantic rejection does.

## Worktree invariant

Before any Action, including `workspace_access: none`:

1. Phoenix pins the Run to one Worker and one source binding.
2. Bun resolves committed source `HEAD` and records the full object ID.
3. Bun creates `qe/run/<stable-id>` using `git worktree add -b` under `QE_WORKTREE_ROOT`.
4. Bun verifies canonical top-level, Git common directory, registration, and branch.
5. Phoenix schedules only after the durable ready report.

Git metadata mutations are serialized by canonical Git common directory, including linked source worktrees. Dirty source changes are allowed but excluded and reported. Missing, corrupt, or branch-switched Run worktrees are fenced; they are never silently repaired, relocated, or recreated.

Terminal worktrees are retained. There is no automatic GC.

## Filesystem access

- `none`: Worker-controlled isolation CWD, no repository tools, no skills/templates/context files, Run worktree not exposed to the model.
- `read_only`: canonical Run worktree CWD with inspection-only mapped tools.
- `read_write`: canonical Run worktree CWD with requested mutation tools.

`terminal.shell` requires `read_write` and root-specific `allow_unconfined_shell: true`. Pi always starts with `--no-skills`, `--no-prompt-templates`, and `--no-context-files`.

Continuation requires exact harness kind, model, reasoning/effort, tools, logical Workspace, binding, worktree, canonical root, and access equality. It never crosses a harness, Run worktree, or Worker.

## Live sessions

`AgentHarness` owns coding-agent semantics and `TerminalSessionBackend` owns terminal transport. `HarnessRegistry` hosts Pi and interactive-first Antigravity concurrently over Herdr; Herdr is not a provider. One QE lineage may span several Attempts while native conversation and terminal/process incarnation remain distinct provenance.

Antigravity 1.2.2 discovers its authenticated native model catalog dynamically, pins the exact native model and any explicitly supported effort before inference, and keeps an actual TUI alive for normal Work Yard observation and authorized takeover. Models that explicitly lack effort control are advertised with `reasoning_capability.kind=unsupported`; their resolved reasoning is `null` and launch omits `--effort`. Its semantic-only `qe_complete_step` MCP tool and Stop hook both use the generic Worker-local control bridge. Native screen rendering and Stop `terminationReason` are not completion evidence. Recovery adopts a surviving exact TUI first, otherwise resumes only a verified native conversation into a new interactive process. Herdr 0.9 `agent_pane_busy` is handled by exact-launch adoption or shell-state settlement with one bounded retry, never a blind delay.

Pi advertises `tool_enforcement=exact` and maps a frozen QE capability subset to its native `--tools` set. Antigravity advertises `tool_enforcement=native_permissions`; its frozen tool list is the complete native capability profile, while Antigravity's allow/ask/deny engine remains authoritative for individual operations.

Herdr's actual `blocked` agent state creates provider-neutral HumanAttention; Pi's explicit `qe_request_human_assistance` tool can enrich the same episode with structured context. In `conversational_intervention` mode, Pi blocks and terminates only the current agent run, returns to its ordinary editor, permits multi-turn human chat, and resumes automation only through `/qe-resume`. The Worker keeps collecting the same dispatch across Pi's `agent_settled` boundary and persists the Product-safe checkpoint/lifecycle in the existing lineage registry. QE does not scan terminal or chat prose. Waiting retains dispatch, Member, Worker-slot, lineage and worktree occupancy. See [live-session acceptance](docs/live-session-acceptance.md) and the repository [architecture](../../docs/live-execution-sessions.md).

## Gates

```sh
bun run check
bun test
bun run integration:herdr-pi
bun run integration:worker-restart
```

The real-provider gates require existing Herdr/Pi authentication and are never run with the fake provider.
