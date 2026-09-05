defmodule QuestEngineering.Server.Persistence.QuestLaunch do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "quest_launches" do
    field :quest_id, Ecto.UUID
    field :run_id, :string
    field :snapshot_version, :integer
    field :snapshot, :map
    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:id, :quest_id, :run_id, :snapshot_version, :snapshot])
    |> validate_required([:id, :quest_id, :run_id, :snapshot_version, :snapshot])
    |> validate_number(:snapshot_version, greater_than: 0)
    |> foreign_key_constraint(:quest_id)
    |> foreign_key_constraint(:run_id)
    |> unique_constraint(:run_id)
    |> check_constraint(:snapshot_version, name: :quest_launches_snapshot_version_positive)
  end
end

defmodule QuestEngineering.Server.Persistence.OccurrenceMemberBinding do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false
  schema "occurrence_member_bindings" do
    field :run_id, :string, primary_key: true
    field :occurrence_id, :string, primary_key: true
    field :member_key, :string
    field :bound_at, :utc_datetime_usec
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:run_id, :occurrence_id, :member_key, :bound_at])
    |> validate_required([:run_id, :occurrence_id, :member_key, :bound_at])
    |> foreign_key_constraint(:run_id)
    |> unique_constraint([:run_id, :occurrence_id], name: :occurrence_member_bindings_pkey)
  end
end

defmodule QuestEngineering.Server.Persistence.OccurrenceContextBinding do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key false
  schema "occurrence_context_bindings" do
    field :run_id, :string, primary_key: true
    field :occurrence_id, :string, primary_key: true
    field :logical_lineage_id, Ecto.UUID
    field :source_occurrence_id, :string
    field :bound_at, :utc_datetime_usec
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [
      :run_id,
      :occurrence_id,
      :logical_lineage_id,
      :source_occurrence_id,
      :bound_at
    ])
    |> validate_required([:run_id, :occurrence_id, :logical_lineage_id, :bound_at])
    |> foreign_key_constraint(:run_id)
    |> unique_constraint([:run_id, :occurrence_id], name: :occurrence_context_bindings_pkey)
  end
end

defmodule QuestEngineering.Server.Persistence.ScheduledActionExecution do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:action_id, :string, autogenerate: false}
  schema "scheduled_action_executions" do
    field :run_id, :string
    field :occurrence_id, :string
    field :squad_id, Ecto.UUID
    field :member_key, :string
    field :logical_lineage_id, Ecto.UUID
    field :worker_id, :string
    field :state, :string
    field :resolved_execution_version, :integer
    field :resolved_execution, :map
    field :bound_at, :utc_datetime_usec
    field :terminal_at, :utc_datetime_usec
    field :failure, :map
  end

  def changeset(execution \\ %__MODULE__{}, attributes) do
    execution
    |> cast(attributes, [
      :action_id,
      :run_id,
      :occurrence_id,
      :squad_id,
      :member_key,
      :logical_lineage_id,
      :worker_id,
      :state,
      :resolved_execution_version,
      :resolved_execution,
      :bound_at,
      :terminal_at,
      :failure
    ])
    |> validate_required([
      :action_id,
      :run_id,
      :occurrence_id,
      :squad_id,
      :member_key,
      :logical_lineage_id,
      :worker_id,
      :state,
      :resolved_execution_version,
      :resolved_execution,
      :bound_at
    ])
    |> validate_inclusion(:state, ["active", "completed", "failed"])
    |> validate_number(:resolved_execution_version, greater_than: 0)
    |> foreign_key_constraint(:action_id)
    |> foreign_key_constraint(:run_id)
    |> foreign_key_constraint(:squad_id)
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:occurrence_id,
      name: :scheduled_action_executions_member_binding_fkey
    )
    |> foreign_key_constraint(:occurrence_id,
      name: :scheduled_action_executions_context_binding_fkey
    )
    |> unique_constraint([:squad_id, :member_key],
      name: :scheduled_action_executions_active_member_index
    )
    |> unique_constraint([:run_id, :logical_lineage_id],
      name: :scheduled_action_executions_active_context_index
    )
    |> check_constraint(:state, name: :scheduled_action_executions_state_valid)
  end
end
