defmodule QuestEngineering.Server.Repo.Migrations.AddClaudeAccountDispatchAuthority do
  use Ecto.Migration

  def change do
    alter table(:worker_dispatches) do
      add :provider_account_id,
          references(:provider_accounts, type: :string, on_delete: :restrict)

      add :provider_account_credential_generation, :integer
      add :workspace_tool_broker_authorization_id, :string
      add :workspace_tool_broker_session_id, :string
      add :workspace_tool_broker_generation, :integer
      add :workspace_tool_broker_admitted_at, :utc_datetime_usec
    end

    create unique_index(
             :worker_dispatches,
             [:workspace_tool_broker_authorization_id],
             name: :worker_dispatches_workspace_tool_broker_authorization_index,
             where: "workspace_tool_broker_authorization_id IS NOT NULL"
           )

    create constraint(:worker_dispatches, :worker_dispatches_provider_account_authority_complete,
             check: """
             (provider_account_id IS NULL AND
              provider_account_credential_generation IS NULL AND
              workspace_tool_broker_authorization_id IS NULL AND
              workspace_tool_broker_session_id IS NULL AND
              workspace_tool_broker_generation IS NULL AND
              workspace_tool_broker_admitted_at IS NULL)
             OR
             (provider_account_id IS NOT NULL AND
              provider_account_credential_generation IS NOT NULL AND
              provider_account_credential_generation > 0 AND
              workspace_tool_broker_authorization_id IS NOT NULL)
             """
           )

    create constraint(:worker_dispatches, :worker_dispatches_broker_admission_complete,
             check: """
             (workspace_tool_broker_admitted_at IS NULL AND
              workspace_tool_broker_session_id IS NULL AND
              workspace_tool_broker_generation IS NULL)
             OR
             (workspace_tool_broker_admitted_at IS NOT NULL AND
              workspace_tool_broker_session_id IS NOT NULL AND
              workspace_tool_broker_generation IS NOT NULL AND
              workspace_tool_broker_generation > 0)
             """
           )
  end
end
