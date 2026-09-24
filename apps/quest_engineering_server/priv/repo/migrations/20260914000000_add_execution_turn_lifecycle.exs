defmodule QuestEngineering.Server.Repo.Migrations.AddExecutionTurnLifecycle do
  use Ecto.Migration

  def change do
    alter table(:execution_sessions) do
      add :turn, :map
    end
  end
end
