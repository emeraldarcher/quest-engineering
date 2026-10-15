defmodule QuestEngineering.Server.Repo.Migrations.AddProviderAccountAuthPreflight do
  use Ecto.Migration

  def up do
    # Prior broad setup-progress projections are not reusable authentication
    # evidence. Force every existing account through current inspection.
    execute("""
    UPDATE provider_accounts
    SET authentication_state = 'not_checked',
        authenticated_at = NULL,
        last_validated_at = NULL
    """)

    drop constraint(:provider_accounts, :provider_accounts_authentication_state_valid)

    alter table(:provider_accounts) do
      add :authentication_method, :text
      add :auth_configuration_identity, :text
      add :auth_environment_policy, :text
      add :auth_inspection_identity, :text
      add :auth_inspected_at, :utc_datetime_usec
    end

    create constraint(:provider_accounts, :provider_accounts_authentication_state_valid,
             check:
               "authentication_state IN ('not_checked','authentication_required','authenticated','forbidden_auth_method','inspection_unavailable','incompatible_status')"
           )

    create constraint(:provider_accounts, :provider_accounts_authentication_method_valid,
             check:
               "authentication_method IS NULL OR authentication_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party')"
           )

    create constraint(:provider_accounts, :provider_accounts_authentication_evidence_complete,
             check: """
             (authentication_state = 'not_checked' AND
              authentication_method IS NULL AND auth_configuration_identity IS NULL AND
              auth_environment_policy IS NULL AND auth_inspection_identity IS NULL AND
              auth_inspected_at IS NULL) OR
             (authentication_state <> 'not_checked' AND
              auth_configuration_identity IS NOT NULL AND auth_environment_policy IS NOT NULL AND
              auth_inspection_identity IS NOT NULL AND auth_inspected_at IS NOT NULL)
             """
           )

    create constraint(
             :provider_accounts,
             :provider_accounts_authentication_method_matches_state,
             check: """
             (authentication_state = 'not_checked' AND authentication_method IS NULL) OR
             (authentication_state = 'authentication_required' AND authentication_method = 'none') OR
             (authentication_state = 'authenticated' AND authentication_method = 'provider_account') OR
             (authentication_state = 'forbidden_auth_method' AND authentication_method IN ('injected_oauth_token','api_key','api_key_helper','third_party')) OR
             (authentication_state = 'inspection_unavailable' AND authentication_method IS NULL) OR
             (authentication_state = 'incompatible_status' AND (authentication_method IS NULL OR authentication_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party')))
             """
           )

    create constraint(:provider_accounts, :provider_accounts_authentication_timestamps,
             check: """
             (authentication_state = 'not_checked' AND authenticated_at IS NULL AND last_validated_at IS NULL) OR
             (authentication_state = 'authenticated' AND authenticated_at IS NOT NULL AND last_validated_at IS NOT NULL) OR
             (authentication_state NOT IN ('not_checked','authenticated') AND authenticated_at IS NULL AND last_validated_at IS NOT NULL)
             """
           )

    alter table(:provider_account_setup_attempts) do
      add :authorization_auth_state, :text, null: false, default: "authentication_required"
      add :authorization_auth_method, :text, null: false, default: "none"
      add :auth_configuration_identity, :text, null: false, default: "legacy-invalidated-v0"
      add :auth_environment_policy, :text, null: false, default: "legacy-invalidated-v0"

      add :authorization_inspection_identity, :text,
        null: false,
        default: "legacy-invalidated-v0"

      add :authorization_inspected_at, :utc_datetime_usec,
        null: false,
        default: fragment("NOW()")

      add :preflight_state, :text
      add :preflight_method, :text
      add :preflight_configuration_identity, :text
      add :preflight_environment_policy, :text
      add :preflight_identity, :text
      add :preflight_inspected_at, :utc_datetime_usec
      add :validation_method, :text
      add :validation_configuration_identity, :text
      add :validation_environment_policy, :text
      add :validation_inspected_at, :utc_datetime_usec
      modify :validation_state, :text, null: true, default: nil
    end

    execute("""
    UPDATE provider_account_setup_attempts
    SET state = 'invalidated',
        failure_code = 'auth_configuration_obsolete',
        failure_message = 'The setup authentication configuration is obsolete.'
    WHERE state IN ('authorized','preparing','invocation_requested','invocation_acknowledged',
                    'human_interaction_required','validating','cancellation_requested')
    """)

    # Legacy validation rows lack the versioned configuration and physical
    # evidence needed by the new contract and therefore cannot be reused.
    execute("""
    UPDATE provider_account_setup_attempts
    SET validation_state = NULL,
        validation_identity = NULL
    """)

    drop constraint(
           :provider_account_setup_attempts,
           :provider_account_setup_validation_state_valid
         )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_validation_state_valid,
             check:
               "validation_state IS NULL OR validation_state IN ('authentication_required','authenticated','forbidden_auth_method','inspection_unavailable','incompatible_status')"
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_auth_method_valid,
             check: """
             authorization_auth_state = 'authentication_required' AND
             authorization_auth_method = 'none' AND
             (preflight_method IS NULL OR preflight_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party')) AND
             (validation_method IS NULL OR validation_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party'))
             """
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_auth_preflight_complete,
             check: """
             (preflight_state IS NULL AND preflight_method IS NULL AND preflight_configuration_identity IS NULL AND preflight_environment_policy IS NULL AND preflight_identity IS NULL AND preflight_inspected_at IS NULL) OR
             (preflight_state = 'authentication_required' AND preflight_method = 'none' AND preflight_configuration_identity IS NOT NULL AND preflight_environment_policy IS NOT NULL AND preflight_identity IS NOT NULL AND preflight_inspected_at IS NOT NULL) OR
             (preflight_state = 'authenticated' AND preflight_method = 'provider_account' AND preflight_configuration_identity IS NOT NULL AND preflight_environment_policy IS NOT NULL AND preflight_identity IS NOT NULL AND preflight_inspected_at IS NOT NULL) OR
             (preflight_state = 'forbidden_auth_method' AND preflight_method IN ('injected_oauth_token','api_key','api_key_helper','third_party') AND preflight_configuration_identity IS NOT NULL AND preflight_environment_policy IS NOT NULL AND preflight_identity IS NOT NULL AND preflight_inspected_at IS NOT NULL) OR
             (preflight_state = 'inspection_unavailable' AND preflight_method IS NULL AND preflight_configuration_identity IS NOT NULL AND preflight_environment_policy IS NOT NULL AND preflight_identity IS NOT NULL AND preflight_inspected_at IS NOT NULL) OR
             (preflight_state = 'incompatible_status' AND (preflight_method IS NULL OR preflight_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party')) AND preflight_configuration_identity IS NOT NULL AND preflight_environment_policy IS NOT NULL AND preflight_identity IS NOT NULL AND preflight_inspected_at IS NOT NULL)
             """
           )

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_auth_validation_complete,
             check: """
             (validation_state IS NULL AND validation_method IS NULL AND validation_identity IS NULL AND validation_configuration_identity IS NULL AND validation_environment_policy IS NULL AND validation_inspected_at IS NULL) OR
             (validation_state = 'authentication_required' AND validation_method = 'none' AND validation_identity IS NOT NULL AND validation_configuration_identity IS NOT NULL AND validation_environment_policy IS NOT NULL AND validation_inspected_at IS NOT NULL) OR
             (validation_state = 'authenticated' AND validation_method = 'provider_account' AND validation_identity IS NOT NULL AND validation_configuration_identity IS NOT NULL AND validation_environment_policy IS NOT NULL AND validation_inspected_at IS NOT NULL) OR
             (validation_state = 'forbidden_auth_method' AND validation_method IN ('injected_oauth_token','api_key','api_key_helper','third_party') AND validation_identity IS NOT NULL AND validation_configuration_identity IS NOT NULL AND validation_environment_policy IS NOT NULL AND validation_inspected_at IS NOT NULL) OR
             (validation_state = 'inspection_unavailable' AND validation_method IS NULL AND validation_identity IS NOT NULL AND validation_configuration_identity IS NOT NULL AND validation_environment_policy IS NOT NULL AND validation_inspected_at IS NOT NULL) OR
             (validation_state = 'incompatible_status' AND (validation_method IS NULL OR validation_method IN ('none','provider_account','injected_oauth_token','api_key','api_key_helper','third_party')) AND validation_identity IS NOT NULL AND validation_configuration_identity IS NOT NULL AND validation_environment_policy IS NOT NULL AND validation_inspected_at IS NOT NULL)
             """
           )

    alter table(:provider_account_setup_authorizations) do
      add :auth_configuration_identity, :text, null: false, default: "legacy-invalidated-v0"
      add :auth_environment_policy, :text, null: false, default: "legacy-invalidated-v0"
      add :auth_inspection_identity, :text, null: false, default: "legacy-invalidated-v0"
      add :auth_inspected_at, :utc_datetime_usec, null: false, default: fragment("NOW()")
    end

    alter table(:provider_account_setup_attempts) do
      modify :authorization_auth_state, :text, default: nil
      modify :authorization_auth_method, :text, default: nil
      modify :auth_configuration_identity, :text, default: nil
      modify :auth_environment_policy, :text, default: nil
      modify :authorization_inspection_identity, :text, default: nil
      modify :authorization_inspected_at, :utc_datetime_usec, default: nil
    end

    alter table(:provider_account_setup_authorizations) do
      modify :auth_configuration_identity, :text, default: nil
      modify :auth_environment_policy, :text, default: nil
      modify :auth_inspection_identity, :text, default: nil
      modify :auth_inspected_at, :utc_datetime_usec, default: nil
    end
  end

  def down do
    alter table(:provider_account_setup_authorizations) do
      remove :auth_inspected_at
      remove :auth_inspection_identity
      remove :auth_environment_policy
      remove :auth_configuration_identity
    end

    drop constraint(
           :provider_account_setup_attempts,
           :provider_account_setup_auth_validation_complete
         )

    drop constraint(
           :provider_account_setup_attempts,
           :provider_account_setup_auth_preflight_complete
         )

    drop constraint(:provider_account_setup_attempts, :provider_account_setup_auth_method_valid)

    drop constraint(
           :provider_account_setup_attempts,
           :provider_account_setup_validation_state_valid
         )

    execute("""
    UPDATE provider_account_setup_attempts
    SET validation_state = CASE
          WHEN validation_state IN ('forbidden_auth_method','incompatible_status') THEN 'inspection_unavailable'
          ELSE COALESCE(validation_state, 'not_checked')
        END
    """)

    alter table(:provider_account_setup_attempts) do
      remove :validation_inspected_at
      remove :validation_environment_policy
      remove :validation_configuration_identity
      remove :validation_method
      remove :preflight_inspected_at
      remove :preflight_identity
      remove :preflight_environment_policy
      remove :preflight_configuration_identity
      remove :preflight_method
      remove :preflight_state
      remove :authorization_inspected_at
      remove :authorization_inspection_identity
      remove :auth_environment_policy
      remove :auth_configuration_identity
      remove :authorization_auth_method
      remove :authorization_auth_state
      modify :validation_state, :text, null: false, default: "not_checked"
    end

    create constraint(
             :provider_account_setup_attempts,
             :provider_account_setup_validation_state_valid,
             check:
               "validation_state IN ('not_checked','authenticated','authentication_required','inspection_unavailable','incompatible_status')"
           )

    drop constraint(:provider_accounts, :provider_accounts_authentication_timestamps)

    drop constraint(
           :provider_accounts,
           :provider_accounts_authentication_method_matches_state
         )

    drop constraint(:provider_accounts, :provider_accounts_authentication_evidence_complete)
    drop constraint(:provider_accounts, :provider_accounts_authentication_method_valid)
    drop constraint(:provider_accounts, :provider_accounts_authentication_state_valid)

    execute("""
    UPDATE provider_accounts
    SET authentication_state = 'invalid',
        authenticated_at = NULL,
        last_validated_at = NULL
    WHERE authentication_state IN ('forbidden_auth_method','incompatible_status')
    """)

    alter table(:provider_accounts) do
      remove :auth_inspected_at
      remove :auth_inspection_identity
      remove :auth_environment_policy
      remove :auth_configuration_identity
      remove :authentication_method
    end

    create constraint(:provider_accounts, :provider_accounts_authentication_state_valid,
             check:
               "authentication_state IN ('not_checked','setup_authorized','setup_in_progress','interaction_required','validating','authenticated','authentication_required','inspection_unavailable','invalid')"
           )
  end
end
