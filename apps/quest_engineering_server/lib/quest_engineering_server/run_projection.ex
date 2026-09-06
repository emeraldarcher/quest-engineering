defmodule QuestEngineering.Server.RunProjection do
  @moduledoc "Product-facing, snapshot-backed view of one durable Quest run."

  import Ecto.Query

  alias QuestEngineering.Server.DeliveryEligibility
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore

  def get(run_id) do
    with %QuestLaunch{} = launch <- Repo.get_by(QuestLaunch, run_id: run_id),
         {:ok, snapshot} <- LaunchSnapshotCodec.decode(launch.snapshot, launch.snapshot_version),
         {:ok, %{run: run, revision: revision}} <- RuntimeStore.fetch_run(run_id) do
      {:ok, build(launch, snapshot, run, revision)}
    else
      nil -> {:error, :not_found}
      {:error, _} = error -> error
    end
  end

  def list(quest_id \\ nil) do
    query = from launch in QuestLaunch, order_by: [desc: launch.inserted_at, asc: launch.run_id]
    query = if quest_id, do: where(query, [launch], launch.quest_id == ^quest_id), else: query

    query
    |> Repo.all()
    |> Enum.reduce_while({:ok, []}, fn launch, {:ok, values} ->
      case get(launch.run_id) do
        {:ok, projection} -> {:cont, {:ok, [summary(projection) | values]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
    |> reverse_ok()
  end

  def artifact(run_id, artifact_id) do
    with {:ok, internal_id} <- decode_artifact_id(artifact_id),
         {:ok, projection} <- get(run_id),
         {:ok, %{run: run}} <- RuntimeStore.fetch_run(run_id),
         artifact when not is_nil(artifact) <- Map.get(run.artifacts, internal_id) do
      {:ok,
       Map.put(Enum.find(projection.artifacts, &(&1.id == artifact_id)), :value, artifact.value)}
    else
      nil -> {:error, :not_found}
      error -> error
    end
  end

  def summary(projection) do
    %{
      id: projection.id,
      status: projection.status,
      quest_title: projection.quest.title,
      launched_at: projection.launched_at,
      step_counts: projection.step_counts,
      delivery: projection.delivery
    }
  end

  defp build(launch, snapshot, run, revision) do
    {actions, scheduled, dispatches} = execution_data(run.id)

    execution = %{
      action_by_attempt: Map.new(actions, fn action -> {action.attempt_id, action} end),
      scheduled_by_action: Map.new(scheduled, &{&1.action_id, &1}),
      dispatch_by_action: Map.new(dispatches, &{&1.action_id, &1})
    }

    plan_by_key = Map.new(run.plan.steps, &{&1.key, &1})

    steps =
      Enum.map(run.occurrence_order, fn id ->
        occurrence = Map.fetch!(run.occurrences, id)
        step(occurrence, execution, run, snapshot, plan_by_key)
      end)

    artifacts =
      Enum.map(run.artifact_order, fn id ->
        project_artifact(Map.fetch!(run.artifacts, id), run)
      end)

    review_gate = DeliveryEligibility.assess(run)
    states = Enum.map(steps, & &1.state)

    assignment = Repo.get(RunWorkspaceAssignment, run.id)
    delivery = DeliveryStore.fetch(run.id)

    %{
      id: run.id,
      status: run_state(run.status, states),
      launched_at: iso(launch.inserted_at),
      revision: revision,
      launch: %{id: launch.id},
      execution_environment: execution_environment(snapshot, assignment),
      delivery: DeliveryStore.projection(delivery),
      quest: %{
        id: snapshot.quest.id,
        title: snapshot.quest.title,
        objective: snapshot.quest.objective
      },
      squad: %{
        id: snapshot.squad.id,
        key: snapshot.squad.key,
        name: snapshot.squad.name,
        members: Enum.map(snapshot.squad.members, &snapshot_member/1)
      },
      tactic:
        Map.merge(View.provenance(snapshot.tactic_provenance) || %{root: nil, definitions: []}, %{
          step_count: length(run.plan.steps)
        }),
      steps: steps,
      artifacts: artifacts,
      review_gate: review_gate(review_gate),
      step_counts: counts(states),
      issues:
        run_issues(run, steps, review_gate) ++
          case execution_environment(snapshot, assignment).issue do
            nil -> []
            issue -> [issue]
          end
    }
  end

  defp execution_environment(snapshot, nil) do
    %{
      workspace: %{
        id: snapshot.workspace.id,
        key: snapshot.workspace.key,
        name: snapshot.workspace.name
      },
      state: "attention_required",
      message: "Run workspace assignment is missing.",
      base_revision: nil,
      branch: nil,
      source_dirty_changes_excluded: nil,
      issue: %{
        code: "run_workspace_assignment_missing",
        message: "Run workspace assignment is missing."
      }
    }
  end

  defp execution_environment(snapshot, assignment) do
    {state, message, issue} =
      case assignment.state do
        "waiting_for_host" ->
          {"waiting_for_host", "Waiting for a Worker capable of hosting this Workspace.", nil}

        "provisioning" ->
          {"preparing", "Preparing an isolated Run workspace.", nil}

        "ready" ->
          {"ready", "Run workspace ready.", nil}

        "retained" ->
          {"retained", "Terminal Run workspace retained.", nil}

        "cleanup_requested" ->
          {"cleanup_requested", "Removing the retained Run workspace.", nil}

        "removed" ->
          {"removed", "Run workspace removed.", nil}

        _ ->
          {"attention_required", "The Run workspace requires attention.",
           %{
             code: assignment.failure_code || "run_workspace_attention_required",
             message: "The Run workspace requires attention."
           }}
      end

    %{
      workspace: %{
        id: snapshot.workspace.id,
        key: snapshot.workspace.key,
        name: snapshot.workspace.name
      },
      state: state,
      message: message,
      base_revision: assignment.base_revision,
      branch: assignment.branch_name,
      source_dirty_changes_excluded: assignment.source_dirty_excluded,
      issue: issue
    }
  end

  defp execution_data(run_id) do
    actions =
      RuntimeOutbox
      |> where([outbox], outbox.run_id == ^run_id)
      |> Repo.all()
      |> Enum.flat_map(fn row ->
        case RuntimeCodec.decode(row.payload) do
          {:ok, action} -> [action]
          _ -> []
        end
      end)

    scheduled = Repo.all(from item in ScheduledActionExecution, where: item.run_id == ^run_id)
    action_ids = Enum.map(scheduled, & &1.action_id)

    dispatches =
      if action_ids == [],
        do: [],
        else: Repo.all(from item in WorkerDispatch, where: item.action_id in ^action_ids)

    {actions, scheduled, dispatches}
  end

  defp step(occurrence, execution, run, snapshot, plan_by_key) do
    plan_step = Map.get(plan_by_key, occurrence.semantic_step_key)
    action = Map.get(execution.action_by_attempt, occurrence.current_attempt_id)
    scheduled = action && Map.get(execution.scheduled_by_action, action.id)
    dispatch = action && Map.get(execution.dispatch_by_action, action.id)
    state = occurrence_state(occurrence.status, scheduled, dispatch)
    member = if scheduled, do: member(snapshot, scheduled.member_key), else: nil
    attempts = attempts(occurrence, execution)

    %{
      occurrence_id: occurrence.id,
      semantic_step_key: occurrence.semantic_step_key,
      name: plan_step && plan_step.name,
      instruction: plan_step && plan_step.instruction,
      state: state,
      phase: occurrence.phase && Atom.to_string(occurrence.phase),
      remediation_cycle: occurrence.remediation_cycle,
      control_path: occurrence.control_path,
      attempt: Enum.find(attempts, &(&1.id == occurrence.current_attempt_id)),
      attempts: attempts,
      member: member,
      performer: performer(action, plan_step, run),
      context: context(action, plan_step, run),
      inputs: artifact_refs(occurrence.input_artifact_ids),
      outputs: artifact_refs(occurrence.output_artifact_ids),
      issue: issue(state, dispatch),
      recovery: recovery(state, dispatch)
    }
  end

  defp recovery("uncertain", dispatch) do
    %{
      can_retry: true,
      can_mark_failed: true,
      message:
        get_in(dispatch && dispatch.failure, ["message"]) ||
          "The Worker could not prove whether this attempt completed."
    }
  end

  defp recovery(_state, _dispatch), do: nil

  defp occurrence_state(:pending, _scheduled, _dispatch), do: "pending"
  defp occurrence_state(:completed, _scheduled, _dispatch), do: "completed"
  defp occurrence_state(:failed, _scheduled, _dispatch), do: "failed"
  defp occurrence_state(:dispatched, _scheduled, %{state: "uncertain"}), do: "uncertain"
  defp occurrence_state(:dispatched, %{state: "failed"}, _dispatch), do: "failed"
  defp occurrence_state(:dispatched, _scheduled, %{state: "failed"}), do: "failed"
  defp occurrence_state(:dispatched, _scheduled, %{state: "running"}), do: "running"

  defp occurrence_state(:dispatched, _scheduled, %{state: state})
       when state in ["claimed", "dispatched", "acknowledged"], do: "scheduled"

  defp occurrence_state(:dispatched, %{}, _dispatch), do: "scheduled"
  defp occurrence_state(:dispatched, _scheduled, _dispatch), do: "waiting"

  defp performer(action, plan_step, run) do
    requirement = (action && action.performer_requirement) || (plan_step && plan_step.performer)
    source_id = action && action.performer_affinity_occurrence_id

    %{
      selector: requirement && Atom.to_string(requirement.selector),
      class_key: class_key(requirement),
      source_occurrence_id: source_id,
      source_semantic_step_key: semantic_key(run, source_id)
    }
  end

  defp context(action, plan_step, run) do
    requirement = (action && action.context_requirement) || (plan_step && plan_step.context)
    source_id = action && action.context_lineage_occurrence_id

    %{
      mode: requirement && Atom.to_string(requirement.selector),
      source_occurrence_id: source_id,
      source_semantic_step_key: semantic_key(run, source_id)
    }
  end

  defp class_key(%{selector: :class, value: value}), do: value
  defp class_key(_), do: nil
  defp semantic_key(_run, nil), do: nil

  defp semantic_key(run, id) do
    case Map.get(run.occurrences, id) do
      nil -> nil
      occurrence -> occurrence.semantic_step_key
    end
  end

  defp attempts(occurrence, execution) do
    Enum.map(occurrence.attempts, fn attempt ->
      action = Map.get(execution.action_by_attempt, attempt.id)
      scheduled = action && Map.get(execution.scheduled_by_action, action.id)
      dispatch = action && Map.get(execution.dispatch_by_action, action.id)
      outputs = attempt_outputs(attempt, occurrence)

      %{
        id: attempt.id,
        number: attempt.number,
        state: attempt_state(attempt, scheduled, dispatch),
        started_at:
          iso((dispatch && dispatch.dispatched_at) || (scheduled && scheduled.bound_at)),
        finished_at:
          iso((dispatch && dispatch.terminal_at) || (scheduled && scheduled.terminal_at)),
        outputs: outputs,
        output_produced: outputs != [],
        resolution: attempt_resolution(dispatch),
        retry_of_attempt_id: previous_attempt_id(occurrence.attempts, attempt.number)
      }
    end)
  end

  defp attempt_state(_attempt, _scheduled, %{state: "uncertain"}), do: "uncertain"

  defp attempt_state(_attempt, _scheduled, %{failure: %{"code" => "operator_retry_requested"}}),
    do: "uncertain"

  defp attempt_state(attempt, scheduled, dispatch) do
    occurrence_state(attempt.status, scheduled, dispatch)
  end

  defp attempt_outputs(%{id: id}, %{current_attempt_id: id, status: :completed} = occurrence),
    do: artifact_refs(occurrence.output_artifact_ids)

  defp attempt_outputs(_attempt, _occurrence), do: []

  defp attempt_resolution(%{failure: %{"code" => "operator_retry_requested"}}), do: "retried"
  defp attempt_resolution(%{failure: %{"code" => "operator_marked_failed"}}), do: "marked_failed"
  defp attempt_resolution(_dispatch), do: nil

  defp previous_attempt_id(attempts, number) when number > 1 do
    case Enum.find(attempts, &(&1.number == number - 1)) do
      nil -> nil
      attempt -> attempt.id
    end
  end

  defp previous_attempt_id(_attempts, _number), do: nil

  defp member(snapshot, key) do
    case Enum.find(snapshot.squad.members, &(&1.key == key)) do
      nil -> nil
      value -> snapshot_member(value)
    end
  end

  defp snapshot_member(value) do
    %{
      member_key: value.key,
      name: value.name,
      class: %{id: value.class.id, key: value.class.key, name: value.class.name},
      loadout: %{id: value.loadout.id, key: value.loadout.key, name: value.loadout.name}
    }
  end

  defp artifact_refs(values) do
    values
    |> Enum.sort_by(fn {type, _id} -> type end)
    |> Enum.map(fn {type, id} -> %{type: type, artifact_id: public_artifact_id(id)} end)
  end

  defp project_artifact(value, run) do
    occurrence = Map.get(run.occurrences, value.producer_occurrence_id)

    %{
      id: public_artifact_id(value.id),
      type: value.type,
      producer_occurrence_id: value.producer_occurrence_id,
      producer_attempt_id: occurrence && occurrence.current_attempt_id,
      preview: artifact_preview(value.type, value.value)
    }
  end

  defp artifact_preview("verdict", %{"status" => status})
       when status in ~w(accepted rejected),
       do: %{kind: "review_verdict", status: status}

  defp artifact_preview(_type, value)
       when is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value),
       do: %{kind: "scalar", value: value}

  defp artifact_preview(_type, value) when is_list(value),
    do: %{kind: "json_summary", summary: "array"}

  defp artifact_preview(_type, value) when is_map(value),
    do: %{kind: "json_summary", summary: "object"}

  defp issue("failed", _dispatch),
    do: %{code: "execution_failed", message: "Execution reported a terminal failure."}

  defp issue("uncertain", dispatch),
    do: %{
      code: "execution_uncertain",
      message:
        get_in(dispatch && dispatch.failure, ["message"]) ||
          "The Worker could not prove whether this attempt completed."
    }

  defp issue(_, _dispatch), do: nil

  defp run_state(:failed, _states), do: "failed"
  defp run_state(:completed, _states), do: "completed"

  defp run_state(:running, states) do
    Enum.find(
      ["uncertain", "failed", "running", "scheduled", "waiting", "pending"],
      "pending",
      &(&1 in states)
    )
  end

  defp counts(states) do
    Enum.reduce(
      ["pending", "waiting", "scheduled", "running", "completed", "failed", "uncertain"],
      %{},
      fn state, counts ->
        Map.put(counts, state, Enum.count(states, &(&1 == state)))
      end
    )
  end

  defp run_issues(run, steps, review_gate) do
    runtime = runtime_issue(run, review_gate)
    runtime ++ (steps |> Enum.map(& &1.issue) |> Enum.reject(&is_nil/1))
  end

  defp runtime_issue(%{failure: %{type: :until_exhausted}} = run, _review_gate) do
    message =
      if review_until_exhausted?(run),
        do: "Review acceptance was not achieved before the remediation limit was exhausted.",
        else: "The remediation limit was exhausted before its required condition was satisfied."

    code = if review_until_exhausted?(run), do: "review_exhausted", else: "remediation_exhausted"
    [%{code: code, message: message}]
  end

  defp runtime_issue(%{failure: failure}, _review_gate) when not is_nil(failure),
    do: [%{code: "run_failed", message: "The runtime reached a terminal failure."}]

  defp runtime_issue(%{status: :completed}, %{required: true, status: status} = review_gate)
       when status != :accepted do
    issue = DeliveryEligibility.issue(review_gate)
    [Map.take(issue, [:code, :message])]
  end

  defp runtime_issue(_run, _review_gate), do: []

  defp review_until_exhausted?(run) do
    Enum.any?(run.plan.control_regions, fn region ->
      region.id == run.failure.region_id and region.condition_binding.artifact_type == "verdict"
    end)
  end

  defp review_gate(value) do
    %{
      required: value.required,
      status: Atom.to_string(value.status),
      occurrence_id: value.occurrence_id,
      attempt_id: value.attempt_id,
      artifact_id: value.artifact_id && public_artifact_id(value.artifact_id)
    }
  end

  defp public_artifact_id(id), do: Base.url_encode64(id, padding: false)

  defp decode_artifact_id(id) do
    case Base.url_decode64(id, padding: false) do
      {:ok, value} -> {:ok, value}
      :error -> {:error, :not_found}
    end
  end

  defp iso(nil), do: nil
  defp iso(value), do: DateTime.to_iso8601(value)
  defp reverse_ok({:ok, values}), do: {:ok, Enum.reverse(values)}
  defp reverse_ok(error), do: error
end
