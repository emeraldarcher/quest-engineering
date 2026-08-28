defmodule QuestEngineering.Core.Runtime do
  @moduledoc """
  Pure deterministic interpreter for a compiled `ExecutionPlan`.

  The runtime is an immutable state machine: `state + event -> state + actions`.
  It does not execute work, start processes, read clocks, or perform I/O.

  A semantic step exists once in the plan. A `StepOccurrence` records one
  control-flow occurrence of that definition, while its `ExecutionAttempt`
  records one concrete try. Re-entering an `Until` check creates a new
  occurrence; it never rewinds an old occurrence. The runtime dispatches one
  attempt per occurrence and deliberately contains no retry policy.
  """

  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference
  alias QuestEngineering.Core.ExecutionPlan.ControlSubtree
  alias QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.Step
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.ExecutionPlan.UntilRegion
  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Runtime.Error
  alias QuestEngineering.Core.Runtime.Event
  alias QuestEngineering.Core.Runtime.ExecutionAttempt
  alias QuestEngineering.Core.Runtime.Failure
  alias QuestEngineering.Core.Runtime.RegionOccurrence
  alias QuestEngineering.Core.Runtime.ResolvedUntilOutput
  alias QuestEngineering.Core.Runtime.Run
  alias QuestEngineering.Core.Runtime.Scope
  alias QuestEngineering.Core.Runtime.StepOccurrence
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  @default_run_id "run/0"

  @type result :: {:ok, Run.t(), [Action.t()]} | {:error, Error.t()}

  @doc "Starts a deterministic run and emits all initially runnable actions."
  @spec start(ExecutionPlan.t(), String.t()) :: result()
  def start(plan, run_id \\ @default_run_id)

  def start(%ExecutionPlan{} = plan, run_id) when is_binary(run_id) and run_id != "" do
    with :ok <- validate_plan(plan) do
      run = %Run{
        id: run_id,
        plan: plan,
        status: :running,
        failure: nil,
        root_scope_id: nil,
        occurrences: %{},
        occurrence_order: [],
        regions: %{},
        region_order: [],
        scopes: %{},
        scope_order: [],
        artifacts: %{},
        artifact_order: [],
        counters: %{occurrence: 0, region: 0, scope: 0, artifact: 0}
      }

      {step_keys, region_ids, dependencies} = root_members(plan)

      with {:ok, run, scope_id} <-
             activate_scope(run, %{
               kind: :root,
               region_occurrence_id: nil,
               remediation_cycle: nil,
               control_path: ["root"],
               step_keys: step_keys,
               region_ids: region_ids,
               dependencies: dependencies,
               step_artifacts: %{},
               region_outputs: [],
               lineage: %{}
             }) do
        advance(%{run | root_scope_id: scope_id})
      end
    end
  end

  def start(_plan, _run_id) do
    {:error, %Error{type: :invalid_execution_plan, details: %{reason: :invalid_start_input}}}
  end

  @doc "Applies one external event and emits newly requested work."
  @spec transition(Run.t(), Event.t()) :: result()
  def transition(%Run{status: status} = run, %Event{} = event) when status != :running do
    {:error,
     %Error{
       type: :run_already_terminal,
       run_id: run.id,
       occurrence_id: event.occurrence_id,
       attempt_id: event.attempt_id,
       details: %{status: status}
     }}
  end

  def transition(%Run{} = run, %Event{type: :step_completed} = event) do
    with {:ok, occurrence} <- fetch_completable_occurrence(run, event),
         {:ok, step} <- fetch_step(run.plan, occurrence.semantic_step_key),
         :ok <- validate_attempt(occurrence, event, run.id),
         :ok <- validate_outputs(step, event, run.id),
         {:ok, run} <- complete_occurrence(run, occurrence, step, event.outputs) do
      advance(run)
    end
  end

  def transition(%Run{} = run, event) do
    {:error, %Error{type: :invalid_event, run_id: run.id, details: %{event: event}}}
  end

  def transition(_run, event) do
    {:error, %Error{type: :invalid_event, details: %{event: event}}}
  end

  @doc "Builds a completion event for an emitted execute-step action."
  @spec completed(Action.t(), map()) :: Event.t()
  def completed(%Action{type: :execute_step} = action, outputs) do
    %Event{
      type: :step_completed,
      occurrence_id: action.occurrence_id,
      attempt_id: action.attempt_id,
      outputs: outputs
    }
  end

  defp validate_plan(plan) do
    step_keys = Enum.map(plan.steps, & &1.key)
    region_ids = Enum.map(plan.control_regions, & &1.id)
    endpoints = MapSet.new(step_keys ++ Enum.map(region_ids, &region_reference/1))

    cond do
      length(step_keys) != length(Enum.uniq(step_keys)) ->
        invalid_plan(:duplicate_step_key)

      length(region_ids) != length(Enum.uniq(region_ids)) ->
        invalid_plan(:duplicate_region_id)

      not Enum.all?(plan.control_dependencies, &valid_dependency?(&1, endpoints)) ->
        invalid_plan(:unknown_control_endpoint)

      cyclic?(plan.control_dependencies) ->
        invalid_plan(:cyclic_control_dependencies)

      true ->
        :ok
    end
  end

  defp invalid_plan(reason) do
    {:error, %Error{type: :invalid_execution_plan, details: %{reason: reason}}}
  end

  defp valid_dependency?(
         %ControlDependency{prerequisite: prerequisite, dependent: dependent},
         set
       ) do
    MapSet.member?(set, endpoint_identity(prerequisite)) and
      MapSet.member?(set, endpoint_identity(dependent))
  end

  defp valid_dependency?(_dependency, _set), do: false

  defp cyclic?(dependencies) do
    adjacency =
      Enum.group_by(
        dependencies,
        &endpoint_identity(&1.prerequisite),
        &endpoint_identity(&1.dependent)
      )

    dependencies
    |> Enum.flat_map(&[endpoint_identity(&1.prerequisite), endpoint_identity(&1.dependent)])
    |> Enum.uniq()
    |> Enum.any?(&reaches_self?(&1, &1, adjacency, %{}))
  end

  defp reaches_self?(current, target, adjacency, visited) do
    adjacency
    |> Map.get(current, [])
    |> Enum.any?(fn next ->
      next == target or
        (not Map.has_key?(visited, next) and
           reaches_self?(next, target, adjacency, Map.put(visited, next, true)))
    end)
  end

  defp root_members(plan) do
    nested_step_keys =
      plan.control_regions
      |> Enum.flat_map(fn region -> region.check.step_keys ++ region.otherwise.step_keys end)
      |> MapSet.new()

    step_keys =
      plan.steps
      |> Enum.map(& &1.key)
      |> Enum.reject(&MapSet.member?(nested_step_keys, &1))

    region_ids =
      plan.control_regions
      |> Enum.filter(&is_nil(&1.parent_region))
      |> Enum.map(& &1.id)

    {step_keys, region_ids, scope_dependencies(plan.control_dependencies, step_keys, region_ids)}
  end

  defp subtree_members(plan, %UntilRegion{} = owner, %ControlSubtree{} = subtree) do
    nested_regions =
      plan.control_regions
      |> Enum.filter(&(&1.id in subtree.control_regions and &1.parent_region == owner.id))

    nested_step_keys =
      nested_regions
      |> Enum.flat_map(fn region -> region.check.step_keys ++ region.otherwise.step_keys end)
      |> MapSet.new()

    step_keys = Enum.reject(subtree.step_keys, &MapSet.member?(nested_step_keys, &1))
    region_ids = Enum.map(nested_regions, & &1.id)

    {step_keys, region_ids,
     scope_dependencies(subtree.control_dependencies, step_keys, region_ids)}
  end

  defp scope_dependencies(dependencies, step_keys, region_ids) do
    endpoints = MapSet.new(step_keys ++ Enum.map(region_ids, &region_reference/1))

    Enum.filter(dependencies, fn dependency ->
      MapSet.member?(endpoints, endpoint_identity(dependency.prerequisite)) and
        MapSet.member?(endpoints, endpoint_identity(dependency.dependent))
    end)
  end

  defp activate_scope(run, specification) do
    {scope_id, run} = next_id(run, :scope, "scope")

    scope = %Scope{
      id: scope_id,
      kind: specification.kind,
      status: :active,
      region_occurrence_id: specification.region_occurrence_id,
      remediation_cycle: specification.remediation_cycle,
      control_path: specification.control_path,
      step_keys: specification.step_keys,
      region_ids: specification.region_ids,
      dependencies: specification.dependencies,
      step_occurrences: %{},
      region_occurrences: %{},
      step_artifacts: specification.step_artifacts,
      region_outputs: specification.region_outputs,
      lineage: specification.lineage
    }

    run = put_scope(run, scope)

    {run, step_occurrences} =
      Enum.reduce(specification.step_keys, {run, %{}}, fn step_key,
                                                          {current_run, occurrence_ids} ->
        {occurrence_id, current_run} = next_occurrence_id(current_run, step_key)

        occurrence = %StepOccurrence{
          id: occurrence_id,
          semantic_step_key: step_key,
          scope_id: scope_id,
          region_occurrence_id: specification.region_occurrence_id,
          phase: specification.kind,
          remediation_cycle: specification.remediation_cycle,
          control_path: specification.control_path,
          status: :pending,
          current_attempt_id: nil,
          attempts: [],
          input_artifact_ids: %{},
          output_artifact_ids: %{}
        }

        {put_occurrence(current_run, occurrence),
         Map.put(occurrence_ids, step_key, occurrence_id)}
      end)

    scope = %{Map.fetch!(run.scopes, scope_id) | step_occurrences: step_occurrences}
    {:ok, put_scope(run, scope), scope_id}
  end

  defp advance(run), do: advance(run, [])

  defp advance(%Run{status: status} = run, actions) when status != :running do
    {:ok, run, actions}
  end

  defp advance(run, actions) do
    with {:ok, run, emitted, changed?} <- advance_once(run) do
      all_actions = actions ++ emitted

      if changed? do
        advance(run, all_actions)
      else
        {:ok, run, all_actions}
      end
    end
  end

  defp advance_once(run) do
    active_scope_ids =
      Enum.filter(run.scope_order, fn scope_id ->
        Map.fetch!(run.scopes, scope_id).status == :active
      end)

    Enum.reduce_while(active_scope_ids, {:ok, run, [], false}, fn scope_id,
                                                                  {:ok, current, actions,
                                                                   changed?} ->
      case advance_scope(current, scope_id) do
        {:ok, next, emitted, scope_changed?} ->
          {:cont, {:ok, next, actions ++ emitted, changed? or scope_changed?}}

        {:error, error} ->
          {:halt, {:error, error}}
      end
    end)
  end

  defp advance_scope(run, scope_id) do
    scope = Map.fetch!(run.scopes, scope_id)

    if scope.status == :completed do
      {:ok, run, [], false}
    else
      with {:ok, run, actions, changed?} <- start_runnable_endpoints(run, scope_id),
           {:ok, run, completion_changed?} <- maybe_complete_scope(run, scope_id) do
        {:ok, run, actions, changed? or completion_changed?}
      end
    end
  end

  defp start_runnable_endpoints(run, scope_id) do
    scope = Map.fetch!(run.scopes, scope_id)

    runnable =
      scope
      |> scope_endpoints()
      |> Enum.filter(fn endpoint ->
        endpoint_unstarted?(run, scope, endpoint) and
          prerequisites_completed?(run, scope, endpoint)
      end)
      |> Enum.sort_by(&endpoint_sort_key/1)

    Enum.reduce_while(runnable, {:ok, run, [], false}, fn endpoint,
                                                          {:ok, current, actions, _changed?} ->
      case start_endpoint(current, scope_id, endpoint) do
        {:ok, next, emitted} -> {:cont, {:ok, next, actions ++ emitted, true}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp scope_endpoints(scope) do
    Enum.map(scope.step_keys, &{:step, &1}) ++ Enum.map(scope.region_ids, &{:region, &1})
  end

  defp endpoint_unstarted?(run, scope, {:step, step_key}) do
    occurrence_id = Map.fetch!(scope.step_occurrences, step_key)
    Map.fetch!(run.occurrences, occurrence_id).status == :pending
  end

  defp endpoint_unstarted?(_run, scope, {:region, region_id}) do
    not Map.has_key?(scope.region_occurrences, region_id)
  end

  defp prerequisites_completed?(run, scope, endpoint) do
    scope.dependencies
    |> Enum.filter(&(endpoint_tuple(&1.dependent) == endpoint))
    |> Enum.all?(&endpoint_completed?(run, scope, endpoint_tuple(&1.prerequisite)))
  end

  defp endpoint_completed?(run, scope, {:step, step_key}) do
    case Map.fetch(scope.step_occurrences, step_key) do
      {:ok, occurrence_id} -> Map.fetch!(run.occurrences, occurrence_id).status == :completed
      :error -> false
    end
  end

  defp endpoint_completed?(run, scope, {:region, region_id}) do
    case Map.fetch(scope.region_occurrences, region_id) do
      {:ok, occurrence_id} -> Map.fetch!(run.regions, occurrence_id).status == :completed
      :error -> false
    end
  end

  defp start_endpoint(run, scope_id, {:step, step_key}) do
    scope = Map.fetch!(run.scopes, scope_id)
    occurrence_id = Map.fetch!(scope.step_occurrences, step_key)
    dispatch_occurrence(run, occurrence_id)
  end

  defp start_endpoint(run, scope_id, {:region, region_id}) do
    enter_region(run, scope_id, region_id)
  end

  defp dispatch_occurrence(run, occurrence_id) do
    occurrence = Map.fetch!(run.occurrences, occurrence_id)
    scope = Map.fetch!(run.scopes, occurrence.scope_id)

    with {:ok, step} <- fetch_step(run.plan, occurrence.semantic_step_key),
         {:ok, inputs} <- resolve_inputs(run, scope, occurrence, step) do
      attempt_id = occurrence.id <> "/attempt/1"
      attempt = %ExecutionAttempt{id: attempt_id, number: 1, status: :dispatched}

      occurrence = %{
        occurrence
        | status: :dispatched,
          current_attempt_id: attempt_id,
          attempts: [attempt],
          input_artifact_ids: Map.new(inputs, fn {type, artifact} -> {type, artifact.id} end)
      }

      action = %Action{
        id: attempt_id <> "/action/execute-step",
        type: :execute_step,
        run_id: run.id,
        occurrence_id: occurrence.id,
        attempt_id: attempt_id,
        semantic_step_key: step.key,
        instruction: step.instruction,
        performer_requirement: step.performer,
        performer_affinity_occurrence_id: resolve_performer_affinity(step, scope),
        context_requirement: step.context,
        context_lineage_occurrence_id: resolve_context_lineage(step, scope),
        inputs: inputs,
        declared_outputs: step.produces
      }

      {:ok, put_occurrence(run, occurrence), [action]}
    end
  end

  defp resolve_inputs(run, scope, occurrence, _step) do
    fixed =
      Enum.filter(run.plan.artifact_bindings, &(&1.consumer == occurrence.semantic_step_key))

    current =
      case occurrence.region_occurrence_id do
        nil -> []
        region_occurrence_id -> current_bindings(run, occurrence, region_occurrence_id)
      end

    Enum.reduce_while(fixed ++ current, {:ok, %{}}, fn binding, {:ok, inputs} ->
      case resolve_binding(run, scope, occurrence, binding) do
        {:ok, artifact} -> {:cont, {:ok, Map.put(inputs, binding.type, artifact)}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp current_bindings(run, occurrence, region_occurrence_id) do
    region_occurrence = Map.fetch!(run.regions, region_occurrence_id)
    region = fetch_region!(run.plan, region_occurrence.semantic_region_id)

    Enum.filter(region.artifact_bindings, fn binding ->
      binding.consumer == occurrence.semantic_step_key and binding.phase == occurrence.phase
    end)
  end

  defp resolve_binding(run, scope, occurrence, %ArtifactBinding{} = binding) do
    case resolve_source(scope, binding.producer, binding.type) do
      {:ok, artifact_id} -> {:ok, Map.fetch!(run.artifacts, artifact_id)}
      :error -> unresolved_input(run, occurrence, binding.type, binding.producer)
    end
  end

  defp resolve_binding(run, _scope, occurrence, %RegionArtifactBinding{} = binding) do
    region_occurrence = Map.fetch!(run.regions, occurrence.region_occurrence_id)

    case Map.fetch(region_occurrence.current_artifacts, binding.type) do
      {:ok, artifact_id} -> {:ok, Map.fetch!(run.artifacts, artifact_id)}
      :error -> unresolved_input(run, occurrence, binding.type, :current)
    end
  end

  defp unresolved_input(run, occurrence, type, source) do
    {:error,
     %Error{
       type: :invalid_execution_plan,
       run_id: run.id,
       occurrence_id: occurrence.id,
       artifact_type: type,
       details: %{reason: :unresolved_input, source: source}
     }}
  end

  defp resolve_performer_affinity(
         %Step{performer: %PerformerRequirement{selector: :same_as, value: step_key}},
         scope
       ) do
    Map.get(scope.lineage, step_key)
  end

  defp resolve_performer_affinity(_step, _scope), do: nil

  defp resolve_context_lineage(
         %Step{context: %ContextRequirement{selector: :continue_from, value: step_key}},
         scope
       ) do
    Map.get(scope.lineage, step_key)
  end

  defp resolve_context_lineage(_step, _scope), do: nil

  defp enter_region(run, parent_scope_id, semantic_region_id) do
    parent_scope = Map.fetch!(run.scopes, parent_scope_id)
    semantic_region = fetch_region!(run.plan, semantic_region_id)
    {region_occurrence_id, run} = next_region_id(run, semantic_region_id)
    control_path = parent_scope.control_path ++ [semantic_region_id]

    with {:ok, current_artifacts} <- initialize_carries(run, parent_scope, semantic_region) do
      occurrence = %RegionOccurrence{
        id: region_occurrence_id,
        semantic_region_id: semantic_region_id,
        parent_scope_id: parent_scope_id,
        parent_region_occurrence_id: parent_scope.region_occurrence_id,
        control_path: control_path,
        status: :checking,
        remediations_completed: 0,
        current_check_scope_id: nil,
        current_otherwise_scope_id: nil,
        check_scope_ids: [],
        otherwise_scope_ids: [],
        current_artifacts: current_artifacts,
        entering_step_artifacts: parent_scope.step_artifacts,
        entering_region_outputs: parent_scope.region_outputs,
        entering_lineage: parent_scope.lineage,
        output_artifacts: [],
        exposed_lineage: %{}
      }

      run = put_region(run, occurrence)

      parent_scope =
        put_in(parent_scope.region_occurrences[semantic_region_id], region_occurrence_id)

      run = put_scope(run, parent_scope)

      with {:ok, run, check_scope_id} <- activate_check_scope(run, occurrence, semantic_region, 0) do
        occurrence = Map.fetch!(run.regions, region_occurrence_id)

        occurrence = %{
          occurrence
          | current_check_scope_id: check_scope_id,
            check_scope_ids: [check_scope_id]
        }

        {:ok, put_region(run, occurrence), []}
      end
    end
  end

  defp initialize_carries(run, scope, region) do
    Enum.reduce_while(region.artifact_carries, {:ok, %{}}, fn carry, {:ok, current} ->
      case resolve_source(scope, carry.initial_producer, carry.type) do
        {:ok, artifact_id} ->
          {:cont, {:ok, Map.put(current, carry.type, artifact_id)}}

        :error ->
          error = %Error{
            type: :invalid_execution_plan,
            run_id: run.id,
            artifact_type: carry.type,
            details: %{reason: :unresolved_initial_carry, region: region.id}
          }

          {:halt, {:error, error}}
      end
    end)
  end

  defp activate_check_scope(run, occurrence, semantic_region, cycle) do
    {step_keys, region_ids, dependencies} =
      subtree_members(run.plan, semantic_region, semantic_region.check)

    activate_scope(run, %{
      kind: :check,
      region_occurrence_id: occurrence.id,
      remediation_cycle: cycle,
      control_path: occurrence.control_path ++ ["check", Integer.to_string(cycle)],
      step_keys: step_keys,
      region_ids: region_ids,
      dependencies: dependencies,
      step_artifacts: occurrence.entering_step_artifacts,
      region_outputs: occurrence.entering_region_outputs,
      lineage: occurrence.entering_lineage
    })
  end

  defp activate_otherwise_scope(run, occurrence, semantic_region, cycle, check_scope) do
    {step_keys, region_ids, dependencies} =
      subtree_members(run.plan, semantic_region, semantic_region.otherwise)

    activate_scope(run, %{
      kind: :otherwise,
      region_occurrence_id: occurrence.id,
      remediation_cycle: cycle,
      control_path: occurrence.control_path ++ ["otherwise", Integer.to_string(cycle)],
      step_keys: step_keys,
      region_ids: region_ids,
      dependencies: dependencies,
      step_artifacts: check_scope.step_artifacts,
      region_outputs: check_scope.region_outputs,
      lineage: check_scope.lineage
    })
  end

  defp maybe_complete_scope(run, scope_id) do
    scope = Map.fetch!(run.scopes, scope_id)

    if scope.status == :active and
         Enum.all?(scope_endpoints(scope), &endpoint_completed?(run, scope, &1)) do
      scope = %{scope | status: :completed}
      run = put_scope(run, scope)
      handle_scope_completion(run, scope)
    else
      {:ok, run, false}
    end
  end

  defp handle_scope_completion(run, %Scope{kind: :root}) do
    {:ok, %{run | status: :completed}, true}
  end

  defp handle_scope_completion(run, %Scope{kind: :check} = scope) do
    occurrence = Map.fetch!(run.regions, scope.region_occurrence_id)
    semantic_region = fetch_region!(run.plan, occurrence.semantic_region_id)

    with {:ok, artifact_id} <- resolve_condition_artifact(run, scope, semantic_region) do
      artifact = Map.fetch!(run.artifacts, artifact_id)

      if condition_true?(artifact.value, semantic_region.condition_binding) do
        complete_region(run, occurrence, semantic_region, scope)
      else
        continue_or_exhaust_region(run, occurrence, semantic_region, scope)
      end
    end
  end

  defp handle_scope_completion(run, %Scope{kind: :otherwise} = scope) do
    occurrence = Map.fetch!(run.regions, scope.region_occurrence_id)
    semantic_region = fetch_region!(run.plan, occurrence.semantic_region_id)

    with {:ok, current_artifacts} <- update_carries(run, occurrence, semantic_region, scope) do
      remediations = occurrence.remediations_completed + 1

      occurrence = %{
        occurrence
        | status: :checking,
          remediations_completed: remediations,
          current_artifacts: current_artifacts,
          current_otherwise_scope_id: scope.id
      }

      run = put_region(run, occurrence)

      with {:ok, run, check_scope_id} <-
             activate_check_scope(run, occurrence, semantic_region, remediations) do
        occurrence = Map.fetch!(run.regions, occurrence.id)

        occurrence = %{
          occurrence
          | current_check_scope_id: check_scope_id,
            check_scope_ids: occurrence.check_scope_ids ++ [check_scope_id]
        }

        {:ok, put_region(run, occurrence), true}
      end
    end
  end

  defp continue_or_exhaust_region(run, occurrence, semantic_region, check_scope) do
    if occurrence.remediations_completed < semantic_region.max_remediations do
      cycle = occurrence.remediations_completed + 1
      occurrence = %{occurrence | status: :remediating}
      run = put_region(run, occurrence)

      with {:ok, run, otherwise_scope_id} <-
             activate_otherwise_scope(run, occurrence, semantic_region, cycle, check_scope) do
        occurrence = Map.fetch!(run.regions, occurrence.id)

        occurrence = %{
          occurrence
          | current_otherwise_scope_id: otherwise_scope_id,
            otherwise_scope_ids: occurrence.otherwise_scope_ids ++ [otherwise_scope_id]
        }

        {:ok, put_region(run, occurrence), true}
      end
    else
      failure = %Failure{
        type: :until_exhausted,
        region_id: semantic_region.id,
        region_occurrence_id: occurrence.id,
        remediations: occurrence.remediations_completed,
        details: %{
          max_remediations: semantic_region.max_remediations,
          checks: length(occurrence.check_scope_ids)
        }
      }

      occurrence = %{occurrence | status: :exhausted}
      run = put_region(run, occurrence)
      {:ok, %{run | status: :failed, failure: failure}, true}
    end
  end

  defp update_carries(run, occurrence, semantic_region, scope) do
    Enum.reduce_while(
      semantic_region.artifact_carries,
      {:ok, occurrence.current_artifacts},
      fn carry, {:ok, current} ->
        case resolve_source(scope, carry.remediation_producer, carry.type) do
          {:ok, artifact_id} ->
            {:cont, {:ok, Map.put(current, carry.type, artifact_id)}}

          :error ->
            error = %Error{
              type: :invalid_execution_plan,
              run_id: run.id,
              artifact_type: carry.type,
              details: %{reason: :unresolved_remediation_carry, region: semantic_region.id}
            }

            {:halt, {:error, error}}
        end
      end
    )
  end

  defp complete_region(run, occurrence, semantic_region, check_scope) do
    with {:ok, outputs} <- resolve_region_outputs(run, occurrence, semantic_region, check_scope) do
      occurrence = %{
        occurrence
        | status: :completed,
          current_check_scope_id: check_scope.id,
          output_artifacts: outputs,
          exposed_lineage: check_scope.lineage
      }

      run = put_region(run, occurrence)
      parent_scope = Map.fetch!(run.scopes, occurrence.parent_scope_id)

      parent_scope = %{
        parent_scope
        | region_outputs: parent_scope.region_outputs ++ outputs,
          lineage: Map.merge(parent_scope.lineage, occurrence.exposed_lineage)
      }

      {:ok, put_scope(run, parent_scope), true}
    end
  end

  defp resolve_region_outputs(run, occurrence, semantic_region, check_scope) do
    Enum.reduce_while(semantic_region.outputs, {:ok, []}, fn output, {:ok, resolved} ->
      source_result =
        case output.kind do
          :check -> resolve_source(check_scope, output.producer, output.type)
          :carried -> Map.fetch(occurrence.current_artifacts, output.type)
        end

      case source_result do
        {:ok, artifact_id} ->
          value = %ResolvedUntilOutput{output: output, artifact_id: artifact_id}
          {:cont, {:ok, resolved ++ [value]}}

        :error ->
          error = %Error{
            type: :invalid_execution_plan,
            run_id: run.id,
            artifact_type: output.type,
            details: %{reason: :unresolved_until_output, region: semantic_region.id}
          }

          {:halt, {:error, error}}
      end
    end)
  end

  defp resolve_condition_artifact(run, scope, region) do
    binding = region.condition_binding

    case resolve_step_or_nested_output(scope, binding.producer, binding.artifact_type) do
      {:ok, artifact_id} ->
        {:ok, artifact_id}

      :error ->
        {:error,
         %Error{
           type: :invalid_execution_plan,
           run_id: run.id,
           artifact_type: binding.artifact_type,
           details: %{reason: :unresolved_condition_artifact, region: region.id}
         }}
    end
  end

  defp resolve_step_or_nested_output(scope, producer, type) do
    case get_in(scope.step_artifacts, [producer, type]) do
      nil ->
        scope.region_outputs
        |> Enum.find(fn resolved ->
          resolved.output.type == type and source_step_key(resolved.output) == producer
        end)
        |> case do
          nil -> :error
          resolved -> {:ok, resolved.artifact_id}
        end

      artifact_id ->
        {:ok, artifact_id}
    end
  end

  defp condition_true?(value, %{operator: :equals, field: field, value: expected})
       when is_map(value) do
    case Map.fetch(value, field) do
      {:ok, actual} -> actual == expected
      :error -> false
    end
  end

  defp condition_true?(_value, _binding), do: false

  defp complete_occurrence(run, occurrence, step, outputs) do
    {run, output_artifact_ids} =
      Enum.reduce(step.produces, {run, %{}}, fn type, {current_run, artifact_ids} ->
        {artifact_id, current_run} = next_artifact_id(current_run, type)

        artifact = %ArtifactInstance{
          id: artifact_id,
          type: type,
          producer_occurrence_id: occurrence.id,
          value: Map.fetch!(outputs, type)
        }

        {put_artifact(current_run, artifact), Map.put(artifact_ids, type, artifact_id)}
      end)

    attempts =
      Enum.map(occurrence.attempts, fn
        %ExecutionAttempt{id: id} = attempt when id == occurrence.current_attempt_id ->
          %{attempt | status: :completed}

        attempt ->
          attempt
      end)

    occurrence = %{
      occurrence
      | status: :completed,
        attempts: attempts,
        output_artifact_ids: output_artifact_ids
    }

    run = put_occurrence(run, occurrence)
    scope = Map.fetch!(run.scopes, occurrence.scope_id)

    scope = %{
      scope
      | step_artifacts:
          Map.put(scope.step_artifacts, occurrence.semantic_step_key, output_artifact_ids),
        lineage: Map.put(scope.lineage, occurrence.semantic_step_key, occurrence.id)
    }

    {:ok, put_scope(run, scope)}
  end

  defp fetch_completable_occurrence(run, event) do
    case Map.fetch(run.occurrences, event.occurrence_id) do
      :error ->
        {:error,
         %Error{
           type: :unknown_occurrence,
           run_id: run.id,
           occurrence_id: event.occurrence_id,
           attempt_id: event.attempt_id
         }}

      {:ok, %StepOccurrence{status: :completed}} ->
        {:error,
         %Error{
           type: :duplicate_completion,
           run_id: run.id,
           occurrence_id: event.occurrence_id,
           attempt_id: event.attempt_id
         }}

      {:ok, %StepOccurrence{status: :dispatched} = occurrence} ->
        {:ok, occurrence}

      {:ok, occurrence} ->
        {:error,
         %Error{
           type: :invalid_occurrence_state,
           run_id: run.id,
           occurrence_id: occurrence.id,
           attempt_id: event.attempt_id,
           details: %{status: occurrence.status, required: :dispatched}
         }}
    end
  end

  defp validate_attempt(occurrence, event, run_id) do
    if occurrence.current_attempt_id == event.attempt_id do
      :ok
    else
      {:error,
       %Error{
         type: :invalid_attempt,
         run_id: run_id,
         occurrence_id: occurrence.id,
         attempt_id: event.attempt_id,
         details: %{expected_attempt_id: occurrence.current_attempt_id}
       }}
    end
  end

  defp validate_outputs(step, event, run_id) when is_map(event.outputs) do
    declared = MapSet.new(step.produces)
    submitted = MapSet.new(Map.keys(event.outputs))
    missing = declared |> MapSet.difference(submitted) |> MapSet.to_list() |> Enum.sort()
    undeclared = submitted |> MapSet.difference(declared) |> MapSet.to_list() |> Enum.sort()

    cond do
      missing != [] ->
        [type | _rest] = missing

        {:error,
         %Error{
           type: :missing_output,
           run_id: run_id,
           occurrence_id: event.occurrence_id,
           attempt_id: event.attempt_id,
           artifact_type: type,
           details: %{missing: missing}
         }}

      undeclared != [] ->
        [type | _rest] = undeclared

        {:error,
         %Error{
           type: :undeclared_output,
           run_id: run_id,
           occurrence_id: event.occurrence_id,
           attempt_id: event.attempt_id,
           artifact_type: type,
           details: %{undeclared: undeclared}
         }}

      true ->
        validate_artifact_values(event, step.produces, run_id)
    end
  end

  defp validate_outputs(_step, event, run_id) do
    {:error,
     %Error{
       type: :invalid_event,
       run_id: run_id,
       occurrence_id: event.occurrence_id,
       attempt_id: event.attempt_id,
       details: %{reason: :outputs_must_be_a_map}
     }}
  end

  defp validate_artifact_values(event, types, run_id) do
    case Enum.find(types, &(not artifact_value?(Map.fetch!(event.outputs, &1)))) do
      nil ->
        :ok

      type ->
        {:error,
         %Error{
           type: :invalid_artifact_value,
           run_id: run_id,
           occurrence_id: event.occurrence_id,
           attempt_id: event.attempt_id,
           artifact_type: type,
           details: %{value: Map.fetch!(event.outputs, type)}
         }}
    end
  end

  defp artifact_value?(value)
       when is_binary(value) or is_integer(value) or is_float(value) or is_boolean(value) or
              is_nil(value),
       do: true

  defp artifact_value?(value) when is_list(value), do: Enum.all?(value, &artifact_value?/1)

  defp artifact_value?(value) when is_map(value) and not is_struct(value) do
    Enum.all?(value, fn {key, nested} -> is_binary(key) and artifact_value?(nested) end)
  end

  defp artifact_value?(_value), do: false

  defp resolve_source(scope, producer, type) when is_binary(producer) do
    case get_in(scope.step_artifacts, [producer, type]) do
      nil -> :error
      artifact_id -> {:ok, artifact_id}
    end
  end

  defp resolve_source(scope, %UntilOutput{} = output, _type) do
    scope.region_outputs
    |> Enum.find(&(&1.output == output))
    |> case do
      nil -> :error
      resolved -> {:ok, resolved.artifact_id}
    end
  end

  defp source_step_key(%UntilOutput{kind: :check, producer: producer}) when is_binary(producer),
    do: producer

  defp source_step_key(%UntilOutput{kind: :check, producer: %UntilOutput{} = producer}),
    do: source_step_key(producer)

  defp source_step_key(%UntilOutput{kind: :carried}), do: nil

  defp fetch_step(plan, key) do
    case Enum.find(plan.steps, &(&1.key == key)) do
      nil ->
        {:error,
         %Error{
           type: :invalid_execution_plan,
           details: %{reason: :unknown_semantic_step, step: key}
         }}

      step ->
        {:ok, step}
    end
  end

  defp fetch_region!(plan, id), do: Enum.find(plan.control_regions, &(&1.id == id))

  defp endpoint_tuple(endpoint) when is_binary(endpoint), do: {:step, endpoint}
  defp endpoint_tuple(%ControlRegionReference{id: id}), do: {:region, id}

  defp endpoint_identity(endpoint) when is_binary(endpoint), do: endpoint
  defp endpoint_identity(%ControlRegionReference{id: id}), do: region_reference(id)
  defp region_reference(id), do: "region:" <> id

  defp endpoint_sort_key({:step, key}), do: "step:" <> key
  defp endpoint_sort_key({:region, id}), do: region_reference(id)

  defp next_occurrence_id(run, step_key) do
    index = run.counters.occurrence
    id = run.id <> "/occurrence/" <> Integer.to_string(index) <> "/" <> step_key
    {id, increment_counter(run, :occurrence)}
  end

  defp next_region_id(run, semantic_region_id) do
    index = run.counters.region

    id =
      run.id <>
        "/region-occurrence/" <> Integer.to_string(index) <> "/" <> semantic_region_id

    {id, increment_counter(run, :region)}
  end

  defp next_artifact_id(run, type) do
    index = run.counters.artifact
    id = run.id <> "/artifact/" <> Integer.to_string(index) <> "/" <> type
    {id, increment_counter(run, :artifact)}
  end

  defp next_id(run, counter, label) do
    index = Map.fetch!(run.counters, counter)
    id = run.id <> "/" <> label <> "/" <> Integer.to_string(index)
    {id, increment_counter(run, counter)}
  end

  defp increment_counter(run, counter) do
    %{run | counters: Map.update!(run.counters, counter, &(&1 + 1))}
  end

  defp put_occurrence(run, occurrence) do
    new? = not Map.has_key?(run.occurrences, occurrence.id)

    %{
      run
      | occurrences: Map.put(run.occurrences, occurrence.id, occurrence),
        occurrence_order:
          if(new?, do: run.occurrence_order ++ [occurrence.id], else: run.occurrence_order)
    }
  end

  defp put_region(run, occurrence) do
    new? = not Map.has_key?(run.regions, occurrence.id)

    %{
      run
      | regions: Map.put(run.regions, occurrence.id, occurrence),
        region_order: if(new?, do: run.region_order ++ [occurrence.id], else: run.region_order)
    }
  end

  defp put_scope(run, scope) do
    new? = not Map.has_key?(run.scopes, scope.id)

    %{
      run
      | scopes: Map.put(run.scopes, scope.id, scope),
        scope_order: if(new?, do: run.scope_order ++ [scope.id], else: run.scope_order)
    }
  end

  defp put_artifact(run, artifact) do
    %{
      run
      | artifacts: Map.put(run.artifacts, artifact.id, artifact),
        artifact_order: run.artifact_order ++ [artifact.id]
    }
  end
end
