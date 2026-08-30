defmodule QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate do
  @moduledoc false
  use Ecto.Schema

  @primary_key {:candidate_id, :string, autogenerate: false}
  schema "worker_workspace_candidates" do
    field :worker_id, :string
    field :name, :string
    field :source_kind, :string
    field :source_fingerprint, :string
    field :publication_remote_name, :string
    field :publication_repository_identity, :string
    field :max_access, :string
    field :allow_unconfined_shell, :boolean
    field :status, :string
    field :last_seen_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end
end
