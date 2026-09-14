defmodule QuestEngineering.Server.RunProjection do
  @moduledoc "Product-facing, snapshot-backed view of one durable Quest run."

  import Ecto.Query

  alias QuestEngineering.Server.DeliveryEligibility
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.OperationalRecovery
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.OperationalAttemptAttribution
  alias QuestEngineering.Server.Persistence.OperationalRecoveryEpoch
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.ResolvedExecutionCodec
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
      live_session_attention:
        projection.steps
        |> Enum.map(& &1.session)
        |> Enum.reject(&is_nil/1)
        |> Enum.filter(&is_map(&1.attention))
        |> Enum.map(fn session ->
          %{
            session_id: session.id,
            category: session.attention["category"],
            attention_id: session.attention["attention_id"]
          }
        end),
      delivery: projection.delivery
    }
  end

  defp build(launch, snapshot, run, revision) do
    {actions, scheduled, dispatches, sessions, session_events, attributions, epochs} =
      execution_data(run.id)

    execution = %{
      action_by_attempt: Map.new(actions, fn action -> {action.attempt_id, action} end),
      scheduled_by_action: Map.new(scheduled, &{&1.action_id, &1}),
      dispatch_by_action: Map.new(dispatches, &{&1.action_id, &1}),
      session_by_action:
        Map.new(sessions, fn {action_id, session, worker} ->
          {action_id, {session, worker}}
        end),
      session_events: session_events,
      attribution_by_action: Map.new(attributions, &{&1.action_id, &1}),
      epoch_by_id: Map.new(epochs, &{&1.id, &1})
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
      planning: planning(run, artifacts),
      review_gate: review_gate(review_gate),
      semantic_remediation: semantic_remediation(run),
      operational_recovery: operational_recovery_epochs(epochs, attributions),
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

    sessions = ExecutionSessionStore.list_for_actions(action_ids)
    session_events = ExecutionSessionStore.audit_history(run_id)

    attributions =
      Repo.all(from item in OperationalAttemptAttribution, where: item.run_id == ^run_id)

    epochs =
      Repo.all(
        from item in OperationalRecoveryEpoch,
          where: item.run_id == ^run_id,
          order_by: [asc: item.occurrence_id, asc: item.epoch_number]
      )

    {actions, scheduled, dispatches, sessions, session_events, attributions, epochs}
  end

  defp step(occurrence, execution, run, snapshot, plan_by_key) do
    plan_step = Map.get(plan_by_key, occurrence.semantic_step_key)
    action = Map.get(execution.action_by_attempt, occurrence.current_attempt_id)
    scheduled = action && Map.get(execution.scheduled_by_action, action.id)
    dispatch = action && Map.get(execution.dispatch_by_action, action.id)
    state = occurrence_state(occurrence.status, scheduled, dispatch)
    member = if scheduled, do: member(snapshot, scheduled.member_key), else: nil
    attempts = attempts(occurrence, execution, run)
    current_attempt = Enum.find(attempts, &(&1.id == occurrence.current_attempt_id))

    %{
      occurrence_id: occurrence.id,
      semantic_step_key: occurrence.semantic_step_key,
      name: plan_step && plan_step.name,
      instruction: plan_step && plan_step.instruction,
      state: state,
      phase: occurrence.phase && Atom.to_string(occurrence.phase),
      remediation_cycle: occurrence.remediation_cycle,
      control_path: occurrence.control_path,
      attempt: current_attempt,
      attempts: attempts,
      session: current_attempt && current_attempt.session,
      member: member,
      performer: performer(action, plan_step, run),
      context: context(action, plan_step, run),
      inputs: artifact_refs(occurrence.input_artifact_ids, run),
      outputs: artifact_refs(occurrence.output_artifact_ids, run),
      issue: issue(state, dispatch),
      recovery: recovery(state, dispatch, current_attempt)
    }
  end

  defp recovery("uncertain", dispatch, _attempt) do
    %{
      can_retry: OperationalRecovery.same_epoch_retry_available?(dispatch.action_id),
      can_mark_failed: true,
      can_human_retry: false,
      can_retry_fresh: false,
      message:
        get_in(dispatch.failure, ["message"]) ||
          "The Worker could not prove whether this attempt completed."
    }
  end

  defp recovery("failed", dispatch, attempt) do
    classification = get_in(dispatch && dispatch.failure, ["classification"])
    retained_available = retained_session_available?(attempt)
    recoverable = classification != "terminal_not_recoverable"

    %{
      can_retry: false,
      can_mark_failed: false,
      can_human_retry: recoverable and retained_available,
      can_retry_fresh: recoverable,
      retained_session_available: retained_available,
      classification: classification || "operator_recovery_required",
      epoch_exhausted: epoch_exhausted?(classification, attempt),
      message:
        get_in(dispatch && dispatch.failure, ["message"]) ||
          "The operational Attempt failed."
    }
  end

  defp recovery(_state, _dispatch, _attempt), do: nil

  defp retained_session_available?(%{
         session: %{state: "retained", attachment: %{available: true}}
       }),
       do: true

  defp retained_session_available?(_attempt), do: false

  defp epoch_exhausted?("auto_retryable", %{
         operational: %{attempt_in_epoch: used, attempt_allowance: allowance}
       })
       when is_integer(allowance),
       do: used >= allowance

  defp epoch_exhausted?(_classification, _attempt), do: false

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

  defp attempts(occurrence, execution, run) do
    Enum.map(occurrence.attempts, &project_attempt(&1, occurrence, execution, run))
  end

  defp project_attempt(attempt, occurrence, execution, run) do
    facts = attempt_execution_facts(attempt, execution)
    outputs = attempt_outputs(attempt, occurrence, run)

    %{
      id: attempt.id,
      number: attempt.number,
      state: attempt_state(attempt, facts.scheduled, facts.dispatch),
      started_at: started_at(facts),
      finished_at: finished_at(facts),
      outputs: outputs,
      output_produced: outputs != [],
      resolution: attempt_resolution(facts.dispatch),
      retry_of_attempt_id: previous_attempt_id(occurrence.attempts, attempt.number),
      operational: operational_attempt(facts.attribution, facts.epoch),
      execution: attempt_execution_configuration(facts.scheduled),
      session: attempt_session(facts.action, execution)
    }
  end

  defp attempt_execution_facts(attempt, execution) do
    action = Map.get(execution.action_by_attempt, attempt.id)
    scheduled = action && Map.get(execution.scheduled_by_action, action.id)
    dispatch = action && Map.get(execution.dispatch_by_action, action.id)
    attribution = action && Map.get(execution.attribution_by_action, action.id)
    epoch = attribution && Map.get(execution.epoch_by_id, attribution.epoch_id)

    %{
      action: action,
      scheduled: scheduled,
      dispatch: dispatch,
      attribution: attribution,
      epoch: epoch
    }
  end

  defp started_at(%{dispatch: dispatch, scheduled: scheduled}),
    do: iso((dispatch && dispatch.dispatched_at) || (scheduled && scheduled.bound_at))

  defp finished_at(%{dispatch: dispatch, scheduled: scheduled}),
    do: iso((dispatch && dispatch.terminal_at) || (scheduled && scheduled.terminal_at))

  defp operational_attempt(nil, _epoch), do: nil

  defp operational_attempt(attribution, epoch) do
    %{
      recovery_epoch: epoch.epoch_number,
      recovery_kind: epoch.authorization_kind,
      attempt_in_epoch: attribution.attempt_in_epoch,
      attempt_allowance: epoch.attempt_allowance,
      policy_source: epoch.policy_source,
      continuation_mode: epoch.continuation_mode,
      recovery_authorized_at: iso(epoch.authorized_at)
    }
  end

  defp attempt_execution_configuration(nil), do: nil

  defp attempt_execution_configuration(scheduled) do
    case ResolvedExecutionCodec.decode(
           scheduled.resolved_execution,
           scheduled.resolved_execution_version
         ) do
      {:ok, execution} ->
        %{
          harness: execution.configuration.harness_kind,
          model: %{
            provider: execution.configuration.model.provider,
            model: execution.configuration.model.model
          },
          reasoning: execution.configuration.reasoning,
          reasoning_capability:
            reasoning_capability(execution.configuration.reasoning_capability),
          tool_policy: tool_policy(execution.configuration.tool_policy),
          tool_enforcement: Atom.to_string(execution.configuration.tool_enforcement),
          resolved_tool_profile: %{
            tools: execution.configuration.resolved_tool_profile.tools
          },
          workspace_permission: Atom.to_string(execution.execution_workspace.access),
          worker_id: scheduled.worker_id
        }

      _ ->
        nil
    end
  end

  defp attempt_session(nil, _execution), do: nil

  defp attempt_session(action, execution) do
    case Map.get(execution.session_by_action, action.id) do
      {persisted, worker} ->
        session_projection(persisted, worker, execution.session_events, action.id)

      nil ->
        nil
    end
  end

  defp reasoning_capability(%{
         kind: :enumerated,
         values: values
       }),
       do: %{kind: "enumerated", values: values}

  defp reasoning_capability(%{kind: :unsupported, values: []}),
    do: %{kind: "unsupported"}

  defp tool_policy(%QuestEngineering.Core.Product.ToolPolicy.Exact{tools: tools}),
    do: %{kind: "exact", tools: tools}

  defp tool_policy(%QuestEngineering.Core.Product.ToolPolicy.NativePermissions{}),
    do: %{kind: "native_permissions"}

  defp session_projection(session, worker, events, action_id) do
    current_usage = session.current_action_id == action_id
    available = session_available?(session, worker)

    %{
      id: session.id,
      harness: %{kind: session.harness_kind, display_name: session.harness_display_name},
      worker: %{
        id: worker.id,
        display_name: worker.id,
        state: worker.status
      },
      state: session_state(session, worker, current_usage),
      native_identity: %{
        conversation_id: session.native_session_id,
        terminal_id: get_in(session.terminal || %{}, ["terminal_id"])
      },
      capabilities: capability_projection(session.capabilities),
      attachment: attachment_projection(session, worker, current_usage, available),
      attention: if(current_usage, do: session.attention, else: nil),
      started_at: iso(session.started_at),
      last_activity_at: iso(session.last_activity_at),
      events:
        events
        |> Enum.filter(&(&1.session_id == session.id and &1.action_id == action_id))
        |> Enum.map(fn event ->
          %{
            id: event.id,
            type: event.event_type,
            attention_id: event.attention_id,
            metadata: event.metadata,
            occurred_at: iso(event.occurred_at)
          }
        end)
    }
  end

  defp capability_projection(capabilities) do
    Map.merge(
      %{
        "structured_confirmation" => false,
        "structured_text_response" => false,
        "structured_choice_response" => false,
        "structured_multiline_response" => false,
        "native_prompt_control" => false,
        "conversational_takeover" => false,
        "automation_resume" => false
      },
      capabilities
    )
  end

  defp session_available?(session, worker) do
    worker.status == "connected" and
      session.last_connection_generation == worker.connection_generation and
      session.state not in ["closed", "unavailable"] and is_map(session.terminal) and
      get_in(session.capabilities, ["can_attach_terminal"]) == true
  end

  defp session_state(_session, %{status: status}, _current_usage)
       when status != "connected",
       do: "unavailable"

  defp session_state(session, worker, _current_usage)
       when session.last_connection_generation != worker.connection_generation,
       do: "recovering"

  defp session_state(session, _worker, true), do: session.state
  defp session_state(_session, _worker, false), do: "retained"

  defp attachment_projection(session, worker, current_usage, available) do
    %{
      mode: "local_native_terminal",
      available: available,
      reason: attachment_unavailable_reason(session, worker, available),
      can_observe: available and get_in(session.terminal, ["supports_observation"]) == true,
      can_takeover:
        available and current_usage and session.state == "waiting_for_human" and
          get_in(session.terminal, ["supports_takeover"]) == true,
      can_recover:
        available and current_usage and session.state == "retained" and
          get_in(session.terminal, ["supports_takeover"]) == true
    }
  end

  defp attachment_unavailable_reason(_session, %{status: status}, _available)
       when status != "connected",
       do: "worker_offline"

  defp attachment_unavailable_reason(session, worker, _available)
       when session.last_connection_generation != worker.connection_generation,
       do: "recovering"

  defp attachment_unavailable_reason(%{terminal: terminal}, _worker, _available)
       when not is_map(terminal),
       do: "terminal_unavailable"

  defp attachment_unavailable_reason(_session, _worker, false), do: "attachment_unavailable"
  defp attachment_unavailable_reason(_session, _worker, true), do: nil

  defp attempt_state(_attempt, _scheduled, %{state: "uncertain"}), do: "uncertain"

  defp attempt_state(_attempt, _scheduled, %{failure: %{"code" => "operator_retry_requested"}}),
    do: "uncertain"

  defp attempt_state(attempt, scheduled, dispatch) do
    occurrence_state(attempt.status, scheduled, dispatch)
  end

  defp attempt_outputs(
         %{id: id},
         %{current_attempt_id: id, status: :completed} = occurrence,
         run
       ),
       do: artifact_refs(occurrence.output_artifact_ids, run)

  defp attempt_outputs(_attempt, _occurrence, _run), do: []

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

  defp artifact_refs(values, run) do
    values
    |> Enum.sort_by(fn {name, _id} -> name end)
    |> Enum.map(fn {name, id} ->
      artifact = Map.fetch!(run.artifacts, id)
      %{name: name, type: artifact.kind, artifact_id: public_artifact_id(id)}
    end)
  end

  defp project_artifact(value, run) do
    occurrence = Map.get(run.occurrences, value.producer_occurrence_id)

    %{
      id: public_artifact_id(value.id),
      type: value.kind,
      producer_occurrence_id: value.producer_occurrence_id,
      producer_attempt_id: occurrence && occurrence.current_attempt_id,
      version: value.version,
      supersedes_artifact_id:
        value.supersedes_artifact_id && public_artifact_id(value.supersedes_artifact_id),
      content_hash: value.content_hash,
      media_type: value.media_type,
      filename: value.filename,
      title: value.title,
      preview: artifact_preview(value.kind, value.value)
    }
  end

  defp artifact_preview(type, %{"status" => status} = value)
       when status in ~w(accepted rejected) do
    if type == "review_verdict" do
      %{
        kind: "review_verdict",
        status: status,
        gate_key: value["gate_key"],
        subject_kind: value["subject_kind"],
        subject_artifact_id:
          value["subject_artifact_id"] && public_artifact_id(value["subject_artifact_id"]),
        findings: value["findings"] || value["reasoning"]
      }
    else
      %{kind: "json_summary", summary: "object"}
    end
  end

  defp artifact_preview(_type, %{"kind" => "document"} = value),
    do: %{
      kind: "document",
      title: value["title"],
      filename: value["filename"],
      media_type: value["media_type"],
      content_hash: value["content_hash"]
    }

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
    {code, message} =
      case exhausted_acceptance_subject(run) do
        "quest_plan" ->
          {"plan_review_exhausted",
           "Plan acceptance was not achieved before the maximum plan revisions were exhausted. Implementation and Delivery did not start."}

        "change_set" ->
          {"review_exhausted",
           "Review acceptance was not achieved before the remediation limit was exhausted."}

        _ ->
          {"remediation_exhausted",
           "The remediation limit was exhausted before its required condition was satisfied."}
      end

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

  defp exhausted_acceptance_subject(run) do
    case Enum.find(run.plan.control_regions, &(&1.id == run.failure.region_id)) do
      nil ->
        nil

      %{acceptance_subject_kind: subject} when is_binary(subject) ->
        subject

      region ->
        region.acceptance_subject_kind
    end
  end

  defp operational_recovery_epochs(epochs, attributions) do
    attempts_by_epoch = Enum.group_by(attributions, & &1.epoch_id)

    Enum.map(epochs, fn epoch ->
      attempts = Map.get(attempts_by_epoch, epoch.id, [])

      %{
        id: epoch.id,
        occurrence_id: epoch.occurrence_id,
        epoch_number: epoch.epoch_number,
        authorization_kind: epoch.authorization_kind,
        attempt_allowance: epoch.attempt_allowance,
        policy_source: epoch.policy_source,
        continuation_mode: epoch.continuation_mode,
        authorized_at: iso(epoch.authorized_at),
        attempts_scheduled: length(attempts)
      }
    end)
  end

  defp semantic_remediation(run) do
    regions = Map.new(run.plan.control_regions, &{&1.id, &1})

    Enum.map(run.region_order, fn id ->
      occurrence = Map.fetch!(run.regions, id)
      semantic = Map.fetch!(regions, occurrence.semantic_region_id)

      %{
        region_occurrence_id: occurrence.id,
        semantic_region_id: occurrence.semantic_region_id,
        remediations_completed: occurrence.remediations_completed,
        maximum_remediations: semantic.max_remediations,
        status: Atom.to_string(occurrence.status),
        review_shaped: semantic.condition_binding.kind == "review_verdict",
        acceptance_gate_key: semantic.acceptance_gate_key,
        acceptance_subject_kind: semantic.acceptance_subject_kind,
        remediation_kind:
          case semantic.acceptance_subject_kind do
            "quest_plan" -> "plan_revision"
            "change_set" -> "implementation_repair"
            _ -> "generic"
          end
      }
    end)
  end

  defp planning(run, projected_artifacts) do
    artifacts = Enum.map(run.artifact_order, &Map.fetch!(run.artifacts, &1))
    plans = Enum.filter(artifacts, &(&1.kind == "quest_plan"))
    verdicts = Enum.filter(artifacts, &verdict?/1)
    history = Enum.map(plans, &plan_history(&1, verdicts))

    %{
      accepted_plan: accepted_plan(history, projected_artifacts),
      history: history
    }
  end

  defp verdict?(artifact) do
    artifact.kind == "review_verdict" and
      is_map(artifact.value) and artifact.value["gate_key"] == "plan_acceptance"
  end

  defp plan_history(plan, verdicts) do
    verdict = Enum.find(Enum.reverse(verdicts), &verdict_for?(&1, plan.id))

    %{
      artifact_id: public_artifact_id(plan.id),
      version: plan.version || 1,
      status: verdict_field(verdict, "status"),
      verdict_artifact_id: verdict_id(verdict),
      findings: verdict_findings(verdict),
      supersedes_artifact_id: public_optional_id(plan.supersedes_artifact_id)
    }
  end

  defp verdict_for?(verdict, plan_id), do: verdict.value["subject_artifact_id"] == plan_id
  defp verdict_field(nil, _field), do: nil
  defp verdict_field(verdict, field), do: verdict.value[field]
  defp verdict_id(nil), do: nil
  defp verdict_id(verdict), do: public_artifact_id(verdict.id)

  defp verdict_findings(nil), do: nil

  defp verdict_findings(verdict),
    do: verdict.value["findings"] || verdict.value["reasoning"]

  defp public_optional_id(nil), do: nil
  defp public_optional_id(id), do: public_artifact_id(id)

  defp accepted_plan(history, artifacts) do
    case Enum.find(Enum.reverse(history), &(&1.status == "accepted")) do
      nil -> nil
      accepted -> Enum.find(artifacts, &(&1.id == accepted.artifact_id))
    end
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
