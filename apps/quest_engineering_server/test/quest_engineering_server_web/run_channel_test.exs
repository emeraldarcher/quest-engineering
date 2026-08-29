defmodule QuestEngineering.ServerWeb.RunChannelTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ChannelTest
  import Phoenix.ConnTest, except: [connect: 2]
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerMessageHandler
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.ServerWeb.ClientSocket
  alias QuestEngineering.ServerWeb.Endpoint
  alias QuestEngineering.ServerWeb.RunChannel

  @endpoint Endpoint

  test "join returns the current projection and committed scheduling, dispatch, completion, and reconciliation invalidate it" do
    root = Path.expand(".pi/tmp/channel-workspace-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)
    previous_scheduler = Application.get_env(:quest_engineering_server, :scheduler_enabled)
    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:channel" => root})
    Application.put_env(:quest_engineering_server, :scheduler_enabled, false)

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})

      Application.put_env(
        :quest_engineering_server,
        :scheduler_enabled,
        if(is_nil(previous_scheduler), do: true, else: previous_scheduler)
      )
    end)

    {:ok, class} =
      Products.create_class(%{key: "builder-channel", name: "Builder", instructions: "Build."})

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "loadout-channel",
        name: "Loadout",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :low,
        tools: [],
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "squad-channel",
        name: "Squad",
        members: [%{key: "alice", name: "Alice", class_id: class.id, loadout_id: loadout.id}]
      })

    tactic =
      step("work",
        name: "Work",
        instruction: "Work.",
        performer: class("builder-channel"),
        produces: ["result"]
      )

    {:ok, quest} =
      Products.create_quest(%{
        title: "Channel",
        objective: "Channel.",
        workspace_ref: "workspace:channel",
        squad_id: squad.id,
        tactic_source: TacticSource.inline(tactic)
      })

    {:ok, launched} = LaunchQuest.launch(quest.id)

    {:ok, socket} = connect(ClientSocket, %{})

    {:ok, %{run: projection}, socket} =
      subscribe_and_join(socket, RunChannel, "run:#{launched.run_id}")

    assert projection.id == launched.run_id
    assert projection.status == "waiting"

    worker = register_worker(root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)
    assert_push "run_changed", %{run_id: run_id}
    assert run_id == launched.run_id

    parent = self()

    connection =
      spawn(fn ->
        receive do
          {:worker_protocol, _message} ->
            send(parent, :worker_dispatch_received)

            receive do
              :stop -> :ok
            end
        end
      end)

    connection_ref = Process.monitor(connection)

    :ok =
      WorkerConnections.activate(
        worker.id,
        Ecto.UUID.generate(),
        worker.connection_generation,
        connection
      )

    assert {:ok, _} = Dispatcher.deliver(dispatch)
    assert_receive :worker_dispatch_received
    assert_push "run_changed", %{run_id: ^run_id}
    send(connection, :stop)
    assert_receive {:DOWN, ^connection_ref, :process, ^connection, :normal}
    Process.sleep(20)

    message = %{
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      outputs: %{"result" => %{"accepted" => true}}
    }

    assert {:ok, _} =
             WorkerMessageHandler.handle(
               worker.id,
               worker.connection_generation,
               Map.put(message, :type, :dispatch_state) |> Map.put(:state, :running)
             )

    assert_push "run_changed", %{run_id: ^run_id}

    # The client-facing adapter publishes only after CompletionAdapter's durable
    # transaction returns.
    assert {:ok, _} =
             WorkerMessageHandler.handle(
               worker.id,
               worker.connection_generation,
               Map.put(message, :type, :step_completed)
             )

    assert_push "run_changed", %{run_id: ^run_id}

    assert {:ok, _} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :reconcile_state,
               dispatches: []
             })

    assert_push "run_changed", %{run_id: ^run_id}

    assert {:ok, completed} = RunProjection.get(run_id)
    assert completed.status == "completed"
    [artifact] = completed.artifacts

    detail = get(build_conn(), "/api/v1/runs/#{run_id}/artifacts/#{artifact.id}")

    assert %{"artifact" => %{"id" => artifact_id, "value" => %{"accepted" => true}}} =
             json_response(detail, 200)

    assert artifact_id == artifact.id

    assert %{"error" => %{"code" => "not_found"}} =
             json_response(
               get(build_conn(), "/api/v1/runs/not-this-run/artifacts/#{artifact_id}"),
               404
             )

    assert socket.topic == "run:#{run_id}"
  end

  defp register_worker(root) do
    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => [],
          "workspaces" => [
            %{"ref" => "workspace:channel", "root" => root, "max_access" => "read_write"}
          ]
        }
      ]
    }

    {:ok, worker} = WorkerStore.register("worker-channel", capabilities, Ecto.UUID.generate())
    worker
  end
end
