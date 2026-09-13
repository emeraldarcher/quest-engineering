defmodule QuestEngineering.Server.Repo.Migrations.AddMultiHarnessExecution do
  use Ecto.Migration

  def up do
    alter table(:product_loadouts) do
      add :harness_kind, :text
    end

    execute("UPDATE product_loadouts SET harness_kind = 'pi' WHERE harness_kind IS NULL")
    execute("ALTER TABLE product_loadouts ALTER COLUMN harness_kind SET NOT NULL")

    create constraint(:product_loadouts, :product_loadouts_harness_kind_valid,
             check: "harness_kind ~ '^[a-z][a-z0-9_-]*$'"
           )
  end

  def down do
    drop constraint(:product_loadouts, :product_loadouts_harness_kind_valid)

    alter table(:product_loadouts) do
      remove :harness_kind
    end
  end
end
