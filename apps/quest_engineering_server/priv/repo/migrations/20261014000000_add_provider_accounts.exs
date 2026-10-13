defmodule QuestEngineering.Server.Repo.Migrations.AddProviderAccounts do
  use Ecto.Migration

  def up do
    create table(:provider_accounts, primary_key: false) do
      add :id, :text, primary_key: true
      add :provider_key, :text, null: false
      add :display_name, :text

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :credential_generation, :bigint, null: false
      add :lifecycle_state, :text, null: false
      add :environment_state, :text, null: false
      add :authentication_state, :text, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create index(:provider_accounts, [:worker_id])
    create index(:provider_accounts, [:provider_key])

    create constraint(:provider_accounts, :provider_accounts_credential_generation_positive,
             check: "credential_generation > 0"
           )

    create constraint(:provider_accounts, :provider_accounts_lifecycle_state_valid,
             check: "lifecycle_state IN ('connected','invalid','disconnected')"
           )

    create constraint(:provider_accounts, :provider_accounts_environment_state_valid,
             check:
               "environment_state IN ('unassigned','pending','available','stopped','missing','degraded','removing','removed')"
           )

    create constraint(:provider_accounts, :provider_accounts_authentication_state_phase_a,
             check: "authentication_state = 'not_checked'"
           )

    create table(:provider_account_environments, primary_key: false) do
      add :provider_account_id,
          references(:provider_accounts, column: :id, type: :text, on_delete: :delete_all),
          primary_key: true

      add :credential_generation, :bigint, null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :worker_generation, :bigint
      add :operation_id, :text, null: false
      add :desired_environment_state, :text, null: false
      add :backend_kind, :text
      add :environment_id, :text
      add :incarnation, :text
      add :physical_state, :text, null: false
      add :last_error_code, :text
      add :last_error_message, :text
      add :canary_persisted, :boolean, null: false, default: false
      add :observed_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:provider_account_environments, [:backend_kind, :environment_id],
             where: "environment_id IS NOT NULL",
             name: :provider_account_environments_physical_identity
           )

    create constraint(
             :provider_account_environments,
             :provider_account_environment_generation_positive,
             check: "credential_generation > 0"
           )

    create constraint(
             :provider_account_environments,
             :provider_account_environment_worker_generation_positive,
             check: "worker_generation IS NULL OR worker_generation > 0"
           )

    create constraint(
             :provider_account_environments,
             :provider_account_environment_desired_state_valid,
             check: "desired_environment_state IN ('available','stopped','removed')"
           )

    create constraint(
             :provider_account_environments,
             :provider_account_environment_identity_complete,
             check:
               "(environment_id IS NULL AND incarnation IS NULL) OR (environment_id IS NOT NULL AND incarnation IS NOT NULL)"
           )

    create constraint(:provider_account_environments, :provider_account_environment_state_valid,
             check:
               "physical_state IN ('pending','available','stopped','missing','degraded','removing','removed')"
           )

    create table(:provider_account_lifecycle_events, primary_key: false) do
      add :id, :text, primary_key: true

      add :provider_account_id,
          references(:provider_accounts, column: :id, type: :text, on_delete: :delete_all),
          null: false

      add :credential_generation, :bigint, null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :worker_generation, :bigint
      add :operation_id, :text, null: false
      add :event_type, :text, null: false
      add :lifecycle_state, :text, null: false
      add :physical_state, :text, null: false
      add :backend_kind, :text
      add :environment_id, :text
      add :incarnation, :text
      add :error_code, :text
      add :details, :map, null: false, default: %{}
      add :occurred_at, :utc_datetime_usec, null: false
      timestamps(updated_at: false, type: :utc_datetime_usec)
    end

    create index(:provider_account_lifecycle_events, [:provider_account_id, :inserted_at])
    create index(:provider_account_lifecycle_events, [:worker_id, :worker_generation])

    create unique_index(
             :provider_account_lifecycle_events,
             [
               :provider_account_id,
               :credential_generation,
               :worker_generation,
               :operation_id,
               :event_type
             ],
             name: :provider_account_lifecycle_events_dedup
           )
  end

  def down do
    drop table(:provider_account_lifecycle_events)
    drop table(:provider_account_environments)
    drop table(:provider_accounts)
  end
end
