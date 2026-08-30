defmodule QuestEngineering.Server.Persistence.RunDelivery do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, Ecto.UUID, autogenerate: true}
  @states ~w(pending preparing publishing creating_review review_open merged closed_unmerged no_changes attention_required)

  schema "run_deliveries" do
    field :run_id, :string
    field :quest_id, Ecto.UUID
    field :state, :string
    field :command_revision, :integer, default: 1
    field :automatic_attempted_at, :utc_datetime_usec
    field :retry_requested_at, :utc_datetime_usec
    field :base_revision, :string
    field :base_branch_name, :string
    field :head_before_finalize, :string
    field :head_revision, :string
    field :branch_name, :string
    field :change_evidence_version, :integer
    field :change_evidence, :map
    field :change_fingerprint, :string
    field :provider, :string
    field :repository_host, :string
    field :repository_identity, :string
    field :remote_name, :string
    field :pull_request_number, :integer
    field :pull_request_url, :string
    field :pull_request_state, :string
    field :pull_request_base_branch, :string
    field :pull_request_head_repository, :string
    field :pull_request_head_branch, :string
    field :pull_request_head_revision, :string
    field :published_at, :utc_datetime_usec
    field :review_created_at, :utc_datetime_usec
    field :last_reconciled_at, :utc_datetime_usec
    field :merged_at, :utc_datetime_usec
    field :closed_at, :utc_datetime_usec
    field :failure_stage, :string
    field :failure_code, :string
    field :failure_details, :map
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(row \\ %__MODULE__{}, attributes) do
    row
    |> cast(attributes, __schema__(:fields))
    |> validate_required([:run_id, :quest_id, :state, :command_revision])
    |> validate_inclusion(:state, @states)
    |> validate_number(:command_revision, greater_than: 0)
    |> foreign_key_constraint(:run_id)
    |> foreign_key_constraint(:quest_id)
    |> unique_constraint(:run_id)
    |> unique_constraint(:quest_id, name: :run_deliveries_active_quest_index)
    |> unique_constraint([:provider, :repository_identity, :pull_request_number],
      name: :run_deliveries_provider_pull_request_index
    )
  end
end

defmodule QuestEngineering.Server.Persistence.WorkspaceBindingAttempt do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:binding_id, Ecto.UUID, autogenerate: true}
  schema "workspace_binding_attempts" do
    field :workspace_id, Ecto.UUID
    field :worker_id, :string
    field :candidate_id, :string
    field :state, :string
    field :failure_code, :string
    field :failure_details, :map
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(row \\ %__MODULE__{}, attributes) do
    row
    |> cast(attributes, [
      :binding_id,
      :workspace_id,
      :worker_id,
      :candidate_id,
      :state,
      :failure_code,
      :failure_details
    ])
    |> validate_required([:binding_id, :workspace_id, :worker_id, :candidate_id, :state])
    |> validate_inclusion(:state, ~w(pending available attention_required offline))
    |> foreign_key_constraint(:workspace_id)
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:candidate_id)
  end
end
