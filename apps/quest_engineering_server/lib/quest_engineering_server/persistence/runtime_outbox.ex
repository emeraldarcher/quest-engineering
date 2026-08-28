defmodule QuestEngineering.Server.Persistence.RuntimeOutbox do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @type t :: %__MODULE__{}

  schema "runtime_outbox" do
    field :action_id, :string
    field :run_id, :string
    field :run_revision, :integer
    field :action_type, :string
    field :payload, :map

    timestamps(type: :utc_datetime_usec)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:action_id, :run_id, :run_revision, :action_type, :payload])
    |> validate_required([:action_id, :run_id, :run_revision, :action_type, :payload])
    |> validate_number(:run_revision, greater_than_or_equal_to: 0)
    |> foreign_key_constraint(:run_id)
    |> unique_constraint(:action_id, name: :runtime_outbox_action_id_index)
    |> check_constraint(:run_revision, name: :runtime_outbox_revision_non_negative)
  end
end
