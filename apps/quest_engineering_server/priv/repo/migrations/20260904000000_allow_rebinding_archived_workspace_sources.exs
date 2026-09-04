defmodule QuestEngineering.Server.Repo.Migrations.AllowRebindingArchivedWorkspaceSources do
  use Ecto.Migration

  @old_root_index :worker_workspace_bindings_worker_id_source_repository_root_inde
  @available_root_index :worker_workspace_bindings_available_root_index

  def up do
    drop index(:worker_workspace_bindings, [:worker_id, :source_repository_root],
           name: @old_root_index
         )

    execute("""
    UPDATE worker_workspace_bindings AS binding
    SET status = 'unavailable', updated_at = NOW()
    FROM product_workspaces AS workspace
    WHERE binding.workspace_id = workspace.id
      AND workspace.archived_at IS NOT NULL
      AND binding.status = 'available'
    """)

    create unique_index(:worker_workspace_bindings, [:worker_id, :source_repository_root],
             name: @available_root_index,
             where: "status = 'available'"
           )
  end

  def down do
    drop index(:worker_workspace_bindings, [:worker_id, :source_repository_root],
           name: @available_root_index
         )

    create unique_index(:worker_workspace_bindings, [:worker_id, :source_repository_root])
  end
end
