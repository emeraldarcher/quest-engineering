defmodule QuestEngineering.Server.Persistence.ExecutionSession do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  schema "execution_sessions" do
    field :worker_id, :string
    field :current_action_id, :string
    field :harness_kind, :string
    field :harness_display_name, :string
    field :state, :string
    field :capabilities, :map
    field :terminal, :map
    field :provider_session_id, :string
    field :attention, :map
    field :last_connection_generation, :integer
    field :started_at, :utc_datetime_usec
    field :last_activity_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(session \\ %__MODULE__{}, attributes) do
    session
    |> cast(attributes, [
      :id,
      :worker_id,
      :current_action_id,
      :harness_kind,
      :harness_display_name,
      :state,
      :capabilities,
      :terminal,
      :provider_session_id,
      :attention,
      :last_connection_generation,
      :started_at,
      :last_activity_at
    ])
    |> validate_required([
      :id,
      :worker_id,
      :harness_kind,
      :harness_display_name,
      :state,
      :capabilities,
      :last_connection_generation,
      :started_at,
      :last_activity_at
    ])
    |> validate_inclusion(
      :state,
      ~w(starting running waiting_for_human recovering retained closed unavailable)
    )
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:current_action_id)
    |> check_constraint(:state, name: :execution_sessions_state_valid)
  end
end

defmodule QuestEngineering.Server.Persistence.ExecutionSessionAuditEvent do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "execution_session_audit_events" do
    field :session_id, :string
    field :event_type, :string
    field :attention_id, :string
    field :run_id, :string
    field :action_id, :string
    field :occurrence_id, :string
    field :attempt_id, :string
    field :metadata, :map, default: %{}
    field :occurred_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [
      :session_id,
      :event_type,
      :attention_id,
      :run_id,
      :action_id,
      :occurrence_id,
      :attempt_id,
      :metadata,
      :occurred_at
    ])
    |> validate_required([
      :session_id,
      :event_type,
      :run_id,
      :action_id,
      :occurrence_id,
      :attempt_id,
      :metadata,
      :occurred_at
    ])
    |> validate_inclusion(
      :event_type,
      ~w(attention_requested attachment_descriptor_issued local_session_opened attention_resolved)
    )
    |> foreign_key_constraint(:session_id)
    |> unique_constraint([:session_id, :event_type, :attention_id],
      name: :execution_session_attention_audit_dedupe_index
    )
  end
end
