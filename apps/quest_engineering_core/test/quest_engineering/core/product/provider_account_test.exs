defmodule QuestEngineering.Core.Product.ProviderAccountTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ProviderAccount

  test "stable identity is separate from positive monotonic credential generation and readiness layers" do
    now = ~U[2026-10-14 00:00:00.000000Z]

    account = %ProviderAccount{
      id: "account-1",
      provider_key: "provider-neutral",
      display_name: "Primary",
      worker_id: "worker-1",
      credential_generation: 1,
      lifecycle_state: :connected,
      environment_state: :available,
      authentication_state: :not_checked,
      inserted_at: now,
      updated_at: now
    }

    assert ProviderAccount.valid?(account)
    next = ProviderAccount.next_credential_generation(account, DateTime.add(now, 1))
    assert next.id == account.id
    assert next.worker_id == account.worker_id
    assert next.credential_generation == 2
    assert next.lifecycle_state == :connected
    assert next.environment_state == :pending
    assert next.authentication_state == :not_checked
    refute Map.has_key?(Map.from_struct(next), :credentials)
  end

  test "validated setup advances credentials without coupling authentication to environment incarnation" do
    now = ~U[2026-10-15 00:00:00.000000Z]

    account = %ProviderAccount{
      id: "account-authenticated",
      provider_key: "fake",
      display_name: nil,
      worker_id: "worker-authenticated",
      credential_generation: 4,
      lifecycle_state: :connected,
      environment_state: :available,
      authentication_state: :validating,
      inserted_at: now,
      updated_at: now
    }

    authenticated = ProviderAccount.authenticated(account, DateTime.add(now, 1))

    assert authenticated.credential_generation == 5
    assert authenticated.environment_state == :available
    assert authenticated.authentication_state == :authenticated
    assert authenticated.authenticated_at == DateTime.add(now, 1)
    assert authenticated.last_validated_at == DateTime.add(now, 1)
    assert ProviderAccount.valid?(authenticated)
  end

  test "semantic invalidation and disconnection never claim authentication or physical readiness" do
    now = ~U[2026-10-14 00:00:00.000000Z]

    account = %ProviderAccount{
      id: "account-1",
      provider_key: "fake",
      worker_id: "worker-1",
      credential_generation: 1,
      lifecycle_state: :connected,
      environment_state: :available,
      authentication_state: :not_checked,
      inserted_at: now,
      updated_at: now
    }

    assert {:ok, invalid} = ProviderAccount.transition(account, :invalid, now)
    assert invalid.environment_state == :available
    assert invalid.authentication_state == :not_checked

    assert {:ok, disconnected} = ProviderAccount.transition(invalid, :disconnected, now)
    assert disconnected.environment_state == :removing
    assert disconnected.authentication_state == :not_checked
  end
end
