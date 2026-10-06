defmodule QuestEngineering.Server.Repo.Migrations.AddRunResourceCleanup do
  use Ecto.Migration

  def change do
    alter table(:run_workspace_assignments) do
      add :cleanup_resources, :map
      add :cleanup_updated_at, :utc_datetime_usec
    end
  end
end
