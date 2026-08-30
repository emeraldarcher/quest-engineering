defmodule QuestEngineering.Server.WorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import Ecto.Query
  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.FakeWorker
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
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

  test "v4 registration fences an older connection", context do
    worker_id = unique("worker-fence")
    first = start_worker(worker_id, context.workspace_root, max_concurrency: 2)
    assert_eventually(fn -> FakeWorker.connected?(first) end)
    assert {:ok, %{connection_generation: 1, max_concurrency: 2}} = WorkerStore.fetch(worker_id)

    second = start_worker(worker_id, context.workspace_root, max_concurrency: 3)
    assert_eventually(fn -> FakeWorker.connected?(second) end)
    assert_eventually(fn -> not FakeWorker.connected?(first) end)
    assert {:ok, %{connection_generation: 2, max_concurrency: 3}} = WorkerStore.fetch(worker_id)
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
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :medium,
        tools: ["workspace.filesystem"],
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
          produces: ["plan"]
        ),
        step("implement",
          name: "Implement",
          instruction: "Implement the plan.",
          performer: class(builder_key),
          consumes: ["plan"],
          produces: ["change_set"]
        ),
        until(
          check:
            step("review",
              name: "Review",
              instruction: "Review the change.",
              performer: class(reviewer_key),
              consumes: ["change_set"],
              produces: ["verdict"]
            ),
          condition: equals(field(artifact("verdict"), "status"), "accepted"),
          otherwise:
            step("repair",
              name: "Repair",
              instruction: "Repair the rejected change.",
              performer: same_as("implement"),
              context: continue_from("implement"),
              consumes: ["change_set", "verdict"],
              produces: ["change_set"]
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
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :medium,
        tools: ["workspace.filesystem"],
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
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => ["workspace.filesystem", "workspace.search", "terminal.shell"],
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
