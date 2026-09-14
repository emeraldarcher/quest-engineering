defmodule QuestEngineering.Server.Repo.Migrations.CanonicalizeToolPolicy do
  use Ecto.Migration

  def up do
    alter table(:product_loadouts) do
      add :tool_policy_kind, :text
      add :tool_policy_tools, {:array, :text}, default: [], null: false
    end

    execute("""
    UPDATE product_loadouts
    SET tool_policy_kind = CASE
      WHEN tool_enforcement = 'native_permissions' THEN 'native_permissions'
      ELSE 'exact'
    END,
    tool_policy_tools = CASE
      WHEN tool_enforcement = 'native_permissions' THEN ARRAY[]::text[]
      ELSE tools
    END
    """)

    execute("ALTER TABLE product_loadouts ALTER COLUMN tool_policy_kind SET NOT NULL")

    create constraint(:product_loadouts, :product_loadouts_tool_policy_valid,
             check:
               "(tool_policy_kind = 'exact') OR (tool_policy_kind = 'native_permissions' AND cardinality(tool_policy_tools) = 0)"
           )

    drop constraint(:product_loadouts, :product_loadouts_tool_enforcement_valid)

    alter table(:product_loadouts) do
      remove :tool_enforcement
      remove :tools
    end
  end

  def down do
    alter table(:product_loadouts) do
      add :tools, {:array, :text}, default: [], null: false
      add :tool_enforcement, :text
    end

    execute("""
    UPDATE product_loadouts
    SET tool_enforcement = tool_policy_kind,
        tools = tool_policy_tools
    """)

    execute("ALTER TABLE product_loadouts ALTER COLUMN tool_enforcement SET NOT NULL")
    drop constraint(:product_loadouts, :product_loadouts_tool_policy_valid)

    create constraint(:product_loadouts, :product_loadouts_tool_enforcement_valid,
             check: "tool_enforcement IN ('exact', 'native_permissions')"
           )

    alter table(:product_loadouts) do
      remove :tool_policy_kind
      remove :tool_policy_tools
    end
  end
end
