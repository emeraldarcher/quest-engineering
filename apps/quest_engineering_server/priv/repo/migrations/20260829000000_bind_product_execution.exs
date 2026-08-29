defmodule QuestEngineering.Server.Repo.Migrations.BindProductExecution do
  use Ecto.Migration

  def up do
    alter table(:runtime_outbox) do
      add :emission_index, :bigint
    end

    execute("""
    WITH ordered AS (
      SELECT id,
             row_number() OVER (PARTITION BY run_id, run_revision ORDER BY id) - 1 AS ordinal
      FROM runtime_outbox
    )
    UPDATE runtime_outbox AS outbox
    SET emission_index = ordered.ordinal
    FROM ordered
    WHERE outbox.id = ordered.id
    """)

    alter table(:runtime_outbox) do
      modify :emission_index, :bigint, null: false
    end

    create unique_index(:runtime_outbox, [:run_id, :run_revision, :emission_index],
             name: :runtime_outbox_emission_order_index
           )

    create index(:runtime_outbox, [:run_id, :run_revision, :emission_index],
             name: :runtime_outbox_scheduling_order_index
           )

    create table(:quest_launches, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :quest_id, references(:product_quests, type: :uuid, on_delete: :restrict), null: false
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict), null: false
      add :snapshot_version, :integer, null: false
      add :snapshot, :map, null: false

      timestamps(type: :utc_datetime_usec, updated_at: false)
    end

    create unique_index(:quest_launches, [:run_id])
    create index(:quest_launches, [:quest_id])

    create constraint(:quest_launches, :quest_launches_snapshot_version_positive,
             check: "snapshot_version > 0"
           )

    create table(:occurrence_member_bindings, primary_key: false) do
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict),
        primary_key: true,
        null: false

      add :occurrence_id, :text, primary_key: true, null: false
      add :member_key, :text, null: false
      add :bound_at, :utc_datetime_usec, null: false
    end

    create table(:occurrence_context_bindings, primary_key: false) do
      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict),
        primary_key: true,
        null: false

      add :occurrence_id, :text, primary_key: true, null: false
      add :logical_lineage_id, :uuid, null: false
      add :source_occurrence_id, :text
      add :bound_at, :utc_datetime_usec, null: false
    end

    create index(:occurrence_context_bindings, [:run_id, :logical_lineage_id])

    create table(:scheduled_action_executions, primary_key: false) do
      add :action_id,
          references(:runtime_outbox, column: :action_id, type: :text, on_delete: :restrict),
          primary_key: true,
          null: false

      add :run_id, references(:runtime_runs, type: :text, on_delete: :restrict), null: false
      add :occurrence_id, :text, null: false
      add :member_key, :text, null: false
      add :logical_lineage_id, :uuid, null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :state, :text, null: false
      add :resolved_execution_version, :integer, null: false
      add :resolved_execution, :map, null: false
      add :bound_at, :utc_datetime_usec, null: false
      add :terminal_at, :utc_datetime_usec
      add :failure, :map
    end

    create constraint(:scheduled_action_executions, :scheduled_action_executions_state_valid,
             check: "state IN ('active', 'completed', 'failed')"
           )

    create constraint(
             :scheduled_action_executions,
             :scheduled_action_executions_version_positive,
             check: "resolved_execution_version > 0"
           )

    create unique_index(:scheduled_action_executions, [:run_id, :member_key],
             where: "state = 'active'",
             name: :scheduled_action_executions_active_member_index
           )

    create unique_index(:scheduled_action_executions, [:run_id, :logical_lineage_id],
             where: "state = 'active'",
             name: :scheduled_action_executions_active_context_index
           )

    execute("""
    ALTER TABLE scheduled_action_executions
    ADD CONSTRAINT scheduled_action_executions_member_binding_fkey
    FOREIGN KEY (run_id, occurrence_id)
    REFERENCES occurrence_member_bindings(run_id, occurrence_id)
    ON DELETE RESTRICT
    """)

    execute("""
    ALTER TABLE scheduled_action_executions
    ADD CONSTRAINT scheduled_action_executions_context_binding_fkey
    FOREIGN KEY (run_id, occurrence_id)
    REFERENCES occurrence_context_bindings(run_id, occurrence_id)
    ON DELETE RESTRICT
    """)

    alter table(:worker_dispatches) do
      add :worker_slot, :integer
    end

    execute("""
    WITH slotted AS (
      SELECT id,
             row_number() OVER (PARTITION BY worker_id ORDER BY id) - 1 AS slot
      FROM worker_dispatches
      WHERE state IN ('claimed', 'dispatched', 'acknowledged', 'running')
    )
    UPDATE worker_dispatches AS dispatch
    SET worker_slot = slotted.slot
    FROM slotted
    WHERE dispatch.id = slotted.id
    """)

    drop constraint(:worker_dispatches, :worker_dispatches_state_valid)

    create constraint(:worker_dispatches, :worker_dispatches_state_valid,
             check:
               "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'completed', 'failed', 'uncertain')"
           )

    create constraint(:worker_dispatches, :worker_dispatches_slot_valid,
             check: "worker_slot IS NULL OR worker_slot >= 0"
           )

    create constraint(:worker_dispatches, :worker_dispatches_nonterminal_slot_required,
             check:
               "state NOT IN ('claimed', 'dispatched', 'acknowledged', 'running', 'uncertain') OR worker_slot IS NOT NULL"
           )

    create unique_index(:worker_dispatches, [:worker_id, :worker_slot],
             where: "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'uncertain')",
             name: :worker_dispatches_active_slot_index
           )
  end

  def down do
    drop index(:worker_dispatches, [:worker_id, :worker_slot],
           name: :worker_dispatches_active_slot_index
         )

    drop constraint(:worker_dispatches, :worker_dispatches_nonterminal_slot_required)
    drop constraint(:worker_dispatches, :worker_dispatches_slot_valid)
    drop constraint(:worker_dispatches, :worker_dispatches_state_valid)

    create constraint(:worker_dispatches, :worker_dispatches_state_valid,
             check:
               "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'completed', 'failed')"
           )

    alter table(:worker_dispatches) do
      remove :worker_slot
    end

    drop table(:scheduled_action_executions)
    drop table(:occurrence_context_bindings)
    drop table(:occurrence_member_bindings)
    drop table(:quest_launches)

    drop index(:runtime_outbox, [:run_id, :run_revision, :emission_index],
           name: :runtime_outbox_scheduling_order_index
         )

    drop index(:runtime_outbox, [:run_id, :run_revision, :emission_index],
           name: :runtime_outbox_emission_order_index
         )

    alter table(:runtime_outbox) do
      remove :emission_index
    end
  end
end
