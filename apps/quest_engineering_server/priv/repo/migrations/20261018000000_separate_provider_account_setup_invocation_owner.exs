defmodule QuestEngineering.Server.Repo.Migrations.SeparateProviderAccountSetupInvocationOwner do
  use Ecto.Migration

  def up do
    alter table(:provider_account_setup_attempts) do
      add :invocation_worker_generation, :bigint
      add :invocation_environment_operation_id, :text
    end

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_invocation_owner_complete,
             check: """
             (invocation_worker_generation IS NULL AND
              invocation_environment_operation_id IS NULL) OR
             (invocation_worker_generation > 0 AND
              invocation_environment_operation_id IS NOT NULL)
             """
           )
  end

  def down do
    drop constraint(
           :provider_account_setup_attempts,
           :provider_account_setup_invocation_owner_complete
         )

    alter table(:provider_account_setup_attempts) do
      remove :invocation_environment_operation_id
      remove :invocation_worker_generation
    end
  end
end
