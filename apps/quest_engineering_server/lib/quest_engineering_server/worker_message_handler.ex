defmodule QuestEngineering.Server.WorkerMessageHandler do
  @moduledoc "Application adapter for validated, generation-fenced Worker messages."

  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Reconciler
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.Server.WorkerStore

  def handle(worker_id, generation, %{type: :heartbeat}) do
    result(WorkerStore.heartbeat(worker_id, generation))
  end

  def handle(worker_id, generation, %{type: :dispatch_accepted} = message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, dispatch} <- DispatchStore.acknowledge(worker_id, generation, message.action_id) do
      notify_action(message.action_id)
      {:ok, response(:dispatch_acknowledged, dispatch)}
    end
  end

  def handle(worker_id, generation, %{type: :dispatch_state, state: :accepted} = message),
    do: handle(worker_id, generation, %{message | type: :dispatch_accepted})

  def handle(worker_id, generation, %{type: :dispatch_state, state: :running} = message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, dispatch} <- DispatchStore.mark_running(worker_id, generation, message.action_id) do
      notify_action(message.action_id)
      {:ok, response(:dispatch_running, dispatch)}
    end
  end

  def handle(worker_id, generation, %{type: :dispatch_state, state: :completed} = message),
    do: completion(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :dispatch_state, state: :failed} = message),
    do: failure(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :dispatch_state, state: :uncertain} = message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, dispatch} <-
           DispatchStore.mark_uncertain(worker_id, generation, message.action_id, message.failure) do
      notify_action(message.action_id)
      {:ok, response(:dispatch_uncertain, dispatch)}
    end
  end

  def handle(worker_id, generation, %{type: :step_completed} = message),
    do: completion(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :step_failed} = message),
    do: failure(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :reconcile_state, dispatches: dispatches}) do
    case Reconciler.reconcile(worker_id, generation, dispatches) do
      {:ok, reconciliation} ->
        Scheduler.wake_all()
        Enum.each(Reconciler.run_ids_for_worker(worker_id), &RunChangeNotifier.notify/1)

        {:ok,
         %{
           "type" => "message_result",
           "protocol_version" => WorkerProtocol.version(),
           "result" => "reconciled",
           "observed_count" => length(reconciliation.observed),
           "anomaly_count" => length(reconciliation.anomalies)
         }}

      {:error, error} ->
        {:error, error}
    end
  end

  defp completion(worker_id, generation, message) do
    case CompletionAdapter.complete(worker_id, generation, message) do
      {:ok, %{transition: transition}} ->
        Scheduler.wake_all()
        notify_action(message.action_id)

        {:ok,
         %{
           "type" => "message_result",
           "protocol_version" => WorkerProtocol.version(),
           "result" => "completion_applied",
           "action_id" => message.action_id,
           "run_revision" => transition.revision,
           "idempotent_replay" => transition.idempotent_replay?
         }}

      {:error, error} ->
        {:error, error}
    end
  end

  defp failure(worker_id, generation, message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, dispatch} <-
           DispatchStore.mark_failed(worker_id, generation, message.action_id, message.failure) do
      Scheduler.wake_all()
      notify_action(message.action_id)
      {:ok, response(:dispatch_failed, dispatch)}
    end
  end

  defp notify_action(action_id) do
    case DispatchStore.fetch(action_id) do
      {:ok, %{action: action}} -> RunChangeNotifier.notify(action.run_id)
      _ -> :ok
    end
  end

  defp validate_identity(worker_id, message) do
    case DispatchStore.fetch(message.action_id) do
      {:ok, %{worker_id: ^worker_id, action: action}} ->
        if action.occurrence_id == message.occurrence_id and
             action.attempt_id == message.attempt_id do
          :ok
        else
          {:error,
           %WorkerError{
             type: :dispatch_identity_mismatch,
             worker_id: worker_id,
             action_id: message.action_id
           }}
        end

      {:ok, %{worker_id: persisted_worker_id}} ->
        {:error,
         %WorkerError{
           type: :dispatch_worker_mismatch,
           worker_id: worker_id,
           action_id: message.action_id,
           details: %{persisted_worker_id: persisted_worker_id}
         }}

      {:error, error} ->
        {:error, error}
    end
  end

  defp result({:ok, _worker}) do
    {:ok,
     %{
       "type" => "message_result",
       "protocol_version" => WorkerProtocol.version(),
       "result" => "heartbeat_recorded"
     }}
  end

  defp result({:error, error}), do: {:error, error}

  defp response(result, dispatch) do
    %{
      "type" => "message_result",
      "protocol_version" => WorkerProtocol.version(),
      "result" => Atom.to_string(result),
      "action_id" => dispatch.action_id
    }
  end
end
