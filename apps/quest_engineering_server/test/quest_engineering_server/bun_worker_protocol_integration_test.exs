defmodule QuestEngineering.Server.BunWorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.RuntimeFixtures
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerStore

  setup do
    :ok = Sandbox.checkout(QuestEngineering.Server.Repo)
    Sandbox.mode(QuestEngineering.Server.Repo, {:shared, self()})
    on_exit(fn -> Sandbox.mode(QuestEngineering.Server.Repo, :manual) end)
    :ok
  end

  test "real Bun Worker v2 durably accepts and completes over Phoenix WebSocket" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker protocol integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        worker_root = Path.join(root, ".pi/tmp/bun-worker-integration-#{System.unique_integer([:positive])}")
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
        end)

        assert_eventually(fn ->
          match?({:ok, %{status: "connected"}}, WorkerStore.fetch(worker_id))
        end)

        {:ok, %{actions: [action]}} =
          RuntimeStore.create_run("bun-worker-run-#{System.unique_integer([:positive])}", RuntimeFixtures.sequence_plan())

        assert {:ok, %{action_id: action_id}} = Dispatcher.dispatch(worker_id)
        assert action_id == action.id

        assert_eventually(fn ->
          match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(action.run_id))
        end)

        assert File.exists?(Path.join(worker_root, "dispatches.sqlite"))
    end
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
