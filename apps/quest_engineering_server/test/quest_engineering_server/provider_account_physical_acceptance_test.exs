defmodule QuestEngineering.Server.ProviderAccountPhysicalAcceptanceTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Server.Persistence.ProviderAccountEnvironment
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.ProviderAccountApi.Service, as: ProviderAccountService
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.ServerWeb.Endpoint

  @endpoint Endpoint
  @moduletag timeout: 12 * 60_000

  setup do
    owner =
      Sandbox.start_owner!(Repo,
        shared: true,
        ownership_timeout: 12 * 60_000
      )

    on_exit(fn -> Sandbox.stop_owner(owner) end)
    :ok
  end

  @tag :physical_scenario_a
  test "real Product and Worker physically accept the fake Claude interaction" do
    if System.get_env("QE_LIVE_SBX") == "1" do
      {bun, root, acceptance_root, baseline_counts} = physical_context("scenario-a")
      scenario = run_interaction_scenario(bun, root, acceptance_root, baseline_counts)
      evidence = physical_evidence(acceptance_root, :scenario_a, scenario)
      assert authority_counts() == baseline_counts
      write_physical_evidence(acceptance_root, "scenario-a-evidence.json", evidence)
      IO.puts("PR48_PHYSICAL_SCENARIO_A=" <> Jason.encode!(evidence))
    else
      IO.puts("PR #48 physical Scenario A skipped: set QE_LIVE_SBX=1")
    end
  end

  @tag :physical_scenario_b
  test "real Product and Worker reconcile a generation-one timeout through generation three" do
    if System.get_env("QE_LIVE_SBX") == "1" do
      {bun, root, acceptance_root, baseline_counts} = physical_context("scenario-b")
      scenario = run_cross_generation_scenario(bun, root, acceptance_root, baseline_counts)
      evidence = physical_evidence(acceptance_root, :scenario_b, scenario)
      assert authority_counts() == baseline_counts
      write_physical_evidence(acceptance_root, "scenario-b-evidence.json", evidence)
      IO.puts("PR48_PHYSICAL_SCENARIO_B=" <> Jason.encode!(evidence))
    else
      IO.puts("PR #48 physical Scenario B skipped: set QE_LIVE_SBX=1")
    end
  end

  defp physical_context(scenario) do
    bun = System.find_executable("bun") || raise "bun is required for physical acceptance"
    root = Path.expand("../../../..", __DIR__)

    acceptance_root =
      Path.join(
        root,
        ".pi/tmp/pr48-physical-acceptance-#{scenario}-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(acceptance_root)
    start_supervised!(QuestEngineering.Server.WorkerConnections)
    baseline_counts = authority_counts()
    assert Enum.all?(baseline_counts, fn {_table, count} -> count == 0 end)
    {bun, root, acceptance_root, baseline_counts}
  end

  defp physical_evidence(acceptance_root, scenario_key, scenario) do
    %{
      scenario_key => scenario,
      evidence_root: acceptance_root,
      protocol_version: 19,
      product_schema_changed: false,
      worker_schema_version: 3,
      account_profile_changed: false,
      zero_provider: %{
        claude_process_launches: 0,
        provider_network_traffic: 0,
        credential_operations: 0,
        inference_authorizations: 0,
        runs: 0,
        model_turns: 0
      }
    }
  end

  defp write_physical_evidence(acceptance_root, filename, evidence) do
    File.write!(
      Path.join(acceptance_root, filename),
      Jason.encode_to_iodata!(evidence, pretty: true)
    )
  end

  defp run_interaction_scenario(bun, root, acceptance_root, baseline_counts) do
    suffix = Integer.to_string(System.unique_integer([:positive]))
    worker_id = "pr48-physical-a-#{suffix}"
    worker_root = Path.join(acceptance_root, worker_id)
    secret = "QE_FAKE_CLAUDE_LOGIN_INTERACTION_SECRET_#{suffix}"
    input = "fake-code##{String.duplicate("s", 43)}"
    File.mkdir_p!(worker_root)
    port = start_worker(bun, root, worker_root, worker_id, "fragmented", secret)
    worker_pid = worker_process_pid(port)

    on_exit(fn -> stop_worker_process(port, worker_id, worker_pid) end)
    assert_eventually(fn -> worker_ready?(worker_id, 1) end, 800)

    assert {:ok, account, _pending} =
             ProviderAccountService.create(%{
               "provider_key" => "anthropic",
               "display_name" => "PR48 physical interaction #{suffix}",
               "worker_id" => worker_id
             })

    on_exit(fn -> cleanup_account(account.id) end)
    assert_eventually(fn -> environment_available?(account.id) end, 4_800)
    environment = Repo.get!(ProviderAccountEnvironment, account.id)

    assert {:ok, attempt, nil, false} =
             ProviderAccountService.authorize_setup(account.id, %{
               "request_id" => Ecto.UUID.generate(),
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

    waiting = ProviderAccountSetups.fetch(attempt.id)
    attention = ProviderAccountSetups.attention_for_attempt(attempt.id)
    assert waiting.invocation_worker_generation == 1
    assert waiting.worker_generation == 1
    assert waiting.process_executable == "/usr/bin/qe-fake-provider-login"

    {client_public_key, client_private_key} = interaction_encryption_key()
    telemetry_id = {__MODULE__, make_ref()}
    test_process = self()

    :ok =
      :telemetry.attach(
        telemetry_id,
        [:phoenix, :endpoint, :stop],
        fn _event, _measurements, metadata, destination ->
          send(destination, {:physical_endpoint_telemetry, metadata})
        end,
        test_process
      )

    interaction_path =
      "/api/v1/provider-accounts/#{account.id}/setup-attempts/#{attempt.id}/interactions/#{attention.id}?generation=#{attempt.setup_generation}"

    interaction_conn =
      local_conn()
      |> put_req_header("x-qe-interaction-public-key", client_public_key)
      |> get(interaction_path)

    :ok = :telemetry.detach(telemetry_id)
    assert ["no-store"] = get_resp_header(interaction_conn, "cache-control")
    refute interaction_conn.resp_body =~ secret

    assert %{"interaction" => %{"output" => sealed_output}} =
             json_response(interaction_conn, 200)

    output = decrypt_interaction(sealed_output, client_private_key)
    assert output =~ "Opening browser to sign in…\n"
    assert output =~ "https://claude.com/cai/oauth/authorize?"
    assert output =~ secret
    assert String.ends_with?(output, "\nPaste code here if prompted > ")
    refute String.ends_with?(output, "\n")
    assert_receive {:physical_endpoint_telemetry, telemetry}
    refute inspect(telemetry, limit: :infinity) =~ secret
    refute_receive {:physical_endpoint_telemetry, _duplicate}, 50

    # The test-only discovery deadline is five seconds. Recognition has already
    # cancelled it; the separate fifteen-second human deadline remains active.
    Process.sleep(5_250)
    assert ProviderAccountSetups.fetch(attempt.id).state == "human_interaction_required"

    response_conn =
      local_conn()
      |> post(
        "/api/v1/provider-accounts/#{account.id}/setup-attempts/#{attempt.id}/respond",
        %{
          "setup_generation" => attempt.setup_generation,
          "attention_id" => attention.id,
          "request_id" => Ecto.UUID.generate(),
          "value" => input
        }
      )

    refute inspect(response_conn.params, limit: :infinity) =~ input

    assert %{"setup_attempt" => %{"state" => response_state}} =
             json_response(response_conn, 200)

    assert response_state in ["human_interaction_required", "validating", "succeeded"]

    assert_eventually(
      fn -> match?(%{state: "succeeded"}, ProviderAccountSetups.fetch(attempt.id)) end,
      800
    )

    terminal = ProviderAccountSetups.fetch(attempt.id)
    assert terminal.invocation_state == "settled"
    assert terminal.invocation_worker_generation == 1
    assert terminal.worker_generation == 1
    assert WorkerStore.fetch(worker_id) |> then(&match?({:ok, %{connection_generation: 1}}, &1))
    assert authority_counts() == baseline_counts
    assert setup_state_observation_count(attempt.id, "human_interaction_required") == 1
    refute_durable_setup_value(secret)
    refute_durable_setup_value(input)
    refute_worker_state_value(worker_root, secret)
    refute_worker_state_value(worker_root, input)

    physical_events = physical_events(worker_root)
    assert event_count(physical_events, "streamed_process_spawn_requested") == 1
    assert event_count(physical_events, "streamed_process_spawned") == 1
    assert event_count(physical_events, "stdin_write_acknowledged") == 1
    assert event_count(physical_events, "process_cancel_requested") == 0

    remove_account(account.id)
    logs = stop_worker_process(port, worker_id, worker_pid)
    refute logs =~ secret
    refute logs =~ input
    refute_worker_state_value(worker_root, secret)
    refute_worker_state_value(worker_root, input)

    %{
      worker_id: worker_id,
      account_id: account.id,
      setup_attempt_id: attempt.id,
      environment: physical_identity(environment),
      process: %{
        backend_process_id: terminal.process_backend_id,
        process_start_identity: terminal.process_start_identity,
        process_generation: terminal.process_generation,
        executable: terminal.process_executable
      },
      fixture_mode: "fragmented",
      interaction_bytes: byte_size(output),
      interaction_discovery_timeout_ms: 5_000,
      human_wait_after_delivery_ms: 5_250,
      ephemeral_delivery_count: 1,
      human_interaction_event_count: 1,
      physical_spawn_count: 1,
      physical_cancel_count: 0,
      durable_secret_occurrences: 0,
      terminal_state: terminal.state,
      unsolicited_reconnects: 0
    }
  end

  defp run_cross_generation_scenario(bun, root, acceptance_root, baseline_counts) do
    suffix = Integer.to_string(System.unique_integer([:positive]))
    worker_id = "pr48-physical-b-#{suffix}"
    worker_root = Path.join(acceptance_root, worker_id)
    secret = "QE_FAKE_CLAUDE_LOGIN_INTERACTION_SECRET_#{suffix}"
    File.mkdir_p!(worker_root)
    port = start_worker(bun, root, worker_root, worker_id, "silent", secret)
    worker_pid = worker_process_pid(port)

    on_exit(fn -> stop_worker_process(port, worker_id, worker_pid) end)
    assert_eventually(fn -> worker_ready?(worker_id, 1) end, 800)

    assert {:ok, account, _pending} =
             ProviderAccountService.create(%{
               "provider_key" => "anthropic",
               "display_name" => "PR48 physical timeout #{suffix}",
               "worker_id" => worker_id
             })

    on_exit(fn -> cleanup_account(account.id) end)
    assert_eventually(fn -> environment_available?(account.id) end, 4_800)
    environment = Repo.get!(ProviderAccountEnvironment, account.id)

    assert {:ok, attempt, nil, false} =
             ProviderAccountService.authorize_setup(account.id, %{
               "request_id" => Ecto.UUID.generate(),
               "confirmed" => true
             })

    assert_eventually(
      fn ->
        match?(
          %{state: "invocation_acknowledged"},
          ProviderAccountSetups.fetch(attempt.id)
        )
      end,
      800
    )

    acknowledged = ProviderAccountSetups.fetch(attempt.id)
    assert acknowledged.worker_generation == 1
    assert acknowledged.invocation_worker_generation == 1
    owner_operation_id = acknowledged.invocation_environment_operation_id
    process_generation = acknowledged.process_generation

    assert {:ok, %{pid: generation_one_channel, generation: 1}} =
             WorkerConnections.lookup(worker_id)

    GenServer.stop(generation_one_channel, :normal)
    assert_eventually(fn -> worker_ready?(worker_id, 2) end, 800)
    assert_eventually(fn -> ProviderAccountSetups.fetch(attempt.id).worker_generation == 2 end)

    assert_eventually(
      fn -> worker_setup_command_generation(worker_root, attempt.id) == 2 end,
      800
    )

    assert {:ok, %{pid: generation_two_channel, generation: 2}} =
             WorkerConnections.lookup(worker_id)

    GenServer.stop(generation_two_channel, :normal)
    assert_eventually(fn -> worker_ready?(worker_id, 3) end, 800)
    assert_eventually(fn -> ProviderAccountSetups.fetch(attempt.id).worker_generation == 3 end)

    assert_eventually(
      fn -> worker_setup_command_generation(worker_root, attempt.id) == 3 end,
      800
    )

    routed = ProviderAccountSetups.fetch(attempt.id)
    assert routed.worker_generation == 3
    assert routed.invocation_worker_generation == 1
    assert routed.invocation_environment_operation_id == owner_operation_id
    assert routed.process_generation == process_generation

    assert_eventually(
      fn ->
        match?(
          %{state: "failed", invocation_state: "settled"},
          ProviderAccountSetups.fetch(attempt.id)
        )
      end,
      2_400
    )

    terminal = ProviderAccountSetups.fetch(attempt.id)
    assert terminal.failure_code == "setup_interaction_discovery_timed_out"
    assert terminal.worker_generation == 3
    assert terminal.invocation_worker_generation == 1
    assert terminal.invocation_environment_operation_id == owner_operation_id
    assert terminal.process_generation == process_generation
    assert worker_ready?(worker_id, 3)
    assert authority_counts() == baseline_counts

    physical_events = physical_events(worker_root)
    assert event_count(physical_events, "streamed_process_spawn_requested") == 1
    assert event_count(physical_events, "streamed_process_spawned") == 1
    assert event_count(physical_events, "process_cancel_requested") == 1
    assert event_count(physical_events, "process_cancelled") == 1

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(
               worker_id,
               1,
               stale_terminal_report(terminal, owner_operation_id)
             )

    refute_durable_setup_value(secret)
    refute_worker_state_value(worker_root, secret)
    remove_account(account.id)
    logs = stop_worker_process(port, worker_id, worker_pid)
    refute logs =~ secret
    refute_worker_state_value(worker_root, secret)

    %{
      worker_id: worker_id,
      account_id: account.id,
      setup_attempt_id: attempt.id,
      environment: physical_identity(environment),
      invocation_owner_generation: 1,
      invocation_environment_operation_id: owner_operation_id,
      routing_generations: [1, 2, 3],
      reconciled_by_generation: terminal.worker_generation,
      process: %{
        backend_process_id: terminal.process_backend_id,
        process_start_identity: terminal.process_start_identity,
        process_generation: terminal.process_generation,
        executable: terminal.process_executable
      },
      physical_spawn_count: 1,
      duplicate_spawn_count: 0,
      physical_cancel_submission_count: 1,
      terminal_state: terminal.state,
      invocation_state: terminal.invocation_state,
      failure_code: terminal.failure_code,
      stale_owner_report: "rejected",
      reconnect_cause: "acceptance-induced channel closure",
      unsolicited_reconnects: 0,
      durable_secret_occurrences: 0
    }
  end

  defp stale_terminal_report(attempt, owner_operation_id) do
    %{
      setup_attempt_id: attempt.id,
      provider_account_id: attempt.provider_account_id,
      setup_generation: attempt.setup_generation,
      credential_generation: attempt.credential_generation_before,
      environment_generation: attempt.environment_generation,
      worker_generation: 1,
      environment_operation_id: owner_operation_id,
      invocation_worker_generation: 1,
      invocation_environment_operation_id: owner_operation_id,
      backend_kind: attempt.backend_kind,
      environment_id: attempt.environment_id,
      environment_incarnation: attempt.environment_incarnation,
      state: "failed",
      invocation_state: "settled",
      process: %{
        backend_process_id: attempt.process_backend_id,
        process_start_identity: attempt.process_start_identity,
        process_generation: attempt.process_generation,
        executable: attempt.process_executable
      },
      attention: nil,
      preflight: %{
        state: attempt.preflight_state,
        method: attempt.preflight_method,
        configuration_identity: attempt.preflight_configuration_identity,
        environment_policy: attempt.preflight_environment_policy,
        evidence_identity: attempt.preflight_identity,
        inspected_at: attempt.preflight_inspected_at
      },
      validation: nil,
      failure_code: attempt.failure_code,
      observed_at: DateTime.utc_now()
    }
  end

  defp start_worker(bun, root, worker_root, worker_id, mode, secret) do
    script = Path.join(root, "workers/bun/test/support/live-provider-account-worker.ts")

    open_worker_process(
      bun,
      [script, mode, secret, "--qe-test-worker=#{worker_id}"],
      root,
      [
        {~c"QE_CONTROL_PLANE_URL", ~c"ws://127.0.0.1:4002/worker/websocket"},
        {~c"QE_WORKER_ID", String.to_charlist(worker_id)},
        {~c"QE_WORKER_TOKEN", ~c"development-worker-token"},
        {~c"QE_ALLOWED_ROOTS_JSON", ~c"[]"},
        {~c"QE_WORKTREE_ROOT", String.to_charlist(Path.join(worker_root, "worktrees"))},
        {~c"QE_WORKER_DATA_ROOT", String.to_charlist(worker_root)},
        {~c"QE_WORKER_HARNESSES", ~c"claude_code"},
        {~c"QE_RECONNECT_MS", ~c"10"}
      ]
    )
  end

  defp local_conn do
    build_conn()
    |> Map.put(:host, "localhost")
    |> Map.put(:remote_ip, {127, 0, 0, 1})
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-quest-engineering-local-client", "tauri")
  end

  defp interaction_encryption_key do
    private_key = :public_key.generate_key({:rsa, 2048, 65_537})
    public_key = {:RSAPublicKey, elem(private_key, 2), elem(private_key, 3)}

    {:SubjectPublicKeyInfo, der, :not_encrypted} =
      :public_key.pem_entry_encode(:SubjectPublicKeyInfo, public_key)

    {Base.encode64(der), private_key}
  end

  defp decrypt_interaction(sealed, private_key) do
    key =
      sealed["encrypted_key"]
      |> Base.decode64!()
      |> :public_key.decrypt_private(private_key,
        rsa_pad: :rsa_pkcs1_oaep_padding,
        rsa_oaep_md: :sha256
      )

    :crypto.crypto_one_time_aead(
      :aes_256_gcm,
      key,
      Base.decode64!(sealed["iv"]),
      Base.decode64!(sealed["ciphertext"]),
      "",
      Base.decode64!(sealed["tag"]),
      false
    )
  end

  defp environment_available?(account_id) do
    match?(
      %{physical_state: "available", canary_persisted: true},
      Repo.get(ProviderAccountEnvironment, account_id)
    )
  end

  defp cleanup_account(account_id) do
    case Repo.get(ProviderAccountEnvironment, account_id) do
      %{physical_state: "removed"} ->
        :ok

      nil ->
        :ok

      _environment ->
        if ProviderAccountSetups.active_for_account?(account_id) do
          case ProviderAccountSetups.list(account_id) do
            [attempt | _rest] ->
              ProviderAccountService.cancel_setup(account_id, attempt.id, %{
                "request_id" => Ecto.UUID.generate()
              })

              assert_eventually(
                fn -> not ProviderAccountSetups.active_for_account?(account_id) end,
                800
              )

            [] ->
              :ok
          end
        end

        case ProviderAccountService.action(account_id, "remove") do
          {:ok, _account, _environment} ->
            assert_eventually(
              fn ->
                match?(
                  %{physical_state: "removed"},
                  Repo.get(ProviderAccountEnvironment, account_id)
                )
              end,
              4_800
            )

          _error ->
            :ok
        end
    end
  end

  defp remove_account(account_id) do
    assert {:ok, _account, _environment} = ProviderAccountService.action(account_id, "remove")

    assert_eventually(
      fn ->
        match?(
          %{physical_state: "removed"},
          Repo.get(ProviderAccountEnvironment, account_id)
        )
      end,
      4_800
    )
  end

  defp physical_identity(environment) do
    %{
      backend_kind: environment.backend_kind,
      environment_id: environment.environment_id,
      incarnation: environment.incarnation
    }
  end

  defp physical_events(worker_root) do
    path = Path.join(worker_root, "provider-account-physical-events.jsonl")

    assert_eventually(fn -> File.exists?(path) end)

    path
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.map(&Jason.decode!/1)
  end

  defp event_count(events, event), do: Enum.count(events, &(&1["event"] == event))

  defp setup_state_observation_count(attempt_id, state) do
    %{rows: [[count]]} =
      Repo.query!(
        "SELECT count(*) FROM provider_account_setup_events " <>
          "WHERE setup_attempt_id=$1 AND event_type='setup_state_observed' " <>
          "AND details->>'observed_state'=$2",
        [attempt_id, state]
      )

    count
  end

  defp authority_counts do
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
    for path <- Path.wildcard(Path.join(root, "**/*")), File.regular?(path) do
      assert :binary.match(File.read!(path), value) == :nomatch
    end
  end

  defp worker_setup_command_generation(worker_root, attempt_id) do
    database = Path.join(worker_root, "provider-account-setups.sqlite")

    if File.exists?(database) do
      {value, status} =
        System.cmd(
          "sqlite3",
          [
            database,
            "SELECT json_extract(command_json,'$.connection_generation') FROM provider_account_setup_attempts WHERE setup_attempt_id='#{attempt_id}'"
          ],
          stderr_to_stdout: true
        )

      if status == 0 do
        case Integer.parse(String.trim(value)) do
          {generation, ""} -> generation
          _other -> nil
        end
      end
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

  defp open_worker_process(bun, args, root, env) do
    python =
      System.find_executable("python3") ||
        raise "python3 is required to create an isolated Worker process group"

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
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> pid
      nil -> nil
    end
  end

  defp stop_worker_process(port, worker_id, captured_pid) do
    case Port.info(port, :os_pid) do
      {:os_pid, pid} -> stop_owned_process(port, worker_id, pid)
      nil when is_integer(captured_pid) -> stop_owned_process(port, worker_id, captured_pid)
      nil -> drain_port_output(port, "")
    end
  end

  defp stop_owned_process(port, worker_id, pid) do
    members = process_group_members(pid)

    if members != [] do
      expected_identity = "--qe-test-worker=#{worker_id}"
      assert Enum.any?(members, &String.contains?(&1.command, expected_identity))
      {_, status} = System.cmd("kill", ["-TERM", "-#{pid}"], stderr_to_stdout: true)
      assert status in [0, 1]
    end

    output = drain_port_output(port, "", 4_000)

    unless process_group_members(pid) == [] do
      {_, kill_status} = System.cmd("kill", ["-KILL", "-#{pid}"], stderr_to_stdout: true)
      assert kill_status in [0, 1]
    end

    assert_eventually(fn -> process_group_members(pid) == [] end)
    output
  end

  defp drain_port_output(port, output, timeout \\ 50) do
    receive do
      {^port, {:data, data}} -> drain_port_output(port, output <> data, timeout)
      {^port, {:exit_status, _status}} -> drain_port_output(port, output, 50)
    after
      timeout -> output
    end
  end

  defp process_group_members(nil), do: []

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
