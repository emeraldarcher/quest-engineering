defmodule QuestEngineering.Server.Repo.Migrations.CreateRuntimePersistence do
  use Ecto.Migration

  def change do
    create table(:runtime_runs, primary_key: false) do
      add :id, :text, primary_key: true
      add :snapshot, :map, null: false
      add :snapshot_version, :integer, null: false
      add :status, :text, null: false
      add :revision, :bigint, null: false, default: 0

      timestamps(type: :utc_datetime_usec)
    end

    create constraint(:runtime_runs, :runtime_runs_revision_non_negative, check: "revision >= 0")

    create constraint(:runtime_runs, :runtime_runs_status_valid,
             check: "status IN ('running', 'completed', 'failed')"
           )

    create table(:runtime_transitions) do
      add :run_id,
          references(:runtime_runs, type: :text, on_delete: :restrict),
          null: false

      add :transition_id, :text, null: false
      add :resulting_revision, :bigint, null: false
      add :event_payload, :map, null: false
      add :result_snapshot, :map, null: false
      add :snapshot_version, :integer, null: false
      add :resulting_status, :text, null: false
      add :action_ids, {:array, :text}, null: false, default: []

      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:runtime_transitions, [:run_id, :transition_id],
             name: :runtime_transitions_run_transition_id_index
           )

    create unique_index(:runtime_transitions, [:run_id, :resulting_revision],
             name: :runtime_transitions_run_revision_index
           )

    create constraint(:runtime_transitions, :runtime_transitions_revision_positive,
             check: "resulting_revision > 0"
           )

    create constraint(:runtime_transitions, :runtime_transitions_status_valid,
             check: "resulting_status IN ('running', 'completed', 'failed')"
           )

    create table(:runtime_outbox) do
      add :action_id, :text, null: false

      add :run_id,
          references(:runtime_runs, type: :text, on_delete: :restrict),
          null: false

      add :run_revision, :bigint, null: false
      add :action_type, :text, null: false
      add :payload, :map, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:runtime_outbox, [:action_id], name: :runtime_outbox_action_id_index)
    create index(:runtime_outbox, [:id], name: :runtime_outbox_claim_lookup_index)
    create index(:runtime_outbox, [:run_id, :id], name: :runtime_outbox_run_lookup_index)

    create constraint(:runtime_outbox, :runtime_outbox_revision_non_negative,
             check: "run_revision >= 0"
           )

    create table(:workers, primary_key: false) do
      add :id, :text, primary_key: true
      add :capabilities, :map, null: false
      add :max_concurrency, :integer, null: false
      add :active_dispatches, :integer, null: false, default: 0
      add :status, :text, null: false
      add :connection_id, :text
      add :connection_generation, :bigint, null: false, default: 0
      add :connected_at, :utc_datetime_usec
      add :disconnected_at, :utc_datetime_usec
      add :last_heartbeat_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create constraint(:workers, :workers_status_valid,
             check: "status IN ('connected', 'disconnected')"
           )

    create constraint(:workers, :workers_max_concurrency_positive, check: "max_concurrency > 0")

    create constraint(:workers, :workers_active_dispatches_valid,
             check: "active_dispatches >= 0 AND active_dispatches <= max_concurrency"
           )

    create table(:worker_dispatches) do
      add :action_id,
          references(:runtime_outbox,
            column: :action_id,
            type: :text,
            on_delete: :restrict
          ),
          null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :state, :text, null: false
      add :payload_hash, :text, null: false
      add :claim_owner, :text, null: false
      add :claim_token, :text, null: false
      add :claim_expires_at, :utc_datetime_usec, null: false
      add :last_connection_generation, :bigint
      add :dispatched_at, :utc_datetime_usec
      add :acknowledged_at, :utc_datetime_usec
      add :terminal_at, :utc_datetime_usec
      add :failure, :map

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:worker_dispatches, [:action_id],
             name: :worker_dispatches_action_id_index
           )

    create index(:worker_dispatches, [:worker_id, :state],
             name: :worker_dispatches_worker_state_index
           )

    create index(:worker_dispatches, [:state, :claim_expires_at],
             name: :worker_dispatches_reclaim_index
           )

    create constraint(:worker_dispatches, :worker_dispatches_state_valid,
             check:
               "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'completed', 'failed')"
           )

    create table(:worker_reconciliation_anomalies) do
      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :action_id, :text, null: false
      add :type, :text, null: false
      add :details, :map, null: false, default: %{}
      add :status, :text, null: false, default: "open"

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:worker_reconciliation_anomalies, [:worker_id, :action_id, :type],
             name: :worker_reconciliation_anomalies_identity_index
           )

    create constraint(:worker_reconciliation_anomalies, :worker_anomalies_type_valid,
             check: "type IN ('dispatch_missing_on_worker', 'dispatch_unknown_to_server')"
           )

    create constraint(:worker_reconciliation_anomalies, :worker_anomalies_status_valid,
             check: "status IN ('open', 'resolved')"
           )
  end
end
