defmodule QuestEngineering.Server.Repo.Migrations.SeparateDiscoveryAndExecutionAuthorization do
  use Ecto.Migration

  def up do
    # 1. worker_workspace_candidates
    execute("ALTER TABLE worker_workspace_candidates DROP CONSTRAINT IF EXISTS worker_workspace_candidates_source_kind_valid")
    execute("ALTER TABLE worker_workspace_candidates DROP CONSTRAINT IF EXISTS worker_workspace_candidates_access_valid")

    execute("ALTER TABLE worker_workspace_candidates ALTER COLUMN source_kind DROP NOT NULL")
    execute("ALTER TABLE worker_workspace_candidates ALTER COLUMN max_access DROP NOT NULL")
    execute("ALTER TABLE worker_workspace_candidates ALTER COLUMN allow_unconfined_shell DROP NOT NULL")

    alter table(:worker_workspace_candidates) do
      add :observation, :text, null: false, default: "present"
      add :authority_status, :text, null: false, default: "authorized"
      add :authority_reason, :text
      add :identity_status, :text, null: false, default: "verified"
      add :policy_digest, :text
      add :last_checked_at, :utc_datetime_usec
      add :last_seen_generation, :integer
    end

    create constraint(
      :worker_workspace_candidates,
      :worker_workspace_candidates_observation_valid,
      check: "observation IN ('present', 'not_seen', 'inaccessible')"
    )

    create constraint(
      :worker_workspace_candidates,
      :worker_workspace_candidates_authority_status_valid,
      check: "authority_status IN ('authorized', 'not_authorized', 'unverifiable')"
    )

    create constraint(
      :worker_workspace_candidates,
      :worker_workspace_candidates_identity_status_valid,
      check: "identity_status IN ('unverified', 'verified')"
    )

    create constraint(
      :worker_workspace_candidates,
      :worker_workspace_candidates_source_kind_valid,
      check: "source_kind IS NULL OR source_kind IN ('git_remote', 'local_git')"
    )

    create constraint(
      :worker_workspace_candidates,
      :worker_workspace_candidates_access_valid,
      check: "max_access IS NULL OR max_access IN ('none', 'read_only', 'read_write')"
    )

    create index(:worker_workspace_candidates, [:worker_id, :authority_status])

    # 2. worker_workspace_bindings
    alter table(:worker_workspace_bindings) do
      add :candidate_id, :text
      add :authorization_intent, :text, null: false, default: "enabled"
      add :intent_revision, :integer, null: false, default: 1
      add :approved_max_access, :text, null: false, default: "read_write"
      add :approved_allow_unconfined_shell, :boolean, null: false, default: false
      add :authorized_at, :utc_datetime_usec
      add :revoked_at, :utc_datetime_usec
      add :physical_status, :text, null: false, default: "pending"
      add :unavailable_reason, :text
      add :observed_intent_revision, :integer
      add :effective_max_access, :text
      add :effective_allow_unconfined_shell, :boolean
      add :execution_policy_digest, :text
      add :last_checked_at, :utc_datetime_usec
    end

    execute("""
    UPDATE worker_workspace_bindings
    SET approved_max_access = max_access,
        approved_allow_unconfined_shell = allow_unconfined_shell,
        effective_max_access = max_access,
        effective_allow_unconfined_shell = allow_unconfined_shell,
        authorized_at = inserted_at,
        physical_status = (CASE WHEN status = 'available' THEN 'ready' ELSE 'unavailable' END),
        observed_intent_revision = 1
    """)

    create constraint(
      :worker_workspace_bindings,
      :worker_workspace_bindings_intent_valid,
      check: "authorization_intent IN ('enabled', 'revoked')"
    )

    create constraint(
      :worker_workspace_bindings,
      :worker_workspace_bindings_approved_access_valid,
      check: "approved_max_access IN ('none', 'read_only', 'read_write')"
    )

    create constraint(
      :worker_workspace_bindings,
      :worker_workspace_bindings_physical_status_valid,
      check: "physical_status IN ('pending', 'ready', 'unavailable')"
    )

    create constraint(
      :worker_workspace_bindings,
      :worker_workspace_bindings_effective_access_valid,
      check: "effective_max_access IS NULL OR effective_max_access IN ('none', 'read_only', 'read_write')"
    )

    create index(:worker_workspace_bindings, [:workspace_id, :authorization_intent])
    create index(:worker_workspace_bindings, [:worker_id, :authorization_intent, :physical_status])

    # 3. workspace_binding_attempts
    execute("ALTER TABLE workspace_binding_attempts ADD COLUMN attempt_id UUID DEFAULT gen_random_uuid()")
    execute("ALTER TABLE workspace_binding_attempts ADD COLUMN intent_revision INTEGER NOT NULL DEFAULT 1")
    execute("ALTER TABLE workspace_binding_attempts ADD COLUMN request_id TEXT")
    execute("ALTER TABLE workspace_binding_attempts DROP CONSTRAINT workspace_binding_attempts_pkey")
    execute("ALTER TABLE workspace_binding_attempts ADD PRIMARY KEY (attempt_id)")

    create index(:workspace_binding_attempts, [:binding_id, :intent_revision])
    create index(:workspace_binding_attempts, [:binding_id, :request_id])
  end

  def down do
    execute("ALTER TABLE workspace_binding_attempts DROP CONSTRAINT IF EXISTS workspace_binding_attempts_pkey")
    execute("ALTER TABLE workspace_binding_attempts ADD PRIMARY KEY (binding_id)")
    alter table(:workspace_binding_attempts) do
      remove :attempt_id
      remove :intent_revision
      remove :request_id
    end

    alter table(:worker_workspace_bindings) do
      remove :candidate_id
      remove :authorization_intent
      remove :intent_revision
      remove :approved_max_access
      remove :approved_allow_unconfined_shell
      remove :authorized_at
      remove :revoked_at
      remove :physical_status
      remove :unavailable_reason
      remove :observed_intent_revision
      remove :effective_max_access
      remove :effective_allow_unconfined_shell
      remove :execution_policy_digest
      remove :last_checked_at
    end

    alter table(:worker_workspace_candidates) do
      remove :observation
      remove :authority_status
      remove :authority_reason
      remove :identity_status
      remove :policy_digest
      remove :last_checked_at
      remove :last_seen_generation
    end
  end
end
