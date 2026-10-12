defmodule QuestEngineering.Server.Repo.Migrations.AddDurableBlockingHumanAttention do
  use Ecto.Migration

  def up do
    create table(:human_attention_requests, primary_key: false) do
      add :id, :text, primary_key: true

      add :session_id,
          references(:execution_sessions, column: :id, type: :text, on_delete: :restrict),
          null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict), null: false

      add :action_id,
          references(:runtime_outbox, column: :action_id, type: :text, on_delete: :restrict),
          null: false

      add :occurrence_id, :text, null: false
      add :attempt_id, :text, null: false
      add :native_session_id, :text
      add :request_generation, :bigint, null: false
      add :request, :map, null: false
      add :response_state, :text, null: false
      add :response, :map
      add :response_request_id, :text
      add :response_submitted_at, :utc_datetime_usec
      add :response_committed_at, :utc_datetime_usec
      add :delivery_state, :text, null: false
      add :delivery_attempt_id, :text
      add :delivery_requested_generation, :bigint
      add :delivery_requested_at, :utc_datetime_usec
      add :delivery_acknowledged_at, :utc_datetime_usec
      add :delivery_uncertain_at, :utc_datetime_usec
      add :cancelled_at, :utc_datetime_usec
      add :cancellation_reason, :text
      add :surfaced_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    execute("""
    UPDATE execution_sessions
    SET attention = jsonb_build_object(
      'request_generation', 1,
      'response_state', 'pending',
      'delivery_state', 'response_not_delivered'
    ) || attention
    WHERE attention IS NOT NULL
    """)

    create index(:human_attention_requests, [:session_id, :inserted_at])
    create index(:human_attention_requests, [:worker_id, :delivery_state])
    create index(:human_attention_requests, [:run_id, :attempt_id])

    create unique_index(:human_attention_requests, [:action_id],
             where:
               "response_state = 'pending' OR (response_state = 'responded' AND delivery_state != 'delivery_acknowledged')",
             name: :human_attention_requests_one_active_per_action
           )

    create constraint(:human_attention_requests, :human_attention_response_state_valid,
             check: "response_state IN ('pending','responded','cancelled','obsolete')"
           )

    create constraint(:human_attention_requests, :human_attention_delivery_state_valid,
             check:
               "delivery_state IN ('response_not_delivered','delivery_requested','delivery_acknowledged','delivery_uncertain')"
           )

    create constraint(:human_attention_requests, :human_attention_request_generation_valid,
             check: "request_generation > 0"
           )

    drop constraint(:execution_session_audit_events, :execution_session_audit_event_type_valid)

    create constraint(:execution_session_audit_events, :execution_session_audit_event_type_valid,
             check:
               "event_type IN ('attention_requested','attention_response_committed','attention_delivery_requested','attention_delivery_acknowledged','attention_delivery_uncertain','attention_cancelled','attachment_descriptor_issued','local_session_opened','attention_resolved')"
           )
  end

  def down do
    execute("""
    UPDATE execution_sessions
    SET attention = attention
      - 'request_generation'
      - 'response_state'
      - 'delivery_state'
      - 'delivery_attempt_id'
    WHERE attention IS NOT NULL
    """)

    drop constraint(:execution_session_audit_events, :execution_session_audit_event_type_valid)

    create constraint(:execution_session_audit_events, :execution_session_audit_event_type_valid,
             check:
               "event_type IN ('attention_requested','attachment_descriptor_issued','local_session_opened','attention_resolved')"
           )

    drop table(:human_attention_requests)
  end
end
