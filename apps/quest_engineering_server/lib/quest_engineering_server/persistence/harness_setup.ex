defmodule QuestEngineering.Server.Persistence.HarnessSetupContext do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "harness_setup_contexts" do
    field :run_id, :string
    field :action_id, :string
    field :occurrence_id, :string
    field :member_key, :string
    field :harness_kind, :string
    field :worker_id, :string
    field :worker_generation, :integer
    field :workspace_id, Ecto.UUID
    field :worktree_id, Ecto.UUID
    field :workspace_binding_id, Ecto.UUID
    field :canonical_root, :string
    field :workspace_access, :string
    field :logical_lineage_id, Ecto.UUID
    field :physical_lineage_id, Ecto.UUID
    field :profile_id, :string
    field :profile_digest, :string
    field :setup_generation, :integer, default: 1
    field :state, :string
    field :invocation_state, :string
    field :resolved_configuration, :map
    field :environment_id, :string
    field :environment_incarnation, :string
    field :config_identity, :string
    field :attention, :map
    field :failure, :map
    field :invocation_requested_at, :utc_datetime_usec
    field :invocation_acknowledged_at, :utc_datetime_usec
    field :ready_at, :utc_datetime_usec
    field :cancelled_at, :utc_datetime_usec
    field :cancellation_request_id, :string
    timestamps(type: :utc_datetime_usec)
  end

  @fields [
    :id,
    :run_id,
    :action_id,
    :occurrence_id,
    :member_key,
    :harness_kind,
    :worker_id,
    :worker_generation,
    :workspace_id,
    :worktree_id,
    :workspace_binding_id,
    :canonical_root,
    :workspace_access,
    :logical_lineage_id,
    :physical_lineage_id,
    :profile_id,
    :profile_digest,
    :setup_generation,
    :state,
    :invocation_state,
    :resolved_configuration,
    :environment_id,
    :environment_incarnation,
    :config_identity,
    :attention,
    :failure,
    :invocation_requested_at,
    :invocation_acknowledged_at,
    :ready_at,
    :cancelled_at,
    :cancellation_request_id
  ]

  def changeset(context \\ %__MODULE__{}, attributes) do
    context
    |> cast(attributes, @fields)
    |> validate_required([
      :run_id,
      :action_id,
      :occurrence_id,
      :member_key,
      :harness_kind,
      :worker_id,
      :worker_generation,
      :workspace_id,
      :worktree_id,
      :workspace_binding_id,
      :canonical_root,
      :workspace_access,
      :logical_lineage_id,
      :physical_lineage_id,
      :profile_id,
      :profile_digest,
      :setup_generation,
      :state,
      :invocation_state,
      :resolved_configuration
    ])
    |> validate_inclusion(:workspace_access, ~w(none read_only read_write))
    |> validate_inclusion(
      :state,
      ~w(authorized preparing invocation_requested invocation_acknowledged human_interaction_required cancellation_requested ready failed uncertain cancelled invalidated)
    )
    |> validate_inclusion(
      :invocation_state,
      ~w(not_requested requested acknowledged settled uncertain)
    )
    |> validate_number(:setup_generation, greater_than: 0)
    |> unique_constraint([:action_id, :setup_generation])
    |> foreign_key_constraint(:run_id)
    |> foreign_key_constraint(:worker_id)
    |> check_constraint(:state, name: :harness_setup_contexts_state_valid)
    |> check_constraint(:invocation_state, name: :harness_setup_contexts_invocation_state_valid)
    |> check_constraint(:setup_generation, name: :harness_setup_contexts_generation_positive)
  end
end

defmodule QuestEngineering.Server.Persistence.HarnessSetupAuthorization do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "harness_setup_authorizations" do
    field :setup_context_id, Ecto.UUID
    field :setup_generation, :integer
    field :request_id, :string
    field :kind, :string
    field :authorized_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [
      :id,
      :setup_context_id,
      :setup_generation,
      :request_id,
      :kind,
      :authorized_at
    ])
    |> validate_required([
      :setup_context_id,
      :setup_generation,
      :request_id,
      :kind,
      :authorized_at
    ])
    |> validate_inclusion(:kind, ["human_harness_setup"])
    |> validate_number(:setup_generation, greater_than: 0)
    |> foreign_key_constraint(:setup_context_id)
    |> unique_constraint(:request_id)
    |> unique_constraint([:setup_context_id, :setup_generation])
    |> check_constraint(:kind, name: :harness_setup_authorizations_kind_valid)
  end
end
