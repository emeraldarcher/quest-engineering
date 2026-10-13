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
    :setup_authorized,
    :setup_in_progress,
    :interaction_required,
    :validating,
    :authenticated,
    :authentication_required,
    :inspection_unavailable,
    :invalid
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
          | :setup_authorized
          | :setup_in_progress
          | :interaction_required
          | :validating
          | :authenticated
          | :authentication_required
          | :inspection_unavailable
          | :invalid
  @type t :: %__MODULE__{
          id: ProviderAccountId.t(),
          provider_key: String.t(),
          display_name: String.t() | nil,
          worker_id: String.t(),
          credential_generation: pos_integer(),
          lifecycle_state: lifecycle_state(),
          environment_state: environment_state(),
          authentication_state: authentication_state(),
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
      match?(%DateTime{}, account.inserted_at),
      match?(%DateTime{}, account.updated_at)
    ])
  end

  @doc "Records a validated setup result without changing the physical environment lifecycle."
  @spec authenticated(t(), DateTime.t()) :: t()
  def authenticated(%__MODULE__{} = account, %DateTime{} = now) do
    %{
      account
      | credential_generation: account.credential_generation + 1,
        lifecycle_state: :connected,
        authentication_state: :authenticated,
        authenticated_at: now,
        last_validated_at: now,
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
           updated_at: now
       }}
    else
      {:error, :invalid_transition}
    end
  end

  def transition(_account, _target, _now), do: {:error, :invalid_transition}

  defp present?(value), do: is_binary(value) and value != ""
  defp positive_integer?(value), do: is_integer(value) and value > 0

  defp allowed_transition?(state, state), do: true
  defp allowed_transition?(:connected, target), do: target in [:invalid, :disconnected]
  defp allowed_transition?(:invalid, target), do: target in [:connected, :disconnected]
  defp allowed_transition?(:disconnected, target), do: target == :connected
end
