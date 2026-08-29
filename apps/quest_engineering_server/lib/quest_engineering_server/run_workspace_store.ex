# credo:disable-for-this-file Credo.Check.Refactor.Nesting
defmodule QuestEngineering.Server.RunWorkspaceStore do
  @moduledoc "Durable Run-to-Worker worktree affinity and provisioning state."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Server.CapabilityMatcher
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RunWorkspaceProvisioner

  @access_rank %{"none" => 0, "read_only" => 1, "read_write" => 2}

  def ensure_assignment(run_id) do
    case Repo.transaction(fn -> ensure_locked(run_id) end) do
      {:ok, result} -> result
      {:error, error} -> {:error, error}
    end
  end

  def ready(worker_id, generation, worktree) do
    update_from_worker(worker_id, generation, worktree, fn assignment ->
      assignment
      |> Changeset.change(
        state: if(assignment.state == "retained", do: "retained", else: "ready"),
        base_revision: worktree.base_revision,
        canonical_worktree_root: worktree.canonical_root,
        source_dirty_excluded: worktree.source_dirty_excluded,
        ready_at: now(),
        failure_code: nil,
        failure_details: nil
      )
      |> Repo.update!()
    end)
  end

  def attention(worker_id, generation, worktree) do
    update_from_worker(worker_id, generation, worktree, fn assignment ->
      assignment
      |> Changeset.change(
        state: "attention_required",
        failure_code: worktree.failure_code,
        failure_details: worktree.failure_details
      )
      |> Repo.update!()
    end)
  end

  def fail(worker_id, generation, worktree) do
    update_from_worker(worker_id, generation, worktree, fn assignment ->
      assignment
      |> Changeset.change(
        state: "failed",
        failure_code: worktree.failure_code,
        failure_details: worktree.failure_details
      )
      |> Repo.update!()
    end)
  end

  def fetch(run_id), do: Repo.get(RunWorkspaceAssignment, run_id)

  # Compatibility only for pre-v4 test fixtures; production never enables this flag.
  # credo:disable-for-next-line Credo.Check.Refactor.Nesting
  def prepare_legacy_test(run_id) do
    if Application.get_env(:quest_engineering_server, :legacy_test_auto_worktrees, false) do
      case ensure_assignment(run_id) do
        {:provision, assignment} ->
          binding = Repo.get(WorkerWorkspaceBinding, assignment.workspace_binding_id)

          if binding && binding.authorized_root_key == "legacy-test" do
            assignment
            |> Changeset.change(
              state: "ready",
              base_revision: String.duplicate("a", 40),
              canonical_worktree_root: "/managed/worktrees/" <> assignment.worktree_id,
              source_dirty_excluded: false,
              ready_at: now()
            )
            |> Repo.update!()
          else
            RunWorkspaceProvisioner.deliver_assignment(assignment)
          end

        _other ->
          :ok
      end
    end

    :ok
  end

  def assignments_for_worker(worker_id) do
    Repo.all(
      from assignment in RunWorkspaceAssignment,
        where:
          assignment.worker_id == ^worker_id and
            assignment.state in ["provisioning", "ready", "attention_required", "retained"],
        order_by: [asc: assignment.inserted_at]
    )
  end

  # credo:disable-for-next-line Credo.Check.Refactor.Nesting
  def fence_for_action(worker_id, generation, action_id, failure) do
    import Ecto.Query
    alias QuestEngineering.Server.Persistence.ScheduledActionExecution

    case Repo.transaction(fn ->
           assignment =
             Repo.one(
               from scheduled in ScheduledActionExecution,
                 join: assignment in RunWorkspaceAssignment,
                 on: assignment.run_id == scheduled.run_id,
                 where: scheduled.action_id == ^action_id and assignment.worker_id == ^worker_id,
                 lock: "FOR UPDATE",
                 select: assignment
             ) || Repo.rollback(:assignment_not_found)

           worker = Repo.get!(Worker, worker_id)
           if worker.connection_generation != generation, do: Repo.rollback(:stale_generation)

           assignment
           |> Changeset.change(
             state: "attention_required",
             failure_code: failure["code"] || "run_worktree_integrity_violation",
             failure_details: failure
           )
           |> Repo.update!()
         end) do
      {:ok, assignment} ->
        RunChangeNotifier.notify(assignment.run_id)
        {:ok, assignment}

      {:error, error} ->
        {:error, error}
    end
  end

  defp ensure_locked(run_id) do
    assignment =
      Repo.one(
        from assignment in RunWorkspaceAssignment,
          where: assignment.run_id == ^run_id,
          lock: "FOR UPDATE"
      ) || Repo.rollback(:assignment_not_found)

    case assignment.state do
      "ready" ->
        {:ready, assignment}

      "retained" ->
        {:ready, assignment}

      "provisioning" ->
        {:provision, assignment}

      "waiting_for_host" ->
        assign_host(assignment)

      state when state in ["attention_required", "failed", "cleanup_requested", "removed"] ->
        {:blocked, assignment}
    end
  end

  defp assign_host(assignment) do
    snapshot = snapshot!(assignment.run_id)
    requirements = required_loadouts(snapshot)
    ensure_legacy_test_bindings!(assignment.workspace_id)

    candidates =
      Repo.all(
        from binding in WorkerWorkspaceBinding,
          join: worker in Worker,
          on: worker.id == binding.worker_id,
          where:
            binding.workspace_id == ^assignment.workspace_id and binding.status == "available" and
              worker.status == "connected",
          order_by: [asc: worker.active_dispatches, asc: worker.id],
          lock: "FOR UPDATE",
          select: {worker, binding}
      )

    case Enum.find(candidates, fn {worker, binding} ->
           Enum.all?(requirements, &compatible_requirement?(worker, binding, &1))
         end) do
      nil ->
        {:waiting_for_host, assignment}

      {worker, binding} ->
        assigned =
          assignment
          |> Changeset.change(
            worker_id: worker.id,
            workspace_binding_id: binding.binding_id,
            state: "provisioning",
            assigned_at: now()
          )
          |> Repo.update!()

        {:provision, assigned}
    end
  end

  # Additive compatibility for pre-v4 tests/historical fake executors. Production v4 Workers
  # advertise explicit top-level bindings and never enter this path.
  # credo:disable-for-next-line Credo.Check.Refactor.Nesting
  defp ensure_legacy_test_bindings!(workspace_id) do
    workspace = Repo.get!(ProductWorkspace, workspace_id)

    Repo.all(from worker in Worker, where: worker.status == "connected")
    |> Enum.each(fn worker ->
      existing =
        Repo.get_by(WorkerWorkspaceBinding, worker_id: worker.id, workspace_id: workspace_id)

      if is_nil(existing) do
        legacy =
          worker.capabilities
          |> Map.get("executors", [])
          |> Enum.flat_map(&Map.get(&1, "workspaces", []))
          |> Enum.find(&(&1["ref"] in [workspace.key, workspace.name]))

        if legacy do
          attributes = %{
            binding_id: Ecto.UUID.generate(),
            worker_id: worker.id,
            workspace_id: workspace_id,
            authorized_root_key: "legacy-test",
            source_repository_root: legacy["root"],
            source_fingerprint: nil,
            max_access: legacy["max_access"],
            allow_unconfined_shell: true,
            status: "available",
            last_seen_generation: worker.connection_generation,
            last_seen_at: now()
          }

          Repo.insert!(WorkerWorkspaceBinding.changeset(attributes))
        end
      end
    end)
  end

  defp snapshot!(run_id) do
    launch = Repo.get_by!(QuestLaunch, run_id: run_id)

    case LaunchSnapshotCodec.decode(launch.snapshot, launch.snapshot_version) do
      {:ok, %LaunchSnapshot{} = snapshot} -> snapshot
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp required_loadouts(snapshot) do
    classes =
      snapshot.execution_plan.steps
      |> Enum.flat_map(fn
        %{performer: %PerformerRequirement{selector: :class, value: key}} -> [key]
        _step -> []
      end)
      |> MapSet.new()

    snapshot.squad.members
    |> Enum.filter(&MapSet.member?(classes, &1.class.key))
    |> Enum.map(& &1.loadout)
    |> Enum.uniq_by(fn loadout ->
      {loadout.model.provider, loadout.model.model, loadout.reasoning, Enum.sort(loadout.tools),
       loadout.workspace_access}
    end)
  end

  defp compatible_requirement?(worker, binding, loadout) do
    requested_access = Atom.to_string(loadout.workspace_access)

    shell_allowed =
      "terminal.shell" not in loadout.tools or binding.allow_unconfined_shell

    access_allowed = @access_rank[binding.max_access] >= @access_rank[requested_access]

    shell_allowed and access_allowed and
      CapabilityMatcher.executor_compatible?(worker.capabilities, %{
        model: loadout.model,
        reasoning: loadout.reasoning,
        tools: loadout.tools,
        workspace_access: loadout.workspace_access
      })
  end

  # credo:disable-for-next-line Credo.Check.Refactor.Nesting
  defp update_from_worker(worker_id, generation, worktree, fun) do
    case Repo.transaction(fn ->
           worker = Repo.get!(Worker, worker_id)
           if worker.connection_generation != generation, do: Repo.rollback(:stale_generation)

           assignment =
             Repo.one(
               from assignment in RunWorkspaceAssignment,
                 where:
                   assignment.worktree_id == ^worktree.worktree_id and
                     assignment.worker_id == ^worker_id,
                 lock: "FOR UPDATE"
             ) || Repo.rollback(:assignment_not_found)

           if identity_conflict?(assignment, worktree) do
             Repo.rollback(:worktree_identity_conflict)
           end

           fun.(assignment)
         end) do
      {:ok, assignment} ->
        RunChangeNotifier.notify(assignment.run_id)
        {:ok, assignment}

      {:error, error} ->
        {:error, error}
    end
  end

  defp identity_conflict?(assignment, worktree) do
    assignment.identity_hash != worktree.identity_hash or
      assignment.run_id != worktree.run_id or
      assignment.workspace_binding_id != worktree.workspace_binding_id or
      (Map.has_key?(worktree, :branch_name) and assignment.branch_name != worktree.branch_name)
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
