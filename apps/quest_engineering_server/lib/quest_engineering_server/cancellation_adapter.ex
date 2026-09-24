defmodule QuestEngineering.Server.CancellationAdapter do
  @moduledoc "Applies an authorized Worker cancellation through the authoritative RuntimeStore boundary."

  import Ecto.Query

  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerError

  def cancel(worker_id, generation, message) do
    transact(fn ->
      outbox = Repo.get_by!(RuntimeOutbox, action_id: message.action_id)
      {:ok, action} = decode_or_rollback(outbox)
      lock_runtime!(action.run_id)
      lock_generation!(worker_id, generation)
      dispatch = lock_dispatch!(message.action_id)
      validate_worker!(dispatch, worker_id)
      validate_identity!(action, message, worker_id)
      validate_authority!(dispatch, message.failure, worker_id, generation)

      transition_id = transition_id(worker_id, action.id, dispatch.cancellation_request_id)

      transition =
        case RuntimeStore.apply_transition(
               action.run_id,
               transition_id,
               Runtime.failed(action, message.failure)
             ) do
          {:ok, result} -> result
          {:error, error} -> Repo.rollback(error)
        end

      case DispatchStore.mark_failed(worker_id, generation, action.id, message.failure) do
        {:ok, dispatch_record} ->
          retain_terminal_workspace(action.run_id, transition.run)
          %{transition: transition, dispatch: dispatch_record}

        {:error, error} ->
          Repo.rollback(error)
      end
    end)
  end

  def transition_id(worker_id, action_id, request_id) do
    "worker-cancellation/v1/" <>
      Base.url_encode64(worker_id, padding: false) <>
      "/" <>
      Base.url_encode64(action_id, padding: false) <>
      "/" <> Base.url_encode64(request_id, padding: false)
  end

  defp validate_authority!(dispatch, failure, worker_id, generation) do
    validate_cancellation_kind!(dispatch, failure, worker_id)
    validate_cancellation_request!(dispatch, failure, worker_id)
    validate_cancellation_provenance!(dispatch, failure, worker_id)
    validate_cancellation_generation!(dispatch, failure, worker_id, generation)

    unless iso8601?(failure["cancelled_at"]),
      do: Repo.rollback(error(:execution_cancellation_invalid, worker_id, dispatch.action_id))
  end

  defp validate_cancellation_kind!(dispatch, failure, worker_id) do
    unless failure["code"] == "execution_cancelled" and
             failure["reason"] == "execution_cancelled" and
             failure["classification"] == "terminal_not_recoverable",
           do:
             Repo.rollback(error(:execution_cancellation_invalid, worker_id, dispatch.action_id))
  end

  defp validate_cancellation_request!(dispatch, failure, worker_id) do
    if is_nil(dispatch.cancellation_request_id),
      do:
        Repo.rollback(error(:execution_cancellation_unauthorized, worker_id, dispatch.action_id))

    if failure["cancellation_request_id"] != dispatch.cancellation_request_id do
      Repo.rollback(
        error(:execution_cancellation_identity_mismatch, worker_id, dispatch.action_id, %{
          expected_request_id: dispatch.cancellation_request_id,
          received_request_id: failure["cancellation_request_id"]
        })
      )
    end
  end

  defp validate_cancellation_provenance!(dispatch, failure, worker_id) do
    expected_requested_at = DateTime.to_iso8601(dispatch.cancellation_requested_at)

    if failure["cancellation_origin"] != dispatch.cancellation_origin or
         failure["cancellation_reason"] != dispatch.cancellation_reason or
         failure["cancellation_requested_at"] != expected_requested_at do
      Repo.rollback(
        error(:execution_cancellation_identity_mismatch, worker_id, dispatch.action_id, %{
          expected_origin: dispatch.cancellation_origin,
          received_origin: failure["cancellation_origin"],
          expected_reason: dispatch.cancellation_reason,
          received_reason: failure["cancellation_reason"],
          expected_requested_at: expected_requested_at,
          received_requested_at: failure["cancellation_requested_at"]
        })
      )
    end
  end

  defp validate_cancellation_generation!(dispatch, failure, worker_id, generation) do
    cancellation_generation = failure["cancellation_worker_generation"]

    if not is_integer(cancellation_generation) or
         cancellation_generation < dispatch.cancellation_requested_generation or
         cancellation_generation > generation do
      Repo.rollback(
        error(:stale_connection_generation, worker_id, dispatch.action_id, %{
          requested_generation: dispatch.cancellation_requested_generation,
          cancellation_generation: cancellation_generation,
          current_generation: generation
        })
      )
    end
  end

  defp retain_terminal_workspace(run_id, %{status: status})
       when status in [:completed, :failed] do
    now = now()

    from(assignment in RunWorkspaceAssignment,
      where:
        assignment.run_id == ^run_id and
          assignment.state in ["ready", "attention_required"]
    )
    |> Repo.update_all(set: [state: "retained", retained_at: now, updated_at: now])
  end

  defp retain_terminal_workspace(_run_id, _run), do: :ok

  defp lock_runtime!(run_id) do
    case Repo.one(from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE") do
      nil -> Repo.rollback(error(:run_not_found, nil))
      run -> run
    end
  end

  defp lock_generation!(worker_id, generation) do
    case Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE") do
      %{connection_generation: ^generation} ->
        :ok

      nil ->
        Repo.rollback(error(:worker_not_found, worker_id))

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

  defp validate_worker!(%{worker_id: worker_id}, worker_id), do: :ok

  defp validate_worker!(_dispatch, worker_id),
    do: Repo.rollback(error(:dispatch_worker_mismatch, worker_id))

  defp validate_identity!(action, message, worker_id) do
    if action.occurrence_id == message.occurrence_id and action.attempt_id == message.attempt_id do
      :ok
    else
      Repo.rollback(
        error(:dispatch_identity_mismatch, worker_id, action.id, %{
          expected_occurrence_id: action.occurrence_id,
          received_occurrence_id: message.occurrence_id,
          expected_attempt_id: action.attempt_id,
          received_attempt_id: message.attempt_id
        })
      )
    end
  end

  defp decode_or_rollback(outbox) do
    case RuntimeCodec.decode(outbox.payload) do
      {:ok, action} -> {:ok, action}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp error(type, worker_id, action_id \\ nil, details \\ nil),
    do: %WorkerError{type: type, worker_id: worker_id, action_id: action_id, details: details}

  defp transact(fun) do
    case Repo.transaction(fun) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp iso8601?(value) when is_binary(value) do
    match?({:ok, _datetime, _offset}, DateTime.from_iso8601(value))
  end

  defp iso8601?(_value), do: false

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
