defmodule QuestEngineering.Server.DispatchStore do
  @moduledoc """
  PostgreSQL authority for delivery of durable runtime Action intents to an
  explicitly selected Worker.

  Claims never enclose network I/O. `FOR UPDATE SKIP LOCKED` prevents duplicate
  claims, while expiring claim metadata makes claim/send ambiguity recoverable.
  """

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerError

  @reserved_states ~w(claimed dispatched acknowledged running)
  @active_states ~w(acknowledged running)
  @default_lease_ms 1_000

  def claim_next(worker_id, claim_owner, options \\ []) do
    lease_ms = Keyword.get(options, :lease_ms, @default_lease_ms)
    now = now()
    expires_at = DateTime.add(now, lease_ms, :millisecond)
    token = Ecto.UUID.generate()

    transact(fn ->
      worker = lock_connected_worker!(worker_id)

      case reclaimable_dispatch(worker_id, now) do
        nil -> claim_pending(worker, claim_owner, token, expires_at)
        dispatch -> reclaim(dispatch, claim_owner, token, expires_at)
      end
    end)
  end

  def mark_dispatched(action_id, claim_token, generation) do
    case Repo.get_by(WorkerDispatch, action_id: action_id) do
      nil ->
        {:error, error(:dispatch_not_found, nil, action_id)}

      known_dispatch ->
        transact(fn ->
          lock_generation!(known_dispatch.worker_id, generation)
          dispatch = lock_dispatch!(action_id)
          mark_dispatched_locked!(dispatch, claim_token, generation)
        end)
    end
  end

  def acknowledge(worker_id, generation, action_id) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      if dispatch.state in ["completed", "failed", "running", "acknowledged"] do
        dispatch
      else
        Repo.update!(
          Changeset.change(dispatch,
            state: "acknowledged",
            acknowledged_at: dispatch.acknowledged_at || now(),
            last_connection_generation: generation
          )
        )
      end
    end)
  end

  def mark_running(worker_id, generation, action_id) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      if dispatch.state in ["completed", "failed"] do
        dispatch
      else
        Repo.update!(
          Changeset.change(dispatch,
            state: "running",
            acknowledged_at: dispatch.acknowledged_at || now(),
            last_connection_generation: generation
          )
        )
      end
    end)
  end

  def mark_completed(worker_id, generation, action_id) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      if dispatch.state == "failed" do
        Repo.rollback(error(:conflicting_terminal_dispatch_state, worker_id, action_id))
      else
        Repo.update!(
          Changeset.change(dispatch,
            state: "completed",
            acknowledged_at: dispatch.acknowledged_at || now(),
            terminal_at: dispatch.terminal_at || now(),
            last_connection_generation: generation
          )
        )
      end
    end)
  end

  def mark_failed(worker_id, generation, action_id, failure) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      if dispatch.state == "completed" do
        Repo.rollback(error(:conflicting_terminal_dispatch_state, worker_id, action_id))
      else
        Repo.update!(
          Changeset.change(dispatch,
            state: "failed",
            acknowledged_at: dispatch.acknowledged_at || now(),
            terminal_at: dispatch.terminal_at || now(),
            failure: failure,
            last_connection_generation: generation
          )
        )
      end
    end)
  end

  def fetch(action_id) do
    case Repo.get_by(WorkerDispatch, action_id: action_id) do
      nil -> {:error, error(:dispatch_not_found, nil, action_id)}
      dispatch -> load_record(dispatch)
    end
  end

  def list_for_worker(worker_id) do
    WorkerDispatch
    |> where([dispatch], dispatch.worker_id == ^worker_id)
    |> order_by([dispatch], asc: dispatch.id)
    |> Repo.all()
    |> Enum.reduce_while({:ok, []}, fn dispatch, {:ok, records} ->
      case load_record(dispatch) do
        {:ok, record} -> {:cont, {:ok, records ++ [record]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  def redeliverable_for_worker(worker_id) do
    query =
      from dispatch in WorkerDispatch,
        join: outbox in RuntimeOutbox,
        on: outbox.action_id == dispatch.action_id,
        where: dispatch.worker_id == ^worker_id and dispatch.state in ["claimed", "dispatched"],
        order_by: [asc: dispatch.id],
        select: {dispatch, outbox}

    query
    |> Repo.all()
    |> Enum.reduce_while({:ok, []}, fn {dispatch, outbox}, {:ok, records} ->
      case decode_action(outbox) do
        {:ok, action} -> {:cont, {:ok, records ++ [dispatch_record(dispatch, action)]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp mark_dispatched_locked!(dispatch, claim_token, generation) do
    cond do
      dispatch.claim_token != claim_token ->
        Repo.rollback(error(:stale_claim_token, dispatch.worker_id, dispatch.action_id))

      dispatch.state in ["acknowledged", "running", "completed", "failed"] ->
        dispatch_record(dispatch)

      dispatch.state in ["claimed", "dispatched"] ->
        dispatch
        |> Changeset.change(
          state: "dispatched",
          dispatched_at: dispatch.dispatched_at || now(),
          last_connection_generation: generation
        )
        |> Repo.update!()
        |> dispatch_record()
    end
  end

  defp claim_pending(worker, claim_owner, token, expires_at) do
    reserved =
      Repo.aggregate(
        from(dispatch in WorkerDispatch,
          where: dispatch.worker_id == ^worker.id and dispatch.state in ^@reserved_states
        ),
        :count
      )

    if reserved >= worker.max_concurrency do
      Repo.rollback(error(:worker_at_capacity, worker.id, nil, %{reserved: reserved}))
    end

    query =
      from outbox in RuntimeOutbox,
        left_join: dispatch in WorkerDispatch,
        on: dispatch.action_id == outbox.action_id,
        where: is_nil(dispatch.id),
        order_by: [asc: outbox.id],
        limit: 1,
        lock: "FOR UPDATE OF r0 SKIP LOCKED",
        select: outbox

    case Repo.one(query) do
      nil -> Repo.rollback(error(:no_pending_action, worker.id))
      outbox -> insert_claim(outbox, worker.id, claim_owner, token, expires_at)
    end
  end

  defp insert_claim(outbox, worker_id, claim_owner, token, expires_at) do
    attributes = %{
      action_id: outbox.action_id,
      worker_id: worker_id,
      state: "claimed",
      payload_hash: payload_hash(outbox.payload),
      claim_owner: claim_owner,
      claim_token: token,
      claim_expires_at: expires_at
    }

    case Repo.insert(WorkerDispatch.changeset(attributes)) do
      {:ok, dispatch} ->
        {:ok, action} = decode_action(outbox)
        dispatch_record(dispatch, action)

      {:error, changeset} ->
        Repo.rollback(
          error(:constraint_failure, worker_id, outbox.action_id, changeset_details(changeset))
        )
    end
  end

  defp reclaim(dispatch, claim_owner, token, expires_at) do
    updated =
      dispatch
      |> Changeset.change(
        claim_owner: claim_owner,
        claim_token: token,
        claim_expires_at: expires_at
      )
      |> Repo.update!()

    outbox = Repo.get_by!(RuntimeOutbox, action_id: updated.action_id)
    {:ok, action} = decode_action(outbox)
    dispatch_record(updated, action)
  end

  defp reclaimable_dispatch(worker_id, now) do
    Repo.one(
      from dispatch in WorkerDispatch,
        where:
          dispatch.worker_id == ^worker_id and dispatch.state in ["claimed", "dispatched"] and
            dispatch.claim_expires_at <= ^now,
        order_by: [asc: dispatch.id],
        limit: 1,
        lock: "FOR UPDATE SKIP LOCKED"
    )
  end

  defp transition_from_worker(worker_id, generation, action_id, fun) do
    transact(fn ->
      lock_generation!(worker_id, generation)
      dispatch = lock_dispatch!(action_id)

      if dispatch.worker_id != worker_id do
        Repo.rollback(error(:dispatch_worker_mismatch, worker_id, action_id))
      end

      result = fun.(dispatch)
      update_active_dispatches!(worker_id)
      dispatch_record(result)
    end)
  end

  defp lock_connected_worker!(worker_id) do
    case Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE") do
      nil -> Repo.rollback(error(:worker_not_found, worker_id))
      %{status: "connected"} = worker -> worker
      _worker -> Repo.rollback(error(:worker_disconnected, worker_id))
    end
  end

  defp lock_generation!(worker_id, generation) do
    case Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE") do
      nil ->
        Repo.rollback(error(:worker_not_found, worker_id))

      %{connection_generation: ^generation} = worker ->
        worker

      worker ->
        Repo.rollback(
          error(:stale_connection_generation, worker_id, nil, %{
            received_generation: generation,
            current_generation: worker.connection_generation
          })
        )
    end
  end

  defp lock_dispatch!(action_id) do
    case Repo.one(
           from dispatch in WorkerDispatch,
             where: dispatch.action_id == ^action_id,
             lock: "FOR UPDATE"
         ) do
      nil -> Repo.rollback(error(:dispatch_not_found, nil, action_id))
      dispatch -> dispatch
    end
  end

  defp update_active_dispatches!(worker_id) do
    count =
      Repo.aggregate(
        from(dispatch in WorkerDispatch,
          where: dispatch.worker_id == ^worker_id and dispatch.state in ^@active_states
        ),
        :count
      )

    worker = Repo.get!(Worker, worker_id)
    Repo.update!(Changeset.change(worker, active_dispatches: count))
  end

  defp load_record(dispatch) do
    outbox = Repo.get_by!(RuntimeOutbox, action_id: dispatch.action_id)

    case decode_action(outbox) do
      {:ok, action} -> {:ok, dispatch_record(dispatch, action)}
      {:error, error} -> {:error, error}
    end
  end

  defp decode_action(outbox), do: RuntimeCodec.decode(outbox.payload)

  defp dispatch_record(dispatch, action \\ nil) do
    %{
      action_id: dispatch.action_id,
      worker_id: dispatch.worker_id,
      state: dispatch_state(dispatch.state),
      action: action,
      claim_owner: dispatch.claim_owner,
      claim_token: dispatch.claim_token,
      claim_expires_at: dispatch.claim_expires_at,
      payload_hash: dispatch.payload_hash,
      last_connection_generation: dispatch.last_connection_generation
    }
  end

  defp dispatch_state("claimed"), do: :claimed
  defp dispatch_state("dispatched"), do: :dispatched
  defp dispatch_state("acknowledged"), do: :acknowledged
  defp dispatch_state("running"), do: :running
  defp dispatch_state("completed"), do: :completed
  defp dispatch_state("failed"), do: :failed

  defp payload_hash(payload) do
    :sha256
    |> :crypto.hash(Jason.encode!(payload))
    |> Base.encode16(case: :lower)
  end

  defp changeset_details(changeset),
    do: %{errors: Changeset.traverse_errors(changeset, &elem(&1, 0))}

  defp error(type, worker_id, action_id \\ nil, details \\ nil) do
    %WorkerError{type: type, worker_id: worker_id, action_id: action_id, details: details}
  end

  defp transact(fun) do
    case Repo.transaction(fun) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
