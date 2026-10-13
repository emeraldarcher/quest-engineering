defmodule QuestEngineering.Server.ProviderAccountApi.Service do
  @moduledoc "ProviderAccount Phase-A application service. No credential material is accepted."

  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  @create_keys ~w(provider_key display_name worker_id)
  @actions ~w(invalidate disconnect reconnect rotate start stop remove)

  def list, do: {:ok, ProviderAccounts.list()}
  def get(id), do: ProviderAccounts.get_with_environment(id)
  def events(id), do: {:ok, ProviderAccounts.events(id)}

  def create(params) when is_map(params) do
    with :ok <- exact_keys(params, @create_keys, ~w(provider_key worker_id)),
         {:ok, provider_key} <- required_string(params, "provider_key"),
         {:ok, worker_id} <- required_string(params, "worker_id"),
         {:ok, display_name} <- optional_string(params, "display_name"),
         generation = connected_generation(worker_id),
         {:ok, {account, environment}} <-
           ProviderAccounts.create(
             %{provider_key: provider_key, worker_id: worker_id, display_name: display_name},
             generation
           ) do
      dispatch(account, environment, "available")
      {:ok, account, environment}
    end
  end

  def create(_params), do: malformed(%{path: []})

  def action(id, action) when action in @actions do
    with {:ok, account, _environment} <- ProviderAccounts.get_with_environment(id) do
      perform_action(account, action, connected_generation(account.worker_id))
    end
  end

  def action(_id, _action), do: malformed(%{path: ["action"]})

  defp perform_action(account, "invalidate", _generation) do
    with {:ok, updated} <- ProviderAccounts.semantic_transition(account.id, :invalid),
         {:ok, _account, environment} <- ProviderAccounts.get_with_environment(account.id) do
      {:ok, updated, environment}
    end
  end

  defp perform_action(account, "disconnect", generation) do
    with {:ok, _updated} <- ProviderAccounts.semantic_transition(account.id, :disconnected),
         {:ok, {updated, environment}} <-
           ProviderAccounts.begin_environment_operation(account.id, "removed", generation) do
      dispatch(updated, environment, "removed")
      {:ok, updated, environment}
    end
  end

  defp perform_action(account, action, generation) when action in ["reconnect", "rotate"] do
    with {:ok, {updated, environment}} <- ProviderAccounts.next_generation(account.id, generation) do
      dispatch(updated, environment, "available")
      {:ok, updated, environment}
    end
  end

  defp perform_action(account, action, generation) when action in ["start", "stop", "remove"] do
    desired = %{"start" => "available", "stop" => "stopped", "remove" => "removed"}[action]

    with {:ok, {updated, environment}} <-
           ProviderAccounts.begin_environment_operation(account.id, desired, generation) do
      dispatch(updated, environment, desired)
      {:ok, updated, environment}
    end
  end

  defp dispatch(_account, %{worker_generation: nil}, _desired), do: :offline

  defp dispatch(account, environment, desired) do
    {expected_backend_kind, expected_environment_id, expected_incarnation} =
      ProviderAccounts.expected_physical_identity(environment)

    message =
      WorkerProtocol.provider_account_environment(
        account.worker_id,
        environment.worker_generation,
        %{
          provider_account_id: account.id,
          provider_key: account.provider_key,
          credential_generation: account.credential_generation,
          worker_generation: environment.worker_generation,
          operation_id: environment.operation_id,
          desired_state: desired,
          expected_backend_kind: expected_backend_kind,
          expected_environment_id: expected_environment_id,
          expected_incarnation: expected_incarnation
        }
      )

    WorkerConnections.send_protocol(account.worker_id, environment.worker_generation, message)
  end

  defp connected_generation(worker_id) do
    case WorkerConnections.lookup(worker_id) do
      {:ok, %{generation: generation}} -> generation
      _ -> nil
    end
  end

  defp exact_keys(params, allowed, required) do
    keys = Map.keys(params)

    cond do
      Enum.any?(keys, &(&1 not in allowed)) -> malformed(%{path: []})
      Enum.any?(required, &(not Map.has_key?(params, &1))) -> malformed(%{path: []})
      true -> :ok
    end
  end

  defp required_string(params, key) do
    case Map.get(params, key) do
      value when is_binary(value) and byte_size(value) > 0 -> {:ok, value}
      _ -> malformed(%{path: [key]})
    end
  end

  defp optional_string(params, key) do
    case Map.get(params, key) do
      nil -> {:ok, nil}
      value when is_binary(value) and byte_size(value) > 0 -> {:ok, value}
      _ -> malformed(%{path: [key]})
    end
  end

  defp malformed(details),
    do:
      {:error,
       %QuestEngineering.Server.ProductApi.Service.Error{code: :invalid_request, details: details}}
end
