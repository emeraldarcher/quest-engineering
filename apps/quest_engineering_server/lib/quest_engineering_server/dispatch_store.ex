defmodule QuestEngineering.Server.DispatchStore do
  @moduledoc """
  PostgreSQL authority for delivery state after the scheduler has atomically
  selected a Worker and reserved its slot. Network I/O never occurs here.
  """

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerError

  @active_states ~w(acknowledged running uncertain)

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
      if dispatch.state in ["completed", "failed", "running", "acknowledged", "uncertain"] do
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
      if dispatch.state in ["completed", "failed", "uncertain"] do
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
        updated =
          Repo.update!(
            Changeset.change(dispatch,
              state: "completed",
              acknowledged_at: dispatch.acknowledged_at || now(),
              terminal_at: dispatch.terminal_at || now(),
              last_connection_generation: generation
            )
          )

        mark_scheduled_terminal!(action_id, "completed", nil)
        updated
      end
    end)
  end

  def mark_failed(worker_id, generation, action_id, failure) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      cond do
        dispatch.state == "completed" ->
          Repo.rollback(error(:conflicting_terminal_dispatch_state, worker_id, action_id))

        dispatch.state == "failed" ->
          dispatch

        true ->
          updated =
            Repo.update!(
              Changeset.change(dispatch,
                state: "failed",
                acknowledged_at: dispatch.acknowledged_at || now(),
                terminal_at: dispatch.terminal_at || now(),
                failure: failure,
                last_connection_generation: generation
              )
            )

          mark_scheduled_terminal!(action_id, "failed", failure)
          updated
      end
    end)
  end

  @doc "Terminalizes an uncertain dispatch after an explicit operator decision."
  def resolve_uncertain(action_id, failure) when is_map(failure) do
    case Repo.get_by(WorkerDispatch, action_id: action_id) do
      nil ->
        {:error, error(:dispatch_not_found, nil, action_id)}

      _known_dispatch ->
        transact(fn -> resolve_uncertain_locked(action_id, failure) end)
    end
  end

  defp resolve_uncertain_locked(action_id, failure) do
    dispatch = lock_dispatch!(action_id)

    if dispatch.state != "uncertain" do
      Repo.rollback(
        error(:dispatch_not_uncertain, dispatch.worker_id, action_id, %{
          state: dispatch.state
        })
      )
    end

    updated =
      Repo.update!(
        Changeset.change(dispatch,
          state: "failed",
          terminal_at: dispatch.terminal_at || now(),
          failure: failure
        )
      )

    mark_scheduled_terminal!(action_id, "failed", failure)
    update_active_dispatches!(dispatch.worker_id)
    dispatch_record(updated)
  end

  def mark_uncertain(worker_id, generation, action_id, failure) do
    transition_from_worker(worker_id, generation, action_id, fn dispatch ->
      if dispatch.state in ["completed", "failed"] do
        dispatch
      else
        Repo.update!(
          Changeset.change(dispatch,
            state: "uncertain",
            acknowledged_at: dispatch.acknowledged_at || now(),
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

      dispatch.state in ["acknowledged", "running", "completed", "failed", "uncertain"] ->
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
      worker_slot: dispatch.worker_slot,
      state: dispatch_state(dispatch.state),
      action: action,
      claim_owner: dispatch.claim_owner,
      claim_token: dispatch.claim_token,
      claim_expires_at: dispatch.claim_expires_at,
      payload_hash: dispatch.payload_hash,
      failure: dispatch.failure,
      last_connection_generation: dispatch.last_connection_generation
    }
  end

  defp dispatch_state("claimed"), do: :claimed
  defp dispatch_state("dispatched"), do: :dispatched
  defp dispatch_state("acknowledged"), do: :acknowledged
  defp dispatch_state("running"), do: :running
  defp dispatch_state("completed"), do: :completed
  defp dispatch_state("failed"), do: :failed
  defp dispatch_state("uncertain"), do: :uncertain

  defp mark_scheduled_terminal!(action_id, state, failure) do
    case Repo.get(ScheduledActionExecution, action_id) do
      nil ->
        :ok

      %{state: "active"} = scheduled ->
        Repo.update!(
          Changeset.change(scheduled,
            state: state,
            terminal_at: now(),
            failure: failure
          )
        )

      _terminal ->
        :ok
    end
  end

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
