defmodule QuestEngineering.Server.ExecutionSessionStoreTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Reconciler
  alias QuestEngineering.Server.WorkerMessageHandler
  alias QuestEngineering.Server.WorkerStore

  test "orphaned retained sessions do not reject reconciliation after a control-plane reset" do
    worker_id = "worker-session-reset-#{System.unique_integer([:positive])}"

    assert {:ok, worker} =
             WorkerStore.register(
               worker_id,
               %{"max_concurrency" => 1, "workspace_bindings" => []},
               Ecto.UUID.generate()
             )

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)
    action_id = "orphaned-action-#{System.unique_integer([:positive])}"

    session = %{
      session_id: Ecto.UUID.generate(),
      action_id: action_id,
      run_id: "orphaned-run",
      occurrence_id: "orphaned-occurrence",
      attempt_id: "orphaned-attempt",
      member_key: "builder",
      harness_kind: "pi",
      harness_display_name: "Pi",
      state: :retained,
      capabilities: %{
        "can_attach_terminal" => true,
        "can_send_input" => true,
        "can_interrupt" => true,
        "can_detect_attention" => true,
        "can_resume" => true,
        "can_observe_structured_events" => true
      },
      terminal: nil,
      native_session_id: nil,
      attention: nil,
      started_at: now,
      last_activity_at: now
    }

    assert {:ok,
            %{
              "result" => "reconciled",
              "anomaly_count" => 0,
              "observed_count" => 1
            }} =
             WorkerMessageHandler.handle(worker_id, worker.connection_generation, %{
               type: :reconcile_state,
               dispatches: [
                 %{
                   action_id: action_id,
                   occurrence_id: session.occurrence_id,
                   attempt_id: session.attempt_id,
                   state: :completed,
                   outputs: %{},
                   failure: nil
                 }
               ],
               sessions: [session]
             })

    assert [%{action_id: ^action_id, type: "dispatch_unknown_to_server"}] =
             Reconciler.list_anomalies(worker_id)
  end
end
