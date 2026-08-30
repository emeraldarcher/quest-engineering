# Quest Engineering

Quest Engineering is a control plane for orchestrating persistent AI-agent work. This repository contains the authoritative Elixir control plane foundation and its first dependency-free semantic tactic compiler.

## Current architecture

```text
Quest Engineering Client
        ↓
Quest Engineering Control Plane (this repository)
        ↓
Quest Engineering Worker (separate Bun/TypeScript component)
        ↓
Herdr mux
        ↓
Pi
```

The control plane hosts Worker Protocol v4 and `workers/bun` is the filesystem authority. Product Workspaces are logical and path-free; Workers discover explicitly authorized source repositories and provision one durable isolated Git worktree per Run before model execution. After successful Runtime completion, the Worker safely finalizes and pushes Git changes while Phoenix creates and centrally reconciles one same-repository GitHub Pull Request. Only an exact human-merged PR completes the Quest; publishing retry, explicit Run Again, and safe worktree cleanup remain separate operations. The Svelte/Pixi/Tauri client presents the Product as a compact fantasy management town.

## Umbrella applications

- `quest_engineering_core` — dependency-free Elixir boundary containing reusable Product Tactic authoring and pure expansion into semantic `Step`/`Sequence`/`Parallel`/`Until` tactics, deterministic compilation, and a pure runtime.
- `quest_engineering_server` — Phoenix/Ecto infrastructure boundary with Product Tactic persistence, immutable resolved launch snapshots, transactional runtime persistence, and the generation-fenced WebSocket Worker Protocol v4.

Dependencies point inward only:

```text
quest_engineering_server
        ↓
quest_engineering_core
```

`quest_engineering_core` must never depend on the server, Phoenix, Ecto, PostgreSQL, HTTP, process/filesystem APIs, Herdr, Pi, or Bun.

## Requirements

Versions are declared in [`.tool-versions`](.tool-versions):

- Erlang/OTP 29.0.5
- Elixir 1.20.3
- PostgreSQL 18.3 (provided by Docker Compose)

Install Erlang and Elixir with your preferred version manager. With asdf:

```sh
asdf install
```

## Local setup

Start PostgreSQL:

```sh
docker compose up -d postgres
```

Install dependencies, create the development database, and run migrations:

```sh
mix deps.get
mix ecto.create
mix ecto.migrate
# Or perform all three steps at once:
mix setup
```

Additive migrations create Product definitions, logical Workspaces, durable binding attempts, Worker source bindings, Run workspace assignments, one-per-Run Deliveries, Quest completion metadata, runtime persistence, dispatches, and reconciliation records. See [`apps/quest_engineering_server/README.md`](apps/quest_engineering_server/README.md) and [`workers/bun/README.md`](workers/bun/README.md) for v4 provisioning, fencing, delivery, and restart recovery.

Run the umbrella tests. The test alias creates and migrates the test database automatically:

```sh
mix test
```

Prove the core compiles and tests independently:

```sh
cd apps/quest_engineering_core
mix test
cd ../..
```

Run the API server:

```sh
mix phx.server
```

The health endpoint is available at <http://localhost:4000/api/v1/health>. Workers connect to `/worker/websocket` with the configured static Worker token.

Run deterministic code-quality checks (format, warnings-as-errors compilation, unused dependency check, ExUnit, and Credo):

```sh
mix check
```

Run Dialyzer separately because initial PLT construction is comparatively slow:

```sh
mix dialyzer
```

Generate test coverage with ExCoveralls:

```sh
mix coveralls.html
```
