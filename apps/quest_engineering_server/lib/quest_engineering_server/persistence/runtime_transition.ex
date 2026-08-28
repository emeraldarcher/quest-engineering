defmodule QuestEngineering.Server.Persistence.RuntimeTransition do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  schema "runtime_transitions" do
    field :run_id, :string
    field :transition_id, :string
    field :resulting_revision, :integer
    field :event_payload, :map
    field :result_snapshot, :map
    field :snapshot_version, :integer
    field :resulting_status, :string
    field :action_ids, {:array, :string}, default: []

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [
      :run_id,
      :transition_id,
      :resulting_revision,
      :event_payload,
      :result_snapshot,
      :snapshot_version,
      :resulting_status,
      :action_ids
    ])
    |> validate_required([
      :run_id,
      :transition_id,
      :resulting_revision,
      :event_payload,
      :result_snapshot,
      :snapshot_version,
      :resulting_status
    ])
    |> validate_number(:resulting_revision, greater_than: 0)
    |> validate_inclusion(:resulting_status, ["running", "completed", "failed"])
    |> foreign_key_constraint(:run_id)
    |> unique_constraint([:run_id, :transition_id],
      name: :runtime_transitions_run_transition_id_index
    )
    |> unique_constraint([:run_id, :resulting_revision],
      name: :runtime_transitions_run_revision_index
    )
    |> check_constraint(:resulting_revision, name: :runtime_transitions_revision_positive)
    |> check_constraint(:resulting_status, name: :runtime_transitions_status_valid)
  end
end
