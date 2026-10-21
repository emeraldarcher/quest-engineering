defmodule QuestEngineering.Server.ProviderAccountSetupsTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Persistence.ProviderAccountSetupAuthorization
  alias QuestEngineering.Server.Persistence.ProviderAccountSetupEvent
  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.ProviderAccountApi.Service
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
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

    # Product authority is reconstructed from PostgreSQL, not a process-local
    # assumption that the semantic and physical owner epochs are equal.
    assert {:ok, reconstructed, reconstructed_environment} =
             Task.async(fn -> ProviderAccounts.get_with_environment(account.id) end)
             |> Task.await()

    assert reconstructed.credential_generation == 2
    assert reconstructed.authentication_state == :authenticated
    assert reconstructed.authentication_method == "provider_account"
    assert reconstructed_environment.credential_generation == 1
    assert reconstructed_environment.environment_id == environment.environment_id
    assert reconstructed_environment.incarnation == environment.incarnation
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

  test "response and explicit cancellation serialize so exactly one authority wins" do
    {worker, account, attempt, process, attention} = waiting_setup("setup-response-cancel-race")
    response_request_id = Ecto.UUID.generate()
    cancellation_request_id = Ecto.UUID.generate()

    [response_result, cancellation_result] =
      [
        fn ->
          ProviderAccountSetups.respond(
            account.id,
            attempt.id,
            attempt.setup_generation,
            attention.id,
            response_request_id,
            "ephemeral-race-input"
          )
        end,
        fn ->
          ProviderAccountSetups.cancel(account.id, attempt.id, cancellation_request_id)
        end
      ]
      |> Enum.map(&Task.async/1)
      |> Task.await_many()

    final_attempt = ProviderAccountSetups.fetch(attempt.id)
    final_attention = ProviderAccountSetups.attention_for_attempt(attempt.id)
    process_generation = process.process_generation

    case {response_result, cancellation_result} do
      {{:ok, _, _}, {:error, %{code: :setup_cancellation_conflict}}} ->
        assert final_attempt.state == "human_interaction_required"
        assert final_attention.response_state == "responded"
        assert final_attention.delivery_state == "delivery_requested"

        assert_receive {:worker_protocol,
                        %{
                          "type" => "respond_provider_account_setup",
                          "process_generation" => ^process_generation
                        }}

      {{:error, %{code: :stale_provider_account_setup_response}}, {:ok, _}} ->
        assert final_attempt.state == "cancellation_requested"
        assert final_attention.response_state == "cancelled"
        assert final_attention.delivery_state == "response_not_delivered"

        assert_receive {:worker_protocol,
                        %{
                          "type" => "cancel_provider_account_setup",
                          "process_generation" => ^process_generation
                        }}
    end

    refute_receive {:worker_protocol, _duplicate}, 25
    assert worker.id == attempt.worker_id
  end

  test "delivery certainty distinguishes not submitted, acknowledged, and ambiguous process exit" do
    {worker_a, account_a, attempt_a, process_a, attention_a} =
      waiting_setup("setup-delivery-not-submitted")

    assert {:ok, failed_a} =
             ProviderAccountSetups.record(
               worker_a.id,
               worker_a.connection_generation,
               setup_report(attempt_a, "failed", "settled",
                 process: process_a,
                 failure_code: "setup_process_failed"
               )
             )

    assert failed_a.state == "failed"
    assert ProviderAccountSetups.attention_for_attempt(attempt_a.id).response_state == "obsolete"

    assert {:error, %{code: :stale_provider_account_setup_response}} =
             ProviderAccountSetups.respond(
               account_a.id,
               attempt_a.id,
               attempt_a.setup_generation,
               attention_a.id,
               Ecto.UUID.generate(),
               "never-submitted"
             )

    assert ProviderAccountSetups.attention_for_attempt(attempt_a.id).delivery_state ==
             "response_not_delivered"

    {worker_b, account_b, attempt_b, process_b, attention_b} =
      waiting_setup("setup-delivery-acknowledged")

    assert {:ok, _, requested_b} =
             ProviderAccountSetups.respond(
               account_b.id,
               attempt_b.id,
               attempt_b.setup_generation,
               attention_b.id,
               Ecto.UUID.generate(),
               "acknowledged-input"
             )

    assert_receive {:worker_protocol, %{"type" => "respond_provider_account_setup"}}

    assert {:ok, [_same_generation]} =
             ProviderAccountSetups.prepare_worker_reconciliation(
               worker_b.id,
               worker_b.connection_generation
             )

    assert ProviderAccountSetups.attention_for_attempt(attempt_b.id).delivery_state ==
             "delivery_requested"

    delivery_b = %{
      setup_attempt_id: attempt_b.id,
      setup_generation: attempt_b.setup_generation,
      attention_id: attention_b.id,
      process_generation: process_b.process_generation,
      delivery_attempt_id: requested_b.delivery_attempt_id,
      state: "delivery_acknowledged",
      observed_at: DateTime.utc_now()
    }

    assert {:ok, acknowledged_b} =
             ProviderAccountSetups.record_input_delivery(
               worker_b.id,
               worker_b.connection_generation,
               delivery_b
             )

    assert acknowledged_b.delivery_state == "delivery_acknowledged"

    assert {:ok, _failed_b} =
             ProviderAccountSetups.record(
               worker_b.id,
               worker_b.connection_generation,
               setup_report(attempt_b, "failed", "settled",
                 process: process_b,
                 failure_code: "setup_process_failed"
               )
             )

    assert ProviderAccountSetups.attention_for_attempt(attempt_b.id).delivery_state ==
             "delivery_acknowledged"

    {worker_not_submitted, account_not_submitted, attempt_not_submitted, process_not_submitted,
     attention_not_submitted} =
      waiting_setup("setup-delivery-worker-rejected")

    assert {:ok, _, _requested_not_submitted} =
             ProviderAccountSetups.respond(
               account_not_submitted.id,
               attempt_not_submitted.id,
               attempt_not_submitted.setup_generation,
               attention_not_submitted.id,
               Ecto.UUID.generate(),
               "not-submitted-input"
             )

    assert_receive {:worker_protocol, %{"type" => "respond_provider_account_setup"}}

    assert {:ok, _failed_not_submitted} =
             ProviderAccountSetups.record(
               worker_not_submitted.id,
               worker_not_submitted.connection_generation,
               setup_report(attempt_not_submitted, "failed", "settled",
                 process: process_not_submitted,
                 failure_code: "input_delivery_not_submitted"
               )
             )

    assert ProviderAccountSetups.attention_for_attempt(attempt_not_submitted.id).delivery_state ==
             "response_not_delivered"

    {worker_c, account_c, attempt_c, process_c, attention_c} =
      waiting_setup("setup-delivery-uncertain")

    assert {:ok, _, requested_c} =
             ProviderAccountSetups.respond(
               account_c.id,
               attempt_c.id,
               attempt_c.setup_generation,
               attention_c.id,
               Ecto.UUID.generate(),
               "ambiguous-input"
             )

    assert_receive {:worker_protocol, %{"type" => "respond_provider_account_setup"}}

    assert {:ok, _failed_c} =
             ProviderAccountSetups.record(
               worker_c.id,
               worker_c.connection_generation,
               setup_report(attempt_c, "failed", "settled",
                 process: process_c,
                 failure_code: "setup_process_failed"
               )
             )

    uncertain_c = ProviderAccountSetups.attention_for_attempt(attempt_c.id)
    assert uncertain_c.response_state == "responded"
    assert uncertain_c.delivery_state == "delivery_uncertain"
    assert uncertain_c.delivery_uncertain_at

    assert {:error, %{code: :stale_provider_account_setup_delivery}} =
             ProviderAccountSetups.record_input_delivery(
               worker_c.id,
               worker_c.connection_generation,
               %{
                 setup_attempt_id: attempt_c.id,
                 setup_generation: attempt_c.setup_generation,
                 attention_id: attention_c.id,
                 process_generation: process_c.process_generation,
                 delivery_attempt_id: requested_c.delivery_attempt_id,
                 state: "delivery_acknowledged",
                 observed_at: DateTime.utc_now()
               }
             )

    {worker_d, account_d, attempt_d, process_d, attention_d} =
      waiting_setup("setup-delivery-ordered-late-report")

    assert {:ok, _, requested_d} =
             ProviderAccountSetups.respond(
               account_d.id,
               attempt_d.id,
               attempt_d.setup_generation,
               attention_d.id,
               Ecto.UUID.generate(),
               "ordered-input"
             )

    assert_receive {:worker_protocol, %{"type" => "respond_provider_account_setup"}}
    terminal_observed_at = DateTime.add(DateTime.utc_now(), 1, :second)

    assert {:ok, _failed_d} =
             ProviderAccountSetups.record(
               worker_d.id,
               worker_d.connection_generation,
               attempt_d
               |> setup_report("failed", "settled",
                 process: process_d,
                 failure_code: "setup_process_failed"
               )
               |> Map.put(:observed_at, terminal_observed_at)
             )

    assert ProviderAccountSetups.attention_for_attempt(attempt_d.id).delivery_state ==
             "delivery_uncertain"

    assert {:ok, ordered_acknowledgement} =
             ProviderAccountSetups.record_input_delivery(
               worker_d.id,
               worker_d.connection_generation,
               %{
                 setup_attempt_id: attempt_d.id,
                 setup_generation: attempt_d.setup_generation,
                 attention_id: attention_d.id,
                 process_generation: process_d.process_generation,
                 delivery_attempt_id: requested_d.delivery_attempt_id,
                 state: "delivery_acknowledged",
                 observed_at: DateTime.add(terminal_observed_at, -1, :microsecond)
               }
             )

    assert ordered_acknowledgement.delivery_state == "delivery_acknowledged"
    assert ordered_acknowledgement.delivery_uncertain_at == nil
  end

  test "route rejection is definitely not submitted and reconnect ambiguity is never replayed" do
    {worker_a, account_a, attempt_a, _process_a, attention_a} =
      waiting_setup("setup-product-route-not-submitted")

    dead_route = spawn(fn -> :ok end)

    assert :ok =
             WorkerConnections.activate(
               worker_a.id,
               Ecto.UUID.generate(),
               worker_a.connection_generation,
               dead_route
             )

    assert_eventually(fn -> WorkerConnections.lookup(worker_a.id) == {:error, :not_connected} end)

    response_request_a = Ecto.UUID.generate()

    assert {:error, :not_connected} =
             ProviderAccountSetups.respond(
               account_a.id,
               attempt_a.id,
               attempt_a.setup_generation,
               attention_a.id,
               response_request_a,
               "not-submitted-input"
             )

    not_submitted = ProviderAccountSetups.attention_for_attempt(attempt_a.id)
    assert not_submitted.response_state == "responded"
    assert not_submitted.delivery_state == "response_not_delivered"

    not_submitted_attempt = ProviderAccountSetups.fetch(attempt_a.id)
    assert not_submitted_attempt.state == "cancellation_requested"
    assert not_submitted_attempt.failure_code == "input_delivery_not_submitted"

    assert {:ok, ^not_submitted_attempt, ^not_submitted} =
             ProviderAccountSetups.respond(
               account_a.id,
               attempt_a.id,
               attempt_a.setup_generation,
               attention_a.id,
               response_request_a,
               "not-submitted-input"
             )

    {worker_b, account_b, attempt_b, _process_b, attention_b} =
      waiting_setup("setup-product-route-ambiguous")

    assert {:ok, _, requested_b} =
             ProviderAccountSetups.respond(
               account_b.id,
               attempt_b.id,
               attempt_b.setup_generation,
               attention_b.id,
               Ecto.UUID.generate(),
               "possibly-submitted-input"
             )

    assert_receive {:worker_protocol, %{"type" => "respond_provider_account_setup"}}

    assert {:ok, reconnected_b} =
             WorkerStore.register(worker_b.id, capabilities(), Ecto.UUID.generate())

    assert {:ok, reconnected_b} =
             WorkerStore.mark_ready(
               reconnected_b.id,
               reconnected_b.connection_generation
             )

    assert {:ok, [_environment]} =
             ProviderAccounts.prepare_worker_reconciliation(
               worker_b.id,
               reconnected_b.connection_generation
             )

    assert {:ok, [desired_setup]} =
             ProviderAccountSetups.prepare_worker_reconciliation(
               worker_b.id,
               reconnected_b.connection_generation
             )

    assert desired_setup.state == "cancellation_requested"
    assert desired_setup.cancellation_request_id == requested_b.delivery_attempt_id

    ambiguous = ProviderAccountSetups.attention_for_attempt(attempt_b.id)
    assert ambiguous.response_state == "responded"
    assert ambiguous.delivery_state == "delivery_uncertain"

    routed_attempt = ProviderAccountSetups.fetch(attempt_b.id)
    assert routed_attempt.state == "cancellation_requested"
    assert routed_attempt.failure_code == "input_delivery_uncertain"
    assert routed_attempt.worker_generation == reconnected_b.connection_generation
  end

  test "Product reconstruction preserves an active HumanAttention identity" do
    {worker, _account, attempt, process, attention} =
      waiting_setup("restart-active-attention-worker")

    assert {:ok, [desired]} =
             ProviderAccountSetups.prepare_worker_reconciliation(
               worker.id,
               worker.connection_generation + 1
             )

    reconstructed = ProviderAccountSetups.fetch(attempt.id)
    reconstructed_attention = ProviderAccountSetups.attention_for_attempt(attempt.id)
    assert reconstructed.state == "human_interaction_required"
    assert reconstructed.process_generation == process.process_generation
    assert reconstructed.invocation_worker_generation == worker.connection_generation
    assert reconstructed.worker_generation == worker.connection_generation + 1
    assert reconstructed_attention.id == attention.id
    assert reconstructed_attention.request_generation == attention.request_generation
    assert reconstructed_attention.response_state == "pending"
    assert reconstructed_attention.delivery_state == "response_not_delivered"
    assert desired.setup_attempt_id == attempt.id
    assert desired.state == "human_interaction_required"
    assert desired.invocation_worker_generation == worker.connection_generation
    assert Repo.aggregate(ProviderAccountSetupAuthorization, :count) == 1
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

  defp waiting_setup(worker_id) do
    unless Process.whereis(WorkerConnections), do: start_supervised!(WorkerConnections)
    {worker, account, _environment} = available_account(worker_id)

    :ok =
      WorkerConnections.activate(
        worker.id,
        worker.connection_id,
        worker.connection_generation,
        self()
      )

    assert {:ok, {attempt, _authorization, false}} =
             ProviderAccountSetups.authorize(account.id, Ecto.UUID.generate())

    process = process_identity()
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

    attention = ProviderAccountSetups.attention_for_attempt(waiting.id)
    {worker, account, waiting, process, attention}
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

  defp assert_eventually(assertion, attempts \\ 50)

  defp assert_eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(10)
      assert_eventually(assertion, attempts - 1)
    end
  end

  defp assert_eventually(_assertion, 0), do: flunk("condition did not become true")

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
