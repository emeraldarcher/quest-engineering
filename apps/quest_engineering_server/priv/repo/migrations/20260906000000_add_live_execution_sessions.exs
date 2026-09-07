defmodule QuestEngineering.Server.Repo.Migrations.AddLiveExecutionSessions do
  use Ecto.Migration

  def change do
    create table(:execution_sessions, primary_key: false) do
      add :id, :text, primary_key: true

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :current_action_id,
          references(:runtime_outbox, column: :action_id, type: :text, on_delete: :restrict)

      add :harness_kind, :text, null: false
      add :harness_display_name, :text, null: false
      add :state, :text, null: false
      add :capabilities, :map, null: false
      add :terminal, :map
      add :provider_session_id, :text
      add :attention, :map
      add :last_connection_generation, :bigint, null: false
      add :started_at, :utc_datetime_usec, null: false
      add :last_activity_at, :utc_datetime_usec, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create index(:execution_sessions, [:worker_id, :state])
    create index(:execution_sessions, [:current_action_id])

    create constraint(:execution_sessions, :execution_sessions_state_valid,
             check:
               "state IN ('starting','running','waiting_for_human','recovering','retained','closed','unavailable')"
           )

    alter table(:worker_dispatches) do
      add :execution_session_id,
          references(:execution_sessions, column: :id, type: :text, on_delete: :restrict)
    end

    create index(:worker_dispatches, [:execution_session_id])

    create table(:execution_session_audit_events, primary_key: false) do
      add :id, :uuid, primary_key: true

      add :session_id,
          references(:execution_sessions, column: :id, type: :text, on_delete: :restrict),
          null: false

      add :event_type, :text, null: false
      add :attention_id, :text
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict), null: false

      add :action_id,
          references(:runtime_outbox, column: :action_id, type: :text, on_delete: :restrict),
          null: false

      add :occurrence_id, :text, null: false
      add :attempt_id, :text, null: false
      add :metadata, :map, null: false, default: %{}
      add :occurred_at, :utc_datetime_usec, null: false

      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create index(:execution_session_audit_events, [:run_id, :occurred_at])

    create unique_index(
             :execution_session_audit_events,
             [:session_id, :event_type, :attention_id],
             where: "attention_id IS NOT NULL",
             name: :execution_session_attention_audit_dedupe_index
           )

    create constraint(:execution_session_audit_events, :execution_session_audit_event_type_valid,
             check:
               "event_type IN ('attention_requested','attachment_descriptor_issued','local_session_opened','attention_resolved')"
           )
  end
end
