defmodule QuestEngineering.Server.Repo.Migrations.AddOperationalRecoveryEpochs do
  use Ecto.Migration

  def up do
    create table(:operational_recovery_epochs, primary_key: false) do
      add :id, :uuid, primary_key: true

      add :run_id, references(:runtime_runs, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :occurrence_id, :text, null: false
      add :epoch_number, :integer, null: false
      add :authorization_kind, :text, null: false
      add :source_attempt_id, :text
      add :request_id, :text
      add :attempt_allowance, :integer
      add :policy_source, :text, null: false

      add :retained_session_id,
          references(:execution_sessions, column: :id, type: :text, on_delete: :restrict)

      add :retained_lineage_id, :text
      add :continuation_mode, :text, null: false
      add :authorized_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:operational_recovery_epochs, [:run_id, :occurrence_id, :epoch_number],
             name: :operational_recovery_epochs_number_index
           )

    create unique_index(:operational_recovery_epochs, [:request_id],
             where: "request_id IS NOT NULL",
             name: :operational_recovery_epochs_request_index
           )

    create constraint(:operational_recovery_epochs, :operational_recovery_epochs_number_valid,
             check: "epoch_number >= 0"
           )

    create constraint(:operational_recovery_epochs, :operational_recovery_epochs_kind_valid,
             check: "authorization_kind IN ('initial', 'human')"
           )

    create constraint(:operational_recovery_epochs, :operational_recovery_epochs_policy_valid,
             check: "policy_source IN ('configured', 'legacy_unknown')"
           )

    create constraint(:operational_recovery_epochs, :operational_recovery_epochs_allowance_valid,
             check:
               "(policy_source = 'legacy_unknown' AND attempt_allowance IS NULL) OR (policy_source = 'configured' AND attempt_allowance > 0)"
           )

    create constraint(
             :operational_recovery_epochs,
             :operational_recovery_epochs_authorization_valid,
             check:
               "(authorization_kind = 'initial' AND epoch_number = 0 AND source_attempt_id IS NULL AND request_id IS NULL) OR (authorization_kind = 'human' AND epoch_number > 0 AND source_attempt_id IS NOT NULL AND request_id IS NOT NULL)"
           )

    create constraint(
             :operational_recovery_epochs,
             :operational_recovery_epochs_continuation_valid,
             check: "continuation_mode IN ('fresh', 'retained')"
           )

    create table(:operational_attempt_attributions, primary_key: false) do
      add :action_id,
          references(:runtime_outbox, column: :action_id, type: :text, on_delete: :restrict),
          primary_key: true

      add :epoch_id,
          references(:operational_recovery_epochs,
            column: :id,
            type: :uuid,
            on_delete: :restrict
          ),
          null: false

      add :run_id, :text, null: false
      add :occurrence_id, :text, null: false
      add :attempt_id, :text, null: false
      add :global_attempt_number, :integer, null: false
      add :attempt_in_epoch, :integer, null: false
      add :scheduled_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:operational_attempt_attributions, [:attempt_id],
             name: :operational_attempt_attributions_attempt_index
           )

    create unique_index(:operational_attempt_attributions, [:epoch_id, :attempt_in_epoch],
             name: :operational_attempt_attributions_epoch_position_index
           )

    create constraint(:operational_attempt_attributions, :operational_attempt_numbers_valid,
             check: "global_attempt_number > 0 AND attempt_in_epoch > 0"
           )

    execute("""
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM scheduled_action_executions
        WHERE action_id !~ '/attempt/[0-9]+/action/execute-step$'
      ) THEN
        RAISE EXCEPTION 'cannot backfill operational attempts: an existing Action ID has no deterministic Attempt number';
      END IF;
    END $$;
    """)

    execute("""
    INSERT INTO operational_recovery_epochs
      (id, run_id, occurrence_id, epoch_number, authorization_kind, attempt_allowance,
       policy_source, continuation_mode, authorized_at, inserted_at, updated_at)
    SELECT gen_random_uuid(), run_id, occurrence_id, 0, 'initial', NULL,
           'legacy_unknown', 'fresh', MIN(bound_at), MIN(bound_at), MIN(bound_at)
    FROM scheduled_action_executions
    GROUP BY run_id, occurrence_id
    """)

    execute("""
    INSERT INTO operational_attempt_attributions
      (action_id, epoch_id, run_id, occurrence_id, attempt_id, global_attempt_number,
       attempt_in_epoch, scheduled_at, inserted_at)
    SELECT s.action_id, e.id, s.run_id, s.occurrence_id,
           regexp_replace(s.action_id, '/action/execute-step$', ''),
           substring(s.action_id from '/attempt/([0-9]+)/action/execute-step$')::integer,
           substring(s.action_id from '/attempt/([0-9]+)/action/execute-step$')::integer,
           s.bound_at, s.bound_at
    FROM scheduled_action_executions s
    JOIN operational_recovery_epochs e
      ON e.run_id = s.run_id AND e.occurrence_id = s.occurrence_id AND e.epoch_number = 0
    """)
  end

  def down do
    drop table(:operational_attempt_attributions)
    drop table(:operational_recovery_epochs)
  end
end
