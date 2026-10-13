defmodule QuestEngineering.Server.Product.ProviderAccounts do
  @moduledoc """
  PostgreSQL authority for Product ProviderAccounts and their Worker-local environments.

  Every Worker observation is fenced by account ID, credential generation,
  Worker ID, Worker connection generation, operation ID, and (once known)
  physical environment ID/incarnation.
  """

  import Ecto.Query

  alias QuestEngineering.Core.Product.ProviderAccount, as: DomainAccount
  alias QuestEngineering.Server.Persistence.ProviderAccount
  alias QuestEngineering.Server.Persistence.ProviderAccountEnvironment
  alias QuestEngineering.Server.Persistence.ProviderAccountLifecycleEvent
  alias QuestEngineering.Server.Repo

  @type error :: %{code: atom(), details: map()}

  def list do
    ProviderAccount
    |> order_by([account], asc: account.inserted_at, asc: account.id)
    |> Repo.all()
    |> Enum.map(&to_domain/1)
  end

  def get(id) when is_binary(id) do
    case Repo.get(ProviderAccount, id) do
      nil -> {:error, %{code: :not_found, details: %{provider_account_id: id}}}
      record -> {:ok, to_domain(record)}
    end
  end

  def get_with_environment(id) when is_binary(id) do
    with {:ok, account} <- get(id) do
      {:ok, account, Repo.get(ProviderAccountEnvironment, id)}
    end
  end

  def events(id) when is_binary(id) do
    ProviderAccountLifecycleEvent
    |> where([event], event.provider_account_id == ^id)
    |> order_by([event], asc: event.inserted_at, asc: event.id)
    |> Repo.all()
  end

  def desired_for_worker(worker_id) when is_binary(worker_id) do
    from(account in ProviderAccount,
      join: environment in ProviderAccountEnvironment,
      on: environment.provider_account_id == account.id,
      where: account.worker_id == ^worker_id,
      order_by: [asc: account.id],
      select: {account, environment}
    )
    |> Repo.all()
    |> Enum.map(fn {account, environment} -> desired_payload(account, environment) end)
  end

  @doc "Re-fences all account operations to one newly authoritative Worker generation."
  def prepare_worker_reconciliation(worker_id, worker_generation) do
    Repo.transaction(fn ->
      accounts =
        from(account in ProviderAccount,
          join: environment in ProviderAccountEnvironment,
          on: environment.provider_account_id == account.id,
          where: account.worker_id == ^worker_id,
          order_by: [asc: account.id],
          lock: "FOR UPDATE",
          select: {account, environment}
        )
        |> Repo.all()

      Enum.map(accounts, &refence_environment(&1, worker_generation))
    end)
    |> unwrap_transaction()
  end

  def create(attrs, worker_generation) when is_map(attrs) do
    now = DateTime.utc_now()
    account_id = Ecto.UUID.generate()
    operation_id = Ecto.UUID.generate()

    account_attrs = %{
      id: account_id,
      provider_key: fetch(attrs, :provider_key),
      display_name: fetch(attrs, :display_name),
      worker_id: fetch(attrs, :worker_id),
      credential_generation: 1,
      lifecycle_state: "connected",
      environment_state: "pending",
      authentication_state: "not_checked"
    }

    Repo.transaction(fn ->
      with {:ok, account} <-
             %ProviderAccount{}
             |> ProviderAccount.changeset(account_attrs)
             |> Repo.insert(),
           {:ok, environment} <-
             %ProviderAccountEnvironment{}
             |> ProviderAccountEnvironment.changeset(%{
               provider_account_id: account.id,
               credential_generation: 1,
               worker_id: account.worker_id,
               worker_generation: worker_generation,
               operation_id: operation_id,
               physical_state: "pending"
             })
             |> Repo.insert(),
           {:ok, _event} <-
             insert_event(account, environment, "account_created", now, %{}) do
        {to_domain(account), environment}
      else
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> unwrap_transaction()
  end

  def semantic_transition(id, target) when target in [:connected, :invalid, :disconnected] do
    Repo.transaction(fn ->
      with {:ok, account} <- locked_account(id),
           {:ok, next} <- DomainAccount.transition(to_domain(account), target, DateTime.utc_now()) do
        persist_semantic_transition(account, next, target)
      else
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> unwrap_transaction()
  end

  @doc "Begins a new positive monotonic credential epoch and replacement environment operation."
  def next_generation(id, worker_generation) do
    Repo.transaction(fn ->
      with {:ok, account} <- locked_account(id),
           next = DomainAccount.next_credential_generation(to_domain(account), DateTime.utc_now()),
           operation_id = Ecto.UUID.generate(),
           {:ok, updated} <-
             account
             |> ProviderAccount.changeset(%{
               credential_generation: next.credential_generation,
               lifecycle_state: "connected",
               environment_state: "pending",
               authentication_state: "not_checked"
             })
             |> Repo.update(),
           {:ok, environment} <-
             upsert_environment(updated, operation_id, worker_generation, "pending"),
           {:ok, _event} <-
             insert_event(
               updated,
               environment,
               "credential_generation_advanced",
               DateTime.utc_now(),
               %{}
             ) do
        {to_domain(updated), environment}
      else
        {:error, reason} -> Repo.rollback(reason)
      end
    end)
    |> unwrap_transaction()
  end

  def begin_environment_operation(id, desired_state, worker_generation)
      when desired_state in ["available", "stopped", "removed"] do
    Repo.transaction(fn ->
      begin_locked_environment_operation(id, desired_state, worker_generation)
    end)
    |> unwrap_transaction()
  end

  @doc "Applies an exactly-fenced Worker report; stale reports are acknowledged without mutation."
  def apply_environment_report(report) when is_map(report) do
    Repo.transaction(fn -> apply_locked_environment_report(report) end)
    |> unwrap_transaction()
  end

  defp refence_environment({account, environment}, worker_generation) do
    updated =
      environment
      |> ProviderAccountEnvironment.changeset(%{
        worker_generation: worker_generation,
        operation_id: Ecto.UUID.generate()
      })
      |> Repo.update!()

    case insert_event(
           account,
           updated,
           "worker_generation_reconciled",
           DateTime.utc_now(),
           %{}
         ) do
      {:ok, _event} -> desired_payload(account, updated)
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp persist_semantic_transition(account, next, target) do
    with {:ok, updated} <-
           account
           |> ProviderAccount.changeset(%{
             lifecycle_state: Atom.to_string(next.lifecycle_state),
             environment_state: Atom.to_string(next.environment_state),
             authentication_state: "not_checked"
           })
           |> Repo.update(),
         {:ok, _event} <-
           insert_event(
             updated,
             Repo.get(ProviderAccountEnvironment, account.id),
             "account_#{target}",
             DateTime.utc_now(),
             %{}
           ) do
      to_domain(updated)
    else
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp begin_locked_environment_operation(id, desired_state, worker_generation) do
    case locked_account(id) do
      {:ok, account} -> persist_environment_operation(account, desired_state, worker_generation)
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp persist_environment_operation(account, desired_state, worker_generation) do
    operation_id = Ecto.UUID.generate()
    pending = if desired_state == "removed", do: "removing", else: "pending"

    identity_mode =
      case Repo.get(ProviderAccountEnvironment, account.id) do
        %{physical_state: "removed"} when desired_state == "available" -> :reset
        _environment -> :preserve
      end

    with {:ok, environment} <-
           upsert_environment(account, operation_id, worker_generation, pending, identity_mode),
         {:ok, updated} <-
           account
           |> ProviderAccount.changeset(%{environment_state: pending})
           |> Repo.update(),
         {:ok, _event} <-
           insert_event(
             updated,
             environment,
             "environment_#{desired_state}_requested",
             DateTime.utc_now(),
             %{desired_state: desired_state}
           ) do
      {to_domain(updated), environment}
    else
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp apply_locked_environment_report(report) do
    id = fetch(report, :provider_account_id)

    with {:ok, account} <- locked_account(id),
         {:ok, environment} <- locked_environment(id) do
      apply_fenced_environment_report(account, environment, report)
    else
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp apply_fenced_environment_report(account, environment, report) do
    if current_report?(account, environment, report) do
      apply_current_environment_report(account, environment, report)
    else
      {:stale, to_domain(account), environment}
    end
  end

  defp apply_current_environment_report(account, environment, report) do
    backend_kind = fetch(report, :backend_kind)
    environment_id = fetch(report, :environment_id)
    incarnation = fetch(report, :incarnation)

    if physical_identity_conflict?(environment, backend_kind, environment_id, incarnation) do
      Repo.rollback(%{
        code: :environment_identity_mismatch,
        details: %{provider_account_id: account.id}
      })
    else
      persist_environment_report(account, environment, report, environment_id, incarnation)
    end
  end

  defp persist_environment_report(account, environment, report, environment_id, incarnation) do
    physical_state = fetch(report, :physical_state)
    observed_at = parse_timestamp(fetch(report, :observed_at))
    canary_persisted = fetch(report, :canary_persisted) == true

    with {:ok, updated_environment} <-
           environment
           |> ProviderAccountEnvironment.changeset(%{
             backend_kind: fetch(report, :backend_kind),
             environment_id: environment_id,
             incarnation: incarnation,
             physical_state: physical_state,
             last_error_code: fetch(report, :error_code),
             last_error_message: fetch(report, :error_message),
             canary_persisted: canary_persisted,
             observed_at: observed_at
           })
           |> Repo.update(),
         {:ok, updated_account} <-
           account
           |> ProviderAccount.changeset(%{environment_state: physical_state})
           |> Repo.update(),
         {:ok, _event} <-
           insert_event(
             updated_account,
             updated_environment,
             fetch(report, :event_type) || "environment_observed",
             observed_at,
             %{report: "credential_free", canary_persisted: canary_persisted}
           ) do
      {:applied, to_domain(updated_account), updated_environment}
    else
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp current_report?(account, environment, report) do
    account.worker_id == fetch(report, :worker_id) and
      account.credential_generation == fetch(report, :credential_generation) and
      environment.worker_id == fetch(report, :worker_id) and
      environment.credential_generation == fetch(report, :credential_generation) and
      environment.worker_generation == fetch(report, :worker_generation) and
      environment.operation_id == fetch(report, :operation_id)
  end

  defp physical_identity_conflict?(environment, backend_kind, environment_id, incarnation) do
    (not is_nil(environment.backend_kind) and environment.backend_kind != backend_kind) or
      (not is_nil(environment.environment_id) and
         environment.environment_id != environment_id) or
      (not is_nil(environment.incarnation) and environment.incarnation != incarnation)
  end

  defp upsert_environment(
         account,
         operation_id,
         worker_generation,
         state,
         identity_mode \\ :reset
       ) do
    attrs =
      %{
        provider_account_id: account.id,
        credential_generation: account.credential_generation,
        worker_id: account.worker_id,
        worker_generation: worker_generation,
        operation_id: operation_id,
        physical_state: state,
        last_error_code: nil,
        last_error_message: nil,
        canary_persisted: false,
        observed_at: nil
      }
      |> maybe_reset_physical_identity(identity_mode)

    case Repo.get(ProviderAccountEnvironment, account.id) do
      nil -> %ProviderAccountEnvironment{}
      environment -> environment
    end
    |> ProviderAccountEnvironment.changeset(attrs)
    |> Repo.insert_or_update()
  end

  defp maybe_reset_physical_identity(attrs, :reset),
    do: Map.merge(attrs, %{backend_kind: nil, environment_id: nil, incarnation: nil})

  defp maybe_reset_physical_identity(attrs, :preserve), do: attrs

  defp insert_event(account, environment, event_type, occurred_at, details) do
    environment = environment || %ProviderAccountEnvironment{}

    %ProviderAccountLifecycleEvent{}
    |> ProviderAccountLifecycleEvent.changeset(%{
      id: Ecto.UUID.generate(),
      provider_account_id: account.id,
      credential_generation: account.credential_generation,
      worker_id: account.worker_id,
      worker_generation: environment.worker_generation,
      operation_id: environment.operation_id || Ecto.UUID.generate(),
      event_type: event_type,
      lifecycle_state: account.lifecycle_state,
      physical_state: environment.physical_state || account.environment_state,
      backend_kind: environment.backend_kind,
      environment_id: environment.environment_id,
      incarnation: environment.incarnation,
      error_code: environment.last_error_code,
      details: details,
      occurred_at: occurred_at
    })
    |> Repo.insert(on_conflict: :nothing)
  end

  defp locked_account(id) do
    case Repo.one(from account in ProviderAccount, where: account.id == ^id, lock: "FOR UPDATE") do
      nil -> {:error, %{code: :not_found, details: %{provider_account_id: id}}}
      account -> {:ok, account}
    end
  end

  defp locked_environment(id) do
    query =
      from environment in ProviderAccountEnvironment,
        where: environment.provider_account_id == ^id,
        lock: "FOR UPDATE"

    case Repo.one(query) do
      nil -> {:error, %{code: :not_found, details: %{provider_account_id: id}}}
      environment -> {:ok, environment}
    end
  end

  defp desired_payload(account, environment) do
    desired_state =
      case environment.physical_state do
        state when state in ["removing", "removed"] -> "removed"
        "stopped" -> "stopped"
        _ -> "available"
      end

    {expected_backend_kind, expected_environment_id, expected_incarnation} =
      expected_physical_identity(environment)

    %{
      provider_account_id: account.id,
      provider_key: account.provider_key,
      credential_generation: account.credential_generation,
      worker_id: account.worker_id,
      worker_generation: environment.worker_generation,
      operation_id: environment.operation_id,
      desired_state: desired_state,
      expected_backend_kind: expected_backend_kind,
      expected_environment_id: expected_environment_id,
      expected_incarnation: expected_incarnation
    }
  end

  def expected_physical_identity(%{
        backend_kind: backend_kind,
        environment_id: environment_id,
        incarnation: incarnation
      })
      when is_binary(backend_kind) and is_binary(environment_id) and is_binary(incarnation),
      do: {backend_kind, environment_id, incarnation}

  def expected_physical_identity(_environment), do: {nil, nil, nil}

  defp to_domain(record) do
    %DomainAccount{
      id: record.id,
      provider_key: record.provider_key,
      display_name: record.display_name,
      worker_id: record.worker_id,
      credential_generation: record.credential_generation,
      lifecycle_state: lifecycle_state(record.lifecycle_state),
      environment_state: environment_state(record.environment_state),
      authentication_state: authentication_state(record.authentication_state),
      inserted_at: record.inserted_at,
      updated_at: record.updated_at
    }
  end

  defp lifecycle_state("connected"), do: :connected
  defp lifecycle_state("invalid"), do: :invalid
  defp lifecycle_state("disconnected"), do: :disconnected

  defp environment_state("unassigned"), do: :unassigned
  defp environment_state("pending"), do: :pending
  defp environment_state("available"), do: :available
  defp environment_state("stopped"), do: :stopped
  defp environment_state("missing"), do: :missing
  defp environment_state("degraded"), do: :degraded
  defp environment_state("removing"), do: :removing
  defp environment_state("removed"), do: :removed

  defp authentication_state("not_checked"), do: :not_checked

  defp parse_timestamp(%DateTime{} = value), do: value

  defp parse_timestamp(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, timestamp, _offset} -> timestamp
      _ -> DateTime.utc_now()
    end
  end

  defp parse_timestamp(_value), do: DateTime.utc_now()

  defp fetch(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp unwrap_transaction({:ok, value}), do: {:ok, value}
  defp unwrap_transaction({:error, reason}), do: {:error, reason}
end
