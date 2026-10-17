defmodule QuestEngineering.Server.ProviderAccountSetupsTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Persistence.ProviderAccountSetupAuthorization
  alias QuestEngineering.Server.Persistence.ProviderAccountSetupEvent
  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.ProviderAccountApi.Service
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.Server.WorkerStore

  test "exact account-scoped setup advances credential generation without replacing the environment" do
    {worker, account, environment} = available_account("setup-worker")
    request_id = Ecto.UUID.generate()

    assert {:ok, {attempt, authorization, false}} =
             ProviderAccountSetups.authorize(account.id, request_id)

    assert authorization.kind == "provider_account_setup"
    assert attempt.credential_generation_before == 1
    assert attempt.environment_generation == 1
    assert attempt.environment_id == environment.environment_id
    assert Repo.aggregate(ProviderAccountSetupAuthorization, :count) == 1

    assert {:ok, preparing} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "preparing", "not_requested")
             )

    assert preparing.state == "preparing"

    process = process_identity()

    assert {:ok, requested} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "invocation_requested", "requested")
             )

    assert requested.invocation_requested_at

    assert {:ok, _acknowledged} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "invocation_acknowledged", "acknowledged", process: process)
             )

    attention_id = Ecto.UUID.generate()

    assert {:ok, waiting} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "human_interaction_required", "acknowledged",
                 process: process,
                 attention: %{
                   attention_id: attention_id,
                   kind: "provider_authentication",
                   message: "Complete deterministic sign-in."
                 }
               )
             )

    assert waiting.attention_id == attention_id
    attention = ProviderAccountSetups.attention_for_attempt(attempt.id)
    assert attention.provider_account_id == account.id
    assert attention.request["kind"] == "provider_authentication"
    refute Map.has_key?(attention.request, "value")

    assert {:ok, validating} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "validating", "settled", process: process)
             )

    validation_identity = "qe-fake-auth-v1:" <> String.duplicate("a", 64)

    assert {:ok, succeeded} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(validating, "succeeded", "settled",
                 process: process,
                 validation:
                   authentication_evidence(
                     validating,
                     "authenticated",
                     "provider_account",
                     validation_identity
                   )
               )
             )

    assert succeeded.credential_generation_after == 2
    assert succeeded.validation_identity == validation_identity

    assert {:ok, updated, retained_environment} =
             ProviderAccounts.get_with_environment(account.id)

    assert updated.credential_generation == 2
    assert updated.authentication_state == :authenticated
    assert updated.environment_state == :available
    assert updated.authenticated_at
    assert updated.last_validated_at
    assert retained_environment.credential_generation == 1
    assert retained_environment.environment_id == environment.environment_id
    assert retained_environment.incarnation == environment.incarnation

    assert [desired] = ProviderAccounts.desired_for_worker(worker.id)
    assert desired.credential_generation == 1
    assert desired.expected_environment_id == environment.environment_id
    assert desired.expected_incarnation == environment.incarnation

    encoded =
      WorkerProtocol.reconcile_request(
        worker.id,
        worker.connection_generation,
        ProviderAccounts.desired_for_worker(worker.id),
        []
      )

    assert get_in(encoded, ["provider_accounts", Access.at(0), "credential_generation"]) == 1
    assert Repo.aggregate(ProviderAccountSetupEvent, :count) >= 6

    assert {:ok, {same_attempt, same_authorization, true}} =
             ProviderAccountSetups.authorize(account.id, request_id)

    assert same_attempt.id == attempt.id
    assert same_authorization.id == authorization.id

    assert {:ok, {stopping_account, _stopping_environment}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "stopped",
               worker.connection_generation
             )

    assert stopping_account.authentication_state == :authenticated

    assert {:ok, {removing_account, _removing_environment}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "removed",
               worker.connection_generation
             )

    assert removing_account.authentication_state == :not_checked
    assert removing_account.credential_generation == 2
  end

  test "setup authorization fails closed for every non-eligible authentication observation" do
    for {state, method} <- [
          {"authenticated", "provider_account"},
          {"forbidden_auth_method", "api_key"},
          {"inspection_unavailable", nil},
          {"incompatible_status", nil}
        ] do
      {_worker, account, _environment} =
        available_account("setup-ineligible-#{state}", state, method)

      assert account.authentication_state == String.to_existing_atom(state)
      assert account.authentication_method == method

      assert {:error, %{code: :provider_account_setup_ineligible}} =
               ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())
    end
  end

  test "concurrent authorization with one request ID creates one idempotent attempt" do
    {_worker, account, _environment} = available_account("setup-idempotency-worker")
    request_id = Ecto.UUID.generate()

    results =
      1..2
      |> Enum.map(fn _index ->
        Task.async(fn -> ProviderAccountSetups.authorize(account.id, request_id) end)
      end)
      |> Task.await_many()

    assert [false, true] ==
             results
             |> Enum.map(fn {:ok, {_attempt, _authorization, idempotent?}} -> idempotent? end)
             |> Enum.sort()

    assert [attempt_id] =
             results
             |> Enum.map(fn {:ok, {attempt, _authorization, _idempotent?}} -> attempt.id end)
             |> Enum.uniq()

    assert ProviderAccountSetups.fetch(attempt_id)
    assert Repo.aggregate(ProviderAccountSetupAuthorization, :count) == 1
  end

  test "failed post-login validation does not advance authentication readiness" do
    {worker, account, environment} = available_account("setup-validation-failure-worker")

    assert {:ok, {attempt, _authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    report =
      attempt
      |> setup_report("failed", "settled")
      |> Map.put(:process, process_identity())
      |> Map.put(
        :validation,
        authentication_evidence(
          attempt,
          "authentication_required",
          "none",
          "post-login-authentication-required"
        )
      )
      |> Map.put(:failure_code, "setup_validation_failed")

    assert {:ok, failed} =
             ProviderAccountSetups.record(worker.id, worker.connection_generation, report)

    assert failed.state == "failed"
    assert failed.credential_generation_after == nil

    {:ok, retained_account, retained_environment} =
      ProviderAccounts.get_with_environment(account.id)

    assert retained_account.credential_generation == 1
    assert retained_account.authentication_state == :authentication_required
    assert retained_environment.environment_id == environment.environment_id
    assert retained_environment.incarnation == environment.incarnation
  end

  test "setup eligibility and reports are fenced by physical readiness and exact identity" do
    {:ok, worker} =
      WorkerStore.register("ineligible-worker", capabilities(), Ecto.UUID.generate())

    {:ok, worker} = WorkerStore.mark_ready(worker.id, worker.connection_generation)

    {:ok, {account, environment}} =
      ProviderAccounts.create(
        %{provider_key: "fake", worker_id: worker.id},
        worker.connection_generation
      )

    assert {:error, %{code: :provider_account_setup_ineligible}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    assert {:ok, {:applied, _, _}} =
             ProviderAccounts.apply_environment_report(
               environment_report(account, environment, "physical-fenced", "incarnation-fenced")
             )

    assert {:ok, {attempt, _, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    stale = %{setup_report(attempt, "preparing", "not_requested") | environment_id: "wrong"}

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(worker.id, worker.connection_generation, stale)

    assert {:error, %{code: :setup_already_authorized}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    assert {:error, %{code: :provider_account_setup_active}} =
             Service.action(account.id, "stop")

    assert {:error, %{code: :provider_account_setup_active}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "stopped",
               worker.connection_generation
             )
  end

  test "a stale Worker preflight cannot cross the Product invocation fence" do
    {worker, account, _environment} = available_account("stale-preflight-worker")

    assert {:ok, {attempt, _authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    stale_report =
      attempt
      |> setup_report("invocation_requested", "requested")
      |> put_in([:preflight, :evidence_identity], "provider-auth-evidence-v1:stale")

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               stale_report
             )

    assert ProviderAccountSetups.fetch(attempt.id).invocation_state == "not_requested"
  end

  test "restart uncertainty preserves previously acknowledged process evidence without inventing preflight" do
    {worker, account, _environment} = available_account("uncertain-restart-worker")

    assert {:ok, {attempt, _authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    process = process_identity()

    assert {:ok, requested} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(attempt, "invocation_requested", "requested")
             )

    assert {:ok, acknowledged} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               setup_report(requested, "invocation_acknowledged", "acknowledged",
                 process: process
               )
             )

    report =
      acknowledged
      |> setup_report("uncertain", "uncertain", failure_code: "setup_process_lost")
      |> Map.put(:process, nil)
      |> Map.put(:preflight, nil)

    assert {:ok, uncertain} =
             ProviderAccountSetups.record(worker.id, worker.connection_generation, report)

    assert uncertain.state == "uncertain"
    assert uncertain.invocation_state == "uncertain"
    assert uncertain.process_backend_id == process.backend_process_id
    assert uncertain.process_start_identity == process.process_start_identity
    assert uncertain.process_generation == process.process_generation
    assert uncertain.process_executable == process.executable
  end

  test "current routing generation settles an exact older-generation invocation idempotently" do
    {worker, account, _environment} = available_account("generation-settlement-worker")

    assert {:ok, {attempt, _authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    owner_generation = worker.connection_generation
    owner_operation_id = attempt.environment_operation_id
    process = %{process_identity() | executable: "/opt/qe/claude/claude"}

    # The original invocation reports are intentionally absent: Product still
    # has not_requested while the current Worker reconciles durable old-owner
    # evidence after reconnect.
    {:ok, reconnected} =
      WorkerStore.register(worker.id, capabilities(), Ecto.UUID.generate())

    {:ok, reconnected} =
      WorkerStore.mark_ready(reconnected.id, reconnected.connection_generation)

    assert reconnected.connection_generation > owner_generation

    assert {:ok, [_desired_environment]} =
             ProviderAccounts.prepare_worker_reconciliation(
               worker.id,
               reconnected.connection_generation
             )

    assert {:ok, [_desired_setup]} =
             ProviderAccountSetups.prepare_worker_reconciliation(
               worker.id,
               reconnected.connection_generation
             )

    routed = ProviderAccountSetups.fetch(attempt.id)
    assert routed.worker_generation == reconnected.connection_generation
    assert routed.environment_operation_id != owner_operation_id
    assert routed.invocation_worker_generation == nil
    assert routed.invocation_environment_operation_id == nil

    reconciled_acknowledgement =
      routed
      |> setup_report("invocation_acknowledged", "acknowledged", process: process)
      |> Map.put(:invocation_worker_generation, owner_generation)
      |> Map.put(:invocation_environment_operation_id, owner_operation_id)

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(
               worker.id,
               reconnected.connection_generation,
               %{
                 reconciled_acknowledgement
                 | invocation_environment_operation_id: "forged-operation"
               }
             )

    assert {:ok, acknowledged} =
             ProviderAccountSetups.record(
               worker.id,
               reconnected.connection_generation,
               reconciled_acknowledgement
             )

    assert acknowledged.invocation_worker_generation == owner_generation
    assert acknowledged.invocation_environment_operation_id == owner_operation_id

    terminal =
      setup_report(acknowledged, "failed", "settled",
        process: process,
        failure_code: "setup_process_failed"
      )

    assert {:ok, settled} =
             ProviderAccountSetups.record(
               worker.id,
               reconnected.connection_generation,
               terminal
             )

    assert settled.state == "failed"
    assert settled.worker_generation == reconnected.connection_generation
    assert settled.invocation_worker_generation == owner_generation

    assert {:ok, idempotent} =
             ProviderAccountSetups.record(
               worker.id,
               reconnected.connection_generation,
               terminal
             )

    assert idempotent.id == settled.id

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(
               worker.id,
               reconnected.connection_generation,
               %{terminal | invocation_worker_generation: reconnected.connection_generation}
             )

    assert {:error, %{code: :stale_provider_account_setup_report}} =
             ProviderAccountSetups.record(worker.id, owner_generation, terminal)
  end

  test "Product restart reconstruction re-fences an active setup without replaying authorization" do
    {worker, account, environment} = available_account("restart-setup-worker")

    assert {:ok, {attempt, authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    assert {:ok, [desired]} =
             ProviderAccountSetups.prepare_worker_reconciliation(
               worker.id,
               worker.connection_generation + 1
             )

    assert desired.setup_attempt_id == attempt.id
    assert desired.authorization_id == authorization.id
    assert desired.environment_id == environment.environment_id
    assert desired.worker_generation == worker.connection_generation + 1
    assert desired.invocation_worker_generation == nil
    assert desired.invocation_environment_operation_id == nil

    command =
      WorkerProtocol.provider_account_setup(
        worker.id,
        desired.worker_generation,
        desired
      )

    assert command["protocol_version"] == 19
    assert command["setup"]["authorization_kind"] == "provider_account_setup"
    assert command["setup"]["credential_generation"] == 1
    assert command["setup"]["environment_generation"] == 1
    assert command["setup"]["invocation_worker_generation"] == nil
    assert command["setup"]["invocation_environment_operation_id"] == nil
    refute Map.has_key?(command["setup"], "credential")
  end

  defp process_identity do
    %{
      backend_process_id: "fake-pid-1",
      process_start_identity: "fake-start-1",
      process_generation: Ecto.UUID.generate(),
      executable: "/usr/bin/qe-fake-provider-login"
    }
  end

  defp available_account(
         worker_id,
         authentication_state \\ "authentication_required",
         authentication_method \\ "none"
       ) do
    {:ok, worker} = WorkerStore.register(worker_id, capabilities(), Ecto.UUID.generate())
    {:ok, worker} = WorkerStore.mark_ready(worker.id, worker.connection_generation)

    {:ok, {account, pending}} =
      ProviderAccounts.create(
        %{provider_key: "fake", worker_id: worker.id},
        worker.connection_generation
      )

    assert {:ok, {:applied, account, environment}} =
             ProviderAccounts.apply_environment_report(
               environment_report(
                 account,
                 pending,
                 "physical-#{worker_id}",
                 "incarnation-#{worker_id}",
                 authentication_state,
                 authentication_method
               )
             )

    {worker, account, environment}
  end

  defp environment_report(
         account,
         environment,
         environment_id,
         incarnation,
         authentication_state \\ "authentication_required",
         authentication_method \\ "none"
       ) do
    %{
      provider_account_id: account.id,
      credential_generation: environment.credential_generation,
      worker_id: account.worker_id,
      worker_generation: environment.worker_generation,
      operation_id: environment.operation_id,
      physical_state: "available",
      event_type: "environment_ensured",
      backend_kind: "fake-account",
      environment_id: environment_id,
      incarnation: incarnation,
      error_code: nil,
      error_message: nil,
      canary_persisted: true,
      observed_at: DateTime.utc_now(),
      authentication: %{
        state: authentication_state,
        method: authentication_method,
        configuration_identity: "qe-fake-provider-account-auth-v1",
        environment_policy: "qe-fake-provider-account-explicit-environment-v1",
        evidence_identity: "provider-auth-evidence-v1:" <> String.duplicate("a", 64),
        inspected_at: DateTime.utc_now()
      }
    }
  end

  defp setup_report(attempt, state, invocation_state, options \\ []) do
    %{
      setup_attempt_id: attempt.id,
      provider_account_id: attempt.provider_account_id,
      setup_generation: attempt.setup_generation,
      credential_generation: attempt.credential_generation_before,
      environment_generation: attempt.environment_generation,
      worker_generation: attempt.worker_generation,
      environment_operation_id: attempt.environment_operation_id,
      invocation_worker_generation:
        if(invocation_state == "not_requested",
          do: nil,
          else: attempt.invocation_worker_generation || attempt.worker_generation
        ),
      invocation_environment_operation_id:
        if(invocation_state == "not_requested",
          do: nil,
          else: attempt.invocation_environment_operation_id || attempt.environment_operation_id
        ),
      backend_kind: attempt.backend_kind,
      environment_id: attempt.environment_id,
      environment_incarnation: attempt.environment_incarnation,
      state: state,
      invocation_state: invocation_state,
      process: Keyword.get(options, :process),
      attention: Keyword.get(options, :attention),
      preflight:
        if(invocation_state == "not_requested",
          do: nil,
          else:
            attempt
            |> authentication_evidence(
              "authentication_required",
              "none",
              attempt.authorization_inspection_identity
            )
            |> Map.put(
              :inspected_at,
              attempt.preflight_inspected_at || attempt.authorization_inspected_at
            )
        ),
      validation: Keyword.get(options, :validation),
      failure_code: Keyword.get(options, :failure_code),
      observed_at: DateTime.utc_now()
    }
  end

  defp authentication_evidence(attempt, state, method, identity) do
    %{
      state: state,
      method: method,
      configuration_identity: attempt.auth_configuration_identity,
      environment_policy: attempt.auth_environment_policy,
      evidence_identity: identity,
      inspected_at: DateTime.utc_now()
    }
  end

  defp capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "features" => [
        "provider_account_environments_v1",
        "provider_account_setup_v1",
        "provider_account_auth_preflight_v1"
      ],
      "workspace_bindings" => [],
      "executors" => [
        %{
          "harness_kind" => "fake",
          "models" => [
            %{
              "provider" => "fake",
              "model" => "test",
              "display_name" => "Test",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{"kind" => "unsupported"}
            }
          ],
          "supported_tool_policies" => ["exact"],
          "tool_enforcement" => "exact",
          "tool_profile" => %{"tools" => []}
        }
      ]
    }
  end
end
