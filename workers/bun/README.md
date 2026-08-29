# Quest Engineering Bun Worker v0.12

The Bun Worker is the sole filesystem authority for Worker Protocol v4. Phoenix schedules logical Workspaces; Bun discovers authorized source repositories, persists bindings, provisions one managed Git worktree per Run, and executes every filesystem-enabled Action in that Run worktree.

## Required configuration

```text
QE_CONTROL_PLANE_URL=ws://127.0.0.1:4000/worker/websocket
QE_WORKER_ID=stable-worker-id
QE_WORKER_TOKEN=...
QE_ALLOWED_ROOTS_JSON=[{"key":"code","path":"/absolute/code","max_access":"read_write","discover_depth":4,"allow_unconfined_shell":false}]
QE_EXECUTOR_MODELS=openai-codex/model-name
```

Optional:

```text
QE_WORKER_DATA_ROOT=.quest-engineering-worker
QE_WORKTREE_ROOT=/durable/managed/worktrees
QE_WORKSPACE_BINDINGS_JSON=[{"binding_id":"...","workspace_id":"...","authorized_root_key":"code","source_repository_root":"/absolute/code/repo","max_access":"read_write","allow_unconfined_shell":false}]
QE_REASONING_LEVELS=low,medium,high
QE_MAX_CONCURRENCY=1
QE_HERDR_SESSION=quest-engineering-worker
```

Bindings created through control-plane discovery are stored in `workspace-bindings.json`. Physical Run mappings and Git provenance are stored with SQLite `synchronous=FULL` in `run-worktrees.sqlite`.

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

Continuation requires exact model, reasoning, tools, logical Workspace, binding, worktree, canonical root, and access equality. It never crosses a Run worktree or Worker.

## Gates

```sh
bun run check
bun test
bun run integration:herdr-pi
bun run integration:worker-restart
```

The real-provider gates require existing Herdr/Pi authentication and are never run with the fake provider.
