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

The control plane hosts Worker Protocol v2 and `workers/bun` contains the first production execution Worker. It durably accepts Actions in local SQLite, hosts normal interactive Pi through a dedicated Herdr session, maps runtime context lineage to persistent provider lineages, validates atomic structured outputs, and reconciles after restart. The client remains a separate concern.

## Umbrella applications

- `quest_engineering_core` — dependency-free Elixir boundary containing semantic `Step`/`Sequence`/`Parallel`/`Until` tactics, orthogonal performer and context-lineage requirements, typed artifact resolution, deterministic compilation, and a pure runtime.
- `quest_engineering_server` — Phoenix/Ecto infrastructure boundary with authoritative runtime snapshots, serial revisions, idempotent transition history, a transactional PostgreSQL outbox, and the generation-fenced WebSocket Worker Protocol v2.

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

The greenfield migration creates runtime persistence plus `workers`, `worker_dispatches`, and reconciliation anomalies. See [`apps/quest_engineering_server/README.md`](apps/quest_engineering_server/README.md) for Worker Protocol v2, claiming, fencing, delivery, recovery, and reconciliation, and [`workers/bun/README.md`](workers/bun/README.md) for the real Worker/Herdr/Pi substrate.

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
