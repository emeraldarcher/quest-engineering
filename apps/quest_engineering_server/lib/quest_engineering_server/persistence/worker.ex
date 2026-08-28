defmodule QuestEngineering.Server.Persistence.Worker do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  schema "workers" do
    field :capabilities, :map
    field :max_concurrency, :integer
    field :active_dispatches, :integer, default: 0
    field :status, :string
    field :connection_id, :string
    field :connection_generation, :integer, default: 0
    field :connected_at, :utc_datetime_usec
    field :disconnected_at, :utc_datetime_usec
    field :last_heartbeat_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  def registration_changeset(worker \\ %__MODULE__{}, attributes) do
    worker
    |> cast(attributes, [
      :id,
      :capabilities,
      :max_concurrency,
      :active_dispatches,
      :status,
      :connection_id,
      :connection_generation,
      :connected_at,
      :disconnected_at,
      :last_heartbeat_at
    ])
    |> validate_required([
      :id,
      :capabilities,
      :max_concurrency,
      :active_dispatches,
      :status,
      :connection_id,
      :connection_generation,
      :connected_at,
      :last_heartbeat_at
    ])
    |> validate_inclusion(:status, ["connected", "disconnected"])
    |> validate_number(:max_concurrency, greater_than: 0)
    |> validate_number(:active_dispatches, greater_than_or_equal_to: 0)
    |> check_constraint(:status, name: :workers_status_valid)
    |> check_constraint(:max_concurrency, name: :workers_max_concurrency_positive)
    |> check_constraint(:active_dispatches, name: :workers_active_dispatches_valid)
  end
end
