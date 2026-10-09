defmodule QuestEngineering.Server.Repo.Migrations.AddRunBoundHarnessSetup do
  use Ecto.Migration

  def change do
    create table(:harness_setup_contexts, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :run_id, references(:runtime_runs, type: :string, on_delete: :nothing), null: false
      add :action_id, :string, null: false
      add :occurrence_id, :string, null: false
      add :member_key, :string, null: false
      add :harness_kind, :string, null: false
      add :worker_id, references(:workers, type: :string, on_delete: :nothing), null: false
      add :worker_generation, :bigint, null: false
      add :workspace_id, :uuid, null: false
      add :worktree_id, :uuid, null: false
      add :workspace_binding_id, :uuid, null: false
      add :canonical_root, :string, null: false
      add :workspace_access, :string, null: false
      add :logical_lineage_id, :uuid, null: false
      add :physical_lineage_id, :uuid, null: false
      add :profile_id, :string, null: false
      add :profile_digest, :string, null: false
      add :setup_generation, :integer, null: false, default: 1
      add :state, :string, null: false
      add :invocation_state, :string, null: false
      add :resolved_configuration, :map, null: false
      add :environment_id, :string
      add :environment_incarnation, :string
      add :config_identity, :string
      add :attention, :map
      add :failure, :map
      add :cancellation_request_id, :string
      add :invocation_requested_at, :utc_datetime_usec
      add :invocation_acknowledged_at, :utc_datetime_usec
      add :ready_at, :utc_datetime_usec
      add :cancelled_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:harness_setup_contexts, [:action_id, :setup_generation])
    create index(:harness_setup_contexts, [:physical_lineage_id])
    create index(:harness_setup_contexts, [:run_id, :occurrence_id])
    create index(:harness_setup_contexts, [:worker_id, :state])

    create constraint(:harness_setup_contexts, :harness_setup_contexts_state_valid,
             check:
               "state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','cancellation_requested','ready','failed','uncertain','cancelled','invalidated')"
           )

    create constraint(:harness_setup_contexts, :harness_setup_contexts_invocation_state_valid,
             check:
               "invocation_state IN ('not_requested','requested','acknowledged','settled','uncertain')"
           )

    create constraint(:harness_setup_contexts, :harness_setup_contexts_generation_positive,
             check: "setup_generation > 0"
           )

    create table(:harness_setup_authorizations, primary_key: false) do
      add :id, :uuid, primary_key: true

      add :setup_context_id,
          references(:harness_setup_contexts, type: :uuid, on_delete: :nothing),
          null: false

      add :setup_generation, :integer, null: false
      add :request_id, :string, null: false
      add :kind, :string, null: false
      add :authorized_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:harness_setup_authorizations, [:request_id])
    create unique_index(:harness_setup_authorizations, [:setup_context_id, :setup_generation])

    create constraint(
             :harness_setup_authorizations,
             :harness_setup_authorizations_kind_valid,
             check: "kind = 'human_harness_setup'"
           )
  end
end
