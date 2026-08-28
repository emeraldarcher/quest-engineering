defmodule QuestEngineering.Core.Compiler do
  @moduledoc """
  Compiles semantic tactics into deterministic static execution specifications.

  Sequence and parallel composition retain the v0.1 entry/exit-frontier model.
  `Until` contributes a control-region reference to those frontiers while its
  check/remediation transition remains explicit region data, never cyclic DAG
  edges. Artifact environments are compiled lexically so region-local current
  values can safely replace their entering values on region exit.
  """

  alias QuestEngineering.Core.CompileError
  alias QuestEngineering.Core.Compiler.Validator
  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ArtifactCarry
  alias QuestEngineering.Core.ExecutionPlan.ConditionBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference
  alias QuestEngineering.Core.ExecutionPlan.ControlSubtree
  alias QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.Step, as: PlanStep
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.ExecutionPlan.UntilRegion
  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @type result :: {:ok, ExecutionPlan.t()} | {:error, [CompileError.t()]}
  @type source :: String.t() | UntilOutput.t()
  @type environment :: %{optional(String.t()) => [source()]}

  @doc "Compiles a valid semantic tactic or returns ordered structured errors."
  @spec compile(term()) :: result()
  def compile(tactic) do
    with {:ok, semantic_steps} <- Validator.validate(tactic) do
      context = %{steps: semantic_steps}
      fragment = compile_node(tactic, %{}, [], nil, context)

      case fragment.errors do
        [] ->
          {:ok,
           %ExecutionPlan{
             steps: Enum.map(semantic_steps, &to_plan_step/1),
             control_dependencies: Enum.uniq(fragment.dependencies),
             artifact_bindings: fragment.bindings,
             control_regions: fragment.regions
           }}

        errors ->
          {:error, errors}
      end
    end
  end

  defp compile_node(%Step{} = step, environment, _path, _parent_region, context) do
    {bindings, errors} = resolve_step_inputs(step, environment, context)
    produced = Enum.map(step.produces, &{&1.type, step.key})

    fragment(
      entries: [step.key],
      exits: [step.key],
      bindings: bindings,
      errors: errors,
      produced: produced,
      environment: add_sources(environment, produced),
      step_keys: [step.key]
    )
  end

  defp compile_node(%Sequence{children: children}, environment, path, parent_region, context) do
    [first | rest] =
      children
      |> Enum.with_index()
      |> Enum.map(fn {child, index} -> {child, path ++ [index]} end)

    {first_child, first_path} = first
    first_fragment = compile_node(first_child, environment, first_path, parent_region, context)

    Enum.reduce(rest, first_fragment, fn {child, child_path}, sequence ->
      child_fragment =
        compile_node(child, sequence.environment, child_path, parent_region, context)

      boundary_dependencies =
        for prerequisite <- sequence.exits, dependent <- child_fragment.entries do
          %ControlDependency{prerequisite: prerequisite, dependent: dependent}
        end

      merge_sequence(sequence, child_fragment, boundary_dependencies)
    end)
  end

  defp compile_node(%Parallel{children: children}, environment, path, parent_region, context) do
    child_fragments =
      children
      |> Enum.with_index()
      |> Enum.map(fn {child, index} ->
        compile_node(child, environment, path ++ [index], parent_region, context)
      end)

    produced = Enum.flat_map(child_fragments, & &1.produced)

    fragment(
      entries: Enum.flat_map(child_fragments, & &1.entries),
      exits: Enum.flat_map(child_fragments, & &1.exits),
      dependencies: Enum.flat_map(child_fragments, & &1.dependencies),
      bindings: Enum.flat_map(child_fragments, & &1.bindings),
      regions: Enum.flat_map(child_fragments, & &1.regions),
      region_ids: Enum.flat_map(child_fragments, & &1.region_ids),
      errors: Enum.flat_map(child_fragments, & &1.errors),
      produced: produced,
      environment: add_sources(environment, produced),
      step_keys: Enum.flat_map(child_fragments, & &1.step_keys)
    )
  end

  defp compile_node(%Until{} = until, environment, path, parent_region, context) do
    id = region_id(path)
    check = compile_node(until.check, environment, path ++ [:check], id, context)

    otherwise =
      compile_node(until.otherwise, check.environment, path ++ [:otherwise], id, context)

    {condition_binding, condition_errors} = bind_condition(until.condition, check, id)
    {carries, carry_errors} = infer_carries(check, otherwise, environment, id)

    {check_bindings, otherwise_bindings, region_bindings} =
      apply_carries(check, otherwise, carries)

    outputs = region_outputs(id, check, carries)
    outgoing_environment = region_environment(environment, outputs)
    reference = %ControlRegionReference{id: id}

    region = %UntilRegion{
      id: id,
      parent_region: parent_region,
      check: to_subtree(check),
      condition: until.condition,
      condition_binding: condition_binding,
      otherwise: to_subtree(otherwise),
      max_remediations: until.max_remediations,
      artifact_bindings: region_bindings,
      artifact_carries: carries,
      outputs: outputs
    }

    fragment(
      entries: [reference],
      exits: [reference],
      dependencies: check.dependencies ++ otherwise.dependencies,
      bindings: check_bindings ++ otherwise_bindings,
      regions: [region] ++ check.regions ++ otherwise.regions,
      region_ids: [id] ++ check.region_ids ++ otherwise.region_ids,
      errors: check.errors ++ otherwise.errors ++ condition_errors ++ carry_errors,
      produced: Enum.map(outputs, &{&1.type, &1}),
      environment: outgoing_environment,
      step_keys: check.step_keys ++ otherwise.step_keys
    )
  end

  defp fragment(options) do
    defaults = [
      entries: [],
      exits: [],
      dependencies: [],
      bindings: [],
      regions: [],
      region_ids: [],
      errors: [],
      produced: [],
      environment: %{},
      step_keys: []
    ]

    defaults |> Keyword.merge(options) |> Map.new()
  end

  defp merge_sequence(left, right, boundary_dependencies) do
    fragment(
      entries: left.entries,
      exits: right.exits,
      dependencies: Enum.uniq(left.dependencies ++ boundary_dependencies ++ right.dependencies),
      bindings: left.bindings ++ right.bindings,
      regions: left.regions ++ right.regions,
      region_ids: left.region_ids ++ right.region_ids,
      errors: left.errors ++ right.errors,
      produced: left.produced ++ right.produced,
      environment: right.environment,
      step_keys: left.step_keys ++ right.step_keys
    )
  end

  defp resolve_step_inputs(step, environment, context) do
    Enum.reduce(step.consumes, {[], []}, fn artifact, {bindings, errors} ->
      case resolve_artifact(step.key, artifact, environment, context) do
        {:ok, binding} -> {bindings ++ [binding], errors}
        {:error, error} -> {bindings, errors ++ [error]}
      end
    end)
  end

  defp resolve_artifact(consumer, %Artifact{type: type, source: nil}, environment, _context) do
    candidates = Map.get(environment, type, [])

    case candidates do
      [producer] ->
        {:ok, %ArtifactBinding{consumer: consumer, type: type, producer: producer}}

      [] ->
        {:error,
         %CompileError{
           type: :missing_artifact,
           step: consumer,
           artifact_type: type,
           candidate_sources: []
         }}

      candidates ->
        {:error,
         %CompileError{
           type: :ambiguous_artifact,
           step: consumer,
           artifact_type: type,
           candidate_sources: candidates
         }}
    end
  end

  defp resolve_artifact(
         consumer,
         %Artifact{type: type, source: requested},
         environment,
         context
       ) do
    source_step = Enum.find(context.steps, &(&1.key == requested))
    visible = Enum.filter(Map.get(environment, type, []), &source_matches?(&1, requested))

    cond do
      is_nil(source_step) ->
        invalid_source(consumer, type, requested, :unknown_step)

      not produces?(source_step, type) ->
        invalid_source(consumer, type, requested, :artifact_not_produced)

      visible == [] ->
        invalid_source(consumer, type, requested, :not_upstream)

      true ->
        {:ok, %ArtifactBinding{consumer: consumer, type: type, producer: List.first(visible)}}
    end
  end

  defp invalid_source(consumer, type, source, reason) do
    {:error,
     %CompileError{
       type: :invalid_artifact_source,
       step: consumer,
       artifact_type: type,
       referenced_source: source,
       details: reason
     }}
  end

  defp bind_condition(%Condition{} = condition, check, region) do
    type = condition.artifact.type

    candidates =
      check.produced
      |> Enum.filter(fn {candidate_type, _source} -> candidate_type == type end)
      |> Enum.map(fn {_type, source} -> source_key(source) end)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    selected =
      case condition.artifact.source do
        nil -> candidates
        source -> Enum.filter(candidates, &(&1 == source))
      end

    cond do
      condition.artifact.source && selected == [] ->
        {nil,
         [
           %CompileError{
             type: :invalid_condition_artifact,
             artifact_type: type,
             referenced_source: condition.artifact.source,
             candidate_sources: candidates,
             region: region,
             condition: condition,
             details: %{reason: :source_not_produced_by_check}
           }
         ]}

      selected == [] ->
        {nil,
         [
           %CompileError{
             type: :invalid_condition_artifact,
             artifact_type: type,
             candidate_sources: [],
             region: region,
             condition: condition,
             details: %{reason: :artifact_not_produced_by_check}
           }
         ]}

      length(selected) > 1 ->
        {nil,
         [
           %CompileError{
             type: :ambiguous_condition_artifact,
             artifact_type: type,
             candidate_sources: selected,
             region: region,
             condition: condition,
             details: %{reason: :multiple_check_producers}
           }
         ]}

      true ->
        [producer] = selected

        {%ConditionBinding{
           artifact_type: type,
           producer: producer,
           field: condition.field,
           operator: condition.operator,
           value: condition.value
         }, []}
    end
  end

  defp infer_carries(check, otherwise, entering_environment, region) do
    external_check_bindings =
      Enum.filter(check.bindings, fn binding ->
        binding.producer in Map.get(entering_environment, binding.type, [])
      end)

    types = external_check_bindings |> Enum.map(& &1.type) |> Enum.uniq()

    Enum.reduce(types, {[], []}, fn type, {carries, errors} ->
      remediation_sources =
        otherwise.produced
        |> Enum.filter(fn {candidate_type, _source} -> candidate_type == type end)
        |> Enum.map(&elem(&1, 1))
        |> Enum.uniq()

      initial_sources =
        external_check_bindings
        |> Enum.filter(&(&1.type == type))
        |> Enum.map(& &1.producer)
        |> Enum.uniq()

      check_producers =
        Enum.filter(check.produced, fn {candidate_type, _} -> candidate_type == type end)

      cond do
        remediation_sources == [] ->
          {carries, errors}

        length(remediation_sources) > 1 ->
          error = %CompileError{
            type: :ambiguous_carried_artifact,
            artifact_type: type,
            candidate_sources: remediation_sources,
            region: region,
            details: %{reason: :multiple_remediation_producers}
          }

          {carries, errors ++ [error]}

        length(initial_sources) != 1 ->
          error = %CompileError{
            type: :ambiguous_carried_artifact,
            artifact_type: type,
            candidate_sources: initial_sources,
            region: region,
            details: %{reason: :multiple_initial_values}
          }

          {carries, errors ++ [error]}

        check_producers != [] ->
          error = %CompileError{
            type: :invalid_carried_artifact,
            artifact_type: type,
            candidate_sources: Enum.map(check_producers, &elem(&1, 1)),
            region: region,
            details: %{reason: :check_also_produces_carried_type}
          }

          {carries, errors ++ [error]}

        true ->
          [initial] = initial_sources
          [remediation] = remediation_sources

          check_consumers =
            external_check_bindings
            |> Enum.filter(&(&1.type == type and &1.producer == initial))
            |> Enum.map(& &1.consumer)

          otherwise_consumers =
            otherwise.bindings
            |> Enum.filter(&(&1.type == type and &1.producer == initial))
            |> Enum.map(& &1.consumer)

          carry = %ArtifactCarry{
            type: type,
            initial_producer: initial,
            remediation_producer: remediation,
            check_consumers: check_consumers,
            otherwise_consumers: otherwise_consumers
          }

          {carries ++ [carry], errors}
      end
    end)
  end

  defp apply_carries(check, otherwise, carries) do
    carried_bindings =
      Enum.flat_map(carries, fn carry ->
        Enum.map(carry.check_consumers, fn consumer ->
          %RegionArtifactBinding{
            consumer: consumer,
            type: carry.type,
            phase: :check,
            source: :current
          }
        end) ++
          Enum.map(carry.otherwise_consumers, fn consumer ->
            %RegionArtifactBinding{
              consumer: consumer,
              type: carry.type,
              phase: :otherwise,
              source: :current
            }
          end)
      end)

    check_bindings = Enum.reject(check.bindings, &carried_binding?(&1, carries, :check))

    otherwise_bindings =
      Enum.reject(otherwise.bindings, &carried_binding?(&1, carries, :otherwise))

    {check_bindings, otherwise_bindings, carried_bindings}
  end

  defp carried_binding?(binding, carries, phase) do
    Enum.any?(carries, fn carry ->
      consumers = if phase == :check, do: carry.check_consumers, else: carry.otherwise_consumers
      binding.type == carry.type and binding.consumer in consumers
    end)
  end

  defp region_outputs(region, check, carries) do
    check_outputs =
      check.produced
      |> Enum.map(fn {type, source} ->
        %UntilOutput{region: region, type: type, kind: :check, producer: source}
      end)
      |> Enum.uniq()

    carry_outputs =
      Enum.map(carries, fn carry ->
        %UntilOutput{region: region, type: carry.type, kind: :carried, producer: nil}
      end)

    check_outputs ++ carry_outputs
  end

  defp region_environment(entering, outputs) do
    outputs
    |> Enum.group_by(& &1.type)
    |> Enum.reduce(entering, fn {type, typed_outputs}, environment ->
      Map.put(environment, type, typed_outputs)
    end)
  end

  defp to_subtree(fragment) do
    %ControlSubtree{
      entries: fragment.entries,
      exits: fragment.exits,
      step_keys: fragment.step_keys,
      control_dependencies: fragment.dependencies,
      control_regions: fragment.region_ids
    }
  end

  defp add_sources(environment, produced) do
    Enum.reduce(produced, environment, fn {type, source}, current ->
      Map.update(current, type, [source], &append_once(&1, source))
    end)
  end

  defp append_once(values, value), do: if(value in values, do: values, else: values ++ [value])

  defp source_matches?(source, requested), do: source_key(source) == requested
  defp source_key(source) when is_binary(source), do: source
  defp source_key(%UntilOutput{kind: :check, producer: producer}), do: source_key(producer)
  defp source_key(%UntilOutput{kind: :carried}), do: nil

  defp produces?(step, type), do: Enum.any?(step.produces, &(&1.type == type))

  defp to_plan_step(%Step{} = step) do
    %PlanStep{
      key: step.key,
      name: step.name,
      instruction: step.instruction,
      performer: step.performer,
      context: step.context,
      produces: Enum.map(step.produces, & &1.type)
    }
  end

  defp region_id([]), do: "until/root"
  defp region_id(path), do: "until/" <> Enum.map_join(path, "/", &to_string/1)
end
