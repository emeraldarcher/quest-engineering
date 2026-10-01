defmodule QuestEngineering.Server.Repo.Migrations.AddWorkerReadyGeneration do
  use Ecto.Migration

  def change do
    alter table(:workers) do
      add :ready_generation, :integer
      add :ready_at, :utc_datetime_usec
    end

    create constraint(:workers, :workers_ready_generation_valid,
             check:
               "(ready_generation IS NULL AND ready_at IS NULL) OR " <>
                 "(ready_generation = connection_generation AND ready_generation > 0 AND ready_at IS NOT NULL)"
           )
  end
end
