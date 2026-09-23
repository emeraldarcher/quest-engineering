defmodule QuestEngineering.Server.WorkerMessageHandler do
  @moduledoc "Application adapter for validated, generation-fenced Worker messages."

  require Logger

  alias QuestEngineering.Server.CancellationAdapter
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DeliveryCoordinator
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ExecutionCancellation
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.OperationalFailure
  alias QuestEngineering.Server.OperationalRecovery
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

  def handle(worker_id, generation, %{type: :human_recovery_requested, recovery: recovery}) do
    with {:ok, _worker} <- WorkerStore.heartbeat(worker_id, generation),
         {:ok, authorized} <- OperationalRecovery.authorize(recovery, mode: :retained) do
      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "human_recovery_authorized",
         "request_id" => authorized.request_id,
         "recovery_epoch" => authorized.epoch_number,
         "attempt_allowance" => authorized.attempt_allowance,
         "idempotent_replay" => authorized.idempotent_replay?
       }}
    end
  end

  def handle(worker_id, generation, %{type: :session_state, session: session}) do
    with {:ok, persisted} <- ExecutionSessionStore.record(worker_id, generation, session) do
      ProductChangeNotifier.notify(["quests", "runs"])

      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "session_recorded",
         "session_id" => persisted.id
       }}
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
      ProductChangeNotifier.notify(["quests", "runs"])
      notify_action(message.action_id)
      {:ok, response(:dispatch_uncertain, dispatch)}
    end
  end

  def handle(worker_id, generation, %{type: :step_completed} = message),
    do: completion(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :step_failed} = message),
    do: failure(worker_id, generation, message)

  def handle(worker_id, generation, %{type: :reconcile_state, dispatches: dispatches} = message) do
    sessions = Map.get(message, :sessions, [])

    with {:ok, _persisted_sessions} <-
           ExecutionSessionStore.reconcile(worker_id, generation, sessions || []),
         {:ok, reconciliation} <- Reconciler.reconcile(worker_id, generation, dispatches) do
      _ = Dispatcher.redeliver(worker_id, generation)
      prompt_authorizations = DispatchStore.prompt_authorizations_for_worker(worker_id)
      cancellation_commands = ExecutionCancellation.pending_for_worker(worker_id, generation)
      Scheduler.wake_all()
      Enum.each(Reconciler.run_ids_for_worker(worker_id), &RunChangeNotifier.notify/1)
      ProductChangeNotifier.notify(["quests", "runs"])

      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "reconciled",
         "observed_count" => length(reconciliation.observed),
         "anomaly_count" => length(reconciliation.anomalies),
         "completion_action_ids" =>
           reconciliation.observed
           |> Enum.flat_map(fn
             %{reconciled_completion_action_id: action_id} -> [action_id]
             _other -> []
           end),
         "terminal_action_ids" =>
           reconciliation.observed
           |> Enum.flat_map(fn
             %{reconciled_terminal_action_id: action_id} -> [action_id]
             _other -> []
           end),
         "dispatch_resolutions" =>
           Enum.filter(reconciliation.observed, &Map.has_key?(&1, :resolution)),
         "prompt_authorizations" => prompt_authorizations,
         "cancellation_commands" => cancellation_commands
       }}
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

  defp failure(worker_id, generation, %{failure: %{"code" => "execution_cancelled"}} = message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, result} <- CancellationAdapter.cancel(worker_id, generation, message) do
      Scheduler.wake_all()
      ProductChangeNotifier.notify(["quests", "runs"])
      notify_action(message.action_id)

      {:ok,
       %{
         "type" => "message_result",
         "protocol_version" => WorkerProtocol.version(),
         "result" => "execution_cancelled",
         "action_id" => message.action_id,
         "run_revision" => result.transition.revision,
         "idempotent_replay" => result.transition.idempotent_replay?
       }}
    end
  end

  defp failure(worker_id, generation, message) do
    with :ok <- validate_identity(worker_id, message),
         {:ok, result} <- OperationalFailure.record(worker_id, generation, message) do
      case OperationalRecovery.finalize_requested(message.action_id) do
        {:error, error} ->
          Logger.error(
            "Could not finalize requested operational recovery for #{message.action_id}: #{inspect(error)}"
          )

        _other ->
          :ok
      end

      Scheduler.wake_all()
      ProductChangeNotifier.notify(["quests", "runs"])
      notify_action(message.action_id)

      {:ok,
       response(result.policy, result.dispatch)
       |> Map.put("run_revision", result.transition && result.transition.revision)}
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
