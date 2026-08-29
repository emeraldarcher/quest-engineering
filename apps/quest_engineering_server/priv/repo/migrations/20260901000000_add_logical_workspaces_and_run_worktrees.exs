defmodule QuestEngineering.Server.Repo.Migrations.AddLogicalWorkspacesAndRunWorktrees do
  use Ecto.Migration

  def up do
    create table(:product_workspaces, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :key, :text, null: false
      add :name, :text, null: false
      add :source_kind, :text, null: false
      add :source_fingerprint, :text
      add :archived_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:product_workspaces, [:key])
    create index(:product_workspaces, [:archived_at])

    create constraint(:product_workspaces, :product_workspaces_source_kind_valid,
             check: "source_kind IN ('git_remote', 'local_git')"
           )

    alter table(:product_quests) do
      add :workspace_id, references(:product_workspaces, type: :uuid, on_delete: :restrict)
    end

    execute("""
    INSERT INTO product_workspaces
      (id, key, name, source_kind, source_fingerprint, inserted_at, updated_at)
    SELECT gen_random_uuid(),
           'legacy-' || substr(md5(workspace_ref), 1, 16),
           workspace_ref,
           'local_git',
           NULL,
           now(),
           now()
    FROM product_quests
    GROUP BY workspace_ref
    """)

    execute("""
    UPDATE product_quests AS quest
    SET workspace_id = workspace.id
    FROM product_workspaces AS workspace
    WHERE workspace.key = 'legacy-' || substr(md5(quest.workspace_ref), 1, 16)
    """)

    alter table(:product_quests) do
      modify :workspace_id, :uuid, null: false
    end

    create index(:product_quests, [:workspace_id])

    create table(:worker_workspace_bindings, primary_key: false) do
      add :binding_id, :uuid, primary_key: true

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :workspace_id, references(:product_workspaces, type: :uuid, on_delete: :restrict),
        null: false

      add :authorized_root_key, :text, null: false
      add :source_repository_root, :text, null: false
      add :source_fingerprint, :text
      add :max_access, :text, null: false
      add :allow_unconfined_shell, :boolean, null: false, default: false
      add :status, :text, null: false
      add :last_seen_generation, :bigint
      add :last_seen_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:worker_workspace_bindings, [:worker_id, :workspace_id])
    create unique_index(:worker_workspace_bindings, [:worker_id, :source_repository_root])

    create constraint(:worker_workspace_bindings, :worker_workspace_bindings_access_valid,
             check: "max_access IN ('none', 'read_only', 'read_write')"
           )

    create constraint(:worker_workspace_bindings, :worker_workspace_bindings_status_valid,
             check: "status IN ('available', 'unavailable')"
           )

    create table(:run_workspace_assignments, primary_key: false) do
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict),
        primary_key: true,
        null: false

      add :workspace_id, references(:product_workspaces, type: :uuid, on_delete: :restrict),
        null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict)

      add :workspace_binding_id,
          references(:worker_workspace_bindings,
            column: :binding_id,
            type: :uuid,
            on_delete: :restrict
          )

      add :worktree_id, :uuid, null: false
      add :base_selector, :text, null: false
      add :base_revision, :text
      add :branch_name, :text, null: false
      add :canonical_worktree_root, :text
      add :source_dirty_excluded, :boolean
      add :state, :text, null: false
      add :provision_revision, :integer, null: false, default: 1
      add :identity_hash, :text, null: false
      add :failure_code, :text
      add :failure_details, :map
      add :assigned_at, :utc_datetime_usec
      add :ready_at, :utc_datetime_usec
      add :retained_at, :utc_datetime_usec
      add :cleanup_requested_at, :utc_datetime_usec
      add :removed_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:run_workspace_assignments, [:worktree_id])
    create index(:run_workspace_assignments, [:worker_id, :state])

    create constraint(:run_workspace_assignments, :run_workspace_assignments_state_valid,
             check:
               "state IN ('waiting_for_host','provisioning','ready','attention_required','failed','retained','cleanup_requested','removed')"
           )

    create constraint(:run_workspace_assignments, :run_workspace_assignments_revision_positive,
             check: "provision_revision > 0"
           )
  end

  def down do
    drop table(:run_workspace_assignments)
    drop table(:worker_workspace_bindings)
    drop index(:product_quests, [:workspace_id])
    alter table(:product_quests), do: remove(:workspace_id)
    drop table(:product_workspaces)
  end
end
