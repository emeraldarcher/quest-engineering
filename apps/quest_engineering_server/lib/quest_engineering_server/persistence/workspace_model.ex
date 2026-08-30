defmodule QuestEngineering.Server.Persistence.WorkerWorkspaceBinding do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:binding_id, Ecto.UUID, autogenerate: true}
  schema "worker_workspace_bindings" do
    field :worker_id, :string
    field :workspace_id, Ecto.UUID
    field :authorized_root_key, :string
    field :source_repository_root, :string
    field :source_fingerprint, :string
    field :publication_remote_name, :string
    field :publication_repository_identity, :string
    field :max_access, :string
    field :allow_unconfined_shell, :boolean, default: false
    field :status, :string
    field :last_seen_generation, :integer
    field :last_seen_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(row \\ %__MODULE__{}, attributes) do
    row
    |> cast(attributes, [
      :binding_id,
      :worker_id,
      :workspace_id,
      :authorized_root_key,
      :source_repository_root,
      :source_fingerprint,
      :publication_remote_name,
      :publication_repository_identity,
      :max_access,
      :allow_unconfined_shell,
      :status,
      :last_seen_generation,
      :last_seen_at
    ])
    |> validate_required([
      :binding_id,
      :worker_id,
      :workspace_id,
      :authorized_root_key,
      :source_repository_root,
      :max_access,
      :allow_unconfined_shell,
      :status
    ])
    |> validate_inclusion(:max_access, ["none", "read_only", "read_write"])
    |> validate_inclusion(:status, ["available", "unavailable"])
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:workspace_id)
    |> unique_constraint([:worker_id, :workspace_id])
    |> unique_constraint([:worker_id, :source_repository_root])
  end
end

defmodule QuestEngineering.Server.Persistence.RunWorkspaceAssignment do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:run_id, :string, autogenerate: false}
  schema "run_workspace_assignments" do
    field :workspace_id, Ecto.UUID
    field :worker_id, :string
    field :workspace_binding_id, Ecto.UUID
    field :worktree_id, Ecto.UUID
    field :base_selector, :string
    field :base_revision, :string
    field :base_branch_name, :string
    field :branch_name, :string
    field :publication_remote_name, :string
    field :publication_repository_identity, :string
    field :canonical_worktree_root, :string
    field :source_dirty_excluded, :boolean
    field :state, :string
    field :provision_revision, :integer
    field :identity_hash, :string
    field :failure_code, :string
    field :failure_details, :map
    field :assigned_at, :utc_datetime_usec
    field :ready_at, :utc_datetime_usec
    field :retained_at, :utc_datetime_usec
    field :retention_confirmed_at, :utc_datetime_usec
    field :cleanup_requested_at, :utc_datetime_usec
    field :removed_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  @states ~w(waiting_for_host provisioning ready attention_required failed retained cleanup_requested removed)

  def changeset(row \\ %__MODULE__{}, attributes) do
    row
    |> cast(attributes, [
      :run_id,
      :workspace_id,
      :worker_id,
      :workspace_binding_id,
      :worktree_id,
      :base_selector,
      :base_revision,
      :base_branch_name,
      :branch_name,
      :publication_remote_name,
      :publication_repository_identity,
      :canonical_worktree_root,
      :source_dirty_excluded,
      :state,
      :provision_revision,
      :identity_hash,
      :failure_code,
      :failure_details,
      :assigned_at,
      :ready_at,
      :retained_at,
      :retention_confirmed_at,
      :cleanup_requested_at,
      :removed_at
    ])
    |> validate_required([
      :run_id,
      :workspace_id,
      :worktree_id,
      :base_selector,
      :branch_name,
      :state,
      :provision_revision,
      :identity_hash
    ])
    |> validate_inclusion(:state, @states)
    |> validate_number(:provision_revision, greater_than: 0)
    |> foreign_key_constraint(:run_id)
    |> foreign_key_constraint(:workspace_id)
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:workspace_binding_id)
    |> unique_constraint(:worktree_id)
  end
end
