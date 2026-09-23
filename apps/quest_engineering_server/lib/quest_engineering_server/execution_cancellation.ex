defmodule QuestEngineering.Server.ExecutionCancellation do
  @moduledoc """
  Authorizes one exact Product execution cancellation and delivers its fenced Worker command.

  Cancellation intent is durable before command delivery. Replays return the original intent;
  disconnected Workers receive the same command during reconciliation.
  """

  import Ecto.Query

  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  defmodule Error do
    @moduledoc "Machine-readable Product execution cancellation rejection."
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  @cancellable_states ~w(acknowledged running)

  def request(run_id, occurrence_id, attempt_id, request_id, reason \\ nil) do
    with :ok <- validate_request(run_id, occurrence_id, attempt_id, request_id, reason),
         {:ok, result} <- transact_request(run_id, occurrence_id, attempt_id, request_id, reason) do
      delivery = if result.new?, do: deliver(result.dispatch), else: :not_repeated
      RunChangeNotifier.notify(run_id)
      {:ok, response(result, delivery)}
    end
  end

  def pending_for_worker(worker_id, generation) do
    Repo.all(
      from dispatch in WorkerDispatch,
        join: outbox in RuntimeOutbox,
        on: outbox.action_id == dispatch.action_id,
        where:
          dispatch.worker_id == ^worker_id and
            dispatch.state in ^@cancellable_states and
            not is_nil(dispatch.cancellation_requested_at),
        order_by: [asc: dispatch.cancellation_requested_at],
        select: {dispatch, outbox}
    )
    |> Enum.map(fn {dispatch, outbox} ->
      {:ok, action} = RuntimeCodec.decode(outbox.payload)
      WorkerProtocol.cancel_dispatch(dispatch, action, generation)
    end)
  end

  defp transact_request(run_id, occurrence_id, attempt_id, request_id, reason) do
    case Repo.transaction(fn ->
           lock_run!(run_id)
           action = current_action!(run_id, occurrence_id, attempt_id)
           dispatch = lock_dispatch!(action.id)
           authorize!(dispatch, action, request_id, reason)
         end) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp authorize!(dispatch, action, request_id, reason) do
    cond do
      cancelled?(dispatch) ->
        %{dispatch: dispatch, action: action, new?: false}

      dispatch.state in ["completed", "failed"] ->
        %{dispatch: dispatch, action: action, new?: false, already_terminal?: true}

      dispatch.state == "uncertain" ->
        Repo.rollback(
          error(:execution_cancellation_requires_recovery, %{action_id: dispatch.action_id})
        )

      dispatch.state not in @cancellable_states ->
        Repo.rollback(
          error(:execution_cancellation_not_ready, %{
            action_id: dispatch.action_id,
            state: dispatch.state
          })
        )

      dispatch.cancellation_request_id ->
        %{dispatch: dispatch, action: action, new?: false}

      true ->
        now = now()

        changeset =
          WorkerDispatch.changeset(dispatch, %{
            cancellation_request_id: request_id,
            cancellation_origin: "product_operator",
            cancellation_reason: reason,
            cancellation_requested_generation: dispatch.last_connection_generation,
            cancellation_requested_at: now
          })

        case Repo.update(changeset) do
          {:ok, updated} ->
            %{dispatch: updated, action: action, new?: true}

          {:error, _changeset} ->
            Repo.rollback(
              error(:execution_cancellation_request_conflict, %{
                request_id: request_id,
                action_id: dispatch.action_id
              })
            )
        end
    end
  end

  defp deliver(dispatch) do
    worker = Repo.get(Worker, dispatch.worker_id)

    if worker && worker.status == "connected" do
      with {:ok, outbox} <- fetch_outbox(dispatch.action_id),
           {:ok, action} <-
             RuntimeCodec.decode(outbox.payload),
           :ok <-
             send_protocol(
               worker.id,
               worker.connection_generation,
               WorkerProtocol.cancel_dispatch(dispatch, action, worker.connection_generation)
             ) do
        :sent
      else
        _error -> :pending
      end
    else
      :pending
    end
  end

  defp send_protocol(worker_id, generation, message) do
    WorkerConnections.send_protocol(worker_id, generation, message)
  catch
    :exit, _reason -> {:error, :not_connected}
  end

  defp fetch_outbox(action_id) do
    case Repo.get_by(RuntimeOutbox, action_id: action_id) do
      nil -> {:error, :action_not_found}
      outbox -> {:ok, outbox}
    end
  end

  defp current_action!(run_id, occurrence_id, attempt_id) do
    scheduled =
      Repo.one(
        from action in ScheduledActionExecution,
          where: action.run_id == ^run_id and action.occurrence_id == ^occurrence_id,
          order_by: [desc: action.bound_at],
          limit: 1,
          lock: "FOR UPDATE"
      ) ||
        Repo.rollback(
          error(:execution_not_found, %{run_id: run_id, occurrence_id: occurrence_id})
        )

    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)

    if action.attempt_id != attempt_id do
      Repo.rollback(
        error(:execution_cancellation_identity_mismatch, %{
          occurrence_id: occurrence_id,
          attempt_id: attempt_id,
          current_attempt_id: action.attempt_id
        })
      )
    end

    action
  end

  defp lock_run!(run_id) do
    case Repo.one(from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE") do
      nil -> Repo.rollback(error(:run_not_found, %{run_id: run_id}))
      run -> run
    end
  end

  defp lock_dispatch!(action_id) do
    Repo.one(
      from dispatch in WorkerDispatch, where: dispatch.action_id == ^action_id, lock: "FOR UPDATE"
    ) ||
      Repo.rollback(error(:execution_not_ready, %{action_id: action_id}))
  end

  defp response(%{dispatch: dispatch, action: action, new?: new?} = result, delivery) do
    state =
      cond do
        cancelled?(dispatch) -> :cancelled
        Map.get(result, :already_terminal?, false) -> :already_terminal
        true -> :cancellation_requested
      end

    %{
      action_id: dispatch.action_id,
      worker_id: dispatch.worker_id,
      occurrence_id: action.occurrence_id,
      attempt_id: action.attempt_id,
      request_id: dispatch.cancellation_request_id,
      origin: dispatch.cancellation_origin,
      reason: dispatch.cancellation_reason,
      requested_generation: dispatch.cancellation_requested_generation,
      requested_at: dispatch.cancellation_requested_at,
      state: state,
      delivery: delivery,
      idempotent_replay: not new?
    }
  end

  defp cancelled?(dispatch) do
    dispatch.state == "failed" and
      get_in(dispatch.failure || %{}, ["code"]) == "execution_cancelled"
  end

  defp validate_request(run_id, occurrence_id, attempt_id, request_id, reason) do
    invalid =
      Enum.find(
        [
          run_id: run_id,
          occurrence_id: occurrence_id,
          attempt_id: attempt_id,
          request_id: request_id
        ],
        fn {_key, value} -> not valid_id?(value) end
      )

    cond do
      invalid ->
        {:error, error(:invalid_execution_cancellation, %{field: elem(invalid, 0)})}

      not is_nil(reason) and (not is_binary(reason) or byte_size(reason) > 500) ->
        {:error, error(:invalid_execution_cancellation, %{field: :reason})}

      true ->
        :ok
    end
  end

  defp valid_id?(value), do: is_binary(value) and value != "" and byte_size(value) <= 255
  defp error(code, details), do: %Error{code: code, details: details}
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
