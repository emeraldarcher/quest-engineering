defmodule QuestEngineering.Server.Persistence.WorkerDispatch do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  schema "worker_dispatches" do
    field :action_id, :string
    field :worker_id, :string
    field :state, :string
    field :payload_hash, :string
    field :claim_owner, :string
    field :claim_token, :string
    field :claim_expires_at, :utc_datetime_usec
    field :last_connection_generation, :integer
    field :dispatched_at, :utc_datetime_usec
    field :acknowledged_at, :utc_datetime_usec
    field :terminal_at, :utc_datetime_usec
    field :failure, :map

    timestamps(type: :utc_datetime_usec)
  end

  def changeset(dispatch \\ %__MODULE__{}, attributes) do
    dispatch
    |> cast(attributes, [
      :action_id,
      :worker_id,
      :state,
      :payload_hash,
      :claim_owner,
      :claim_token,
      :claim_expires_at,
      :last_connection_generation,
      :dispatched_at,
      :acknowledged_at,
      :terminal_at,
      :failure
    ])
    |> validate_required([
      :action_id,
      :worker_id,
      :state,
      :payload_hash,
      :claim_owner,
      :claim_token,
      :claim_expires_at
    ])
    |> validate_inclusion(:state, [
      "claimed",
      "dispatched",
      "acknowledged",
      "running",
      "completed",
      "failed"
    ])
    |> foreign_key_constraint(:action_id)
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint(:action_id, name: :worker_dispatches_action_id_index)
    |> check_constraint(:state, name: :worker_dispatches_state_valid)
  end
end
