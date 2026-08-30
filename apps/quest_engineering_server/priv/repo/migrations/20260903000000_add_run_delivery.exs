defmodule QuestEngineering.Server.Repo.Migrations.AddRunDelivery do
  use Ecto.Migration

  def up do
    alter table(:product_quests) do
      add :completed_at, :utc_datetime_usec
      add :completed_by_run_id, references(:runtime_runs, type: :text, on_delete: :restrict)
    end

    create index(:product_quests, [:completed_by_run_id])

    alter table(:worker_workspace_candidates) do
      add :publication_remote_name, :text
      add :publication_repository_identity, :text
    end

    alter table(:worker_workspace_bindings) do
      add :publication_remote_name, :text
      add :publication_repository_identity, :text
    end

    alter table(:run_workspace_assignments) do
      add :base_branch_name, :text
      add :publication_remote_name, :text
      add :publication_repository_identity, :text
      add :retention_confirmed_at, :utc_datetime_usec
    end

    create table(:run_deliveries, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict), null: false
      add :quest_id, references(:product_quests, type: :uuid, on_delete: :restrict), null: false
      add :state, :text, null: false
      add :command_revision, :integer, null: false, default: 1
      add :automatic_attempted_at, :utc_datetime_usec
      add :retry_requested_at, :utc_datetime_usec
      add :base_revision, :text
      add :base_branch_name, :text
      add :head_before_finalize, :text
      add :head_revision, :text
      add :branch_name, :text
      add :change_evidence_version, :integer
      add :change_evidence, :map
      add :change_fingerprint, :text
      add :provider, :text
      add :repository_host, :text
      add :repository_identity, :text
      add :remote_name, :text
      add :pull_request_number, :bigint
      add :pull_request_url, :text
      add :pull_request_state, :text
      add :pull_request_base_branch, :text
      add :pull_request_head_repository, :text
      add :pull_request_head_branch, :text
      add :pull_request_head_revision, :text
      add :published_at, :utc_datetime_usec
      add :review_created_at, :utc_datetime_usec
      add :last_reconciled_at, :utc_datetime_usec
      add :merged_at, :utc_datetime_usec
      add :closed_at, :utc_datetime_usec
      add :failure_stage, :text
      add :failure_code, :text
      add :failure_details, :map
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:run_deliveries, [:run_id])
    create index(:run_deliveries, [:quest_id, :inserted_at])

    create unique_index(:run_deliveries, [:provider, :repository_identity, :pull_request_number],
             where: "pull_request_number IS NOT NULL",
             name: :run_deliveries_provider_pull_request_index
           )

    create unique_index(:run_deliveries, [:quest_id],
             where:
               "state IN ('pending','preparing','publishing','creating_review','review_open')",
             name: :run_deliveries_active_quest_index
           )

    create constraint(:run_deliveries, :run_deliveries_state_valid,
             check:
               "state IN ('pending','preparing','publishing','creating_review','review_open','merged','closed_unmerged','no_changes','attention_required')"
           )

    create constraint(:run_deliveries, :run_deliveries_revision_positive,
             check: "command_revision > 0"
           )

    create table(:workspace_binding_attempts, primary_key: false) do
      add :binding_id, :uuid, primary_key: true

      add :workspace_id, references(:product_workspaces, type: :uuid, on_delete: :restrict),
        null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :candidate_id,
          references(:worker_workspace_candidates,
            column: :candidate_id,
            type: :text,
            on_delete: :restrict
          ),
          null: false

      add :state, :text, null: false
      add :failure_code, :text
      add :failure_details, :map
      timestamps(type: :utc_datetime_usec)
    end

    create index(:workspace_binding_attempts, [:workspace_id, :inserted_at])

    create constraint(:workspace_binding_attempts, :workspace_binding_attempts_state_valid,
             check: "state IN ('pending','available','attention_required','offline')"
           )
  end

  def down do
    drop table(:workspace_binding_attempts)
    drop table(:run_deliveries)

    alter table(:run_workspace_assignments) do
      remove :base_branch_name
      remove :publication_remote_name
      remove :publication_repository_identity
      remove :retention_confirmed_at
    end

    alter table(:worker_workspace_bindings) do
      remove :publication_remote_name
      remove :publication_repository_identity
    end

    alter table(:worker_workspace_candidates) do
      remove :publication_remote_name
      remove :publication_repository_identity
    end

    drop index(:product_quests, [:completed_by_run_id])

    alter table(:product_quests) do
      remove :completed_at
      remove :completed_by_run_id
    end
  end
end
