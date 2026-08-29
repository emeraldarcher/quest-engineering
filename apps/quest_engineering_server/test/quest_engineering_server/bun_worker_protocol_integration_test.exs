defmodule QuestEngineering.Server.BunWorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
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

  test "real Bun Worker v4 provisions a Run worktree before Product execution" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker protocol integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        previous_workspaces = Application.get_env(:quest_engineering_server, :workspaces)
        previous_scheduler = Application.get_env(:quest_engineering_server, :scheduler_enabled)
        Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:test" => root})
        Application.put_env(:quest_engineering_server, :scheduler_enabled, false)

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
            args: ["run", Path.join(root, "workers/bun/src/main.ts")],
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

        {:os_pid, worker_os_pid} = Port.info(port, :os_pid)

        on_exit(fn ->
          if Port.info(port), do: Port.close(port)
          System.cmd("kill", ["-TERM", Integer.to_string(worker_os_pid)], stderr_to_stdout: true)
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
