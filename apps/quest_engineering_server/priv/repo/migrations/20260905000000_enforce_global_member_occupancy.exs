defmodule QuestEngineering.Server.Repo.Migrations.EnforceGlobalMemberOccupancy do
  use Ecto.Migration

  def up do
    alter table(:scheduled_action_executions) do
      add :squad_id, references(:product_squads, type: :uuid, on_delete: :restrict)
    end

    execute("""
    WITH frozen_squads AS (
      SELECT launch.run_id, (id_pair ->> 1)::uuid AS squad_id
      FROM quest_launches AS launch
      CROSS JOIN LATERAL jsonb_array_elements(launch.snapshot -> 'fields' -> '$map') AS squad_pair
      CROSS JOIN LATERAL jsonb_array_elements((squad_pair -> 1) -> 'fields' -> '$map') AS id_pair
      WHERE squad_pair -> 0 ->> '$atom' = 'squad'
        AND id_pair -> 0 ->> '$atom' = 'id'
    )
    UPDATE scheduled_action_executions AS execution
    SET squad_id = frozen_squads.squad_id
    FROM frozen_squads
    WHERE execution.run_id = frozen_squads.run_id
    """)

    execute("""
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM scheduled_action_executions WHERE squad_id IS NULL) THEN
        RAISE EXCEPTION 'cannot backfill frozen squad identity for every scheduled execution';
      END IF;
    END
    $$
    """)

    execute("""
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM scheduled_action_executions
        WHERE state = 'active'
        GROUP BY squad_id, member_key
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'existing active executions conflict on frozen logical Member identity';
      END IF;
    END
    $$
    """)

    alter table(:scheduled_action_executions) do
      modify :squad_id, :uuid, null: false
    end

    drop index(:scheduled_action_executions, [:run_id, :member_key],
           name: :scheduled_action_executions_active_member_index
         )

    create unique_index(:scheduled_action_executions, [:squad_id, :member_key],
             where: "state = 'active'",
             name: :scheduled_action_executions_active_member_index
           )
  end

  def down do
    drop index(:scheduled_action_executions, [:squad_id, :member_key],
           name: :scheduled_action_executions_active_member_index
         )

    create unique_index(:scheduled_action_executions, [:run_id, :member_key],
             where: "state = 'active'",
             name: :scheduled_action_executions_active_member_index
           )

    alter table(:scheduled_action_executions) do
      remove :squad_id
    end
  end
end
