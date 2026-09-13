defmodule QuestEngineering.Server.Repo.Migrations.TightenEffortAndToolSemantics do
  use Ecto.Migration

  def up do
    drop constraint(:product_loadouts, :product_loadouts_reasoning_valid)

    alter table(:product_loadouts) do
      modify :reasoning, :text, null: true
      add :tool_enforcement, :text
    end

    execute("""
    UPDATE product_loadouts
    SET tool_enforcement = CASE
      WHEN harness_kind = 'antigravity' THEN 'native_permissions'
      ELSE 'exact'
    END
    WHERE tool_enforcement IS NULL
    """)

    execute("ALTER TABLE product_loadouts ALTER COLUMN tool_enforcement SET NOT NULL")

    create constraint(:product_loadouts, :product_loadouts_reasoning_valid,
             check: "reasoning IS NULL OR reasoning ~ '^\\S(?:.*\\S)?$'"
           )

    create constraint(:product_loadouts, :product_loadouts_tool_enforcement_valid,
             check: "tool_enforcement IN ('exact', 'native_permissions')"
           )
  end

  def down do
    execute("UPDATE product_loadouts SET reasoning = 'medium' WHERE reasoning IS NULL")
    drop constraint(:product_loadouts, :product_loadouts_tool_enforcement_valid)
    drop constraint(:product_loadouts, :product_loadouts_reasoning_valid)

    alter table(:product_loadouts) do
      remove :tool_enforcement
      modify :reasoning, :text, null: false
    end

    create constraint(:product_loadouts, :product_loadouts_reasoning_valid,
             check: "reasoning IN ('low', 'medium', 'high')"
           )
  end
end
