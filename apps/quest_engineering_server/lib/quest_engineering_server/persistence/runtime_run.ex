defmodule QuestEngineering.Server.Persistence.RuntimeRun do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key false
  schema "runtime_runs" do
    field :id, :string, primary_key: true
    field :snapshot, :map
    field :snapshot_version, :integer
    field :status, :string
    field :revision, :integer, default: 0

    timestamps(type: :utc_datetime_usec)
  end

  def create_changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:id, :snapshot, :snapshot_version, :status, :revision])
    |> validate_required([:id, :snapshot, :snapshot_version, :status, :revision])
    |> validate_number(:revision, greater_than_or_equal_to: 0)
    |> validate_inclusion(:status, ["running", "completed", "failed"])
    |> unique_constraint(:id)
    |> check_constraint(:revision, name: :runtime_runs_revision_non_negative)
    |> check_constraint(:status, name: :runtime_runs_status_valid)
  end

  def transition_changeset(run, attributes) do
    run
    |> cast(attributes, [:snapshot, :snapshot_version, :status])
    |> validate_required([:snapshot, :snapshot_version, :status])
    |> validate_inclusion(:status, ["running", "completed", "failed"])
    |> check_constraint(:revision, name: :runtime_runs_revision_non_negative)
    |> check_constraint(:status, name: :runtime_runs_status_valid)
    |> optimistic_lock(:revision)
  end
end
