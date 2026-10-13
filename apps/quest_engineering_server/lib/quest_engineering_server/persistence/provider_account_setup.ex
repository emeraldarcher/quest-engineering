defmodule QuestEngineering.Server.Persistence.ProviderAccountSetupAttempt do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_setup_attempts" do
    field :provider_account_id, :string
    field :setup_generation, :integer
    field :credential_generation_before, :integer
    field :credential_generation_after, :integer
    field :environment_generation, :integer
    field :provider_key, :string
    field :worker_id, :string
    field :worker_generation, :integer
    field :environment_operation_id, :string
    field :backend_kind, :string
    field :environment_id, :string
    field :environment_incarnation, :string
    field :state, :string
    field :invocation_state, :string
    field :process_backend_id, :string
    field :process_start_identity, :string
    field :process_generation, :string
    field :process_executable, :string
    field :attention_id, :string
    field :validation_state, :string
    field :validation_identity, :string
    field :failure_code, :string
    field :failure_message, :string
    field :invocation_requested_at, :utc_datetime_usec
    field :invocation_acknowledged_at, :utc_datetime_usec
    field :interaction_required_at, :utc_datetime_usec
    field :validated_at, :utc_datetime_usec
    field :succeeded_at, :utc_datetime_usec
    field :cancelled_at, :utc_datetime_usec
    field :cancellation_request_id, :string
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(record \\ %__MODULE__{}, attrs) do
    record
    |> cast(attrs, [
      :id,
      :provider_account_id,
      :setup_generation,
      :credential_generation_before,
      :credential_generation_after,
      :environment_generation,
      :provider_key,
      :worker_id,
      :worker_generation,
      :environment_operation_id,
      :backend_kind,
      :environment_id,
      :environment_incarnation,
      :state,
      :invocation_state,
      :process_backend_id,
      :process_start_identity,
      :process_generation,
      :process_executable,
      :attention_id,
      :validation_state,
      :validation_identity,
      :failure_code,
      :failure_message,
      :invocation_requested_at,
      :invocation_acknowledged_at,
      :interaction_required_at,
      :validated_at,
      :succeeded_at,
      :cancelled_at,
      :cancellation_request_id
    ])
    |> validate_required([
      :id,
      :provider_account_id,
      :setup_generation,
      :credential_generation_before,
      :environment_generation,
      :provider_key,
      :worker_id,
      :worker_generation,
      :environment_operation_id,
      :backend_kind,
      :environment_id,
      :environment_incarnation,
      :state,
      :invocation_state,
      :validation_state
    ])
    |> validate_number(:setup_generation, greater_than: 0)
    |> validate_number(:credential_generation_before, greater_than: 0)
    |> validate_number(:credential_generation_after, greater_than: 0)
    |> validate_number(:environment_generation, greater_than: 0)
    |> validate_number(:worker_generation, greater_than: 0)
    |> validate_inclusion(
      :state,
      ~w(authorized preparing invocation_requested invocation_acknowledged human_interaction_required validating succeeded failed uncertain cancellation_requested cancelled invalidated)
    )
    |> validate_inclusion(
      :invocation_state,
      ~w(not_requested requested acknowledged settled uncertain)
    )
    |> validate_inclusion(
      :validation_state,
      ~w(not_checked authenticated authentication_required inspection_unavailable incompatible_status)
    )
    |> foreign_key_constraint(:provider_account_id)
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint(:provider_account_id,
      name: :provider_account_setup_attempts_one_active_per_account
    )
    |> unique_constraint(:setup_generation,
      name: :provider_account_setup_attempt_generation_unique
    )
    |> check_constraint(:setup_generation, name: :provider_account_setup_generation_valid)
    |> check_constraint(:credential_generation_before,
      name: :provider_account_setup_credential_generation_valid
    )
    |> check_constraint(:worker_generation, name: :provider_account_setup_worker_generation_valid)
    |> check_constraint(:state, name: :provider_account_setup_state_valid)
    |> check_constraint(:invocation_state, name: :provider_account_setup_invocation_state_valid)
    |> check_constraint(:validation_state, name: :provider_account_setup_validation_state_valid)
    |> check_constraint(:process_backend_id,
      name: :provider_account_setup_process_identity_complete
    )
  end
end

