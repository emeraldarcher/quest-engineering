defmodule QuestEngineering.Server.Repo.Migrations.AddWorkerDispatchSlotRelease do
  use Ecto.Migration

  def up do
    alter table(:worker_dispatches) do
      add :slot_released_at, :utc_datetime_usec
    end

    drop index(:worker_dispatches, [:worker_id, :worker_slot],
           name: :worker_dispatches_active_slot_index
         )

    create unique_index(:worker_dispatches, [:worker_id, :worker_slot],
             where:
               "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'uncertain') AND slot_released_at IS NULL",
             name: :worker_dispatches_active_slot_index
           )
  end

  def down do
    drop index(:worker_dispatches, [:worker_id, :worker_slot],
           name: :worker_dispatches_active_slot_index
         )

    create unique_index(:worker_dispatches, [:worker_id, :worker_slot],
             where: "state IN ('claimed', 'dispatched', 'acknowledged', 'running', 'uncertain')",
             name: :worker_dispatches_active_slot_index
           )

    alter table(:worker_dispatches) do
      remove :slot_released_at
    end
  end
end
