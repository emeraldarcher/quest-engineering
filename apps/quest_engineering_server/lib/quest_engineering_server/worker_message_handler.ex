defmodule QuestEngineering.Server.WorkerMessageHandler do
  @moduledoc "Application adapter for validated, generation-fenced Worker messages."

  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DeliveryCoordinator
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ProductChangeNotifier
  alias QuestEngineering.Server.Reconciler
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.Server.WorkspaceControl

  def handle(worker_id, generation, %{type: :heartbeat}) do
    result(WorkerStore.heartbeat(worker_id, generation))
  end

  def handle(worker_id, generation, %{type: :workspace_sources, candidates: candidates}) do
    with {:ok, _} <- WorkerStore.heartbeat(worker_id, generation),
         {:ok, _} <- WorkspaceControl.record_candidates(worker_id, candidates) do
      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "workspace_sources_recorded"
       }}
    end
  end

  def handle(worker_id, generation, %{type: :workspace_binding_failed, binding: binding}) do
    with {:ok, _} <- WorkerStore.heartbeat(worker_id, generation),
         {:ok, _} <- WorkspaceControl.record_binding_failure(worker_id, binding) do
      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "workspace_binding_failed_recorded"
       }}
    end
  end

  def handle(worker_id, generation, %{type: :workspace_binding_ready, binding: binding}) do
    with {:ok, _} <- WorkerStore.heartbeat(worker_id, generation),
         {:ok, _row} <- WorkspaceControl.record_binding(worker_id, generation, binding) do
      Scheduler.wake_all()

      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "workspace_binding_recorded"
       }}
    end
  end

  def handle(worker_id, generation, %{type: :run_worktree_retained, worktree: worktree}) do
    with {:ok, assignment} <- RunWorkspaceStore.retained(worker_id, generation, worktree) do
      DeliveryCoordinator.wake(assignment.run_id)
      {:ok, workspace_response("run_worktree_retained", assignment.worktree_id)}
    end
  end

  def handle(worker_id, generation, %{type: :run_worktree_removed, worktree: worktree}) do
    with {:ok, assignment} <- RunWorkspaceStore.removed(worker_id, generation, worktree),
         do: {:ok, workspace_response("run_worktree_removed", assignment.worktree_id)}
  end

  def handle(worker_id, generation, %{type: :run_delivery_inspected, delivery: delivery}) do
    with {:ok, persisted} <- DeliveryStore.inspected(worker_id, generation, delivery) do
      DeliveryCoordinator.wake(persisted.run_id)
      {:ok, delivery_response("run_delivery_inspected", persisted.id)}
    end
  end

  def handle(worker_id, generation, %{type: :run_delivery_published, delivery: delivery}) do
    with {:ok, persisted} <- DeliveryStore.published(worker_id, generation, delivery) do
      DeliveryCoordinator.wake(persisted.run_id)
      {:ok, delivery_response("run_delivery_published", persisted.id)}
    end
  end

  def handle(worker_id, generation, %{type: :run_delivery_failed, delivery: delivery}) do
    with {:ok, persisted} <- DeliveryStore.failed(worker_id, generation, delivery),
         do: {:ok, delivery_response("run_delivery_failed", persisted.id)}
  end

  def handle(worker_id, generation, %{type: :run_worktree_ready, worktree: worktree}) do
    with {:ok, assignment} <- RunWorkspaceStore.ready(worker_id, generation, worktree) do
      Scheduler.wake(assignment.run_id)
      {:ok, workspace_response("run_worktree_ready", assignment.worktree_id)}
    end
  end

  def handle(worker_id, generation, %{type: :run_worktree_failed, worktree: worktree}) do
    with {:ok, assignment} <- RunWorkspaceStore.fail(worker_id, generation, worktree) do
      {:ok, workspace_response("run_worktree_failed", assignment.worktree_id)}
    end
  end

  def handle(worker_id, generation, %{type: :run_worktree_attention, worktree: worktree}) do
    with {:ok, assignment} <- RunWorkspaceStore.attention(worker_id, generation, worktree) do
      {:ok, workspace_response("run_worktree_attention", assignment.worktree_id)}
    end
  end

  def handle(worker_id, generation, %{
        type: :run_worktree_integrity_failed,
        action_id: action_id,
        failure: failure
      }) do
    with {:ok, assignment} <-
           RunWorkspaceStore.fence_for_action(worker_id, generation, action_id, failure) do
      {:ok, workspace_response("run_worktree_fenced", assignment.worktree_id)}
    end
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
        _ = Dispatcher.redeliver(worker_id, generation)
        Scheduler.wake_all()
        Enum.each(Reconciler.run_ids_for_worker(worker_id), &RunChangeNotifier.notify/1)

        {:ok,
         %{
           "type" => "message_result",
           "protocol_version" => WorkerProtocol.version(),
           "result" => "reconciled",
           "observed_count" => length(reconciliation.observed),
           "anomaly_count" => length(reconciliation.anomalies),
           "dispatch_resolutions" =>
             Enum.filter(reconciliation.observed, &Map.has_key?(&1, :resolution))
         }}

      {:error, error} ->
        {:error, error}
    end
  end

  defp completion(worker_id, generation, message) do
    case CompletionAdapter.complete(worker_id, generation, message) do
      {:ok, %{transition: transition}} ->
        Scheduler.wake_all()
        DeliveryCoordinator.wake(transition.run.id)
        ProductChangeNotifier.notify(["quests", "runs"])
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

  defp workspace_response(result, worktree_id) do
    %{
      "type" => "message_result",
      "protocol_version" => WorkerProtocol.version(),
      "result" => result,
      "worktree_id" => worktree_id
    }
  end

  defp delivery_response(result, delivery_id) do
    %{
      "type" => "message_result",
      "protocol_version" => WorkerProtocol.version(),
      "result" => result,
      "delivery_id" => delivery_id
    }
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
