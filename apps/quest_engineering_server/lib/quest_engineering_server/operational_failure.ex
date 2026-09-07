defmodule QuestEngineering.Server.OperationalFailure do
  @moduledoc "Applies one classified terminal execution failure and any safe same-epoch retry."

  import Ecto.Query

  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.OperationalRecovery
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Repo

  def record(worker_id, generation, message) do
    case Repo.transaction(fn -> record_locked!(worker_id, generation, message) end) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp record_locked!(worker_id, generation, message) do
    lock_run_for_action!(message.action_id)

    with {:ok, dispatch} <-
           DispatchStore.mark_failed(
             worker_id,
             generation,
             message.action_id,
             message.failure
           ),
         {:ok, result} <-
           apply_policy(
             dispatch,
             OperationalRecovery.failure_policy(message.action_id, message.failure)
           ) do
      result
    else
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp lock_run_for_action!(action_id) do
    outbox = Repo.get_by!(RuntimeOutbox, action_id: action_id)
    Repo.one!(from run in RuntimeRun, where: run.id == ^outbox.run_id, lock: "FOR UPDATE")
  end

  defp apply_policy(dispatch, {:automatic_retry, _epoch}) do
    case OperationalRecovery.automatic_retry(dispatch.action_id) do
      {:ok, transition} ->
        {:ok,
         %{
           dispatch: dispatch,
           policy: :automatic_retry_scheduled,
           transition: transition
         }}

      {:error, error} ->
        {:error, error}
    end
  end

  defp apply_policy(dispatch, {policy, epoch}),
    do: {:ok, %{dispatch: dispatch, policy: policy, epoch: epoch, transition: nil}}
end
