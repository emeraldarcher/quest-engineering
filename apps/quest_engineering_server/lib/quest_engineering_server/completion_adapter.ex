defmodule QuestEngineering.Server.CompletionAdapter do
  @moduledoc "Applies worker completion facts through the authoritative RuntimeStore boundary."

  import Ecto.Query

  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerError

  def complete(worker_id, generation, message) do
    transact(fn ->
      lock_generation!(worker_id, generation)
      dispatch = lock_dispatch!(message.action_id)
      validate_worker!(dispatch, worker_id)
      outbox = Repo.get_by!(RuntimeOutbox, action_id: message.action_id)
      {:ok, action} = decode_or_rollback(outbox)
      validate_identity!(action, message, worker_id)

      event = Runtime.completed(action, message.outputs)
      transition_id = transition_id(worker_id, action.id)

      result =
        case RuntimeStore.apply_transition(action.run_id, transition_id, event) do
          {:ok, result} -> result
          {:error, error} -> Repo.rollback(error)
        end

      case DispatchStore.mark_completed(worker_id, generation, action.id) do
        {:ok, dispatch_record} ->
          retain_terminal_workspace(action.run_id, result.run)
          delivery = ensure_delivery(action.run_id, result.run)
          %{transition: result, dispatch: dispatch_record, delivery: delivery}

        {:error, error} ->
          Repo.rollback(error)
      end
    end)
  end

  defp retain_terminal_workspace(run_id, %{status: status})
       when status in [:completed, :failed] do
    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    from(assignment in RunWorkspaceAssignment,
      where: assignment.run_id == ^run_id and assignment.state == "ready"
    )
    |> Repo.update_all(set: [state: "retained", retained_at: now, updated_at: now])
  end

  defp retain_terminal_workspace(_run_id, _run), do: :ok

  defp ensure_delivery(run_id, %{status: :completed}),
    do: DeliveryStore.ensure_for_completed_run(run_id)

  defp ensure_delivery(_run_id, _run), do: nil

  def transition_id(worker_id, action_id) do
    "worker-completion/v1/" <>
      Base.url_encode64(worker_id, padding: false) <>
      "/" <> Base.url_encode64(action_id, padding: false)
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
end