defmodule QuestEngineering.Server.Persistence.ProviderAccountSetupAuthorization do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_setup_authorizations" do
    field :setup_attempt_id, :string
    field :setup_generation, :integer
    field :request_id, :string
    field :kind, :string
    field :authorized_at, :utc_datetime_usec
    timestamps(updated_at: false, type: :utc_datetime_usec)
  end

  def changeset(record \\ %__MODULE__{}, attrs) do
    record
    |> cast(attrs, [
      :id,
      :setup_attempt_id,
      :setup_generation,
      :request_id,
      :kind,
      :authorized_at
    ])
    |> validate_required([
      :id,
      :setup_attempt_id,
      :setup_generation,
      :request_id,
      :kind,
      :authorized_at
    ])
    |> validate_number(:setup_generation, greater_than: 0)
    |> validate_inclusion(:kind, ["provider_account_setup"])
    |> foreign_key_constraint(:setup_attempt_id)
    |> unique_constraint(:setup_attempt_id)
    |> unique_constraint(:request_id)
    |> check_constraint(:kind, name: :provider_account_setup_authorization_kind_valid)
  end
end

defmodule QuestEngineering.Server.Persistence.ProviderAccountSetupEvent do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_setup_events" do
    field :setup_attempt_id, :string
    field :provider_account_id, :string
    field :setup_generation, :integer
    field :event_type, :string
    field :state, :string
    field :invocation_state, :string
    field :details, :map, default: %{}
    field :occurred_at, :utc_datetime_usec
    timestamps(updated_at: false, type: :utc_datetime_usec)
  end

  def changeset(record \\ %__MODULE__{}, attrs) do
    record
    |> cast(attrs, [
      :id,
      :setup_attempt_id,
      :provider_account_id,
      :setup_generation,
      :event_type,
      :state,
      :invocation_state,
      :details,
      :occurred_at
    ])
    |> validate_required([
      :id,
      :setup_attempt_id,
      :provider_account_id,
      :setup_generation,
      :event_type,
      :state,
      :invocation_state,
      :details,
      :occurred_at
    ])
    |> foreign_key_constraint(:setup_attempt_id)
    |> foreign_key_constraint(:provider_account_id)
  end
end

defmodule QuestEngineering.Server.Persistence.ProviderAccountHumanAttentionRequest do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string
  schema "provider_account_human_attention_requests" do
    field :setup_attempt_id, :string
    field :provider_account_id, :string
    field :worker_id, :string
    field :setup_generation, :integer
    field :request_generation, :integer
    field :request, :map
    field :response_state, :string
    field :response_request_id, :string
    field :response_committed_at, :utc_datetime_usec
    field :delivery_state, :string
    field :delivery_attempt_id, :string
    field :delivery_requested_at, :utc_datetime_usec
    field :delivery_acknowledged_at, :utc_datetime_usec
    field :delivery_uncertain_at, :utc_datetime_usec
    field :cancelled_at, :utc_datetime_usec
    field :cancellation_reason, :string
    field :surfaced_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(record \\ %__MODULE__{}, attrs) do
    record
    |> cast(attrs, [
      :id,
      :setup_attempt_id,
      :provider_account_id,
      :worker_id,
      :setup_generation,
      :request_generation,
      :request,
      :response_state,
      :response_request_id,
      :response_committed_at,
      :delivery_state,
      :delivery_attempt_id,
      :delivery_requested_at,
      :delivery_acknowledged_at,
      :delivery_uncertain_at,
      :cancelled_at,
      :cancellation_reason,
      :surfaced_at
    ])
    |> validate_required([
      :id,
      :setup_attempt_id,
      :provider_account_id,
      :worker_id,
      :setup_generation,
      :request_generation,
      :request,
      :response_state,
      :delivery_state,
      :surfaced_at
    ])
    |> validate_number(:setup_generation, greater_than: 0)
    |> validate_number(:request_generation, greater_than: 0)
    |> validate_inclusion(:response_state, ~w(pending responded cancelled obsolete))
    |> validate_inclusion(
      :delivery_state,
      ~w(response_not_delivered delivery_requested delivery_acknowledged delivery_uncertain)
    )
    |> foreign_key_constraint(:setup_attempt_id)
    |> foreign_key_constraint(:provider_account_id)
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint(:setup_attempt_id,
      name: :provider_account_attention_attempt_unique
    )
    |> unique_constraint(:response_request_id,
      name: :provider_account_attention_response_request_unique
    )
    |> check_constraint(:request_generation, name: :provider_account_attention_generation_valid)
    |> check_constraint(:response_state, name: :provider_account_attention_response_state_valid)
    |> check_constraint(:delivery_state, name: :provider_account_attention_delivery_state_valid)
  end
end
