defmodule QuestEngineering.Server.WorkerStore do
  @moduledoc "Durable Worker identity, capability, connection-generation, and liveness storage."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerError

  @doc "Registers a connection and atomically advances its fencing generation."
  def register(worker_id, capabilities, connection_id) do
    now = now()

    transact(fn ->
      # Stable IDs are external strings, so a transaction-scoped advisory lock
      # avoids atom creation and serializes first registration races.
      Repo.query!("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [worker_id])

      worker = Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE")
      generation = if worker, do: worker.connection_generation + 1, else: 1
      active_dispatches = if worker, do: worker.active_dispatches, else: 0

      attributes = %{
        id: worker_id,
        capabilities: capabilities,
        max_concurrency: capabilities["max_concurrency"],
        active_dispatches: active_dispatches,
        status: "connected",
        connection_id: connection_id,
        connection_generation: generation,
        connected_at: now,
        disconnected_at: nil,
        last_heartbeat_at: now
      }

      persist_registration(worker, attributes)
    end)
  end

  def heartbeat(worker_id, generation) do
    with_current(worker_id, generation, fn worker ->
      worker
      |> Changeset.change(last_heartbeat_at: now())
      |> Repo.update!()
    end)
  end

  def disconnect(worker_id, connection_id, generation) do
    transact(fn ->
      query =
        from worker in Worker,
          where:
            worker.id == ^worker_id and worker.connection_id == ^connection_id and
              worker.connection_generation == ^generation,
          lock: "FOR UPDATE"

      case Repo.one(query) do
        nil ->
          :stale_connection

        worker ->
          Repo.update!(Changeset.change(worker, status: "disconnected", disconnected_at: now()))
      end
    end)
  end

  def fetch(worker_id) do
    case Repo.get(Worker, worker_id) do
      nil -> {:error, %WorkerError{type: :worker_not_found, worker_id: worker_id}}
      worker -> {:ok, worker}
    end
  end

  @doc "Runs work while holding the Worker row lock and validating its generation fence."
  def with_current(worker_id, generation, fun) when is_function(fun, 1) do
    transact(fn ->
      query = from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE"

      case Repo.one(query) do
        nil ->
          Repo.rollback(%WorkerError{type: :worker_not_found, worker_id: worker_id})

        %{connection_generation: ^generation} = worker ->
          fun.(worker)

        worker ->
          Repo.rollback(stale_connection(worker_id, generation, worker.connection_generation))
      end
    end)
  end

  def authoritative?(worker_id, generation) do
    Repo.exists?(
      from worker in Worker,
        where:
          worker.id == ^worker_id and worker.connection_generation == ^generation and
            worker.status == "connected"
    )
  end

  defp persist_registration(worker, attributes) do
    changeset = Worker.registration_changeset(worker || %Worker{}, attributes)
    result = if worker, do: Repo.update(changeset), else: Repo.insert(changeset)

    case result do
      {:ok, registered} -> registered
      {:error, invalid_changeset} -> Repo.rollback(changeset_error(invalid_changeset))
    end
  end

  defp stale_connection(worker_id, received, current) do
    %WorkerError{
      type: :stale_connection_generation,
      worker_id: worker_id,
      details: %{received_generation: received, current_generation: current}
    }
  end

  defp changeset_error(changeset) do
    %WorkerError{
      type: :constraint_failure,
      details: %{errors: Changeset.traverse_errors(changeset, &elem(&1, 0))}
    }
  end

  defp transact(fun) do
    case Repo.transaction(fun) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
