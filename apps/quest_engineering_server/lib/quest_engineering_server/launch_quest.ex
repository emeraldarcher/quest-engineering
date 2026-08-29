defmodule QuestEngineering.Server.LaunchQuest do
  @moduledoc "Atomically binds an immutable Product snapshot to a newly started Runtime Run."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.Class
  alias QuestEngineering.Core.Product.LaunchSnapshot.Builder
  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.Member
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.Quest
  alias QuestEngineering.Core.Product.Squad
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Core.Product.Workspace
  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.ProductClass
  alias QuestEngineering.Server.Persistence.ProductLoadout
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.ProductSquad
  alias QuestEngineering.Server.Persistence.ProductSquadMember
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.TacticGraphLoader
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.Scheduler

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
    @type t :: %__MODULE__{code: atom(), details: map()}
  end

  @spec launch(String.t()) :: {:ok, map()} | {:error, term()}
  def launch(quest_id) when is_binary(quest_id), do: launch_transaction(quest_id)

  def launch(quest_id), do: {:error, error(:invalid_quest_id, %{quest_id: quest_id})}

  defp launch_transaction(quest_id) do
    case Repo.transaction(
           fn -> launch_locked(quest_id) end,
           isolation: :repeatable_read
         ) do
      {:ok, result} ->
        RunWorkspaceStore.prepare_legacy_test(result.run_id)

        if Application.get_env(:quest_engineering_server, :scheduler_enabled, true),
          do: Scheduler.wake(result.run_id)

        # The transaction above has committed; UI observers only see durable state.
        RunChangeNotifier.notify(result.run_id)
        {:ok, result}

      {:error, error} ->
        {:error, error}
    end
  end

  defp launch_locked(quest_id) do
    quest_row = lock_active!(ProductQuest, quest_id, :quest)

    workspace_row =
      lock_active!(ProductWorkspace, quest_row.workspace_id, :workspace, "FOR SHARE")

    squad_row = lock_active!(ProductSquad, quest_row.squad_id, :squad, "FOR SHARE")

    member_rows =
      Repo.all(
        from member in ProductSquadMember,
          where: member.squad_id == ^squad_row.id,
          order_by: [asc: member.position],
          lock: "FOR SHARE"
      )

    class_rows = lock_definitions!(ProductClass, Enum.map(member_rows, & &1.class_id), :class)

    loadout_rows =
      lock_definitions!(ProductLoadout, Enum.map(member_rows, & &1.loadout_id), :loadout)

    with {:ok, tactic_source} <- decode_tactic_source(quest_row),
         {:ok, catalog} <- TacticGraphLoader.load(tactic_source),
         {:ok, snapshot} <-
           Builder.build(
             quest(quest_row, tactic_source),
             workspace(workspace_row),
             squad(squad_row, member_rows),
             Enum.map(class_rows, &class/1),
             Enum.map(loadout_rows, &loadout/1),
             catalog
           ),
         launch_id = Ecto.UUID.generate(),
         # HTTP Product resource IDs must be one URL path segment; occurrence IDs
         # still retain their own slash-delimited internal structure.
         run_id = "quest-launch-" <> launch_id,
         {:ok, run, actions} <- start_runtime(snapshot, run_id),
         runtime_result = RuntimeStore.persist_started_run(run, actions),
         {:ok, launch} <- insert_launch(launch_id, quest_id, run_id, snapshot),
         {:ok, _assignment} <- insert_workspace_assignment(run_id, snapshot.workspace.id) do
      %{
        launch_id: launch.id,
        run_id: run_id,
        snapshot: snapshot,
        run: runtime_result.run,
        actions: runtime_result.actions
      }
    else
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp lock_active!(schema, id, kind, lock \\ "FOR UPDATE")

  defp lock_active!(schema, id, kind, "FOR UPDATE") do
    locked_active(schema, id, kind, "FOR UPDATE")
  end

  defp lock_active!(schema, id, kind, "FOR SHARE") do
    locked_active(schema, id, kind, "FOR SHARE")
  end

  defp locked_active(schema, id, kind, "FOR UPDATE") do
    row =
      Repo.one(
        from row in schema,
          where: row.id == ^id and is_nil(row.archived_at),
          lock: "FOR UPDATE"
      )

    row || Repo.rollback(error(:not_found, %{kind: kind, id: id}))
  end

  defp locked_active(schema, id, kind, "FOR SHARE") do
    row =
      Repo.one(
        from row in schema,
          where: row.id == ^id and is_nil(row.archived_at),
          lock: "FOR SHARE"
      )

    row || Repo.rollback(error(:not_found, %{kind: kind, id: id}))
  end

  defp lock_definitions!(schema, ids, kind) do
    unique_ids = Enum.uniq(ids)

    rows =
      Repo.all(
        from row in schema,
          where: row.id in ^unique_ids and is_nil(row.archived_at),
          lock: "FOR SHARE"
      )

    if length(rows) == length(unique_ids),
      do: rows,
      else: Repo.rollback(error(:missing_or_archived_definition, %{kind: kind, ids: unique_ids}))
  end

  defp decode_tactic_source(%{tactic_source_type: "inline", inline_tactic: encoded}) do
    case TacticCodec.decode(encoded) do
      {:ok, body} -> {:ok, %Inline{body: body}}
      {:error, codec_error} -> {:error, error(:invalid_persisted_tactic, %{error: codec_error})}
    end
  end

  defp decode_tactic_source(%{
         tactic_source_type: "definition",
         tactic_definition_id: definition_id
       }) do
    {:ok, %Definition{tactic_definition_id: definition_id}}
  end

  defp decode_tactic_source(row),
    do: {:error, error(:invalid_persisted_tactic_source, %{type: row.tactic_source_type})}

  defp start_runtime(snapshot, run_id) do
    case Runtime.start(snapshot.execution_plan, run_id) do
      {:ok, run, actions} -> {:ok, run, actions}
      {:error, runtime_error} -> {:error, runtime_error}
    end
  end

  defp insert_launch(id, quest_id, run_id, snapshot) do
    attributes = %{
      id: id,
      quest_id: quest_id,
      run_id: run_id,
      snapshot_version: LaunchSnapshotCodec.version(),
      snapshot: LaunchSnapshotCodec.encode(snapshot)
    }

    case Repo.insert(QuestLaunch.changeset(attributes)) do
      {:ok, launch} -> {:ok, launch}
      {:error, changeset} -> {:error, changeset_error(changeset)}
    end
  end

  defp insert_workspace_assignment(run_id, workspace_id) do
    worktree_id = Ecto.UUID.generate()
    stable_id = String.replace(worktree_id, "-", "")
    branch_name = "qe/run/" <> stable_id

    identity_hash =
      :sha256
      |> :crypto.hash(
        Enum.join([run_id, workspace_id, worktree_id, "binding_head_v1", branch_name], "\n")
      )
      |> Base.encode16(case: :lower)

    attributes = %{
      run_id: run_id,
      workspace_id: workspace_id,
      worktree_id: worktree_id,
      base_selector: "binding_head_v1",
      branch_name: branch_name,
      state: "waiting_for_host",
      provision_revision: 1,
      identity_hash: identity_hash
    }

    Repo.insert(RunWorkspaceAssignment.changeset(attributes))
  end

  defp quest(row, tactic_source) do
    %Quest{
      id: row.id,
      title: row.title,
      objective: row.objective,
      workspace_id: row.workspace_id,
      squad_id: row.squad_id,
      tactic_source: tactic_source
    }
  end

  defp workspace(row) do
    %Workspace{
      id: row.id,
      key: row.key,
      name: row.name,
      source_kind: String.to_existing_atom(row.source_kind),
      source_fingerprint: row.source_fingerprint
    }
  end

  defp squad(row, members) do
    %Squad{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      members:
        Enum.map(members, fn member ->
          %Member{
            key: member.member_key,
            name: member.name,
            class_id: member.class_id,
            loadout_id: member.loadout_id
          }
        end)
    }
  end

  defp class(row) do
    %Class{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      instructions: row.instructions
    }
  end

  defp loadout(row) do
    %Loadout{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      model: %ModelRef{provider: row.model_provider, model: row.model_name},
      reasoning: reasoning(row.reasoning),
      tools: row.tools,
      workspace_access: workspace_access(row.workspace_access)
    }
  end

  defp reasoning("low"), do: :low
  defp reasoning("medium"), do: :medium
  defp reasoning("high"), do: :high
  defp workspace_access("none"), do: :none
  defp workspace_access("read_only"), do: :read_only
  defp workspace_access("read_write"), do: :read_write

  defp changeset_error(changeset),
    do: error(:constraint_failure, %{errors: Changeset.traverse_errors(changeset, &elem(&1, 0))})

  defp error(code, details), do: %Error{code: code, details: details}
end
