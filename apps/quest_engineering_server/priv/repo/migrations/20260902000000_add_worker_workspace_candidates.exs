defmodule QuestEngineering.Server.Repo.Migrations.AddWorkerWorkspaceCandidates do
  use Ecto.Migration

  def change do
    create table(:worker_workspace_candidates, primary_key: false) do
      add :candidate_id, :text, primary_key: true

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :delete_all),
        null: false

      add :name, :text, null: false
      add :source_kind, :text, null: false
      add :source_fingerprint, :text
      add :max_access, :text, null: false
      add :allow_unconfined_shell, :boolean, null: false
      add :status, :text, null: false
      add :last_seen_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create index(:worker_workspace_candidates, [:worker_id, :status])

    create constraint(
             :worker_workspace_candidates,
             :worker_workspace_candidates_source_kind_valid,
             check: "source_kind IN ('git_remote', 'local_git')"
           )

    create constraint(:worker_workspace_candidates, :worker_workspace_candidates_access_valid,
             check: "max_access IN ('none', 'read_only', 'read_write')"
           )
  end
end
