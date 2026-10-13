defmodule QuestEngineering.Server.BunWorkerProtocolIntegrationTest do
  use ExUnit.Case, async: false

  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.ProviderAccountEnvironment
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate
  alias QuestEngineering.Server.Persistence.WorkspaceBindingAttempt
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.ProviderAccountApi.Service, as: ProviderAccountService
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.Server.WorkspaceControl

  setup do
    owner = Sandbox.start_owner!(Repo, shared: true)
    on_exit(fn -> Sandbox.stop_owner(owner) end)
    :ok
  end

  @tag timeout: 120_000
  test "real Bun Worker completes zero-Run ProviderAccount setup and restart reconciliation" do
    if System.get_env("QE_LIVE_SBX") == "1" do
      run_live_provider_account_setup()
    else
      IO.puts("ProviderAccount Product/Bun integration skipped: set QE_LIVE_SBX=1")
    end
  end

  test "real Bun Worker v16 provisions a Run worktree before Product execution" do
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
          open_worker_process(
            bun,
            [Path.join(root, "workers/bun/src/main.ts"), "--qe-test-worker=#{worker_id}"],
            root,
            [
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
          )

        worker_pid = worker_process_pid(port)

        on_exit(fn ->
          stop_worker_process(port, worker_id, worker_pid)
          File.rm_rf!(worker_root)

          Application.put_env(
            :quest_engineering_server,
            :workspaces,
            previous_workspaces || %{}
          )
        end)

        assert_eventually(fn -> worker_ready?(worker_id, 1) end)

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

  test "maintenance Worker teardown is exact, disconnects authoritatively, and cannot claim later work" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker maintenance integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        start_supervised!(QuestEngineering.Server.WorkerConnections)
        start_supervised!(QuestEngineering.Server.RunWorkspaceProvisioner)

        start_supervised!(
          {QuestEngineering.Server.Dispatcher, claim_owner: "maintenance-worker-test"}
        )

        start_supervised!(
          {QuestEngineering.Server.Scheduler, claim_owner: "maintenance-worker-test"}
        )

        worker_root =
          Path.join(root, ".pi/tmp/bun-worker-maintenance-#{System.unique_integer([:positive])}")

        source_root = Path.join(worker_root, "source")
        File.mkdir_p!(source_root)
        {_, 0} = System.cmd("git", ["init", "-q", source_root])
        File.write!(Path.join(source_root, "README.md"), "# maintenance fixture\n")
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

        worker_id = "bun-maintenance-#{System.unique_integer([:positive])}"
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
          open_worker_process(
            bun,
            [Path.join(root, "workers/bun/src/main.ts"), "--qe-test-worker=#{worker_id}"],
            root,
            [
              {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
              {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
              {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
              {~c"QE_ALLOWED_ROOTS_JSON", String.to_charlist(allowed_roots)},
              {~c"QE_WORKSPACE_BINDINGS_JSON", String.to_charlist(bindings)},
              {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
              {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
              {~c"QE_WORKER_PROVIDER", ~c"fake"},
              {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"},
              {~c"QE_WORKER_DISPATCH_AVAILABILITY", ~c"maintenance"}
            ]
          )

        worker_pid = worker_process_pid(port)

        on_exit(fn ->
          stop_worker_process(port, worker_id, worker_pid)
          File.rm_rf!(worker_root)
        end)

        assert_eventually(fn ->
          match?(
            {:ok,
             %{
               status: "connected",
               capabilities: %{"dispatch_availability" => "maintenance"}
             }},
            WorkerStore.fetch(worker_id)
          ) and worker_ready?(worker_id, 1)
        end)

        {:os_pid, exact_worker_pid} = Port.info(port, :os_pid)
        stop_worker_process(port, worker_id)
        assert Port.info(port) == nil

        assert_eventually(fn ->
          match?({:ok, %{status: "disconnected"}}, WorkerStore.fetch(worker_id))
        end)

        assert {_, 1} =
                 System.cmd("kill", ["-0", Integer.to_string(exact_worker_pid)],
                   stderr_to_stdout: true
                 )

        # The Action is created only after exact process exit and authoritative
        # disconnect. A stale/orphan Worker therefore has no claim window.
        assert {:ok, launched} = LaunchQuest.launch(quest.id)
        assert [_action] = launched.actions
        Process.sleep(150)

        refute Repo.get_by(WorkerDispatch, worker_id: worker_id)
        assert {:ok, %{status: "disconnected"}} = WorkerStore.fetch(worker_id)
    end
  end

  test "real Bun Worker fences a lost topic, rejoins, and reconciles active local work once" do
    case System.find_executable("bun") do
      nil ->
        IO.puts("Bun Worker reconnect integration skipped: bun executable is unavailable")

      bun ->
        root = Path.expand("../../../..", __DIR__)
        previous_workspaces = Application.get_env(:quest_engineering_server, :workspaces)
        start_supervised!(QuestEngineering.Server.WorkerConnections)
        start_supervised!({QuestEngineering.Server.Dispatcher, claim_owner: "bun-reconnect-test"})
        start_supervised!(QuestEngineering.Server.RunWorkspaceProvisioner)
        start_supervised!({QuestEngineering.Server.Scheduler, claim_owner: "bun-reconnect-test"})

        worker_root =
          Path.join(root, ".pi/tmp/bun-worker-reconnect-#{System.unique_integer([:positive])}")

        source_root = Path.join(worker_root, "source")
        File.mkdir_p!(source_root)
        {_, 0} = System.cmd("git", ["init", "-q", source_root])
        File.write!(Path.join(source_root, "README.md"), "# reconnect fixture\n")
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

        worker_id = "bun-reconnect-#{System.unique_integer([:positive])}"
        {quest, workspace} = product_fixture()

        Application.put_env(:quest_engineering_server, :workspaces, %{workspace.id => source_root})

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
          open_worker_process(
            bun,
            [Path.join(root, "workers/bun/src/main.ts"), "--qe-test-worker=#{worker_id}"],
            root,
            [
              {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
              {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
              {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
              {~c"QE_ALLOWED_ROOTS_JSON", String.to_charlist(allowed_roots)},
              {~c"QE_WORKSPACE_BINDINGS_JSON", String.to_charlist(bindings)},
              {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
              {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
              {~c"QE_WORKER_PROVIDER", ~c"fake"},
              {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"},
              {~c"QE_FAKE_DELAY_MS", ~c"1000"},
              {~c"QE_RECONNECT_MS", ~c"10"}
            ]
          )

        worker_pid = worker_process_pid(port)

        on_exit(fn ->
          stop_worker_process(port, worker_id, worker_pid)
          File.rm_rf!(worker_root)

          Application.put_env(
            :quest_engineering_server,
            :workspaces,
            previous_workspaces || %{}
          )
        end)

        assert_eventually(fn -> worker_ready?(worker_id, 1) end)

        assert {:ok, launched} = LaunchQuest.launch(quest.id)
        [action] = launched.actions

        assert_eventually(fn ->
          match?(%{state: "ready"}, Repo.get(RunWorkspaceAssignment, launched.run_id))
        end)

        assert_eventually(fn ->
          match?({:ok, %{state: :running}}, DispatchStore.fetch(action.id))
        end)

        assert {:ok, %{pid: channel_pid, generation: 1}} =
                 WorkerConnections.lookup(worker_id)

        GenServer.stop(channel_pid, :normal)

        assert_eventually(fn ->
          case WorkerStore.fetch(worker_id) do
            {:ok,
             %{
               status: "connected",
               connection_generation: generation,
               ready_generation: generation
             }}
            when generation >= 2 ->
              true

            _other ->
              false
          end
        end)

        assert_eventually(fn ->
          match?({:ok, %{revision: 1}}, RuntimeStore.fetch_run(launched.run_id))
        end)

        assert {:ok, %{state: :completed}} = DispatchStore.fetch(action.id)

        {dispatch_count, 0} =
          System.cmd("sqlite3", [
            Path.join(worker_root, "dispatches.sqlite"),
            "SELECT count(*) FROM dispatches WHERE action_id='#{action.id}'"
          ])

        assert String.trim(dispatch_count) == "1"

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
            open_worker_process(
              bun,
              [Path.join(root, "workers/bun/src/main.ts"), "--qe-test-worker=#{worker_id}"],
              root,
              [
                {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
                {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
                {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
                {~c"QE_ALLOWED_ROOTS_JSON", String.to_charlist(allowed_roots)},
                {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
                {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
                {~c"QE_WORKER_PROVIDER", ~c"fake"},
                {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"}
              ]
            )

          port
        end

        stop_worker = fn port -> stop_worker_process(port, worker_id) end

        on_exit(fn -> File.rm_rf!(worker_root) end)
        first_port = start_worker.()
        first_pid = worker_process_pid(first_port)
        on_exit(fn -> stop_worker_process(first_port, worker_id, first_pid) end)

        assert_eventually(fn -> worker_ready?(worker_id, 1) end)

        :ok = WorkspaceControl.request_discovery()
        assert_eventually(fn -> worker_candidate(worker_id) != nil end)

        candidate = worker_candidate(worker_id)

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
        second_pid = worker_process_pid(second_port)
        on_exit(fn -> stop_worker_process(second_port, worker_id, second_pid) end)

        assert_eventually(fn -> worker_ready?(worker_id, 2) end)

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
        assert_eventually(fn -> worker_candidate(worker_id) != nil end)
        replacement_candidate = worker_candidate(worker_id)

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

        assert worker_ready?(worker_id, 2)

        assert_eventually(fn ->
          persisted =
            Path.join(worker_root, "workspace-bindings.json") |> File.read!() |> Jason.decode!()

          Enum.any?(persisted["active"], &(&1["workspace_id"] == replacement.id)) and
            Enum.any?(
              persisted["retired"],
              &(&1["workspace_id"] == deleted_workspace.id)
            )
        end)

        stop_worker.(second_port)

        assert_eventually(fn ->
          match?({:ok, %{status: "disconnected"}}, WorkerStore.fetch(worker_id))
        end)
    end
  end

  defp run_live_provider_account_setup do
    bun = System.find_executable("bun") || raise "bun is required for live ProviderAccount setup"
    root = Path.expand("../../../..", __DIR__)
    worker_id = "bun-account-setup-#{System.unique_integer([:positive])}"
    worker_root = Path.join(root, ".pi/tmp/#{worker_id}")
    started_at = System.monotonic_time(:millisecond)
    File.mkdir_p!(worker_root)
    start_supervised!(QuestEngineering.Server.WorkerConnections)

    start_worker = fn ->
      open_worker_process(
        bun,
        [Path.join(root, "workers/bun/src/main.ts"), "--qe-test-worker=#{worker_id}"],
        root,
        [
          {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
          {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
          {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
          {~c"QE_ALLOWED_ROOTS_JSON", ~c"[]"},
          {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
          {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
          {~c"QE_WORKER_PROVIDER", ~c"fake"},
          {~c"QE_ENABLE_TEST_PROVIDER", ~c"1"},
          {~c"QE_RECONNECT_MS", ~c"25"}
        ]
      )
    end

    first_port = start_worker.()
    first_pid = worker_process_pid(first_port)

    on_exit(fn ->
      stop_worker_process(first_port, worker_id, first_pid)
      File.rm_rf!(worker_root)
    end)

    assert_eventually(fn -> worker_ready?(worker_id, 1) end, 800)
    zero_run_counts = run_authority_counts()
    assert Enum.all?(zero_run_counts, fn {_table, count} -> count == 0 end)

    assert {:ok, account, _pending_environment} =
             ProviderAccountService.create(%{
               "provider_key" => "deterministic-fake",
               "display_name" => "Phase B real Worker proof",
               "worker_id" => worker_id
             })

    assert_eventually(fn -> environment_available?(account.id) end, 2_400)
    initial_environment = Repo.get!(ProviderAccountEnvironment, account.id)
    initial_identity = physical_identity(initial_environment)
    request_id = Ecto.UUID.generate()

    assert {:ok, attempt, nil, false} =
             ProviderAccountService.authorize_setup(account.id, %{
               "request_id" => request_id,
               "confirmed" => true
             })

    assert_eventually(
      fn ->
        match?(
          %{state: "human_interaction_required"},
          ProviderAccountSetups.fetch(attempt.id)
        )
      end,
      800
    )

    attention = ProviderAccountSetups.attention_for_attempt(attempt.id)
    assert attention.provider_account_id == account.id

    assert_eventually(
      fn ->
        match?(
          {:ok, %{output: output}} when is_binary(output) and byte_size(output) > 0,
          ProviderAccountSetups.interaction(
            account.id,
            attempt.id,
            attempt.setup_generation,
            attention.id
          )
        )
      end,
      800
    )

    {:ok, %{output: sensitive_output}} =
      ProviderAccountSetups.interaction(
        account.id,
        attempt.id,
        attempt.setup_generation,
        attention.id
      )

    assert sensitive_output =~ "https://fake-provider.invalid/device"
    sensitive_input = "phase-b-sensitive-#{Ecto.UUID.generate()}"

    assert {:ok, _responding_attempt, responding_attention} =
             ProviderAccountService.respond_setup(account.id, attempt.id, %{
               "setup_generation" => attempt.setup_generation,
               "attention_id" => attention.id,
               "request_id" => Ecto.UUID.generate(),
               "value" => sensitive_input
             })

    assert responding_attention.delivery_state == "delivery_requested"

    assert_eventually(
      fn -> match?(%{state: "succeeded"}, ProviderAccountSetups.fetch(attempt.id)) end,
      800
    )

    {:ok, authenticated_account, retained_environment} = ProviderAccountService.get(account.id)
    assert authenticated_account.authentication_state == :authenticated
    assert authenticated_account.credential_generation == 2
    assert retained_environment.credential_generation == 1
    assert physical_identity(retained_environment) == initial_identity
    refute ProviderAccountSetups.active_for_account?(account.id)
    assert run_authority_counts() == zero_run_counts
    refute_durable_setup_value(sensitive_input)
    refute_durable_setup_value("https://fake-provider.invalid/device")
    refute_worker_state_value(worker_root, sensitive_input)
    refute_worker_state_value(worker_root, "https://fake-provider.invalid/device")

    stop_worker_process(first_port, worker_id)

    assert_eventually(fn ->
      match?({:ok, %{status: "disconnected"}}, WorkerStore.fetch(worker_id))
    end)

    second_port = start_worker.()
    second_pid = worker_process_pid(second_port)
    on_exit(fn -> stop_worker_process(second_port, worker_id, second_pid) end)
    assert_eventually(fn -> worker_ready?(worker_id, 2) end, 800)
    assert_eventually(fn -> environment_available?(account.id) end, 800)

    {:ok, restarted_account, restarted_environment} = ProviderAccountService.get(account.id)
    assert restarted_account.authentication_state == :authenticated
    assert restarted_account.credential_generation == 2
    assert physical_identity(restarted_environment) == initial_identity
    assert run_authority_counts() == zero_run_counts

    assert {:ok, _removing_account, _removing_environment} =
             ProviderAccountService.action(account.id, "remove")

    assert_eventually(
      fn ->
        match?(
          %{physical_state: "removed"},
          Repo.get(ProviderAccountEnvironment, account.id)
        )
      end,
      2_400
    )

    {:ok, removed_account, _removed_environment} = ProviderAccountService.get(account.id)
    assert removed_account.authentication_state == :authentication_required
    assert removed_account.credential_generation == 2

    stop_worker_process(second_port, worker_id)
    assert System.monotonic_time(:millisecond) - started_at < 120_000
  end

  defp environment_available?(account_id) do
    match?(
      %{physical_state: "available", canary_persisted: true},
      Repo.get(ProviderAccountEnvironment, account_id)
    )
  end

  defp physical_identity(environment) do
    {environment.backend_kind, environment.environment_id, environment.incarnation}
  end

  defp run_authority_counts do
    for table <- [
          "product_workspaces",
          "product_quests",
          "runtime_runs",
          "quest_launches",
          "scheduled_action_executions",
          "operational_attempt_attributions"
        ],
        into: %{} do
      %{rows: [[count]]} = Repo.query!("SELECT count(*) FROM #{table}")
      {table, count}
    end
  end

  defp refute_durable_setup_value(value) do
    for table <- [
          "provider_accounts",
          "provider_account_environments",
          "provider_account_setup_attempts",
          "provider_account_setup_authorizations",
          "provider_account_setup_events",
          "provider_account_human_attention_requests"
        ] do
      %{rows: columns} =
        Repo.query!(
          "SELECT column_name FROM information_schema.columns " <>
            "WHERE table_schema='public' AND table_name=$1 " <>
            "AND data_type IN ('character varying','text','json','jsonb')",
          [table]
        )

      predicates =
        Enum.map_join(columns, " OR ", fn [column] ->
          "position($1 in coalesce(#{column}::text,'')) > 0"
        end)

      if predicates != "" do
        %{rows: [[count]]} =
          Repo.query!("SELECT count(*) FROM #{table} WHERE #{predicates}", [value])

        assert count == 0
      end
    end
  end

  defp refute_worker_state_value(root, value) do
    for path <- Path.wildcard(Path.join(root, "**/*sqlite*")), File.regular?(path) do
      assert :binary.match(File.read!(path), value) == :nomatch
    end
  end

  defp worker_ready?(worker_id, generation) do
    match?(
      {:ok,
       %{
         status: "connected",
         connection_generation: ^generation,
         ready_generation: ^generation
       }},
      WorkerStore.fetch(worker_id)
    )
  end

  defp worker_candidate(worker_id) do
    Enum.find(WorkspaceControl.list_candidates(), fn candidate ->
      case Repo.get(WorkerWorkspaceCandidate, candidate.candidate_id) do
        %{worker_id: ^worker_id} -> true
        _ -> false
      end
    end)
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

  defp open_worker_process(bun, args, root, env) do
    python =
      System.find_executable("python3") ||
        raise "python3 is required to create an isolated Worker process group"

    # The direct Python bootstrap performs only setsid + exec. The resulting
    # Port PID is the Bun Worker PID and the leader of its own process group.
    port =
      Port.open({:spawn_executable, python}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        args: [
          "-c",
          "import os,sys; os.getpgrp()==os.getpid() or os.setsid(); os.execv(sys.argv[1], sys.argv[1:])",
          bun | args
        ],
        cd: String.to_charlist(root),
        env: env
      ])

    {:os_pid, pid} = Port.info(port, :os_pid)

    expected_identity = List.last(args)

    assert_eventually(fn ->
      Enum.any?(process_group_members(pid), fn member ->
        member.pid == pid and member.pgid == pid and
          String.contains?(member.command, expected_identity)
      end)
    end)

    port
  end

  defp worker_process_pid(port) do
    {:os_pid, pid} = Port.info(port, :os_pid)
    pid
  end

  defp stop_worker_process(port, worker_id, captured_pid \\ nil) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> stop_owned_process(port, worker_id, pid)
      nil when is_integer(captured_pid) -> stop_owned_process(port, worker_id, captured_pid)
      nil -> :ok
    end
  end

  defp stop_owned_process(port, worker_id, pid) do
    members = process_group_members(pid)
    if members != [], do: terminate_owned_process_group(port, worker_id, pid, members)
    assert Port.info(port) == nil
  end

  defp terminate_owned_process_group(port, worker_id, pid, members) do
    expected_identity = "--qe-test-worker=#{worker_id}"
    assert Enum.any?(members, &String.contains?(&1.command, expected_identity))
    {_, status} = System.cmd("kill", ["-TERM", "-#{pid}"], stderr_to_stdout: true)
    assert status in [0, 1]

    receive do
      {^port, {:exit_status, _status}} -> :ok
    after
      2_000 -> :ok
    end

    unless process_group_members(pid) == [] do
      {_, kill_status} = System.cmd("kill", ["-KILL", "-#{pid}"], stderr_to_stdout: true)
      assert kill_status in [0, 1]
    end

    assert_eventually(fn -> process_group_members(pid) == [] end)
  end

  defp process_group_members(pgid) do
    {output, 0} = System.cmd("ps", ["-axo", "pid=,pgid=,command="])

    output
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case String.split(String.trim(line), ~r/\s+/, parts: 3) do
        [pid, process_group, command] ->
          [
            %{
              pid: String.to_integer(pid),
              pgid: String.to_integer(process_group),
              command: command
            }
          ]

        _ ->
          []
      end
    end)
    |> Enum.filter(&(&1.pgid == pgid))
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
