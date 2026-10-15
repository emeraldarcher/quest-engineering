defmodule QuestEngineering.Core.Product.ProviderAccountId do
  @moduledoc """
  Stable Product-owned identity for a provider account.

  The value is opaque to the domain. Credential generation and physical
  environment incarnation are separate fencing dimensions and never replace it.
  """

  @opaque t :: String.t()

  @spec cast(String.t()) :: {:ok, t()} | :error
  def cast(value) when is_binary(value) and byte_size(value) > 0, do: {:ok, value}
  def cast(_value), do: :error
end

defmodule QuestEngineering.Core.Product.ProviderAccount do
  @moduledoc """
  Provider-neutral Product account identity and semantic lifecycle.

  This entity records no credential material. `credential_generation` is only
  a positive monotonic epoch used to fence Worker-local physical state.
  Environment and authentication readiness are deliberately independent: an
  available environment does not assert authentication or inference readiness.
  """

  alias QuestEngineering.Core.Product.ProviderAccountId

  @lifecycle_states [:connected, :invalid, :disconnected]
  @environment_states [
    :unassigned,
    :pending,
    :available,
    :stopped,
    :missing,
    :degraded,
    :removing,
    :removed
  ]
  @authentication_states [
    :not_checked,
    :authentication_required,
    :authenticated,
    :forbidden_auth_method,
    :inspection_unavailable,
    :incompatible_status
  ]
  @authentication_methods [
    "none",
    "provider_account",
    "injected_oauth_token",
    "api_key",
    "api_key_helper",
    "third_party"
  ]

  @enforce_keys [
    :id,
    :provider_key,
    :worker_id,
    :credential_generation,
    :lifecycle_state,
    :environment_state,
    :authentication_state,
    :inserted_at,
    :updated_at
  ]
  defstruct [
    :id,
    :provider_key,
    :display_name,
    :worker_id,
    :credential_generation,
    :lifecycle_state,
    :environment_state,
    :authentication_state,
    :authentication_method,
    :auth_configuration_identity,
    :auth_environment_policy,
    :auth_inspection_identity,
    :auth_inspected_at,
    :authenticated_at,
    :last_validated_at,
    :inserted_at,
    :updated_at
  ]

  @type lifecycle_state :: :connected | :invalid | :disconnected
  @type environment_state ::
          :unassigned
          | :pending
          | :available
          | :stopped
          | :missing
          | :degraded
          | :removing
          | :removed
  @type authentication_state ::
          :not_checked
          | :authentication_required
          | :authenticated
          | :forbidden_auth_method
          | :inspection_unavailable
          | :incompatible_status
  @type t :: %__MODULE__{
          id: ProviderAccountId.t(),
          provider_key: String.t(),
          display_name: String.t() | nil,
          worker_id: String.t(),
          credential_generation: pos_integer(),
          lifecycle_state: lifecycle_state(),
          environment_state: environment_state(),
          authentication_state: authentication_state(),
          authentication_method: String.t() | nil,
          auth_configuration_identity: String.t() | nil,
          auth_environment_policy: String.t() | nil,
          auth_inspection_identity: String.t() | nil,
          auth_inspected_at: DateTime.t() | nil,
          authenticated_at: DateTime.t() | nil,
          last_validated_at: DateTime.t() | nil,
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @spec lifecycle_states() :: [lifecycle_state()]
  def lifecycle_states, do: @lifecycle_states

  @spec environment_states() :: [environment_state()]
  def environment_states, do: @environment_states

  @spec authentication_states() :: [authentication_state()]
  def authentication_states, do: @authentication_states

  @spec valid?(t()) :: boolean()
  def valid?(%__MODULE__{} = account) do
    Enum.all?([
      match?({:ok, _}, ProviderAccountId.cast(account.id)),
      present?(account.provider_key),
      present?(account.worker_id),
      positive_integer?(account.credential_generation),
      account.lifecycle_state in @lifecycle_states,
      account.environment_state in @environment_states,
      account.authentication_state in @authentication_states,
      valid_authentication_evidence?(account),
      match?(%DateTime{}, account.inserted_at),
      match?(%DateTime{}, account.updated_at)
    ])
  end

  @doc "Records exact validated provider-account evidence without changing the physical environment lifecycle."
  @spec authenticated(t(), map(), DateTime.t()) :: t()
  def authenticated(%__MODULE__{} = account, evidence, %DateTime{} = now)
      when is_map(evidence) do
    %{
      account
      | credential_generation: account.credential_generation + 1,
        lifecycle_state: :connected,
        authentication_state: :authenticated,
        authentication_method: "provider_account",
        auth_configuration_identity: Map.fetch!(evidence, :configuration_identity),
        auth_environment_policy: Map.fetch!(evidence, :environment_policy),
        auth_inspection_identity: Map.fetch!(evidence, :inspection_identity),
        auth_inspected_at: Map.fetch!(evidence, :inspected_at),
        authenticated_at: Map.fetch!(evidence, :inspected_at),
        last_validated_at: Map.fetch!(evidence, :inspected_at),
        updated_at: now
    }
  end

  @doc "Starts a new credential epoch; the stable account identity is unchanged."
  @spec next_credential_generation(t(), DateTime.t()) :: t()
  def next_credential_generation(%__MODULE__{} = account, %DateTime{} = now) do
    %{
      account
      | credential_generation: account.credential_generation + 1,
        lifecycle_state: :connected,
        environment_state: :pending,
        authentication_state: :not_checked,
        authentication_method: nil,
        auth_configuration_identity: nil,
        auth_environment_policy: nil,
        auth_inspection_identity: nil,
        auth_inspected_at: nil,
        authenticated_at: nil,
        last_validated_at: nil,
        updated_at: now
    }
  end

  @spec transition(t(), lifecycle_state(), DateTime.t()) ::
          {:ok, t()} | {:error, :invalid_transition}
  def transition(%__MODULE__{} = account, target, %DateTime{} = now)
      when target in @lifecycle_states do
    if allowed_transition?(account.lifecycle_state, target) do
      environment_state =
        if target == :disconnected, do: :removing, else: account.environment_state

      {:ok,
       %{
         account
         | lifecycle_state: target,
           environment_state: environment_state,
           authentication_state: :not_checked,
           authentication_method: nil,
           auth_configuration_identity: nil,
           auth_environment_policy: nil,
           auth_inspection_identity: nil,
           auth_inspected_at: nil,
           authenticated_at: nil,
           last_validated_at: nil,
           updated_at: now
       }}
    else
      {:error, :invalid_transition}
    end
  end

  def transition(_account, _target, _now), do: {:error, :invalid_transition}

  defp valid_authentication_evidence?(%{authentication_state: :not_checked} = account) do
    Enum.all?(
      [
        account.authentication_method,
        account.auth_configuration_identity,
        account.auth_environment_policy,
        account.auth_inspection_identity,
        account.auth_inspected_at,
        account.authenticated_at,
        account.last_validated_at
      ],
      &is_nil/1
    )
  end

  defp valid_authentication_evidence?(account) do
    present?(account.auth_configuration_identity) and
      present?(account.auth_environment_policy) and present?(account.auth_inspection_identity) and
      match?(%DateTime{}, account.auth_inspected_at) and
      match?(%DateTime{}, account.last_validated_at) and valid_authentication_pair?(account) and
      ((account.authentication_state == :authenticated and
          match?(%DateTime{}, account.authenticated_at)) or
         (account.authentication_state != :authenticated and is_nil(account.authenticated_at)))
  end

  defp valid_authentication_pair?(%{
         authentication_state: :authentication_required,
         authentication_method: "none"
       }),
       do: true

  defp valid_authentication_pair?(%{
         authentication_state: :authenticated,
         authentication_method: "provider_account"
       }),
       do: true

  defp valid_authentication_pair?(%{
         authentication_state: :forbidden_auth_method,
         authentication_method: method
       }),
       do: method in ~w(injected_oauth_token api_key api_key_helper third_party)

  defp valid_authentication_pair?(%{
         authentication_state: :inspection_unavailable,
         authentication_method: nil
       }),
       do: true

  defp valid_authentication_pair?(%{
         authentication_state: :incompatible_status,
         authentication_method: method
       }),
       do: is_nil(method) or method in @authentication_methods

  defp valid_authentication_pair?(_account), do: false

  defp present?(value), do: is_binary(value) and value != ""
  defp positive_integer?(value), do: is_integer(value) and value > 0

  defp allowed_transition?(state, state), do: true
  defp allowed_transition?(:connected, target), do: target in [:invalid, :disconnected]
  defp allowed_transition?(:invalid, target), do: target in [:connected, :disconnected]
  defp allowed_transition?(:disconnected, target), do: target == :connected
end
