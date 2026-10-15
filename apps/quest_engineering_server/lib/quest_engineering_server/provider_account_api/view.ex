defmodule QuestEngineering.Server.ProviderAccountApi.View do
  @moduledoc false

  alias QuestEngineering.Server.Product.ProviderAccounts

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
      capabilities: %{
        can_authorize_setup: can_authorize_setup?(value, environment)
      },
      authentication: authentication(value),
      environment: environment(environment),
      authenticated_at: iso(value.authenticated_at),
      last_validated_at: iso(value.last_validated_at),
      inserted_at: DateTime.to_iso8601(value.inserted_at),
      updated_at: DateTime.to_iso8601(value.updated_at)
    }
  end

  def setup_attempt(value, attention \\ nil) do
    %{
      id: value.id,
      provider_account_id: value.provider_account_id,
      setup_generation: value.setup_generation,
      credential_generation_before: value.credential_generation_before,
      credential_generation_after: value.credential_generation_after,
      environment_generation: value.environment_generation,
      worker_id: value.worker_id,
      worker_generation: value.worker_generation,
      authorized_authentication: %{
        state: value.authorization_auth_state,
        method: value.authorization_auth_method,
        configuration_identity: value.auth_configuration_identity,
        environment_policy: value.auth_environment_policy,
        evidence_identity: value.authorization_inspection_identity,
        inspected_at: iso(value.authorization_inspected_at)
      },
      state: value.state,
      invocation_state: value.invocation_state,
      process:
        if(value.process_generation,
          do: %{
            backend_process_id: value.process_backend_id,
            process_start_identity: value.process_start_identity,
            process_generation: value.process_generation,
            executable: value.process_executable
          },
          else: nil
        ),
      attention: attention(attention),
      preflight:
        authentication_evidence(
          value.preflight_state,
          value.preflight_method,
          value.preflight_configuration_identity,
          value.preflight_environment_policy,
          value.preflight_identity,
          value.preflight_inspected_at
        ),
      validation:
        authentication_evidence(
          value.validation_state,
          value.validation_method,
          value.validation_configuration_identity,
          value.validation_environment_policy,
          value.validation_identity,
          value.validation_inspected_at
        ),
      failure:
        if(value.failure_code,
          do: %{code: value.failure_code, message: value.failure_message},
          else: nil
        ),
      authorized_at: iso(value.inserted_at),
      invocation_requested_at: iso(value.invocation_requested_at),
      invocation_acknowledged_at: iso(value.invocation_acknowledged_at),
      interaction_required_at: iso(value.interaction_required_at),
      succeeded_at: iso(value.succeeded_at),
      cancelled_at: iso(value.cancelled_at),
      updated_at: iso(value.updated_at)
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

  defp authentication(value) do
    authentication_evidence(
      Atom.to_string(value.authentication_state),
      value.authentication_method,
      value.auth_configuration_identity,
      value.auth_environment_policy,
      value.auth_inspection_identity,
      value.auth_inspected_at
    )
  end

  defp authentication_evidence(nil, _method, _configuration, _policy, _identity, _at),
    do: nil

  defp authentication_evidence(state, method, configuration, policy, identity, at) do
    %{
      state: state,
      method: method,
      configuration_identity: configuration,
      environment_policy: policy,
      evidence_identity: identity,
      inspected_at: iso(at)
    }
  end

  defp can_authorize_setup?(value, environment) do
    value.lifecycle_state == :connected and value.environment_state == :available and
      ProviderAccounts.setup_authentication_eligible?(value) and not is_nil(environment) and
      environment.desired_environment_state == "available" and
      environment.physical_state == "available" and environment.canary_persisted == true
  end

  defp attention(nil), do: nil

  defp attention(value) do
    %{
      attention_id: value.id,
      request_generation: value.request_generation,
      kind: value.request["kind"],
      message: value.request["message"],
      response_state: value.response_state,
      delivery_state: value.delivery_state,
      delivery_attempt_id: value.delivery_attempt_id,
      surfaced_at: iso(value.surfaced_at)
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
