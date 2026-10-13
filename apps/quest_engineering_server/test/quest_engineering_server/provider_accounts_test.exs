defmodule QuestEngineering.Server.ProviderAccountsTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.WorkerMessageHandler
  alias QuestEngineering.Server.WorkerStore

  test "generation, Worker generation, operation, and incarnation are exact fences" do
    {:ok, worker} = WorkerStore.register("account-worker", capabilities(), Ecto.UUID.generate())

    assert {:ok, {account, environment}} =
             ProviderAccounts.create(
               %{provider_key: "fake", worker_id: worker.id, display_name: "Primary"},
               worker.connection_generation
             )

    report = report(account, environment, "environment-1", "incarnation-1")

    assert {:ok, {:applied, available, binding}} =
             ProviderAccounts.apply_environment_report(report)

    assert available.environment_state == :available
    assert binding.canary_persisted

    stale_report = %{
      report
      | operation_id: Ecto.UUID.generate(),
        physical_state: "degraded"
    }

    assert {:ok, %{"disposition" => "stale"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :provider_account_environment_state,
               account_environment: Map.delete(stale_report, :worker_id)
             })

    assert {:ok, {:stale, _account, _binding}} =
             ProviderAccounts.apply_environment_report(stale_report)

    assert {:error, %{code: :environment_identity_mismatch}} =
             ProviderAccounts.apply_environment_report(%{
               report
               | backend_kind: "different-backend"
             })

    assert {:error, %{code: :environment_identity_mismatch}} =
             ProviderAccounts.apply_environment_report(%{
               report
               | environment_id: "different-environment"
             })

    assert {:error, %{code: :environment_identity_mismatch}} =
             ProviderAccounts.apply_environment_report(%{
               report
               | incarnation: "different-incarnation"
             })

    assert {:ok, {_stopping, stop_environment}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "stopped",
               worker.connection_generation
             )

    assert stop_environment.backend_kind == "fake-account"
    assert stop_environment.environment_id == "environment-1"
    assert stop_environment.incarnation == "incarnation-1"

    assert [desired] = ProviderAccounts.desired_for_worker(worker.id)
    assert desired.expected_backend_kind == "fake-account"
    assert desired.expected_environment_id == "environment-1"
    assert desired.expected_incarnation == "incarnation-1"

    assert {:ok, {:stale, _account, _binding}} =
             ProviderAccounts.apply_environment_report(%{
               report
               | worker_generation: worker.connection_generation + 1,
                 physical_state: "degraded"
             })

    assert {:ok, current, current_binding} = ProviderAccounts.get_with_environment(account.id)
    assert current.environment_state == :pending
    assert current_binding.environment_id == "environment-1"

    assert {:ok, {next, replacement}} =
             ProviderAccounts.next_generation(account.id, worker.connection_generation)

    assert next.id == account.id
    assert next.credential_generation == account.credential_generation + 1
    assert replacement.environment_id == nil
    assert replacement.incarnation == nil

    assert {:ok, {:stale, _, _}} = ProviderAccounts.apply_environment_report(report)

    next_report = report(next, replacement, "environment-2", "incarnation-2")

    assert {:ok, {:applied, _, next_binding}} =
             ProviderAccounts.apply_environment_report(next_report)

    assert next_binding.environment_id == "environment-2"
    assert next_binding.incarnation == "incarnation-2"

    assert Enum.map(ProviderAccounts.events(account.id), & &1.event_type) == [
             "account_created",
             "environment_ensured",
             "environment_stopped_requested",
             "credential_generation_advanced",
             "environment_ensured"
           ]
  end

  test "backend observation without a physical identity never creates a partial command fence" do
    {:ok, worker} =
      WorkerStore.register("account-worker-missing", capabilities(), Ecto.UUID.generate())

    assert {:ok, {account, environment}} =
             ProviderAccounts.create(
               %{provider_key: "fake", worker_id: worker.id},
               worker.connection_generation
             )

    missing_report =
      account
      |> report(environment, nil, nil)
      |> Map.merge(%{physical_state: "missing", event_type: "environment_missing"})

    assert {:ok, {:applied, _, binding}} =
             ProviderAccounts.apply_environment_report(missing_report)

    assert binding.backend_kind == "fake-account"
    assert binding.environment_id == nil

    assert {:ok, {_updated, _environment}} =
             ProviderAccounts.begin_environment_operation(
               account.id,
               "available",
               worker.connection_generation
             )

    assert [desired] = ProviderAccounts.desired_for_worker(worker.id)
    assert desired.expected_backend_kind == nil
    assert desired.expected_environment_id == nil
    assert desired.expected_incarnation == nil
  end

  test "two accounts on one Worker retain isolated stable identities" do
    {:ok, worker} =
      WorkerStore.register("shared-account-worker", capabilities(), Ecto.UUID.generate())

    {:ok, {first, first_environment}} =
      ProviderAccounts.create(
        %{provider_key: "fake-a", worker_id: worker.id},
        worker.connection_generation
      )

    {:ok, {second, second_environment}} =
      ProviderAccounts.create(
        %{provider_key: "fake-b", worker_id: worker.id},
        worker.connection_generation
      )

    refute first.id == second.id

    assert {:ok, {:applied, _, _}} =
             ProviderAccounts.apply_environment_report(
               report(first, first_environment, "physical-a", "incarnation-a")
             )

    assert {:ok, _second, untouched} = ProviderAccounts.get_with_environment(second.id)
    assert untouched.environment_id == nil
    assert untouched.operation_id == second_environment.operation_id
  end

  defp report(account, environment, environment_id, incarnation) do
    %{
      provider_account_id: account.id,
      credential_generation: account.credential_generation,
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
      observed_at: DateTime.utc_now()
    }
  end

  defp capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "features" => ["provider_account_environments_v1"],
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
