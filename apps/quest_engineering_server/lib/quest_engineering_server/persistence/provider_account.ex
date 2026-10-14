defmodule QuestEngineering.Server.Persistence.ProviderAccount do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_accounts" do
    field :provider_key, :string
    field :display_name, :string
    field :worker_id, :string
    field :credential_generation, :integer
    field :lifecycle_state, :string
    field :environment_state, :string
    field :authentication_state, :string
    field :authentication_method, :string
    field :auth_configuration_identity, :string
    field :auth_environment_policy, :string
    field :auth_inspection_identity, :string
    field :auth_inspected_at, :utc_datetime_usec
    field :authenticated_at, :utc_datetime_usec
    field :last_validated_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(record, attrs) do
    record
    |> cast(attrs, [
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
      :last_validated_at
    ])
    |> validate_required([
      :id,
      :provider_key,
      :worker_id,
      :credential_generation,
      :lifecycle_state,
      :environment_state,
      :authentication_state
    ])
    |> validate_number(:credential_generation, greater_than: 0)
    |> validate_inclusion(:lifecycle_state, ~w(connected invalid disconnected))
    |> validate_inclusion(
      :environment_state,
      ~w(unassigned pending available stopped missing degraded removing removed)
    )
    |> validate_inclusion(
      :authentication_state,
      ~w(not_checked authentication_required authenticated forbidden_auth_method inspection_unavailable incompatible_status)
    )
    |> validate_inclusion(
      :authentication_method,
      ~w(none provider_account injected_oauth_token api_key api_key_helper third_party)
    )
    |> foreign_key_constraint(:worker_id)
    |> check_constraint(:authentication_state,
      name: :provider_accounts_authentication_state_valid
    )
    |> check_constraint(:authentication_method,
      name: :provider_accounts_authentication_method_valid
    )
    |> check_constraint(:authentication_state,
      name: :provider_accounts_authentication_method_matches_state
    )
    |> check_constraint(:authentication_state,
      name: :provider_accounts_authentication_evidence_complete
    )
    |> check_constraint(:authentication_state,
      name: :provider_accounts_authentication_timestamps
    )
  end
end

defmodule QuestEngineering.Server.Persistence.ProviderAccountEnvironment do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:provider_account_id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_environments" do
    field :credential_generation, :integer
    field :worker_id, :string
    field :worker_generation, :integer
    field :operation_id, :string
    field :desired_environment_state, :string
    field :backend_kind, :string
    field :environment_id, :string
    field :incarnation, :string
    field :physical_state, :string
    field :last_error_code, :string
    field :last_error_message, :string
    field :canary_persisted, :boolean, default: false
    field :observed_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(record, attrs) do
    record
    |> cast(attrs, [
      :provider_account_id,
      :credential_generation,
      :worker_id,
      :worker_generation,
      :operation_id,
      :desired_environment_state,
      :backend_kind,
      :environment_id,
      :incarnation,
      :physical_state,
      :last_error_code,
      :last_error_message,
      :canary_persisted,
      :observed_at
    ])
    |> validate_required([
      :provider_account_id,
      :credential_generation,
      :worker_id,
      :operation_id,
      :desired_environment_state,
      :physical_state
    ])
    |> validate_number(:credential_generation, greater_than: 0)
    |> validate_number(:worker_generation, greater_than: 0)
    |> validate_inclusion(:desired_environment_state, ~w(available stopped removed))
    |> validate_inclusion(
      :physical_state,
      ~w(pending available stopped missing degraded removing removed)
    )
    |> foreign_key_constraint(:provider_account_id)
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint(:environment_id, name: :provider_account_environments_physical_identity)
  end
end

defmodule QuestEngineering.Server.Persistence.ProviderAccountLifecycleEvent do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_lifecycle_events" do
    field :provider_account_id, :string
    field :credential_generation, :integer
    field :worker_id, :string
    field :worker_generation, :integer
    field :operation_id, :string
    field :event_type, :string
    field :lifecycle_state, :string
    field :physical_state, :string
    field :backend_kind, :string
    field :environment_id, :string
    field :incarnation, :string
    field :error_code, :string
    field :details, :map, default: %{}
    field :occurred_at, :utc_datetime_usec
    timestamps(updated_at: false, type: :utc_datetime_usec)
  end

  def changeset(record, attrs) do
    record
    |> cast(attrs, [
      :id,
      :provider_account_id,
      :credential_generation,
      :worker_id,
      :worker_generation,
      :operation_id,
      :event_type,
      :lifecycle_state,
      :physical_state,
      :backend_kind,
      :environment_id,
      :incarnation,
      :error_code,
      :details,
      :occurred_at
    ])
    |> validate_required([
      :id,
      :provider_account_id,
      :credential_generation,
      :worker_id,
      :operation_id,
      :event_type,
      :lifecycle_state,
      :physical_state,
      :occurred_at
    ])
    |> validate_number(:credential_generation, greater_than: 0)
    |> validate_number(:worker_generation, greater_than: 0)
    |> foreign_key_constraint(:provider_account_id)
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint(:event_type, name: :provider_account_lifecycle_events_dedup)
  end
end
