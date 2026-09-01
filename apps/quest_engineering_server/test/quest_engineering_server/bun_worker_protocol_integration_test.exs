defmodule QuestEngineering.Server.BunWorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate
  alias QuestEngineering.Server.Persistence.WorkspaceBindingAttempt
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.Server.WorkspaceControl

  setup do
    owner = Sandbox.start_owner!(Repo, shared: true)
    on_exit(fn -> Sandbox.stop_owner(owner) end)
    :ok
  end

  test "real Bun Worker v4 provisions a Run worktree before Product execution" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker protocol integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        previous_workspaces = Application.get_env(:quest_engineering_server, :workspaces)
        Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:test" => root})
        start_supervised!(QuestEngineering.Server.WorkerConnections)
        start_supervised!(QuestEngineering.Server.RunWorkspaceProvisioner)

        worker_root =
          Path.join(root, ".pi/tmp/bun-worker-integration-#{System.unique_integer([:positive])}")

        File.mkdir_p!(worker_root)
        source_root = Path.join(worker_root, "source")
        File.mkdir_p!(source_root)
        {_, 0} = System.cmd("git", ["init", "-q", source_root])
        File.write!(Path.join(source_root, "README.md"), "# Bun worktree fixture\n")
        {_, 0} = System.cmd("git", ["-C", source_root, "add", "README.md"])

        {_, 0} =
          System.cmd("git", [
            "-C",
            source_root,
            "-c",
            "user.name=Quest Engineering",
            "-c",
            "user.email=quest@example.invalid",
            "commit",
            "-q",
            "-m",
            "fixture"
          ])

        worker_id = "bun-integration-#{System.unique_integer([:positive])}"
        {quest, workspace} = product_fixture()
        binding_id = Ecto.UUID.generate()

        allowed_roots =
          Jason.encode!([
            %{
              key: "repository",
              path: worker_root,
              max_access: "read_write",
              discover_depth: 1,
              allow_unconfined_shell: true
            }
          ])

        bindings =
          Jason.encode!([
            %{
              binding_id: binding_id,
              workspace_id: workspace.id,
              authorized_root_key: "repository",
              source_repository_root: source_root,
              max_access: "read_write",
              allow_unconfined_shell: true
            }
          ])

        port =
          Port.open({:spawn_executable, bun}, [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [
              Path.join(root, "workers/bun/src/main.ts"),
              "--qe-test-worker=#{worker_id}"
            ],
            cd: String.to_charlist(root),
            env: [
              {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
              {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
              {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
              {~c"QE_ALLOWED_ROOTS_JSON", String.to_charlist(allowed_roots)},
              {~c"QE_WORKSPACE_BINDINGS_JSON", String.to_charlist(bindings)},
              {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
              {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
              {~c"QE_WORKER_PROVIDER", ~c"fake"},
              {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"}
            ]
          ])

        on_exit(fn ->
          stop_worker_process(port, worker_id)
          File.rm_rf!(worker_root)

          Application.put_env(
            :quest_engineering_server,
            :workspaces,
            previous_workspaces || %{}
          )
        end)

        assert_eventually(fn ->
          match?({:ok, %{status: "connected"}}, WorkerStore.fetch(worker_id))
        end)

        assert {:ok, launched} = LaunchQuest.launch(quest.id)
        assert [_action] = launched.actions

        assert_eventually(fn ->
          match?(%{state: "ready"}, Repo.get(RunWorkspaceAssignment, launched.run_id))
        end)

        assignment = Repo.get!(RunWorkspaceAssignment, launched.run_id)
        assert File.dir?(assignment.canonical_worktree_root)
        assert File.exists?(Path.join(worker_root, "run-worktrees.sqlite"))
        assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(launched.run_id)
        assert Repo.get_by!(QuestLaunch, run_id: launched.run_id)

        stop_worker_process(port, worker_id)

        assert_eventually(fn ->
          match?({:ok, %{status: "disconnected"}}, WorkerStore.fetch(worker_id))
        end)
    end
  end

  test "real Bun Worker retires a database-reset binding and rebinds the repository without restart" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker reset recovery skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        start_supervised!(QuestEngineering.Server.WorkerConnections)
        start_supervised!(QuestEngineering.Server.RunWorkspaceProvisioner)

        worker_root =
          Path.join(root, ".pi/tmp/bun-worker-reset-#{System.unique_integer([:positive])}")

        source_root = Path.join(worker_root, "source")
        File.mkdir_p!(source_root)
        {_, 0} = System.cmd("git", ["init", "-q", source_root])
        File.write!(Path.join(source_root, "README.md"), "# reset recovery fixture\n")
        sentinel = Path.join(worker_root, "unrelated-worker-state")
        File.write!(sentinel, "preserve me")
        worker_id = "bun-reset-#{System.unique_integer([:positive])}"

        allowed_roots =
          Jason.encode!([
            %{
              key: "repository",
              path: worker_root,
              max_access: "read_write",
              discover_depth: 1,
              allow_unconfined_shell: false
            }
          ])

        start_worker = fn ->
          port =
            Port.open({:spawn_executable, bun}, [
              :binary,
              :exit_status,
              :stderr_to_stdout,
              args: [
                Path.join(root, "workers/bun/src/main.ts"),
                "--qe-test-worker=#{worker_id}"
              ],
              cd: String.to_charlist(root),
              env: [
                {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
                {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
                {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
                {~c"QE_ALLOWED_ROOTS_JSON", String.to_charlist(allowed_roots)},
                {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
                {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
                {~c"QE_WORKER_PROVIDER", ~c"fake"},
                {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"}
              ]
            ])

          port
        end

        stop_worker = fn port -> stop_worker_process(port, worker_id) end

        on_exit(fn -> File.rm_rf!(worker_root) end)
        first_port = start_worker.()
        on_exit(fn -> stop_worker.(first_port) end)

        assert_eventually(fn ->
          match?(
            {:ok, %{status: "connected", connection_generation: 1}},
            WorkerStore.fetch(worker_id)
          )
        end)

        :ok = WorkspaceControl.request_discovery()
        assert_eventually(fn -> WorkspaceControl.list_candidates() != [] end)
        [candidate | _] = WorkspaceControl.list_candidates()

        {:ok, deleted_workspace} =
          Products.create_workspace(%{
            key: "deleted-#{System.unique_integer([:positive])}",
            name: "Deleted before Worker restart",
            source_kind: :local_git,
            source_fingerprint: nil
          })

        assert {:ok, %{binding_id: stale_binding_id}} =
                 WorkspaceControl.bind(deleted_workspace.id, candidate.candidate_id)

        assert_eventually(fn ->
          match?(
            %{status: "available"},
            Repo.get(WorkerWorkspaceBinding, stale_binding_id)
          )
        end)

        assert_eventually(fn ->
          case Path.join(worker_root, "workspace-bindings.json")
               |> File.read!()
               |> Jason.decode!() do
            %{"active" => [%{"workspace_id" => workspace_id}]} ->
              workspace_id == deleted_workspace.id

            _other ->
              false
          end
        end)

        stop_worker.(first_port)

        assert_eventually(fn ->
          match?({:ok, %{status: "disconnected"}}, WorkerStore.fetch(worker_id))
        end)

        Repo.delete_all(WorkspaceBindingAttempt)
        Repo.delete_all(WorkerWorkspaceCandidate)
        Repo.delete_all(WorkerWorkspaceBinding)
        Repo.delete!(Repo.get!(ProductWorkspace, deleted_workspace.id))

        second_port = start_worker.()
        on_exit(fn -> stop_worker.(second_port) end)

        assert_eventually(fn ->
          match?(
            {:ok, %{status: "connected", connection_generation: 2}},
            WorkerStore.fetch(worker_id)
          )
        end)

        refute Repo.get(WorkerWorkspaceBinding, stale_binding_id)
        assert File.read!(sentinel) == "preserve me"
        assert File.exists?(Path.join(worker_root, "dispatches.sqlite"))
        assert File.exists?(Path.join(worker_root, "run-worktrees.sqlite"))

        assert_eventually(fn ->
          case Jason.decode!(File.read!(Path.join(worker_root, "workspace-bindings.json"))) do
            %{"active" => [], "retired" => [%{"binding_id" => retired_id}]} ->
              retired_id == stale_binding_id

            _other ->
              false
          end
        end)

        :ok = WorkspaceControl.request_discovery()
        assert_eventually(fn -> WorkspaceControl.list_candidates() != [] end)
        [replacement_candidate | _] = WorkspaceControl.list_candidates()

        {:ok, replacement} =
          Products.create_workspace(%{
            key: "replacement-#{System.unique_integer([:positive])}",
            name: "Replacement Project",
            source_kind: :local_git,
            source_fingerprint: nil
          })

        assert {:ok, %{status: "preparing", binding_id: replacement_binding_id}} =
                 WorkspaceControl.bind(replacement.id, replacement_candidate.candidate_id)

        assert_eventually(fn ->
          case Repo.get(WorkerWorkspaceBinding, replacement_binding_id) do
            %{status: "available", workspace_id: workspace_id} ->
              workspace_id == replacement.id

            _other ->
              false
          end
        end)

        assert {:ok, %{status: "connected", connection_generation: 2}} =
                 WorkerStore.fetch(worker_id)

        assert_eventually(fn ->
          persisted =
            Path.join(worker_root, "workspace-bindings.json") |> File.read!() |> Jason.decode!()

          Enum.any?(persisted["active"], &(&1["workspace_id"] == replacement.id)) and
            Enum.any?(
              persisted["retired"],
              &(&1["workspace_id"] == deleted_workspace.id)
            )
        end)
    end
  end

  defp product_fixture do
    suffix = Integer.to_string(System.unique_integer([:positive]))

    {:ok, workspace} =
      Products.create_workspace(%{
        key: "bun-integration-#{suffix}",
        name: "Bun integration",
        source_kind: :local_git,
        source_fingerprint: nil
      })

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
        title: "Bun v4 integration",
        objective: "Complete through Product launch, scheduling, and Bun.",
        workspace_id: workspace.id,
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

    {quest, workspace}
  end

  defp stop_worker_process(port, worker_id) do
    marker = "--qe-test-worker=#{worker_id}"
    {output, _status} = System.cmd("pgrep", ["-f", "--", marker], stderr_to_stdout: true)

    output
    |> String.split()
    |> Enum.each(fn pid ->
      System.cmd("kill", ["-TERM", pid], stderr_to_stdout: true)
    end)

    Process.sleep(20)
    if Port.info(port), do: Port.close(port)
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
