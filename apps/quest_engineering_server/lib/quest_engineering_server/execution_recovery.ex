defmodule QuestEngineering.Server.ExecutionRecovery do
  @moduledoc "Explicit operator resolution for physically uncertain Step attempts."

  import Ecto.Query

  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.ProductChangeNotifier
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  defmodule Error do
    @moduledoc "Machine-readable rejection of an execution recovery request."
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  @type resolution :: :retry | :mark_failed

  def retry(run_id, occurrence_id), do: resolve(run_id, occurrence_id, :retry)
  def mark_failed(run_id, occurrence_id), do: resolve(run_id, occurrence_id, :mark_failed)

  defp resolve(run_id, occurrence_id, resolution) do
    result =
      Repo.transaction(fn ->
        {_dispatch, action} = lock_uncertain!(run_id, occurrence_id)
        failure = resolution_failure(resolution)
        event = resolution_event(resolution, action, failure)
        transition_id = transition_id(resolution, action.id)

        transition =
          case RuntimeStore.apply_transition(run_id, transition_id, event) do
            {:ok, value} -> value
            {:error, error} -> Repo.rollback(error)
          end

        dispatch =
          case DispatchStore.resolve_uncertain(action.id, failure) do
            {:ok, value} -> value
            {:error, error} -> Repo.rollback(error)
          end

        if resolution == :mark_failed, do: retain_workspace(run_id)
        %{transition: transition, dispatch: dispatch, resolution: resolution}
      end)

    case result do
      {:ok, recovered} ->
        notify_worker(recovered)
        Scheduler.wake(run_id)
        RunChangeNotifier.notify(run_id)
        ProductChangeNotifier.notify(["quests", "runs"])
        {:ok, recovered}

      {:error, error} ->
        {:error, error}
    end
  end

  defp lock_uncertain!(run_id, occurrence_id) do
    query =
      from dispatch in WorkerDispatch,
        join: outbox in RuntimeOutbox,
        on: outbox.action_id == dispatch.action_id,
        where: outbox.run_id == ^run_id and dispatch.state == "uncertain",
        select: {dispatch, outbox},
        lock: "FOR UPDATE"

    match =
      query
      |> Repo.all()
      |> Enum.find_value(fn {dispatch, outbox} ->
        case RuntimeCodec.decode(outbox.payload) do
          {:ok, %{occurrence_id: ^occurrence_id} = action} -> {dispatch, action}
          {:ok, _other_action} -> nil
          {:error, error} -> Repo.rollback(error)
        end
      end)

    case match do
      nil ->
        Repo.rollback(%Error{
          code: :execution_not_uncertain,
          details: %{run_id: run_id, occurrence_id: occurrence_id}
        })

      value ->
        value
    end
  end

  defp resolution_event(:retry, action, _failure), do: Runtime.retry_requested(action)
  defp resolution_event(:mark_failed, action, failure), do: Runtime.failed(action, failure)

  defp resolution_failure(:retry) do
    %{
      "code" => "operator_retry_requested",
      "reason" => "operator_retry_requested",
      "message" => "The operator acknowledged uncertainty and requested a new attempt."
    }
  end

  defp resolution_failure(:mark_failed) do
    %{
      "code" => "operator_marked_failed",
      "reason" => "operator_marked_failed",
      "message" => "The operator marked the uncertain attempt as failed."
    }
  end

  defp transition_id(resolution, action_id) do
    "operator-execution-resolution/v1/#{resolution}/" <>
      Base.url_encode64(action_id, padding: false)
  end

  defp retain_workspace(run_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    from(assignment in RunWorkspaceAssignment,
      where: assignment.run_id == ^run_id and assignment.state == "ready"
    )
    |> Repo.update_all(set: [state: "retained", retained_at: now, updated_at: now])
  end

  defp notify_worker(%{dispatch: dispatch, resolution: resolution}) do
    worker = Repo.get(Worker, dispatch.worker_id)

    if worker && Process.whereis(WorkerConnections) do
      WorkerConnections.send_protocol(
        worker.id,
        worker.connection_generation,
        WorkerProtocol.resolve_uncertain_dispatch(worker.id, dispatch.action_id, resolution)
      )
      |> case do
        :ok -> :ok
        {:error, _reason} -> :ok
      end
    else
      :ok
    end
  end
end
