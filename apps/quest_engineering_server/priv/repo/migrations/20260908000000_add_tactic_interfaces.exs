defmodule QuestEngineering.Server.Repo.Migrations.AddTacticInterfaces do
  use Ecto.Migration

  def change do
    alter table(:product_tactics) do
      add :interface, :map, null: false, default: %{"inputs" => [], "outputs" => []}
    end
  end
end
