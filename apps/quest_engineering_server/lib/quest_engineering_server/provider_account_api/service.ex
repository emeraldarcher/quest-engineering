defmodule QuestEngineering.Server.ProviderAccountApi.Service do
  @moduledoc "ProviderAccount Phase-A application service. No credential material is accepted."

  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  @create_keys ~w(provider_key display_name worker_id)
  @actions ~w(invalidate disconnect reconnect rotate start stop remove)

  def list, do: {:ok, ProviderAccounts.list()}
  def get(id), do: ProviderAccounts.get_with_environment(id)
  def events(id), do: {:ok, ProviderAccounts.events(id)}
  def setup_attempts(id), do: {:ok, ProviderAccountSetups.list(id)}

  def authorize_setup(id, %{"request_id" => request_id, "confirmed" => true} = params)
      when map_size(params) == 2 and is_binary(request_id) and request_id != "" do
    with {:ok, {attempt, _authorization, idempotent?}} <-
           ProviderAccountSetups.authorize(id, request_id),
         :ok <- ProviderAccountSetups.deliver(attempt) do
      {:ok, attempt, ProviderAccountSetups.attention_for_attempt(attempt.id), idempotent?}
    end
  end

  def authorize_setup(_id, _params), do: malformed(%{path: ["request_id"]})

  def setup_interaction(id, attempt_id, generation, attention_id),
    do: ProviderAccountSetups.interaction(id, attempt_id, generation, attention_id)

  def respond_setup(id, attempt_id, params) when is_map(params) do
    with :ok <-
           exact_keys(
             params,
             ~w(setup_generation attention_id request_id value),
             ~w(setup_generation attention_id request_id value)
           ),
         generation when is_integer(generation) and generation > 0 <- params["setup_generation"],
         {:ok, attention_id} <- required_string(params, "attention_id"),
         {:ok, request_id} <- required_string(params, "request_id"),
         value when is_binary(value) and byte_size(value) <= 8_192 <- params["value"],
         {:ok, attempt, attention} <-
           ProviderAccountSetups.respond(
             id,
             attempt_id,
             generation,
             attention_id,
             request_id,
             value
           ) do
      {:ok, attempt, attention}
    else
      {:error, reason} -> {:error, reason}
      _ -> malformed(%{path: []})
    end
  end

  def respond_setup(_id, _attempt_id, _params), do: malformed(%{path: []})

  def cancel_setup(id, attempt_id, %{"request_id" => request_id} = params)
      when map_size(params) == 1 and is_binary(request_id) and request_id != "" do
    with {:ok, attempt} <- ProviderAccountSetups.cancel(id, attempt_id, request_id) do
      {:ok, attempt, ProviderAccountSetups.attention_for_attempt(attempt.id)}
    end
  end

  def cancel_setup(_id, _attempt_id, _params), do: malformed(%{path: ["request_id"]})

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
      dispatch(account, environment)
      {:ok, account, environment}
    end
  end

  def create(_params), do: malformed(%{path: []})

  def action(id, action) when action in @actions do
    with {:ok, account, _environment} <- ProviderAccounts.get_with_environment(id),
         false <- ProviderAccountSetups.active_for_account?(id) do
      perform_action(account, action, connected_generation(account.worker_id))
    else
      true ->
        {:error,
         %{
           code: :provider_account_setup_active,
           details: %{provider_account_id: id, action: action}
         }}

      {:error, reason} ->
        {:error, reason}
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
    with {:ok, {updated, environment}} <- ProviderAccounts.disconnect(account.id, generation) do
      dispatch(updated, environment)
      {:ok, updated, environment}
    end
  end

  defp perform_action(account, action, generation) when action in ["reconnect", "rotate"] do
    with {:ok, {updated, environment}} <- ProviderAccounts.next_generation(account.id, generation) do
      dispatch(updated, environment)
      {:ok, updated, environment}
    end
  end

  defp perform_action(account, action, generation) when action in ["start", "stop", "remove"] do
    desired = %{"start" => "available", "stop" => "stopped", "remove" => "removed"}[action]

    with {:ok, {updated, environment}} <-
           ProviderAccounts.begin_environment_operation(account.id, desired, generation) do
      dispatch(updated, environment)
      {:ok, updated, environment}
    end
  end

  defp dispatch(_account, %{worker_generation: nil}), do: :offline

  defp dispatch(account, environment) do
    {expected_backend_kind, expected_environment_id, expected_incarnation} =
      ProviderAccounts.expected_physical_identity(environment)

    message =
      WorkerProtocol.provider_account_environment(
        account.worker_id,
        environment.worker_generation,
        %{
          provider_account_id: account.id,
          provider_key: account.provider_key,
          credential_generation: environment.credential_generation,
          worker_generation: environment.worker_generation,
          operation_id: environment.operation_id,
          desired_state: environment.desired_environment_state,
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
