defmodule QuestEngineering.Server.WorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import Ecto.Query

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Runtime.Error, as: RuntimeError
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.FakeWorker
  alias QuestEngineering.Server.Persistence.Error, as: PersistenceError
  alias QuestEngineering.Server.Persistence.ReconciliationAnomaly
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeTransition
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeFixtures
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.Server.WorkerStore

  setup do
    :ok = Sandbox.checkout(Repo)
    Sandbox.mode(Repo, {:shared, self()})
    on_exit(fn -> Sandbox.mode(Repo, :manual) end)
    :ok
  end

  describe "registration and fencing" do
    test "registers capabilities and the newest connection supersedes the old one" do
      worker_id = unique("worker-registration")
      first = start_worker(worker_id, max_concurrency: 2)

      assert_eventually(fn -> FakeWorker.connected?(first) end)
      assert {:ok, registered} = WorkerStore.fetch(worker_id)
      assert registered.status == "connected"
      assert registered.max_concurrency == 2
      assert registered.capabilities["os"] == "test"
      assert registered.connection_generation == 1

      second = start_worker(worker_id, max_concurrency: 3)
      assert_eventually(fn -> FakeWorker.connected?(second) end)
      assert_eventually(fn -> not FakeWorker.connected?(first) end)

      assert {:ok, registered} = WorkerStore.fetch(worker_id)
      assert registered.connection_generation == 2
      assert registered.max_concurrency == 3
    end

    test "records a validated heartbeat as infrastructure metadata" do
      worker_id = unique("worker-heartbeat")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)
      assert {:ok, before_heartbeat} = WorkerStore.fetch(worker_id)
      Process.sleep(2)

      :ok =
        FakeWorker.send_message(worker, %{
          "type" => "worker_heartbeat",
          "protocol_version" => 2,
          "worker_id" => worker_id
        })

      assert_eventually(fn ->
        {:ok, after_heartbeat} = WorkerStore.fetch(worker_id)

        DateTime.compare(after_heartbeat.last_heartbeat_at, before_heartbeat.last_heartbeat_at) ==
          :gt
      end)
    end

    test "rejects unsupported protocol versions and malformed hello messages over WebSocket" do
      unsupported =
        start_worker(unique("worker-version"), protocol_version: 99)

      assert_eventually(fn ->
        match?(
          %{"response" => %{"error" => %{"code" => "unsupported_protocol_version"}}},
          FakeWorker.registration_error(unsupported)
        )
      end)

      malformed =
        start_worker(unique("worker-malformed"),
          hello_payload: %{"type" => "worker_hello", "protocol_version" => 2}
        )

      assert_eventually(fn ->
        match?(
          %{"response" => %{"error" => %{"code" => "missing_or_invalid_field"}}},
          FakeWorker.registration_error(malformed)
        )
      end)
    end

    test "an older generation cannot submit a late authoritative completion" do
      worker_id = unique("worker-fence")
      first = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(first) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("fenced-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)

      second = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(second) end)

      message = %{
        action_id: action.id,
        occurrence_id: action.occurrence_id,
        attempt_id: action.attempt_id,
        outputs: %{}
      }

      assert {:error, %WorkerError{type: :stale_connection_generation}} =
               CompletionAdapter.complete(worker_id, 1, message)

      assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(action.run_id)
    end
  end

  describe "dispatch delivery" do
    test "sends the core Action ID once and enforces Worker capacity" do
      worker_id = unique("worker-capacity")
      worker = start_worker(worker_id, max_concurrency: 1)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [first]}} =
        RuntimeStore.create_run(unique("capacity-a"), RuntimeFixtures.sequence_plan())

      {:ok, %{actions: [_second]}} =
        RuntimeStore.create_run(unique("capacity-b"), RuntimeFixtures.sequence_plan())

      assert {:ok, %{action_id: action_id}} = Dispatcher.dispatch(worker_id)
      assert action_id == first.id
      assert_eventually(fn -> state(first.id) == :acknowledged end)
      assert FakeWorker.execution_count(worker, first.id) == 1

      assert {:error, %WorkerError{type: :worker_at_capacity}} = Dispatcher.dispatch(worker_id)
      assert {:ok, persisted} = WorkerStore.fetch(worker_id)
      assert persisted.active_dispatches == 1
    end

    test "duplicate delivery and a lost ACK do not duplicate local execution" do
      worker_id = unique("worker-lost-ack")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)
      :ok = FakeWorker.drop_ack(worker, true)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("lost-ack-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id, lease_ms: 20)
      assert_eventually(fn -> FakeWorker.execution_count(worker, action.id) == 1 end)
      assert state(action.id) == :dispatched

      :ok = FakeWorker.disconnect(worker)
      :ok = FakeWorker.drop_ack(worker, false)
      :ok = FakeWorker.connect(worker)

      assert_eventually(fn -> FakeWorker.connected?(worker) end)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      assert FakeWorker.execution_count(worker, action.id) == 1
      assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(action.run_id)
    end

    test "an expired pre-send claim is recovered and dispatched" do
      worker_id = unique("worker-claim-recovery")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("claim-recovery-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, claimed} =
               DispatchStore.claim_next(worker_id, "crashed-dispatcher", lease_ms: 1)

      assert claimed.state == :claimed
      Process.sleep(5)

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      assert FakeWorker.execution_count(worker, action.id) == 1
    end

    test "two concurrent claimers cannot own the same Action" do
      worker_id = unique("worker-concurrent-claim")
      connection_id = Ecto.UUID.generate()
      capabilities = capabilities(2)
      assert {:ok, _worker} = WorkerStore.register(worker_id, capabilities, connection_id)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("concurrent-claim-run"), RuntimeFixtures.sequence_plan())

      tasks =
        for owner <- ["dispatcher-a", "dispatcher-b"] do
          Task.async(fn -> DispatchStore.claim_next(worker_id, owner) end)
        end

      results = Task.await_many(tasks, 5_000)
      assert Enum.count(results, &match?({:ok, %{action_id: _}}, &1)) == 1

      assert Repo.aggregate(from(d in WorkerDispatch, where: d.action_id == ^action.id), :count) ==
               1
    end
  end

  describe "completion and reconciliation" do
    test "rejects undeclared completion outputs without mutating the Run" do
      worker_id = unique("worker-invalid-completion")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("invalid-completion-run"), RuntimeFixtures.pressure_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      assert {:ok, persisted_worker} = WorkerStore.fetch(worker_id)

      message = %{
        action_id: action.id,
        occurrence_id: action.occurrence_id,
        attempt_id: action.attempt_id,
        outputs: %{"plan" => %{}, "undeclared" => true}
      }

      assert {:error, %RuntimeError{type: :undeclared_output}} =
               CompletionAdapter.complete(
                 worker_id,
                 persisted_worker.connection_generation,
                 message
               )

      assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(action.run_id)
      assert state(action.id) == :acknowledged
    end

    test "completion advances RuntimeStore and duplicate/conflicting delivery is idempotent" do
      worker_id = unique("worker-completion")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("completion-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)

      :ok = FakeWorker.complete(worker, action.id, %{})

      assert_eventually(fn ->
        match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(action.run_id))
      end)

      assert state(action.id) == :completed
      assert Repo.aggregate(RuntimeOutbox, :count) == 2

      :ok = FakeWorker.complete(worker, action.id, %{})
      Process.sleep(30)
      assert Repo.aggregate(RuntimeTransition, :count) == 1
      assert {:ok, persisted_worker} = WorkerStore.fetch(worker_id)

      replay = %{
        action_id: action.id,
        occurrence_id: action.occurrence_id,
        attempt_id: action.attempt_id,
        outputs: %{}
      }

      assert {:ok, %{transition: %{idempotent_replay?: true, revision: 1}}} =
               CompletionAdapter.complete(
                 worker_id,
                 persisted_worker.connection_generation,
                 replay
               )

      conflict = %{replay | outputs: %{"different" => true}}

      assert {:error, %PersistenceError{type: :transition_id_conflict}} =
               CompletionAdapter.complete(
                 worker_id,
                 persisted_worker.connection_generation,
                 conflict
               )

      assert {:ok, %{revision: 1}} = RuntimeStore.fetch_run(action.run_id)
      assert Repo.aggregate(RuntimeOutbox, :count) == 2
    end

    test "disconnect does not fail a running Run and reconnect reconstructs capacity" do
      worker_id = unique("worker-running")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("running-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      :ok = FakeWorker.mark_running(worker, action.id)
      assert_eventually(fn -> state(action.id) == :running end)
      :ok = FakeWorker.disconnect(worker)

      assert {:ok, %{run: run, revision: 0}} = RuntimeStore.fetch_run(action.run_id)
      assert run.status == :running
      assert {:ok, persisted} = WorkerStore.fetch(worker_id)
      assert persisted.active_dispatches == 1

      :ok = FakeWorker.connect(worker)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)
      assert_eventually(fn -> state(action.id) == :running end)
      assert FakeWorker.execution_count(worker, action.id) == 1
      assert {:ok, persisted} = WorkerStore.fetch(worker_id)
      assert persisted.active_dispatches == 1
    end

    test "completion discovered after disconnected execution advances the Run" do
      worker_id = unique("worker-offline-completion")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("offline-completion-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      :ok = FakeWorker.disconnect(worker)
      :ok = FakeWorker.complete(worker, action.id, %{})

      assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(action.run_id)
      :ok = FakeWorker.connect(worker)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      assert_eventually(fn ->
        match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(action.run_id))
      end)

      assert state(action.id) == :completed
      assert FakeWorker.execution_count(worker, action.id) == 1
      assert {:ok, persisted} = WorkerStore.fetch(worker_id)
      assert persisted.active_dispatches == 0
    end

    test "missing acknowledged dispatch is persisted as an anomaly" do
      worker_id = unique("worker-missing")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("missing-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      :ok = FakeWorker.disconnect(worker)
      :ok = FakeWorker.forget(worker, action.id)
      :ok = FakeWorker.connect(worker)

      assert_eventually(fn ->
        Repo.exists?(
          from anomaly in ReconciliationAnomaly,
            where:
              anomaly.worker_id == ^worker_id and anomaly.action_id == ^action.id and
                anomaly.type == "dispatch_missing_on_worker"
        )
      end)

      assert state(action.id) == :acknowledged
      assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(action.run_id)
    end

    test "worker-known running state advances stale server delivery metadata" do
      worker_id = unique("worker-stale-server")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("stale-server-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      :ok = FakeWorker.mark_running(worker, action.id)
      assert_eventually(fn -> state(action.id) == :running end)
      :ok = FakeWorker.disconnect(worker)

      Repo.update_all(
        from(dispatch in WorkerDispatch, where: dispatch.action_id == ^action.id),
        set: [state: "dispatched"]
      )

      Repo.update_all(from(persisted in Worker, where: persisted.id == ^worker_id),
        set: [active_dispatches: 0]
      )

      :ok = FakeWorker.connect(worker)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)
      assert_eventually(fn -> state(action.id) == :running end)
      assert {:ok, persisted} = WorkerStore.fetch(worker_id)
      assert persisted.active_dispatches == 1
    end

    test "worker-local failure is infrastructure state and never fails the core Run" do
      worker_id = unique("worker-failure")
      worker = start_worker(worker_id)
      assert_eventually(fn -> FakeWorker.connected?(worker) end)

      {:ok, %{actions: [action]}} =
        RuntimeStore.create_run(unique("failure-run"), RuntimeFixtures.sequence_plan())

      assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
      assert_eventually(fn -> state(action.id) == :acknowledged end)
      :ok = FakeWorker.fail(worker, action.id, %{"reason" => "test_failure"})
      assert_eventually(fn -> state(action.id) == :failed end)

      assert {:ok, %{run: run, revision: 0}} = RuntimeStore.fetch_run(action.run_id)
      assert run.status == :running
    end
  end

  test "full Plan Implement Review Repair Review pressure flow survives lost Repair ACK" do
    worker_id = unique("worker-pressure")
    worker = start_worker(worker_id)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    run_id = unique("worker-pressure-run")

    {:ok, %{actions: [plan]}} =
      RuntimeStore.create_run(run_id, RuntimeFixtures.pressure_plan())

    transcript = ["worker_registered", "run_created", "plan_persisted"]
    plan = dispatch_and_complete(worker_id, worker, plan, %{"plan" => %{"summary" => "ship"}})
    assert plan.semantic_step_key == "plan"

    implement = pending_action!(run_id)
    assert implement.semantic_step_key == "implement"
    dispatch_and_complete(worker_id, worker, implement, %{"change_set" => %{"version" => 0}})

    review_0 = pending_action!(run_id)
    assert review_0.semantic_step_key == "review"
    dispatch_and_complete(worker_id, worker, review_0, %{"verdict" => %{"status" => "rejected"}})

    repair = pending_action!(run_id)
    assert repair.semantic_step_key == "repair"
    :ok = FakeWorker.drop_ack(worker, true)
    assert {:ok, _sent} = Dispatcher.dispatch(worker_id)
    assert_eventually(fn -> FakeWorker.execution_count(worker, repair.id) == 1 end)
    assert state(repair.id) == :dispatched

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.drop_ack(worker, false)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    assert_eventually(fn -> state(repair.id) == :acknowledged end)
    assert FakeWorker.execution_count(worker, repair.id) == 1
    :ok = FakeWorker.complete(worker, repair.id, %{"change_set" => %{"version" => 1}})
    assert_eventually(fn -> match?({:ok, %{revision: 4}}, RuntimeStore.fetch_run(run_id)) end)

    review_1 = pending_action!(run_id)
    assert review_1.semantic_step_key == "review"
    dispatch_and_complete(worker_id, worker, review_1, %{"verdict" => %{"status" => "accepted"}})

    transcript =
      transcript ++
        [
          "plan_completed",
          "implement_completed",
          "review_0_rejected",
          "repair_ack_lost",
          "worker_reconnected",
          "repair_reconciled_without_duplicate",
          "repair_completed",
          "review_1_accepted",
          "run_completed"
        ]

    assert transcript == [
             "worker_registered",
             "run_created",
             "plan_persisted",
             "plan_completed",
             "implement_completed",
             "review_0_rejected",
             "repair_ack_lost",
             "worker_reconnected",
             "repair_reconciled_without_duplicate",
             "repair_completed",
             "review_1_accepted",
             "run_completed"
           ]

    assert {:ok, %{run: completed, revision: 5}} = RuntimeStore.fetch_run(run_id)
    assert completed.status == :completed
    assert length(completed.occurrence_order) == 5
    assert length(completed.artifact_order) == 5
    assert length(Enum.uniq(completed.occurrence_order)) == 5
    assert length(Enum.uniq(completed.artifact_order)) == 5

    action_ids =
      Repo.all(
        from outbox in RuntimeOutbox, where: outbox.run_id == ^run_id, select: outbox.action_id
      )

    assert length(action_ids) == 5
    assert length(Enum.uniq(action_ids)) == 5
    assert Enum.all?(action_ids, &(FakeWorker.execution_count(worker, &1) == 1))
    assert Enum.all?(action_ids, &(state(&1) == :completed))
    assert {:ok, transitions} = RuntimeStore.list_transitions(run_id)
    assert Enum.map(transitions, & &1.revision) == [1, 2, 3, 4, 5]
    assert length(Enum.uniq_by(transitions, & &1.transition_id)) == 5
    assert {:ok, persisted_worker} = WorkerStore.fetch(worker_id)
    assert persisted_worker.active_dispatches == 0
  end

  defp dispatch_and_complete(worker_id, worker, action, outputs) do
    assert {:ok, %{action_id: action_id}} = Dispatcher.dispatch(worker_id)
    assert action_id == action.id
    assert_eventually(fn -> state(action.id) == :acknowledged end)
    :ok = FakeWorker.complete(worker, action.id, outputs)

    assert_eventually(fn ->
      case DispatchStore.fetch(action.id) do
        {:ok, %{state: :completed}} -> true
        _other -> false
      end
    end)

    action
  end

  defp pending_action!(run_id) do
    assert {:ok, [%{action: action}]} = RuntimeStore.pending_actions(run_id)
    action
  end

  defp start_worker(worker_id, options \\ []) do
    max_concurrency = Keyword.get(options, :max_concurrency, 1)

    start_supervised!(
      {FakeWorker,
       Keyword.merge(
         [worker_id: worker_id, capabilities: capabilities(max_concurrency)],
         options
       )},
      id: {FakeWorker, System.unique_integer([:positive])}
    )
  end

  defp capabilities(max_concurrency) do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => max_concurrency,
      "tags" => ["fake"],
      "capabilities" => ["protocol-test"]
    }
  end

  defp state(action_id) do
    case DispatchStore.fetch(action_id) do
      {:ok, dispatch} -> dispatch.state
      _error -> nil
    end
  end

  defp assert_eventually(fun, attempts \\ 100)
  defp assert_eventually(fun, 0), do: assert(fun.())

  defp assert_eventually(fun, attempts) do
    if fun.() do
      assert true
    else
      Process.sleep(20)
      assert_eventually(fun, attempts - 1)
    end
  end

  defp unique(prefix), do: prefix <> "-" <> Integer.to_string(System.unique_integer([:positive]))
end
