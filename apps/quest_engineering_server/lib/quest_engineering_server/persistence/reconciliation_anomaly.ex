defmodule QuestEngineering.Server.Persistence.ReconciliationAnomaly do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  schema "worker_reconciliation_anomalies" do
    field :worker_id, :string
    field :action_id, :string
    field :type, :string
    field :details, :map, default: %{}
    field :status, :string, default: "open"

    timestamps(type: :utc_datetime_usec)
  end

  def changeset(attributes) do
    %__MODULE__{}
    |> cast(attributes, [:worker_id, :action_id, :type, :details, :status])
    |> validate_required([:worker_id, :action_id, :type, :details, :status])
    |> validate_inclusion(:type, [
      "dispatch_missing_on_worker",
      "dispatch_unknown_to_server"
    ])
    |> validate_inclusion(:status, ["open", "resolved"])
    |> foreign_key_constraint(:worker_id)
    |> unique_constraint([:worker_id, :action_id, :type],
      name: :worker_reconciliation_anomalies_identity_index
    )
    |> check_constraint(:type, name: :worker_anomalies_type_valid)
    |> check_constraint(:status, name: :worker_anomalies_status_valid)
  end
end
