defmodule QuestEngineering.Server.SchedulingStore do
  @moduledoc "Atomic deterministic Product/context/Worker acquisition for Runtime Actions."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.ResolvedExecution.Builder
  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Server.CapabilityMatcher
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.OccurrenceContextBinding
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.ResolvedExecutionCodec
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RunWorkspaceStore

  @reserved_dispatch_states ~w(claimed dispatched acknowledged running uncertain)
  @default_lease_ms 1_000

  defmodule Error do
    @moduledoc "Structured scheduling wait or invariant failure."
    @enforce_keys [:code, :temporary, :details]
    defstruct [:code, :temporary, :details]
    @type t :: %__MODULE__{code: atom(), temporary: boolean(), details: map()}
  end

  @spec schedule_next(String.t(), keyword()) ::
          {:ok, map()} | {:waiting, [Error.t()]} | {:error, Error.t()}
  def schedule_next(run_id, options \\ []) do
    RunWorkspaceStore.prepare_legacy_test(run_id)

    case RunWorkspaceStore.fetch(run_id) do
      %{state: state} when state not in ["ready", "retained"] ->
        {:waiting,
         [waiting(:waiting_for_run_workspace, %{id: nil}, %{run_id: run_id, state: state})]}

      _assignment ->
        schedule_ready(run_id, options)
    end
  end

  defp schedule_ready(run_id, options) do
    case Repo.transaction(fn -> schedule_locked(run_id, options) end) do
      {:ok, {:scheduled, dispatch}} ->
        RunChangeNotifier.notify(run_id)
        {:ok, dispatch}

      {:ok, {:waiting, waits}} ->
        {:waiting, waits}

      {:error, %Error{} = error} ->
        {:error, error}

      {:error, error} ->
        {:error, invariant(:constraint_failure, %{error: inspect(error)})}
    end
  end

  def fetch_execution(action_id) do
    with %ScheduledActionExecution{} = scheduled <- Repo.get(ScheduledActionExecution, action_id),
         {:ok, execution} <-
           ResolvedExecutionCodec.decode(
             scheduled.resolved_execution,
             scheduled.resolved_execution_version
           ) do
      {:ok, %{scheduled: scheduled, execution: execution}}
    else
      nil -> {:error, invariant(:scheduled_execution_not_found, %{action_id: action_id})}
      {:error, error} -> {:error, invariant(:invalid_resolved_execution, %{error: error})}
    end
  end

  defp schedule_locked(run_id, options) do
    lock_run!(run_id)
    launch = load_launch!(run_id)
    assignment = load_ready_assignment!(run_id)
    snapshot = decode_snapshot!(launch)
    candidates = unscheduled_actions(run_id)

    candidates
    |> Enum.reduce_while({:waiting, []}, fn outbox, {:waiting, waits} ->
      action = decode_action!(outbox)

      case resolve_candidate(snapshot, launch, assignment, action) do
        {:ok, resolved} ->
          dispatch = persist_acquisition!(outbox, action, resolved, options)
          {:halt, {:scheduled, dispatch}}

        {:waiting, wait} ->
          {:cont, {:waiting, waits ++ [wait]}}

        {:error, error} ->
          Repo.rollback(error)
      end
    end)
  end

  defp resolve_candidate(snapshot, launch, assignment, action) do
    with {:ok, member} <- resolve_member(snapshot, action),
         {:ok, context} <- resolve_context(action),
         execution =
           Builder.build(
             snapshot,
             action,
             launch.id,
             member,
             context.logical_lineage_id,
             context.source_occurrence_id,
             %{
               worktree_id: assignment.worktree_id,
               workspace_binding_id: assignment.workspace_binding_id,
               canonical_root: assignment.canonical_worktree_root
             }
           ),
         {:ok, worker, slot} <- select_worker(execution, assignment, action, context) do
      {:ok, %{member: member, context: context, execution: execution, worker: worker, slot: slot}}
    end
  end

  defp resolve_member(
         snapshot,
         %Action{
           performer_requirement: %PerformerRequirement{selector: :class, value: class_key}
         } = action
       ) do
    case existing_member_binding(action) do
      %OccurrenceMemberBinding{} = binding -> member_by_key(snapshot, action, binding.member_key)
      nil -> first_available_class_member(snapshot, action.run_id, class_key)
    end
  end

  defp resolve_member(snapshot, %Action{performer_affinity_occurrence_id: affinity} = action)
       when is_binary(affinity) do
    case existing_member_binding(action) do
      %OccurrenceMemberBinding{} = binding ->
        member_by_key(snapshot, action, binding.member_key)

      nil ->
        resolve_affinity_member(snapshot, action, affinity)
    end
  end

  defp resolve_member(_snapshot, action),
    do: {:error, invariant(:unsupported_performer_requirement, %{action_id: action.id})}

  defp resolve_affinity_member(snapshot, action, affinity) do
    binding =
      Repo.get_by(OccurrenceMemberBinding,
        run_id: action.run_id,
        occurrence_id: affinity
      )

    if binding do
      available_affinity_member(snapshot, action, binding)
    else
      {:error,
       invariant(:missing_affinity_member_binding, %{
         run_id: action.run_id,
         affinity_occurrence_id: affinity
       })}
    end
  end

  defp available_affinity_member(snapshot, action, binding),
    do: member_by_key(snapshot, action, binding.member_key)

  defp existing_member_binding(action),
    do:
      Repo.get_by(OccurrenceMemberBinding,
        run_id: action.run_id,
        occurrence_id: action.occurrence_id
      )

  defp first_available_class_member(snapshot, run_id, class_key) do
    members = Enum.filter(snapshot.squad.members, &(&1.class.key == class_key))

    case Enum.find(members, &(not member_occupied?(run_id, &1.key))) do
      nil -> {:waiting, waiting(:waiting_for_member, %{run_id: run_id}, %{class_key: class_key})}
      member -> {:ok, member}
    end
  end

  defp member_by_key(snapshot, action, member_key) do
    case Enum.find(snapshot.squad.members, &(&1.key == member_key)) do
      nil ->
        {:error,
         invariant(:binding_snapshot_mismatch, %{action_id: action.id, member_key: member_key})}

      member ->
        if member_occupied?(action.run_id, member_key) do
          {:waiting, waiting(:waiting_for_member, action, %{member_key: member_key})}
        else
          {:ok, member}
        end
    end
  end

  defp member_occupied?(run_id, member_key) do
    Repo.exists?(
      from scheduled in ScheduledActionExecution,
        where:
          scheduled.run_id == ^run_id and scheduled.member_key == ^member_key and
            scheduled.state == "active"
    )
  end

  defp resolve_context(
         %Action{context_requirement: %ContextRequirement{selector: :fresh}} = action
       ) do
    case existing_context_binding(action) do
      nil ->
        {:ok, %{logical_lineage_id: Ecto.UUID.generate(), source_occurrence_id: nil}}

      binding ->
        available_context(action, binding.logical_lineage_id, binding.source_occurrence_id)
    end
  end

  defp resolve_context(%Action{context_lineage_occurrence_id: source} = action)
       when is_binary(source) do
    case existing_context_binding(action) do
      nil ->
        case Repo.get_by(OccurrenceContextBinding,
               run_id: action.run_id,
               occurrence_id: source
             ) do
          nil ->
            {:error,
             invariant(:missing_context_source_binding, %{
               run_id: action.run_id,
               source_occurrence_id: source
             })}

          source_binding ->
            available_context(action, source_binding.logical_lineage_id, source)
        end

      binding ->
        available_context(action, binding.logical_lineage_id, binding.source_occurrence_id)
    end
  end

  defp resolve_context(action),
    do: {:error, invariant(:unsupported_context_requirement, %{action_id: action.id})}

  defp existing_context_binding(action),
    do:
      Repo.get_by(OccurrenceContextBinding,
        run_id: action.run_id,
        occurrence_id: action.occurrence_id
      )

  defp available_context(action, logical_lineage_id, source_occurrence_id) do
    occupied? =
      Repo.exists?(
        from scheduled in ScheduledActionExecution,
          where:
            scheduled.run_id == ^action.run_id and
              scheduled.logical_lineage_id == ^logical_lineage_id and
              scheduled.state == "active"
      )

    if occupied? do
      {:waiting, waiting(:waiting_for_context, action, %{logical_lineage_id: logical_lineage_id})}
    else
      {:ok, %{logical_lineage_id: logical_lineage_id, source_occurrence_id: source_occurrence_id}}
    end
  end

  defp select_worker(execution, assignment, action, context) do
    continuation_worker_id = continuation_worker(action, context)
    required_worker_id = assignment.worker_id

    if continuation_worker_id && continuation_worker_id != required_worker_id do
      Repo.rollback(invariant(:continuation_run_worker_mismatch, %{run_id: action.run_id}))
    end

    requested =
      execution.configuration
      |> Map.from_struct()
      |> Map.put(:workspace_access, execution.execution_workspace.access)

    workers =
      Repo.all(
        from worker in Worker,
          where: worker.status == "connected",
          order_by: [asc: worker.id],
          lock: "FOR UPDATE"
      )
      |> Enum.filter(fn worker ->
        worker.id == required_worker_id and
          CapabilityMatcher.executor_compatible?(worker.capabilities, requested)
      end)

    case Enum.find_value(workers, &worker_with_free_slot/1) do
      {worker, slot} ->
        {:ok, worker, slot}

      nil when workers == [] ->
        {:waiting,
         waiting(:waiting_for_worker, action, %{required_worker_id: required_worker_id})}

      nil ->
        {:waiting,
         waiting(:waiting_for_capacity, action, %{
           compatible_worker_ids: Enum.map(workers, & &1.id)
         })}
    end
  end

  defp continuation_worker(_action, %{source_occurrence_id: nil}), do: nil

  defp continuation_worker(action, %{source_occurrence_id: source}) do
    Repo.one(
      from scheduled in ScheduledActionExecution,
        where: scheduled.run_id == ^action.run_id and scheduled.occurrence_id == ^source,
        select: scheduled.worker_id
    ) || Repo.rollback(invariant(:missing_source_execution, %{source_occurrence_id: source}))
  end

  defp worker_with_free_slot(worker) do
    case free_slot(worker) do
      nil -> nil
      slot -> {worker, slot}
    end
  end

  defp free_slot(worker) do
    used =
      Repo.all(
        from dispatch in WorkerDispatch,
          where:
            dispatch.worker_id == ^worker.id and dispatch.state in ^@reserved_dispatch_states,
          select: dispatch.worker_slot
      )
      |> MapSet.new()

    Enum.find(0..(worker.max_concurrency - 1), &(not MapSet.member?(used, &1)))
  end

  defp persist_acquisition!(outbox, action, resolved, options) do
    now = now()
    insert_member_binding!(action, resolved.member, now)
    insert_context_binding!(action, resolved.context, now)

    encoded_execution = ResolvedExecutionCodec.encode(resolved.execution)

    scheduled =
      insert!(
        ScheduledActionExecution.changeset(%{
          action_id: action.id,
          run_id: action.run_id,
          occurrence_id: action.occurrence_id,
          member_key: resolved.member.key,
          logical_lineage_id: resolved.context.logical_lineage_id,
          worker_id: resolved.worker.id,
          state: "active",
          resolved_execution_version: ResolvedExecutionCodec.version(),
          resolved_execution: encoded_execution,
          bound_at: now
        })
      )

    lease_ms = Keyword.get(options, :lease_ms, @default_lease_ms)
    claim_token = Ecto.UUID.generate()

    dispatch =
      insert!(
        WorkerDispatch.changeset(%{
          action_id: action.id,
          worker_id: resolved.worker.id,
          worker_slot: resolved.slot,
          state: "claimed",
          payload_hash: payload_hash(encoded_execution),
          claim_owner: Keyword.get(options, :claim_owner, "scheduler"),
          claim_token: claim_token,
          claim_expires_at: DateTime.add(now, lease_ms, :millisecond)
        })
      )

    %{
      action_id: action.id,
      run_id: action.run_id,
      outbox: outbox,
      scheduled: scheduled,
      worker_id: resolved.worker.id,
      worker_slot: resolved.slot,
      state: :claimed,
      claim_token: dispatch.claim_token,
      execution: resolved.execution
    }
  end

  defp insert_member_binding!(action, member, now) do
    insert!(
      OccurrenceMemberBinding.changeset(%{
        run_id: action.run_id,
        occurrence_id: action.occurrence_id,
        member_key: member.key,
        bound_at: now
      })
    )
  end

  defp insert_context_binding!(action, context, now) do
    insert!(
      OccurrenceContextBinding.changeset(%{
        run_id: action.run_id,
        occurrence_id: action.occurrence_id,
        logical_lineage_id: context.logical_lineage_id,
        source_occurrence_id: context.source_occurrence_id,
        bound_at: now
      })
    )
  end

  defp insert!(changeset) do
    case Repo.insert(changeset) do
      {:ok, row} -> row
      {:error, changeset} -> Repo.rollback(changeset_error(changeset))
    end
  end

  defp lock_run!(run_id) do
    case Repo.one(from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE") do
      nil -> Repo.rollback(invariant(:run_not_found, %{run_id: run_id}))
      run -> run
    end
  end

  defp load_ready_assignment!(run_id) do
    case Repo.one(
           from assignment in RunWorkspaceAssignment,
             where: assignment.run_id == ^run_id,
             lock: "FOR UPDATE"
         ) do
      %{state: state, canonical_worktree_root: root} = assignment
      when state in ["ready", "retained"] and is_binary(root) ->
        assignment

      %{state: state} ->
        Repo.rollback(invariant(:run_workspace_not_ready, %{run_id: run_id, state: state}))

      nil ->
        Repo.rollback(invariant(:missing_run_workspace_assignment, %{run_id: run_id}))
    end
  end

  defp load_launch!(run_id) do
    case Repo.get_by(QuestLaunch, run_id: run_id) do
      nil -> Repo.rollback(invariant(:missing_quest_launch, %{run_id: run_id}))
      launch -> launch
    end
  end

  defp decode_snapshot!(launch) do
    case LaunchSnapshotCodec.decode(launch.snapshot, launch.snapshot_version) do
      {:ok, %LaunchSnapshot{} = snapshot} -> snapshot
      {:error, error} -> Repo.rollback(invariant(:invalid_launch_snapshot, %{error: error}))
    end
  end

  defp unscheduled_actions(run_id) do
    Repo.all(
      from outbox in RuntimeOutbox,
        left_join: scheduled in ScheduledActionExecution,
        on: scheduled.action_id == outbox.action_id,
        where: outbox.run_id == ^run_id and is_nil(scheduled.action_id),
        order_by: [asc: outbox.run_revision, asc: outbox.emission_index],
        lock: "FOR UPDATE OF r0",
        select: outbox
    )
  end

  defp decode_action!(outbox) do
    case RuntimeCodec.decode(outbox.payload) do
      {:ok, %Action{} = action} -> action
      {:error, error} -> Repo.rollback(invariant(:invalid_action, %{error: error}))
    end
  end

  defp changeset_error(changeset) do
    invariant(:constraint_failure, %{
      errors: Changeset.traverse_errors(changeset, &elem(&1, 0))
    })
  end

  defp waiting(code, action, details),
    do: %Error{
      code: code,
      temporary: true,
      details: Map.merge(%{action_id: Map.get(action, :id)}, details)
    }

  defp invariant(code, details), do: %Error{code: code, temporary: false, details: details}

  defp payload_hash(payload) do
    :sha256 |> :crypto.hash(Jason.encode!(payload)) |> Base.encode16(case: :lower)
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
