defmodule QuestEngineering.Server.Persistence.OperationalRecoveryEpoch do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  schema "operational_recovery_epochs" do
    field :run_id, :string
    field :occurrence_id, :string
    field :epoch_number, :integer
    field :authorization_kind, :string
    field :source_attempt_id, :string
    field :request_id, :string
    field :attempt_allowance, :integer
    field :policy_source, :string
    field :retained_session_id, :string
    field :retained_lineage_id, :string
    field :continuation_mode, :string
    field :authorized_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(epoch \\ %__MODULE__{}, attributes) do
    epoch
    |> cast(attributes, [
      :run_id,
      :occurrence_id,
      :epoch_number,
      :authorization_kind,
      :source_attempt_id,
      :request_id,
      :attempt_allowance,
      :policy_source,
      :retained_session_id,
      :retained_lineage_id,
      :continuation_mode,
      :authorized_at
    ])
    |> validate_required([
      :run_id,
      :occurrence_id,
      :epoch_number,
      :authorization_kind,
      :policy_source,
      :continuation_mode,
      :authorized_at
    ])
    |> validate_number(:epoch_number, greater_than_or_equal_to: 0)
    |> validate_number(:attempt_allowance, greater_than: 0)
    |> unique_constraint([:run_id, :occurrence_id, :epoch_number],
      name: :operational_recovery_epochs_number_index
    )
    |> unique_constraint(:request_id, name: :operational_recovery_epochs_request_index)
  end
end

defmodule QuestEngineering.Server.Persistence.OperationalAttemptAttribution do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:action_id, :string, autogenerate: false}
  schema "operational_attempt_attributions" do
    field :epoch_id, Ecto.UUID
    field :run_id, :string
    field :occurrence_id, :string
    field :attempt_id, :string
    field :global_attempt_number, :integer
    field :attempt_in_epoch, :integer
    field :scheduled_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  def changeset(attribution \\ %__MODULE__{}, attributes) do
    attribution
    |> cast(attributes, [
      :action_id,
      :epoch_id,
      :run_id,
      :occurrence_id,
      :attempt_id,
      :global_attempt_number,
      :attempt_in_epoch,
      :scheduled_at
    ])
    |> validate_required([
      :action_id,
      :epoch_id,
      :run_id,
      :occurrence_id,
      :attempt_id,
      :global_attempt_number,
      :attempt_in_epoch,
      :scheduled_at
    ])
    |> validate_number(:global_attempt_number, greater_than: 0)
    |> validate_number(:attempt_in_epoch, greater_than: 0)
    |> unique_constraint(:action_id)
    |> unique_constraint(:attempt_id, name: :operational_attempt_attributions_attempt_index)
    |> unique_constraint([:epoch_id, :attempt_in_epoch],
      name: :operational_attempt_attributions_epoch_position_index
    )
  end
end
