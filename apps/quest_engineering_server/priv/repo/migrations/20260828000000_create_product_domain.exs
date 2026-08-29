defmodule QuestEngineering.Server.Repo.Migrations.CreateProductDomain do
  use Ecto.Migration

  def change do
    create table(:product_classes, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :key, :text, null: false
      add :name, :text, null: false
      add :description, :text, null: false, default: ""
      add :instructions, :text, null: false
      add :archived_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:product_classes, [:key])

    create table(:product_loadouts, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :key, :text, null: false
      add :name, :text, null: false
      add :description, :text, null: false, default: ""
      add :model_provider, :text, null: false
      add :model_name, :text, null: false
      add :reasoning, :text, null: false
      add :tools, {:array, :text}, null: false, default: []
      add :workspace_access, :text, null: false
      add :archived_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:product_loadouts, [:key])

    create constraint(:product_loadouts, :product_loadouts_reasoning_valid,
             check: "reasoning IN ('low', 'medium', 'high')"
           )

    create constraint(:product_loadouts, :product_loadouts_workspace_access_valid,
             check: "workspace_access IN ('none', 'read_only', 'read_write')"
           )

    create table(:product_squads, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :key, :text, null: false
      add :name, :text, null: false
      add :description, :text, null: false, default: ""
      add :archived_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:product_squads, [:key])

    create table(:product_squad_members, primary_key: false) do
      add :squad_id,
          references(:product_squads, type: :uuid, on_delete: :restrict),
          primary_key: true,
          null: false

      add :member_key, :text, primary_key: true, null: false
      add :name, :text, null: false

      add :class_id,
          references(:product_classes, type: :uuid, on_delete: :restrict),
          null: false

      add :loadout_id,
          references(:product_loadouts, type: :uuid, on_delete: :restrict),
          null: false

      add :position, :integer, null: false
    end

    create unique_index(:product_squad_members, [:squad_id, :position])
    create index(:product_squad_members, [:class_id])
    create index(:product_squad_members, [:loadout_id])

    create constraint(:product_squad_members, :product_squad_members_position_non_negative,
             check: "position >= 0"
           )

    create table(:product_quests, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :title, :text, null: false
      add :objective, :text, null: false
      add :workspace_ref, :text, null: false

      add :squad_id,
          references(:product_squads, type: :uuid, on_delete: :restrict),
          null: false

      add :tactic, :map, null: false
      add :archived_at, :utc_datetime_usec

      timestamps(type: :utc_datetime_usec)
    end

    create index(:product_quests, [:squad_id])
    create index(:product_quests, [:archived_at])
    create index(:product_classes, [:archived_at])
    create index(:product_loadouts, [:archived_at])
    create index(:product_squads, [:archived_at])
  end
end
