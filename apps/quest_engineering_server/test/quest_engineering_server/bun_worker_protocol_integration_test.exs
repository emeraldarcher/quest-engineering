defmodule QuestEngineering.Server.BunWorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerStore

  setup do
    :ok = Sandbox.checkout(Repo)
    Sandbox.mode(Repo, {:shared, self()})
    on_exit(fn -> Sandbox.mode(Repo, :manual) end)
    :ok
  end

  test "real Bun Worker v3 executes a Product launch over Phoenix WebSocket" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker protocol integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        previous_workspaces = Application.get_env(:quest_engineering_server, :workspaces)
        previous_scheduler = Application.get_env(:quest_engineering_server, :scheduler_enabled)
        Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:test" => root})
        Application.put_env(:quest_engineering_server, :scheduler_enabled, true)

        worker_root =
          Path.join(root, ".pi/tmp/bun-worker-integration-#{System.unique_integer([:positive])}")

        File.mkdir_p!(worker_root)
        worker_id = "bun-integration-#{System.unique_integer([:positive])}"

        port =
          Port.open({:spawn_executable, bun}, [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: ["run", Path.join(root, "workers/bun/src/main.ts")],
            cd: String.to_charlist(root),
            env: [
              {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
              {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
              {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
              {~c"QE_WORKSPACE_ROOT", String.to_charlist(root)},
              {~c"QE_WORKSPACE_REF", ~c"workspace:test"},
              {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
              {~c"QE_WORKER_PROVIDER", ~c"fake"},
              {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"}
            ]
          ])

        logger = spawn(fn -> port_log_loop() end)
        Port.connect(port, logger)

        on_exit(fn ->
          if Port.info(port), do: Port.close(port)
          File.rm_rf!(worker_root)

          Application.put_env(
            :quest_engineering_server,
            :workspaces,
            previous_workspaces || %{}
          )

          Application.put_env(
            :quest_engineering_server,
            :scheduler_enabled,
            if(is_nil(previous_scheduler), do: true, else: previous_scheduler)
          )
        end)

        assert_eventually(fn ->
          match?({:ok, %{status: "connected"}}, WorkerStore.fetch(worker_id))
        end)

        quest = product_fixture()
        assert {:ok, launched} = LaunchQuest.launch(quest.id)
        [action] = launched.actions

        assert_eventually(fn ->
          match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(action.run_id))
        end)

        assert Repo.get_by!(QuestLaunch, run_id: launched.run_id)
        assert Repo.get!(ScheduledActionExecution, action.id).state == "completed"
        assert File.exists?(Path.join(worker_root, "dispatches.sqlite"))
    end
  end

  defp product_fixture do
    suffix = Integer.to_string(System.unique_integer([:positive]))

    {:ok, class} =
      Products.create_class(%{
        key: "builder-#{suffix}",
        name: "Builder",
        instructions: "Execute the product-bound integration step."
      })

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "fake-#{suffix}",
        name: "Fake integration",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :medium,
        tools: ["workspace.filesystem"],
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "squad-#{suffix}",
        name: "Integration Squad",
        members: [
          %{
            key: "member",
            name: "Integration Member",
            class_id: class.id,
            loadout_id: loadout.id
          }
        ]
      })

    {:ok, quest} =
      Products.create_quest(%{
        title: "Bun v3 integration",
        objective: "Complete through Product launch, scheduling, and Bun.",
        workspace_ref: "workspace:test",
        squad_id: squad.id,
        tactic_source: %Inline{
          body:
            step("integrate",
              name: "Integrate",
              instruction: "Return the declared integration result.",
              performer: class(class.key)
            )
        }
      })

    quest
  end

  defp port_log_loop do
    receive do
      {_port, {:data, data}} ->
        IO.write(data)
        port_log_loop()

      {_port, {:exit_status, _status}} ->
        :ok
    end
  end

  defp assert_eventually(fun, attempts \\ 200)
  defp assert_eventually(fun, 0), do: assert(fun.())

  defp assert_eventually(fun, attempts) do
    if fun.() do
      assert true
    else
      Process.sleep(25)
      assert_eventually(fun, attempts - 1)
    end
  end
end
