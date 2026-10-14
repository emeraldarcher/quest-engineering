defmodule QuestEngineering.Server.WorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import Ecto.Query
  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.FakeWorker
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.HumanAttentionRequest
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerStore

  setup do
    owner = Sandbox.start_owner!(Repo, shared: true)
    root = Path.expand(".pi/tmp/v08b-protocol-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous_workspaces = Application.get_env(:quest_engineering_server, :workspaces)
    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:protocol" => root})

    start_supervised!(QuestEngineering.Server.WorkerConnections)
    start_supervised!({QuestEngineering.Server.Dispatcher, claim_owner: "protocol-test"})
    start_supervised!(QuestEngineering.Server.RunWorkspaceProvisioner)
    start_supervised!({QuestEngineering.Server.Scheduler, claim_owner: "protocol-test"})

    on_exit(fn ->
      File.rm_rf!(root)

      Application.put_env(
        :quest_engineering_server,
        :workspaces,
        previous_workspaces || %{}
      )

      Sandbox.stop_owner(owner)
    end)

    %{workspace_root: root}
  end

  test "v5 registration fences an older connection", context do
    worker_id = unique("worker-fence")
    first = start_worker(worker_id, context.workspace_root, max_concurrency: 2)
    assert_eventually(fn -> FakeWorker.connected?(first) end)
    assert {:ok, %{connection_generation: 1, max_concurrency: 2}} = WorkerStore.fetch(worker_id)

    second = start_worker(worker_id, context.workspace_root, max_concurrency: 3)
    assert_eventually(fn -> FakeWorker.connected?(second) end)
    assert_eventually(fn -> not FakeWorker.connected?(first) end)
    assert {:ok, %{connection_generation: 2, max_concurrency: 3}} = WorkerStore.fetch(worker_id)
  end

  test "ProviderAccount reconnect sends current fences and rejects prior-generation reports",
       context do
    worker_id = unique("worker-provider-account")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    assert {:ok, first_worker} = WorkerStore.fetch(worker_id)

    assert {:ok, {account, first_environment}} =
             ProviderAccounts.create(
               %{provider_key: "fake", worker_id: worker_id, display_name: "Reconnect proof"},
               first_worker.connection_generation
             )

    first_report = %{
      provider_account_id: account.id,
      credential_generation: account.credential_generation,
      worker_id: worker_id,
      worker_generation: first_environment.worker_generation,
      operation_id: first_environment.operation_id,
      physical_state: "available",
      event_type: "environment_ensured",
      backend_kind: "fake-account",
      environment_id: "physical-provider-account",
      incarnation: "provider-account-incarnation",
      error_code: nil,
      error_message: nil,
      canary_persisted: true,
      observed_at: DateTime.utc_now(),
      authentication: nil
    }

    assert {:ok, {:applied, _, _}} = ProviderAccounts.apply_environment_report(first_report)

    assert {:ok, {_stopping, stop_environment}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "stopped",
               first_worker.connection_generation
             )

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert {:ok, second_worker} = WorkerStore.fetch(worker_id)
    assert second_worker.connection_generation == first_worker.connection_generation + 1

    assert_eventually(fn ->
      match?(
        [
          %{
            "provider_account_id" => id,
            "worker_generation" => generation,
            "operation_id" => operation_id
          }
        ]
        when id == account.id and generation == second_worker.connection_generation and
               operation_id != first_environment.operation_id,
        FakeWorker.provider_accounts(worker)
      )
    end)

    [desired] = FakeWorker.provider_accounts(worker)
    assert desired["desired_state"] == "stopped"
    assert desired["operation_id"] != stop_environment.operation_id

    :ok =
      FakeWorker.send_message(worker, %{
        "type" => "provider_account_environment_state",
        "protocol_version" => 18,
        "worker_id" => worker_id,
        "environment" =>
          first_report
          |> Map.drop([:worker_id])
          |> Map.put(:physical_state, "degraded")
          |> Map.put(:event_type, "environment_degraded")
          |> Map.put(:observed_at, DateTime.utc_now() |> DateTime.to_iso8601())
          |> Map.new(fn {key, value} -> {Atom.to_string(key), value} end)
      })

    :ok =
      FakeWorker.send_message(worker, %{
        "type" => "provider_account_environment_state",
        "protocol_version" => 18,
        "worker_id" => worker_id,
        "environment" => %{
          "provider_account_id" => account.id,
          "credential_generation" => account.credential_generation,
          "worker_generation" => desired["worker_generation"],
          "operation_id" => desired["operation_id"],
          "physical_state" => "stopped",
          "event_type" => "environment_stopped",
          "backend_kind" => "fake-account",
          "environment_id" => "physical-provider-account",
          "incarnation" => "provider-account-incarnation",
          "error_code" => nil,
          "error_message" => nil,
          "canary_persisted" => true,
          "observed_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
          "authentication" => nil
        }
      })

    assert_eventually(fn ->
      match?(
        {:ok, %{environment_state: :stopped}, %{physical_state: "stopped"}},
        ProviderAccounts.get_with_environment(account.id)
      )
    end)

    refute Enum.any?(
             ProviderAccounts.events(account.id),
             &(&1.event_type == "environment_degraded")
           )
  end

  test "lost acceptance ACK redelivers one scheduled ResolvedExecution without duplication",
       context do
    worker_id = unique("worker-lost-ack")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    :ok = FakeWorker.drop_ack(worker, true)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions

    assert_eventually(fn -> FakeWorker.execution_count(worker, action.id) == 1 end)
    assert {:ok, %{state: :dispatched}} = DispatchStore.fetch(action.id)

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.drop_ack(worker, false)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    assert FakeWorker.execution_count(worker, action.id) == 1

    :ok = FakeWorker.complete(worker, action.id, %{})

    assert_eventually(fn ->
      match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(launched.run_id))
    end)

    assert Repo.get!(ScheduledActionExecution, action.id).state == "completed"
  end

  test "offline durable completion reconciles once without re-executing the Attempt", context do
    worker_id = unique("worker-offline-completion")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.complete(worker, action.id, %{})
    assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(launched.run_id)

    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert_eventually(fn ->
      match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(launched.run_id))
    end)

    assert {:ok, %{state: :completed}} = DispatchStore.fetch(action.id)
    assert FakeWorker.execution_count(worker, action.id) == 1

    # A second generation republishes the same immutable completion fact.
    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert_eventually(fn ->
      match?({:ok, %{state: :completed}}, DispatchStore.fetch(action.id))
    end)

    assert {:ok, %{revision: 1}} = RuntimeStore.fetch_run(launched.run_id)
    assert FakeWorker.execution_count(worker, action.id) == 1
  end

  test "offline reconciled completion emits and schedules the next Action exactly once",
       context do
    worker_id = unique("worker-offline-next-action")
    worker = start_worker(worker_id, context.workspace_root, max_concurrency: 2)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = pressure_product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    plan = await_action(launched.run_id, "plan", 0)

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.complete(worker, plan.id, %{"plan" => %{"summary" => "ship"}})
    assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(launched.run_id)

    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    implement = await_action(launched.run_id, "implement", 0)

    assert implement.inputs["plan"].value == %{"summary" => "ship"}
    assert {:ok, %{run: run, revision: 1}} = RuntimeStore.fetch_run(launched.run_id)
    assert run.occurrences[plan.occurrence_id].status == :completed
    assert run.occurrences[implement.occurrence_id].status == :dispatched
    assert FakeWorker.execution_count(worker, plan.id) == 1
    assert FakeWorker.execution_count(worker, implement.id) == 1
    assert action_count(launched.run_id, "implement") == 1

    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    assert action_count(launched.run_id, "implement") == 1
    assert FakeWorker.execution_count(worker, implement.id) == 1
  end

  test "equivalent terminal failure is idempotent and conflicting failure is rejected", context do
    worker_id = unique("worker-failure-facts")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    failure = %{
      "code" => "known_terminal",
      "classification" => "terminal_not_recoverable"
    }

    :ok = FakeWorker.fail(worker, action.id, failure)

    assert_eventually(fn ->
      match?({:ok, %{state: :failed, failure: ^failure}}, DispatchStore.fetch(action.id))
    end)

    assert {:ok, current_worker} = WorkerStore.fetch(worker_id)

    assert {:ok, %{state: :failed}} =
             DispatchStore.mark_failed(
               worker_id,
               current_worker.connection_generation,
               action.id,
               failure
             )

    assert {:error,
            %QuestEngineering.Server.WorkerError{type: :conflicting_terminal_dispatch_fact}} =
             DispatchStore.mark_failed(
               worker_id,
               current_worker.connection_generation,
               action.id,
               Map.put(failure, "code", "different_terminal")
             )
  end

  test "exact snapshot observation uncertainty can resume while genuine uncertainty stays sticky",
       context do
    worker_id = unique("worker-observation-recovery")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    assert {:ok, current_worker} = WorkerStore.fetch(worker_id)

    observation_failure = %{
      "reason" => "harness_execution_failed",
      "code" => "timeout",
      "classification" => "auto_retryable",
      "message" => "Herdr request timed out: session.snapshot"
    }

    assert {:ok, %{state: :uncertain}} =
             DispatchStore.mark_uncertain(
               worker_id,
               current_worker.connection_generation,
               action.id,
               observation_failure
             )

    assert {:ok, resumed} =
             DispatchStore.mark_running(
               worker_id,
               current_worker.connection_generation,
               action.id
             )

    assert resumed.state == :running
    assert resumed.failure == observation_failure
    assert Repo.get!(ScheduledActionExecution, action.id).state == "active"
    assert {:ok, %{steps: [%{state: "running"}]}} = RunProjection.get(launched.run_id)

    genuine_failure = %{
      "reason" => "harness_execution_failed",
      "code" => "agent_prompt_uncertain",
      "classification" => "operator_recovery_required"
    }

    assert {:ok, %{state: :uncertain}} =
             DispatchStore.mark_uncertain(
               worker_id,
               current_worker.connection_generation,
               action.id,
               genuine_failure
             )

    assert {:ok, still_uncertain} =
             DispatchStore.mark_running(
               worker_id,
               current_worker.connection_generation,
               action.id
             )

    assert still_uncertain.state == :uncertain
    assert still_uncertain.failure == genuine_failure
  end

  test "human attention survives reconnect and resumes the same active Attempt", context do
    worker_id = unique("worker-human-assist")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions
    attempt_id = action.attempt_id

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    attention_id = Ecto.UUID.generate()
    :ok = FakeWorker.request_attention(worker, action.id, attention_id)

    assert_eventually(fn ->
      with {:ok, projection} <- RunProjection.get(launched.run_id),
           [step] <- projection.steps do
        match?(
          %{
            state: "blocked",
            attempt: %{id: ^attempt_id, state: "blocked"},
            session: %{attention: %{"attention_id" => ^attention_id}}
          },
          step
        )
      else
        _ -> false
      end
    end)

    assert Repo.get!(ScheduledActionExecution, action.id).state == "active"
    assert {:ok, %{state: :running}} = DispatchStore.fetch(action.id)
    assert FakeWorker.execution_count(worker, action.id) == 1

    :ok = FakeWorker.disconnect(worker)

    assert_eventually(fn ->
      with {:ok, projection} <- RunProjection.get(launched.run_id),
           [step] <- projection.steps do
        match?(
          %{session: %{state: "unavailable", attachment: nil}},
          step
        )
      else
        _ -> false
      end
    end)

    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert_eventually(fn ->
      with {:ok, projection} <- RunProjection.get(launched.run_id),
           [step] <- projection.steps do
        match?(
          %{
            session: %{
              state: "waiting_for_human",
              attention: %{"attention_id" => ^attention_id}
            }
          },
          step
        )
      else
        _ -> false
      end
    end)

    {:ok, projection} = RunProjection.get(launched.run_id)
    [step] = projection.steps
    session_id = step.session.id

    # Product commits while the Worker is offline. No native delivery can be
    # claimed until the exact request is reconciled on a later generation.
    :ok = FakeWorker.disconnect(worker)

    response_request_id = Ecto.UUID.generate()

    assert {:ok,
            %{
              response_state: "responded",
              delivery_state: "response_not_delivered",
              delivered: false
            }} =
             ExecutionSessionStore.respond_to_attention(
               launched.run_id,
               attempt_id,
               session_id,
               %{
                 attention_id: attention_id,
                 request_id: response_request_id,
                 approved: true,
                 value: true
               }
             )

    assert Repo.get!(HumanAttentionRequest, attention_id).delivery_state ==
             "response_not_delivered"

    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)

    assert_eventually(fn ->
      match?(
        %{
          "response" => %{
            "attention_id" => ^attention_id,
            "request_generation" => 1,
            "delivery_attempt_id" => delivery_attempt_id
          }
        }
        when is_binary(delivery_attempt_id),
        FakeWorker.attention_response(worker, attention_id)
      )
    end)

    assert Repo.get!(HumanAttentionRequest, attention_id).delivery_state ==
             "delivery_requested"

    :ok = FakeWorker.acknowledge_attention(worker, attention_id)

    assert_eventually(fn ->
      Repo.get!(HumanAttentionRequest, attention_id).delivery_state ==
        "delivery_acknowledged"
    end)

    # A lagging native session projection cannot resurrect an acknowledged
    # response after reconnect; the durable request lifecycle wins.
    :ok = FakeWorker.disconnect(worker)
    :ok = FakeWorker.connect(worker)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    assert Repo.get!(ExecutionSession, session_id).attention == nil

    assert {:ok, %{delivery_state: "delivery_acknowledged", idempotent_replay: true}} =
             ExecutionSessionStore.respond_to_attention(
               launched.run_id,
               attempt_id,
               session_id,
               %{
                 attention_id: attention_id,
                 request_id: response_request_id,
                 approved: true,
                 value: true
               }
             )

    assert {:error, :stale_attention} =
             ExecutionSessionStore.respond_to_attention(
               launched.run_id,
               attempt_id,
               session_id,
               %{
                 attention_id: attention_id,
                 request_id: Ecto.UUID.generate(),
                 approved: true,
                 value: true
               }
             )

    assert {:error, :stale_attention} =
             ExecutionSessionStore.respond_to_attention(
               launched.run_id,
               attempt_id,
               session_id,
               %{
                 attention_id: attention_id,
                 request_id: Ecto.UUID.generate(),
                 approved: false,
                 value: nil
               }
             )

    assert_eventually(fn ->
      with {:ok, projection} <- RunProjection.get(launched.run_id),
           [step] <- projection.steps do
        match?(
          %{
            attempt: %{id: ^attempt_id},
            session: %{state: "running", attention: nil}
          },
          step
        )
      else
        _ -> false
      end
    end)

    # A newer local cancellation fact remains independently reconcilable when
    # the session projection is lagging behind the native request lifecycle.
    obsolete_attention_id = Ecto.UUID.generate()
    :ok = FakeWorker.request_attention(worker, action.id, obsolete_attention_id)

    assert_eventually(fn ->
      match?(
        %HumanAttentionRequest{response_state: "pending"},
        Repo.get(HumanAttentionRequest, obsolete_attention_id)
      )
    end)

    obsolete_request = Repo.get!(HumanAttentionRequest, obsolete_attention_id)
    {:ok, current_worker} = WorkerStore.fetch(worker_id)
    cancelled_at = DateTime.utc_now()

    assert {:ok, [%HumanAttentionRequest{response_state: "obsolete"}]} =
             ExecutionSessionStore.reconcile_attention_deliveries(
               worker_id,
               current_worker.connection_generation,
               [
                 %{
                   action_id: obsolete_request.action_id,
                   run_id: obsolete_request.run_id,
                   occurrence_id: obsolete_request.occurrence_id,
                   attempt_id: obsolete_request.attempt_id,
                   session_id: obsolete_request.session_id,
                   attention_id: obsolete_attention_id,
                   request_generation: obsolete_request.request_generation,
                   response_state: "obsolete",
                   delivery_state: "response_not_delivered",
                   delivery_attempt_id: nil,
                   response_committed_at: nil,
                   delivery_requested_at: nil,
                   delivery_acknowledged_at: nil,
                   delivery_uncertain_at: nil,
                   cancelled_at: cancelled_at,
                   reason: "The native request was replaced before response delivery.",
                   state: "response_not_delivered",
                   observed_at: cancelled_at
                 }
               ]
             )

    assert Repo.get!(ExecutionSession, session_id).attention == nil

    :ok = FakeWorker.complete(worker, action.id, %{})

    assert_eventually(fn ->
      match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(launched.run_id))
    end)

    assert FakeWorker.execution_count(worker, action.id) == 1
    assert Repo.get!(ScheduledActionExecution, action.id).state == "completed"
  end

  test "Product Plan/Implement/Review/Repair/Review pressure flow preserves bindings", context do
    worker_id = unique("worker-pressure")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = pressure_product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)

    plan = await_action(launched.run_id, "plan", 0)
    :ok = FakeWorker.complete(worker, plan.id, %{"plan" => %{"summary" => "ship"}})

    implement = await_action(launched.run_id, "implement", 0)
    :ok = FakeWorker.complete(worker, implement.id, %{"change_set" => %{"version" => 0}})

    review_0 = await_action(launched.run_id, "review", 0)
    :ok = FakeWorker.complete(worker, review_0.id, %{"verdict" => %{"status" => "rejected"}})

    repair = await_action(launched.run_id, "repair", 0)
    :ok = FakeWorker.complete(worker, repair.id, %{"change_set" => %{"version" => 1}})

    review_1 = await_action(launched.run_id, "review", 1)
    :ok = FakeWorker.complete(worker, review_1.id, %{"verdict" => %{"status" => "accepted"}})

    assert_eventually(fn ->
      match?(
        {:ok, %{run: %{status: :completed}, revision: 5}},
        RuntimeStore.fetch_run(launched.run_id)
      )
    end)

    assert %{state: "pending"} = Repo.get_by!(RunDelivery, run_id: launched.run_id)

    action_ids = [plan.id, implement.id, review_0.id, repair.id, review_1.id]
    assert Enum.all?(action_ids, &(FakeWorker.execution_count(worker, &1) == 1))
    assert Enum.all?(action_ids, &(Repo.get!(ScheduledActionExecution, &1).state == "completed"))

    implement_binding =
      Repo.get_by!(OccurrenceMemberBinding,
        run_id: launched.run_id,
        occurrence_id: implement.occurrence_id
      )

    repair_binding =
      Repo.get_by!(OccurrenceMemberBinding,
        run_id: launched.run_id,
        occurrence_id: repair.occurrence_id
      )

    assert repair_binding.member_key == implement_binding.member_key
  end

  test "known terminal Worker failure releases scheduling occupancy but leaves Core dispatched",
       context do
    worker_id = unique("worker-known-failure")
    worker = start_worker(worker_id, context.workspace_root)
    assert_eventually(fn -> FakeWorker.connected?(worker) end)
    quest = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(quest.id)
    [action] = launched.actions

    assert_eventually(fn ->
      match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id))
    end)

    :ok = FakeWorker.fail(worker, action.id, %{"code" => "known_terminal"})
    assert_eventually(fn -> match?({:ok, %{state: :failed}}, DispatchStore.fetch(action.id)) end)
    assert Repo.get!(ScheduledActionExecution, action.id).state == "failed"
    assert {:ok, %{run: run, revision: 0}} = RuntimeStore.fetch_run(launched.run_id)
    assert run.status == :running

    assert Enum.any?(run.occurrences, fn {_id, occurrence} -> occurrence.status == :dispatched end)
  end

  defp pressure_product_fixture do
    suffix = Integer.to_string(System.unique_integer([:positive]))
    architect_key = "architect-#{suffix}"
    builder_key = "builder-#{suffix}"
    reviewer_key = "reviewer-#{suffix}"
    architect = create_class(architect_key, "Plan the work.")
    builder = create_class(builder_key, "Implement and repair the work.")
    reviewer = create_class(reviewer_key, "Review independently.")

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "pressure-#{suffix}",
        name: "Pressure",
        harness: "fake",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: "medium",
        tool_policy: %QuestEngineering.Core.Product.ToolPolicy.Exact{
          tools: ["workspace.filesystem"]
        },
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "pressure-squad-#{suffix}",
        name: "Pressure Squad",
        members: [
          %{key: "architect", name: "Architect", class_id: architect.id, loadout_id: loadout.id},
          %{key: "builder", name: "Builder", class_id: builder.id, loadout_id: loadout.id},
          %{key: "reviewer", name: "Reviewer", class_id: reviewer.id, loadout_id: loadout.id}
        ]
      })

    tactic =
      sequence([
        step("plan",
          name: "Plan",
          instruction: "Produce a plan.",
          performer: class(architect_key),
          produces: [output("plan", "plan")]
        ),
        step("implement",
          name: "Implement",
          instruction: "Implement the plan.",
          performer: class(builder_key),
          consumes: [input("plan", "plan")],
          produces: [output("change_set", "change_set")]
        ),
        until(
          check:
            step("review",
              name: "Review",
              instruction: "Review the change.",
              performer: class(reviewer_key),
              consumes: [input("change_set", "change_set")],
              produces: [
                output("verdict", "review_verdict",
                  review: review("implementation_acceptance", "change_set")
                )
              ]
            ),
          condition: equals(field(ref("review", "verdict"), "status"), "accepted"),
          otherwise:
            step("repair",
              name: "Repair",
              instruction: "Repair the rejected change.",
              performer: same_as("implement"),
              context: continue_from("implement"),
              consumes: [input("change_set", "change_set"), input("verdict", "review_verdict")],
              produces: [output("change_set", "change_set")]
            ),
          max_remediations: 2
        )
      ])

    {:ok, quest} =
      Products.create_quest(%{
        title: "Pressure",
        objective: "Exercise Product-bound review and repair.",
        workspace_ref: "workspace:protocol",
        squad_id: squad.id,
        tactic_source: %Inline{body: tactic}
      })

    quest
  end

  defp create_class(key, instructions) do
    {:ok, class} =
      Products.create_class(%{key: key, name: key, instructions: instructions})

    class
  end

  defp await_action(run_id, semantic_step_key, index, attempts \\ 150)

  defp await_action(_run_id, semantic_step_key, index, 0) do
    flunk("Action #{semantic_step_key}[#{index}] was not acknowledged")
  end

  defp await_action(run_id, semantic_step_key, index, attempts) do
    action =
      Repo.all(
        from row in RuntimeOutbox,
          where: row.run_id == ^run_id,
          order_by: [row.run_revision, row.emission_index]
      )
      |> Enum.map(fn row ->
        {:ok, action} = RuntimeCodec.decode(row.payload)
        action
      end)
      |> Enum.filter(&(&1.semantic_step_key == semantic_step_key))
      |> Enum.at(index)

    if action && match?({:ok, %{state: :acknowledged}}, DispatchStore.fetch(action.id)) do
      action
    else
      Process.sleep(20)
      await_action(run_id, semantic_step_key, index, attempts - 1)
    end
  end

  defp product_fixture do
    suffix = Integer.to_string(System.unique_integer([:positive]))
    class_key = "builder-#{suffix}"

    {:ok, class} =
      Products.create_class(%{
        key: class_key,
        name: "Builder",
        instructions: "Execute the protocol integration work."
      })

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "loadout-#{suffix}",
        name: "Fake",
        harness: "fake",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: "medium",
        tool_policy: %QuestEngineering.Core.Product.ToolPolicy.Exact{
          tools: ["workspace.filesystem"]
        },
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "squad-#{suffix}",
        name: "Protocol Squad",
        members: [
          %{key: "member", name: "Member", class_id: class.id, loadout_id: loadout.id}
        ]
      })

    {:ok, quest} =
      Products.create_quest(%{
        title: "Protocol integration",
        objective: "Prove durable v4 delivery.",
        workspace_ref: "workspace:protocol",
        squad_id: squad.id,
        tactic_source: %Inline{
          body:
            step("execute",
              name: "Execute",
              instruction: "Complete the integration action.",
              performer: class(class_key)
            )
        }
      })

    quest
  end

  defp action_count(run_id, semantic_step_key) do
    Repo.all(
      from row in RuntimeOutbox,
        where: row.run_id == ^run_id,
        order_by: [row.run_revision, row.emission_index]
    )
    |> Enum.count(fn row ->
      {:ok, action} = RuntimeCodec.decode(row.payload)
      action.semantic_step_key == semantic_step_key
    end)
  end

  defp start_worker(worker_id, root, options \\ []) do
    max_concurrency = Keyword.get(options, :max_concurrency, 1)

    start_supervised!(
      {FakeWorker, worker_id: worker_id, capabilities: capabilities(max_concurrency, root)},
      id: {FakeWorker, System.unique_integer([:positive])}
    )
  end

  defp capabilities(max_concurrency, root) do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => max_concurrency,
      "tags" => ["fake"],
      "executors" => [
        %{
          "harness_kind" => "fake",
          "models" => [
            %{
              "provider" => "fake",
              "model" => "test",
              "display_name" => "Test model",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{
                "kind" => "enumerated",
                "values" => ["low", "medium", "high"]
              }
            }
          ],
          "supported_tool_policies" => ["exact"],
          "tool_enforcement" => "exact",
          "tool_profile" => %{
            "tools" => ["workspace.filesystem", "workspace.search", "terminal.shell"]
          },
          "workspaces" => [
            %{
              "ref" => "workspace:protocol",
              "root" => root,
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }
  end

  defp assert_eventually(fun, attempts \\ 150)
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
