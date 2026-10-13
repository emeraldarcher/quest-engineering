defmodule QuestEngineering.Server.Repo.Migrations.AddProviderAccountSetup do
  use Ecto.Migration

  def up do
    alter table(:provider_accounts) do
      add :authenticated_at, :utc_datetime_usec
      add :last_validated_at, :utc_datetime_usec
    end

    drop constraint(:provider_accounts, :provider_accounts_authentication_state_phase_a)

    create constraint(:provider_accounts, :provider_accounts_authentication_state_valid,
             check:
               "authentication_state IN ('not_checked','setup_authorized','setup_in_progress','interaction_required','validating','authenticated','authentication_required','inspection_unavailable','invalid')"
           )

    create table(:provider_account_setup_attempts, primary_key: false) do
      add :id, :text, primary_key: true

      add :provider_account_id,
          references(:provider_accounts, column: :id, type: :text, on_delete: :restrict),
          null: false

      add :setup_generation, :bigint, null: false
      add :credential_generation_before, :bigint, null: false
      add :credential_generation_after, :bigint
      add :environment_generation, :bigint, null: false
      add :provider_key, :text, null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :worker_generation, :bigint, null: false
      add :environment_operation_id, :text, null: false
      add :backend_kind, :text, null: false
      add :environment_id, :text, null: false
      add :environment_incarnation, :text, null: false
      add :state, :text, null: false
      add :invocation_state, :text, null: false
      add :process_backend_id, :text
      add :process_start_identity, :text
      add :process_generation, :text
      add :process_executable, :text
      add :attention_id, :text
      add :validation_state, :text, null: false, default: "not_checked"
      add :validation_identity, :text
      add :failure_code, :text
      add :failure_message, :text
      add :invocation_requested_at, :utc_datetime_usec
      add :invocation_acknowledged_at, :utc_datetime_usec
      add :interaction_required_at, :utc_datetime_usec
      add :validated_at, :utc_datetime_usec
      add :succeeded_at, :utc_datetime_usec
      add :cancelled_at, :utc_datetime_usec
      add :cancellation_request_id, :text
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(
             :provider_account_setup_attempts,
             [:provider_account_id, :setup_generation],
             name: :provider_account_setup_attempt_generation_unique
           )

    create unique_index(:provider_account_setup_attempts, [:provider_account_id],
             where:
               "state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','validating','cancellation_requested')",
             name: :provider_account_setup_attempts_one_active_per_account
           )

    create constraint(:provider_account_setup_attempts, :provider_account_setup_generation_valid,
             check: "setup_generation > 0"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_credential_generation_valid,
             check:
               "credential_generation_before > 0 AND environment_generation > 0 AND (credential_generation_after IS NULL OR credential_generation_after > credential_generation_before)"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_worker_generation_valid,
             check: "worker_generation > 0"
           )

    create constraint(:provider_account_setup_attempts, :provider_account_setup_state_valid,
             check:
               "state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','validating','succeeded','failed','uncertain','cancellation_requested','cancelled','invalidated')"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_invocation_state_valid,
             check:
               "invocation_state IN ('not_requested','requested','acknowledged','settled','uncertain')"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_validation_state_valid,
             check:
               "validation_state IN ('not_checked','authenticated','authentication_required','inspection_unavailable','incompatible_status')"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_process_identity_complete,
             check:
               "(process_backend_id IS NULL AND process_start_identity IS NULL AND process_generation IS NULL AND process_executable IS NULL) OR (process_backend_id IS NOT NULL AND process_start_identity IS NOT NULL AND process_generation IS NOT NULL AND process_executable IS NOT NULL)"
           )

    create table(:provider_account_setup_authorizations, primary_key: false) do
      add :id, :text, primary_key: true

      add :setup_attempt_id,
          references(:provider_account_setup_attempts,
            column: :id,
            type: :text,
            on_delete: :restrict
          ),
          null: false

      add :setup_generation, :bigint, null: false
      add :request_id, :text, null: false
      add :kind, :text, null: false
      add :authorized_at, :utc_datetime_usec, null: false
      timestamps(updated_at: false, type: :utc_datetime_usec)
    end

    create unique_index(:provider_account_setup_authorizations, [:setup_attempt_id])
    create unique_index(:provider_account_setup_authorizations, [:request_id])

    create constraint(
             :provider_account_setup_authorizations,
             :provider_account_setup_authorization_kind_valid,
             check: "kind = 'provider_account_setup'"
           )

    create table(:provider_account_setup_events, primary_key: false) do
      add :id, :text, primary_key: true

      add :setup_attempt_id,
          references(:provider_account_setup_attempts,
            column: :id,
            type: :text,
            on_delete: :restrict
          ),
          null: false

      add :provider_account_id,
          references(:provider_accounts, column: :id, type: :text, on_delete: :restrict),
          null: false

      add :setup_generation, :bigint, null: false
      add :event_type, :text, null: false
      add :state, :text, null: false
      add :invocation_state, :text, null: false
      add :details, :map, null: false, default: %{}
      add :occurred_at, :utc_datetime_usec, null: false
      timestamps(updated_at: false, type: :utc_datetime_usec)
    end

    create index(:provider_account_setup_events, [:setup_attempt_id, :inserted_at])

    create table(:provider_account_human_attention_requests, primary_key: false) do
      add :id, :text, primary_key: true

      add :setup_attempt_id,
          references(:provider_account_setup_attempts,
            column: :id,
            type: :text,
            on_delete: :restrict
          ),
          null: false

      add :provider_account_id,
          references(:provider_accounts, column: :id, type: :text, on_delete: :restrict),
          null: false

      add :worker_id, references(:workers, column: :id, type: :text, on_delete: :restrict),
        null: false

      add :setup_generation, :bigint, null: false
      add :request_generation, :bigint, null: false
      add :request, :map, null: false
      add :response_state, :text, null: false
      add :response_request_id, :text
      add :response_committed_at, :utc_datetime_usec
      add :delivery_state, :text, null: false
      add :delivery_attempt_id, :text
      add :delivery_requested_at, :utc_datetime_usec
      add :delivery_acknowledged_at, :utc_datetime_usec
      add :delivery_uncertain_at, :utc_datetime_usec
      add :cancelled_at, :utc_datetime_usec
      add :cancellation_reason, :text
      add :surfaced_at, :utc_datetime_usec, null: false
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:provider_account_human_attention_requests, [:setup_attempt_id],
             name: :provider_account_attention_attempt_unique
           )

    create unique_index(:provider_account_human_attention_requests, [:response_request_id],
             name: :provider_account_attention_response_request_unique
           )

    create index(:provider_account_human_attention_requests, [:provider_account_id, :inserted_at])
    create index(:provider_account_human_attention_requests, [:worker_id, :delivery_state])

    create constraint(
             :provider_account_human_attention_requests,
             :provider_account_attention_generation_valid,
             check: "setup_generation > 0 AND request_generation > 0"
           )

    create constraint(
             :provider_account_human_attention_requests,
             :provider_account_attention_response_state_valid,
             check: "response_state IN ('pending','responded','cancelled','obsolete')"
           )

    create constraint(
             :provider_account_human_attention_requests,
             :provider_account_attention_delivery_state_valid,
             check:
               "delivery_state IN ('response_not_delivered','delivery_requested','delivery_acknowledged','delivery_uncertain')"
           )
  end

  def down do
    drop table(:provider_account_human_attention_requests)
    drop table(:provider_account_setup_events)
    drop table(:provider_account_setup_authorizations)
    drop table(:provider_account_setup_attempts)

    drop constraint(:provider_accounts, :provider_accounts_authentication_state_valid)

    create constraint(:provider_accounts, :provider_accounts_authentication_state_phase_a,
             check: "authentication_state = 'not_checked'"
           )

    alter table(:provider_accounts) do
      remove :last_validated_at
      remove :authenticated_at
    end
  end
end
