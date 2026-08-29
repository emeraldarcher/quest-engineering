defmodule QuestEngineering.Server.Repo.Migrations.AddReusableTactics do
  use Ecto.Migration

  def up do
    create table(:product_tactics, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :key, :text, null: false
      add :name, :text, null: false
      add :description, :text, null: false, default: ""
      add :body, :map, null: false
      add :archived_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:product_tactics, [:key])
    create index(:product_tactics, [:archived_at])

    rename table(:product_quests), :tactic, to: :inline_tactic

    alter table(:product_quests) do
      add :tactic_source_type, :text, null: false, default: "inline"

      add :tactic_definition_id,
          references(:product_tactics, type: :uuid, on_delete: :restrict)

      modify :inline_tactic, :map, null: true
    end

    create index(:product_quests, [:tactic_definition_id])

    create constraint(:product_quests, :product_quests_tactic_source_valid,
             check: """
             (tactic_source_type = 'inline' AND inline_tactic IS NOT NULL AND tactic_definition_id IS NULL)
             OR
             (tactic_source_type = 'definition' AND inline_tactic IS NULL AND tactic_definition_id IS NOT NULL)
             """
           )
  end

  def down do
    drop constraint(:product_quests, :product_quests_tactic_source_valid)
    drop index(:product_quests, [:tactic_definition_id])

    alter table(:product_quests) do
      modify :inline_tactic, :map, null: false
      remove :tactic_definition_id
      remove :tactic_source_type
    end

    rename table(:product_quests), :inline_tactic, to: :tactic
    drop table(:product_tactics)
  end
end
