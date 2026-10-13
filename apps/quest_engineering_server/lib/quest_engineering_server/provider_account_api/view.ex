defmodule QuestEngineering.Server.ProviderAccountApi.View do
  @moduledoc false

  def account(value, environment \\ nil) do
    %{
      id: value.id,
      provider_key: value.provider_key,
      display_name: value.display_name,
      worker_id: value.worker_id,
      credential_generation: value.credential_generation,
      lifecycle_state: Atom.to_string(value.lifecycle_state),
      readiness: %{
        semantic: semantic_readiness(value.lifecycle_state),
        environment: Atom.to_string(value.environment_state),
        authentication: Atom.to_string(value.authentication_state),
        inference: "not_evaluated"
      },
      environment: environment(environment),
      inserted_at: DateTime.to_iso8601(value.inserted_at),
      updated_at: DateTime.to_iso8601(value.updated_at)
    }
  end

  def event(value) do
    %{
      id: value.id,
      provider_account_id: value.provider_account_id,
      credential_generation: value.credential_generation,
      worker_id: value.worker_id,
      worker_generation: value.worker_generation,
      operation_id: value.operation_id,
      event_type: value.event_type,
      lifecycle_state: value.lifecycle_state,
      physical_state: value.physical_state,
      backend_kind: value.backend_kind,
      environment_id: value.environment_id,
      incarnation: value.incarnation,
      error_code: value.error_code,
      details: value.details,
      occurred_at: DateTime.to_iso8601(value.occurred_at)
    }
  end

  defp environment(nil), do: nil

  defp environment(value) do
    %{
      credential_generation: value.credential_generation,
      worker_id: value.worker_id,
      worker_generation: value.worker_generation,
      operation_id: value.operation_id,
      desired_state: value.desired_environment_state,
      backend_kind: value.backend_kind,
      environment_id: value.environment_id,
      incarnation: value.incarnation,
      physical_state: value.physical_state,
      durable_canary_persisted: value.canary_persisted,
      last_error: error(value),
      observed_at: iso(value.observed_at)
    }
  end

  defp error(%{last_error_code: nil}), do: nil

  defp error(value),
    do: %{code: value.last_error_code, message: value.last_error_message}

  defp semantic_readiness(:connected), do: "semantically_connected"
  defp semantic_readiness(:invalid), do: "semantically_invalid"
  defp semantic_readiness(:disconnected), do: "semantically_disconnected"

  defp iso(nil), do: nil
  defp iso(value), do: DateTime.to_iso8601(value)
end
