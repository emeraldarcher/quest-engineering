defmodule QuestEngineering.Server.Repo.Migrations.AddRunProjectionIndexes do
  use Ecto.Migration

  def change do
    create index(:scheduled_action_executions, [:run_id])
    create index(:quest_launches, [:inserted_at])
  end
end
