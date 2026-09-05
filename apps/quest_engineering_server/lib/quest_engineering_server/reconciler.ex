defmodule QuestEngineering.Server.Reconciler do
  @moduledoc "Converges server dispatch records with one Worker's fenced local registry."

  import Ecto.Query

  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.ReconciliationAnomaly
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerError

  @expected_states ~w(acknowledged running completed failed uncertain)

  def reconcile(worker_id, generation, observed) do
    case Repo.transaction(fn -> reconcile_locked!(worker_id, generation, observed) end) do
      {:ok, reconciliation} -> {:ok, reconciliation}
      {:error, error} -> {:error, error}
    end
  end

  @doc false
  def run_ids_for_worker(worker_id) do
    Repo.all(
      from dispatch in WorkerDispatch,
        join: outbox in QuestEngineering.Server.Persistence.RuntimeOutbox,
        on: outbox.action_id == dispatch.action_id,
        where: dispatch.worker_id == ^worker_id,
        select: outbox.run_id,
        distinct: true
    )
  end

  def list_anomalies(worker_id) do
    ReconciliationAnomaly
    |> where([anomaly], anomaly.worker_id == ^worker_id and anomaly.status == "open")
    |> order_by([anomaly], asc: anomaly.id)
    |> Repo.all()
  end

  defp reconcile_locked!(worker_id, generation, observed) do
    lock_generation!(worker_id, generation)

    with {:ok, observed_results} <- reconcile_observed(worker_id, generation, observed),
         {:ok, missing} <- record_missing(worker_id, observed) do
      %{observed: observed_results, anomalies: missing}
    else
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp lock_generation!(worker_id, generation) do
    case Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE") do
      %{connection_generation: ^generation} ->
        :ok

      nil ->
        Repo.rollback(%WorkerError{type: :worker_not_found, worker_id: worker_id})

      worker ->
        Repo.rollback(%WorkerError{
          type: :stale_connection_generation,
          worker_id: worker_id,
          details: %{
            received_generation: generation,
            current_generation: worker.connection_generation
          }
        })
    end
  end

  defp reconcile_observed(worker_id, generation, observed) do
    Enum.reduce_while(observed, {:ok, []}, fn item, {:ok, results} ->
      case reconcile_one(worker_id, generation, item) do
        {:ok, result} -> {:cont, {:ok, results ++ [result]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp reconcile_one(worker_id, generation, item) do
    case DispatchStore.fetch(item.action_id) do
      {:error, %WorkerError{type: :dispatch_not_found}} ->
        anomaly =
          anomaly(worker_id, item.action_id, "dispatch_unknown_to_server", %{state: item.state})

        {:ok, %{action_id: item.action_id, anomaly: anomaly.type}}

      {:error, error} ->
        {:error, error}

      {:ok, %{worker_id: other_worker}} when other_worker != worker_id ->
        {:error,
         %WorkerError{
           type: :dispatch_worker_mismatch,
           worker_id: worker_id,
           action_id: item.action_id,
           details: %{persisted_worker_id: other_worker}
         }}

      {:ok,
       %{
         action: action,
         state: :failed,
         failure: %{"code" => code}
       }}
      when item.state == :uncertain and
             code in ["operator_retry_requested", "operator_marked_failed"] ->
        with :ok <- validate_identity(action, item, worker_id) do
          {:ok,
           %{
             action_id: item.action_id,
             resolution: if(code == "operator_retry_requested", do: "retry", else: "mark_failed")
           }}
        end

      {:ok, %{action: action}} ->
        with :ok <- validate_identity(action, item, worker_id) do
          apply_observed(worker_id, generation, item)
        end
    end
  end

  defp apply_observed(worker_id, generation, %{state: :accepted} = item) do
    DispatchStore.acknowledge(worker_id, generation, item.action_id)
  end

  defp apply_observed(worker_id, generation, %{state: :running} = item) do
    DispatchStore.mark_running(worker_id, generation, item.action_id)
  end

  defp apply_observed(worker_id, generation, %{state: :completed} = item) do
    CompletionAdapter.complete(worker_id, generation, item)
  end

  defp apply_observed(worker_id, generation, %{state: :failed} = item) do
    DispatchStore.mark_failed(worker_id, generation, item.action_id, item.failure)
  end

  defp apply_observed(worker_id, generation, %{state: :uncertain} = item) do
    DispatchStore.mark_uncertain(worker_id, generation, item.action_id, item.failure)
  end

  defp record_missing(worker_id, observed) do
    observed_ids = MapSet.new(observed, & &1.action_id)

    expected =
      Repo.all(
        from dispatch in WorkerDispatch,
          where: dispatch.worker_id == ^worker_id and dispatch.state in ^@expected_states
      )

    anomalies =
      expected
      |> Enum.reject(&MapSet.member?(observed_ids, &1.action_id))
      |> Enum.map(fn dispatch ->
        anomaly(worker_id, dispatch.action_id, "dispatch_missing_on_worker", %{
          server_state: dispatch.state
        })
      end)

    {:ok, anomalies}
  end

  defp anomaly(worker_id, action_id, type, details) do
    attributes = %{
      worker_id: worker_id,
      action_id: action_id,
      type: type,
      details: stringify(details),
      status: "open"
    }

    attributes
    |> ReconciliationAnomaly.changeset()
    |> Repo.insert!(
      on_conflict: [set: [details: attributes.details, status: "open", updated_at: now()]],
      conflict_target: [:worker_id, :action_id, :type]
    )
  end

  defp validate_identity(action, item, worker_id) do
    if action.occurrence_id == item.occurrence_id and action.attempt_id == item.attempt_id do
      :ok
    else
      {:error,
       %WorkerError{
         type: :dispatch_identity_mismatch,
         worker_id: worker_id,
         action_id: action.id
       }}
    end
  end

  defp stringify(map), do: Map.new(map, fn {key, value} -> {to_string(key), value} end)
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
