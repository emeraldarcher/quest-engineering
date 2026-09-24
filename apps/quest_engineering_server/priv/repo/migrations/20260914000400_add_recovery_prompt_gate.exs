defmodule QuestEngineering.Server.Repo.Migrations.AddRecoveryPromptGate do
  use Ecto.Migration

  def change do
    alter table(:worker_dispatches) do
      add :operational_recovery_request_id, :text
      add :operational_recovery_requested_at, :utc_datetime_usec
      add :prompt_authorization_request_id, :text
      add :prompt_authorized_at, :utc_datetime_usec
    end

    create unique_index(:worker_dispatches, [:operational_recovery_request_id],
             where: "operational_recovery_request_id IS NOT NULL",
             name: :worker_dispatches_operational_recovery_request_index
           )

    create unique_index(:worker_dispatches, [:prompt_authorization_request_id],
             where: "prompt_authorization_request_id IS NOT NULL",
             name: :worker_dispatches_prompt_authorization_request_index
           )
  end
end
