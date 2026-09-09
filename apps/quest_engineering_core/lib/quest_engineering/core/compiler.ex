defmodule QuestEngineering.Core.Compiler do
  @moduledoc "Compiles semantic trees into deterministic plans with exact named artifact bindings."

  alias QuestEngineering.Core.CompileError
  alias QuestEngineering.Core.Compiler.Validator
  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Product.AcceptedArtifactSource
  alias QuestEngineering.Core.Product.ResolvedTacticUse
  alias QuestEngineering.Core.Product.TacticInterface
  alias QuestEngineering.Core.Product.TacticResolver.Resolution

  alias QuestEngineering.Core.ExecutionPlan.{
    ArtifactBinding,
    ArtifactCarry,
    ConditionBinding,
    ControlDependency,
    ControlRegionReference,
    ControlSubtree,
    InputEndpoint,
    RegionArtifactBinding,
    TacticOutput,
    UntilOutput,
    UntilRegion
  }

  alias QuestEngineering.Core.ExecutionPlan.Step, as: PlanStep

  alias QuestEngineering.Core.Tactics.{
    ArtifactInput,
    ArtifactOutput,
    ArtifactRef,
    Condition,
    Parallel,
    Sequence,
    Step,
    Until
  }

  @type result :: {:ok, ExecutionPlan.t()} | {:error, [CompileError.t()]}
  @type producer :: ArtifactRef.t() | UntilOutput.t()
  @type entry :: %{kind: String.t(), ref: ArtifactRef.t() | nil, source: producer()}
  @type environment :: %{optional(String.t()) => [entry()]}

  @spec compile(term()) :: result()
  def compile(%Resolution{} = resolution),
    do: do_compile(resolution.tactic, resolution.interface, %{})

  def compile(tactic), do: do_compile(tactic, %TacticInterface{}, %{})

  @doc "Compiles a reusable definition with symbolic values for its declared root input ports."
  def compile_for_definition(%Resolution{} = resolution) do
    environment =
      Enum.reduce(resolution.interface.inputs, %{}, fn port, env ->
        source = %ArtifactRef{producer: "$inputs", output: port.key}
        add_entries(env, [%{kind: port.kind, ref: source, source: source}])
      end)

    do_compile(resolution.tactic, resolution.interface, environment)
  end

  defp do_compile(tactic, interface, root_environment) do
    with {:ok, semantic_steps} <- Validator.validate(tactic) do
      context = %{steps: semantic_steps}
      fragment = compile_node(tactic, root_environment, [], nil, context)
      {tactic_outputs, output_errors} = resolve_tactic_outputs(interface.outputs, fragment)
      errors = fragment.errors ++ output_errors

      if errors == [] do
        {:ok,
         %ExecutionPlan{
           steps: Enum.map(semantic_steps, &to_plan_step/1),
           control_dependencies: Enum.uniq(fragment.dependencies),
           artifact_bindings: fragment.bindings,
           control_regions: fragment.regions,
           tactic_outputs: tactic_outputs
         }}
      else
        {:error, errors}
      end
    end
  end

  defp compile_node(%Step{} = step, environment, _path, _parent, _context) do
    {bindings, errors} = resolve_step_inputs(step, environment)
    produced = Enum.map(step.produces, fn output -> output_entry(step.key, output) end)

    fragment(
      entries: [step.key],
      exits: [step.key],
      bindings: bindings,
      errors: errors,
      produced: produced,
      environment: add_entries(environment, produced),
      step_keys: [step.key]
    )
  end

  defp compile_node(%Sequence{children: children}, environment, path, parent, context) do
    [{first, first_index} | rest] = Enum.with_index(children)
    initial = compile_node(first, environment, path ++ [first_index], parent, context)

    Enum.reduce(rest, initial, fn {child, index}, left ->
      right = compile_node(child, left.environment, path ++ [index], parent, context)

      deps =
        for prerequisite <- left.exits,
            dependent <- right.entries,
            do: %ControlDependency{prerequisite: prerequisite, dependent: dependent}

      merge_sequence(left, right, deps)
    end)
  end

  defp compile_node(%Parallel{children: children}, environment, path, parent, context) do
    fragments =
      children
      |> Enum.with_index()
      |> Enum.map(fn {child, i} ->
        compile_node(child, environment, path ++ [i], parent, context)
      end)

    produced = Enum.flat_map(fragments, & &1.produced)

    fragment(
      entries: Enum.flat_map(fragments, & &1.entries),
      exits: Enum.flat_map(fragments, & &1.exits),
      dependencies: Enum.flat_map(fragments, & &1.dependencies),
      bindings: Enum.flat_map(fragments, & &1.bindings),
      regions: Enum.flat_map(fragments, & &1.regions),
      region_ids: Enum.flat_map(fragments, & &1.region_ids),
      errors: Enum.flat_map(fragments, & &1.errors),
      produced: produced,
      environment: add_entries(environment, produced),
      step_keys: Enum.flat_map(fragments, & &1.step_keys)
    )
  end

  defp compile_node(%ResolvedTacticUse{} = use, environment, path, parent, context) do
    {child_environment, input_errors} = child_input_environment(use, environment)
    child = compile_node(use.body, child_environment, path ++ [:use], parent, context)
    {exports, output_errors} = resolve_use_outputs(use, child)
    outgoing = add_entries(environment, exports)

    fragment(
      entries: child.entries,
      exits: child.exits,
      dependencies: child.dependencies,
      bindings: child.bindings,
      regions: child.regions,
      region_ids: child.region_ids,
      errors: input_errors ++ child.errors ++ output_errors,
      produced: exports,
      environment: outgoing,
      step_keys: child.step_keys
    )
  end

  defp compile_node(%Until{} = until, environment, path, parent, context) do
    id = region_id(path)
    check = compile_node(until.check, environment, path ++ [:check], id, context)

    otherwise =
      compile_node(until.otherwise, check.environment, path ++ [:otherwise], id, context)

    {condition, condition_errors} = bind_condition(until.condition, check, id)
    {carries, carry_errors} = infer_carries(check, otherwise, environment, id)
    {gate, subject_kind, acceptance_errors} = acceptance_scope(id, condition, carries, context)

    {check_bindings, otherwise_bindings, region_bindings} =
      apply_carries(check, otherwise, carries)

    outputs = region_outputs(id, check, carries)
    outgoing = replace_kinds(environment, Enum.map(outputs, &until_entry/1))
    reference = %ControlRegionReference{id: id}

    region = %UntilRegion{
      id: id,
      parent_region: parent,
      check: to_subtree(check),
      condition: until.condition,
      condition_binding: condition,
      otherwise: to_subtree(otherwise),
      max_remediations: until.max_remediations,
      artifact_bindings: region_bindings,
      artifact_carries: carries,
      outputs: outputs,
      acceptance_gate_key: gate,
      acceptance_subject_kind: subject_kind
    }

    fragment(
      entries: [reference],
      exits: [reference],
      dependencies: check.dependencies ++ otherwise.dependencies,
      bindings: check_bindings ++ otherwise_bindings,
      regions: [region] ++ check.regions ++ otherwise.regions,
      region_ids: [id] ++ check.region_ids ++ otherwise.region_ids,
      errors:
        check.errors ++ otherwise.errors ++ condition_errors ++ carry_errors ++ acceptance_errors,
      produced: Enum.map(outputs, &until_entry/1),
      environment: outgoing,
      step_keys: check.step_keys ++ otherwise.step_keys
    )
  end

  defp fragment(options) do
    [
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
    |> Keyword.merge(options)
    |> Map.new()
  end

  defp merge_sequence(left, right, boundary) do
    fragment(
      entries: left.entries,
      exits: right.exits,
      dependencies: Enum.uniq(left.dependencies ++ boundary ++ right.dependencies),
      bindings: left.bindings ++ right.bindings,
      regions: left.regions ++ right.regions,
      region_ids: left.region_ids ++ right.region_ids,
      errors: left.errors ++ right.errors,
      produced: left.produced ++ right.produced,
      environment: right.environment,
      step_keys: left.step_keys ++ right.step_keys
    )
  end

  defp child_input_environment(use, parent_environment) do
    bindings_by_input = Map.new(use.input_bindings, &{&1.input, &1.source})
    duplicate_keys = use.input_bindings |> Enum.map(& &1.input) |> duplicates()
    known_keys = MapSet.new(use.input_ports, & &1.key)

    errors =
      Enum.map(
        duplicate_keys,
        &interface_error(:duplicate_tactic_input_binding, use.instance_key, &1, %{})
      ) ++
        Enum.flat_map(use.input_bindings, fn binding ->
          if MapSet.member?(known_keys, binding.input),
            do: [],
            else: [interface_error(:unknown_tactic_input, use.instance_key, binding.input, %{})]
        end)

    Enum.reduce(use.input_ports, {%{}, errors}, fn port, accumulator ->
      bind_child_input(port, accumulator, bindings_by_input, parent_environment, use.instance_key)
    end)
  end

  defp bind_child_input(port, {environment, errors}, bindings, parent, instance_key) do
    case Map.fetch(bindings, port.key) do
      :error when port.required ->
        error =
          interface_error(:missing_required_tactic_input, instance_key, port.key, %{
            kind: port.kind
          })

        {environment, errors ++ [error]}

      :error ->
        {environment, errors}

      {:ok, source_ref} ->
        bind_child_source(port, source_ref, {environment, errors}, parent, instance_key)
    end
  end

  defp bind_child_source(port, source_ref, {environment, errors}, parent, instance_key) do
    case find_ref(parent, source_ref) do
      nil ->
        error =
          interface_error(:unavailable_tactic_input_source, instance_key, port.key, %{
            source: source_ref
          })

        {environment, errors ++ [error]}

      %{kind: kind} when kind != port.kind ->
        details = %{expected_kind: port.kind, actual_kind: kind, source: source_ref}
        error = interface_error(:incompatible_tactic_input_kind, instance_key, port.key, details)
        {environment, errors ++ [error]}

      entry ->
        alias_ref = %ArtifactRef{producer: instance_key <> "/$inputs", output: port.key}
        child_entry = %{kind: port.kind, ref: alias_ref, source: entry.source}
        {add_entries(environment, [child_entry]), errors}
    end
  end

  defp resolve_use_outputs(use, child) do
    Enum.reduce(use.output_ports, {[], []}, fn port, {exports, errors} ->
      case resolve_port_source(port, child) do
        {:ok, source} ->
          ref = %ArtifactRef{producer: use.instance_key, output: port.key}
          {exports ++ [%{kind: port.kind, ref: ref, source: source}], errors}

        {:error, reason} ->
          {exports,
           errors ++
             [
               interface_error(
                 :unresolved_tactic_output,
                 use.instance_key,
                 port.key,
                 Map.put(reason, :kind, port.kind)
               )
             ]}
      end
    end)
  end

  defp resolve_tactic_outputs(ports, fragment) do
    Enum.reduce(ports, {[], []}, fn port, {outputs, errors} ->
      case resolve_port_source(port, fragment) do
        {:ok, source} ->
          {outputs ++
             [%TacticOutput{key: port.key, label: port.label, kind: port.kind, producer: source}],
           errors}

        {:error, reason} ->
          {outputs,
           errors ++
             [
               interface_error(
                 :unresolved_tactic_output,
                 "$root",
                 port.key,
                 Map.put(reason, :kind, port.kind)
               )
             ]}
      end
    end)
  end

  defp resolve_port_source(%{kind: kind, source: %ArtifactRef{} = ref}, fragment) do
    case find_ref(fragment.environment, ref) do
      nil ->
        {:error, %{reason: :binding_not_available, source: ref}}

      %{kind: ^kind, source: source} ->
        {:ok, source}

      %{kind: actual} ->
        {:error,
         %{reason: :source_kind_mismatch, expected_kind: kind, actual_kind: actual, source: ref}}
    end
  end

  defp resolve_port_source(
         %{kind: kind, source: %AcceptedArtifactSource{gate_key: gate}},
         fragment
       ) do
    regions = Enum.filter(fragment.regions, &(&1.acceptance_gate_key == gate))

    case regions do
      [region] ->
        case Enum.find(region.outputs, &(&1.source_kind == :carried and &1.kind == kind)) do
          nil -> {:error, %{reason: :accepted_subject_kind_mismatch, gate_key: gate}}
          output -> {:ok, output}
        end

      [] ->
        {:error, %{reason: :acceptance_gate_not_found, gate_key: gate}}

      _ ->
        {:error, %{reason: :ambiguous_acceptance_gate, gate_key: gate}}
    end
  end

  defp find_ref(environment, ref),
    do: environment |> Map.values() |> List.flatten() |> Enum.find(&(&1.ref == ref))

  defp interface_error(type, use, port, details),
    do: %CompileError{
      type: type,
      step: use,
      artifact_type: Map.get(details, :kind),
      details: Map.merge(details, %{port: port})
    }

  defp duplicates(values),
    do:
      values
      |> Enum.frequencies()
      |> Enum.filter(fn {_, count} -> count > 1 end)
      |> Enum.map(&elem(&1, 0))

  defp output_entry(step, %ArtifactOutput{name: name, kind: kind}) do
    source = %ArtifactRef{producer: step, output: name}
    %{kind: kind, ref: source, source: source}
  end

  defp until_entry(%UntilOutput{name: name, kind: kind} = output),
    do: %{kind: kind, ref: nil, source: output, name: name}

  defp resolve_step_inputs(step, environment) do
    Enum.reduce(step.consumes, {[], []}, fn input, {bindings, errors} ->
      case resolve_input(step.key, input, environment) do
        {:ok, nil} -> {bindings, errors}
        {:ok, binding} -> {bindings ++ [binding], errors}
        {:error, error} -> {bindings, errors ++ [error]}
      end
    end)
  end

  defp resolve_input(consumer, %ArtifactInput{source: nil} = input, environment) do
    candidates = Map.get(environment, input.kind, [])

    case candidates do
      [entry] ->
        {:ok, binding(consumer, input, entry.source)}

      [] when input.required == false ->
        {:ok, nil}

      [] ->
        {:error,
         compile_error(:missing_artifact, consumer, input, [], %{
           reason: :no_compatible_upstream_binding
         })}

      entries ->
        {:error,
         compile_error(
           :ambiguous_artifact,
           consumer,
           input,
           Enum.map(entries, &candidate_label/1),
           %{reason: :explicit_source_required}
         )}
    end
  end

  defp resolve_input(consumer, %ArtifactInput{source: source} = input, environment) do
    all = environment |> Map.values() |> List.flatten()

    case Enum.find(all, &(&1.ref == source)) do
      nil when input.required == false ->
        {:ok, nil}

      nil ->
        {:error,
         compile_error(
           :invalid_artifact_source,
           consumer,
           input,
           Enum.map(Map.get(environment, input.kind, []), &candidate_label/1),
           %{reason: :specific_output_not_available, source: source}
         )}

      %{kind: kind} when kind != input.kind ->
        {:error,
         compile_error(:incompatible_artifact_kind, consumer, input, [kind], %{
           reason: :source_kind_mismatch,
           source: source
         })}

      entry ->
        {:ok, binding(consumer, input, entry.source)}
    end
  end

  defp binding(consumer, input, producer),
    do: %ArtifactBinding{
      consumer: consumer,
      input: input.name,
      kind: input.kind,
      producer: producer,
      required: input.required
    }

  defp compile_error(type, consumer, input, candidates, details) do
    referenced =
      case Map.get(details, :source) do
        %ArtifactRef{producer: producer} -> producer
        _ -> nil
      end

    %CompileError{
      type: type,
      step: consumer,
      artifact_type: input.kind,
      candidate_sources: candidates,
      referenced_source: referenced,
      details: Map.put(details, :input, input.name)
    }
  end

  defp candidate_label(%{ref: %ArtifactRef{} = ref}), do: ref
  defp candidate_label(%{source: source}), do: source

  defp bind_condition(%Condition{source: source} = value, check, region) do
    candidates = check.produced |> Enum.filter(&(&1.ref == source))

    case candidates do
      [%{kind: kind}] ->
        {%ConditionBinding{
           kind: kind,
           producer: source,
           field: value.field,
           operator: value.operator,
           value: value.value
         }, []}

      [] ->
        {nil,
         [
           %CompileError{
             type: :invalid_condition_artifact,
             referenced_source: source.producer,
             candidate_sources: Enum.map(check.produced, &candidate_label/1),
             region: region,
             condition: value,
             details: %{reason: :specific_output_not_produced_by_check, output: source.output}
           }
         ]}

      _ ->
        {nil,
         [
           %CompileError{
             type: :ambiguous_condition_artifact,
             referenced_source: source.producer,
             region: region,
             condition: value,
             details: %{reason: :duplicate_output_binding, output: source.output}
           }
         ]}
    end
  end

  defp infer_carries(check, otherwise, entering, region) do
    entering_sources = entering |> Map.values() |> List.flatten() |> MapSet.new(& &1.source)
    external = Enum.filter(check.bindings, &MapSet.member?(entering_sources, &1.producer))
    kinds = external |> Enum.map(& &1.kind) |> Enum.uniq()

    Enum.reduce(kinds, {[], []}, fn kind, {carries, errors} ->
      remediation =
        otherwise.produced
        |> Enum.filter(&(&1.kind == kind))
        |> Enum.map(& &1.source)
        |> Enum.uniq()

      initial =
        external |> Enum.filter(&(&1.kind == kind)) |> Enum.map(& &1.producer) |> Enum.uniq()

      check_outputs = Enum.filter(check.produced, &(&1.kind == kind))

      cond do
        remediation == [] ->
          {carries, errors}

        length(remediation) != 1 ->
          {carries,
           errors ++
             [
               carry_error(
                 :ambiguous_carried_artifact,
                 kind,
                 remediation,
                 region,
                 :multiple_remediation_outputs
               )
             ]}

        length(initial) != 1 ->
          {carries,
           errors ++
             [
               carry_error(
                 :ambiguous_carried_artifact,
                 kind,
                 initial,
                 region,
                 :multiple_initial_values
               )
             ]}

        check_outputs != [] ->
          {carries,
           errors ++
             [
               carry_error(
                 :invalid_carried_artifact,
                 kind,
                 Enum.map(check_outputs, & &1.source),
                 region,
                 :check_also_produces_carried_kind
               )
             ]}

        true ->
          [initial_source] = initial

          carry = %ArtifactCarry{
            kind: kind,
            initial_producer: initial_source,
            remediation_producer: hd(remediation),
            check_consumers: endpoints(external, kind, initial_source),
            otherwise_consumers: endpoints(otherwise.bindings, kind, initial_source)
          }

          {carries ++ [carry], errors}
      end
    end)
  end

  defp endpoints(bindings, kind, source),
    do:
      bindings
      |> Enum.filter(&(&1.kind == kind and &1.producer == source))
      |> Enum.map(&%InputEndpoint{step: &1.consumer, input: &1.input})

  defp carry_error(type, kind, sources, region, reason),
    do: %CompileError{
      type: type,
      artifact_type: kind,
      candidate_sources: sources,
      region: region,
      details: %{reason: reason}
    }

  defp apply_carries(check, otherwise, carries) do
    regional =
      Enum.flat_map(carries, fn carry ->
        Enum.map(
          carry.check_consumers,
          &%RegionArtifactBinding{
            consumer: &1.step,
            input: &1.input,
            kind: carry.kind,
            phase: :check,
            source: :current
          }
        ) ++
          Enum.map(
            carry.otherwise_consumers,
            &%RegionArtifactBinding{
              consumer: &1.step,
              input: &1.input,
              kind: carry.kind,
              phase: :otherwise,
              source: :current
            }
          )
      end)

    {Enum.reject(check.bindings, &carried?(&1, carries, :check)),
     Enum.reject(otherwise.bindings, &carried?(&1, carries, :otherwise)), regional}
  end

  defp carried?(binding, carries, phase),
    do:
      Enum.any?(carries, fn carry ->
        endpoints = if phase == :check, do: carry.check_consumers, else: carry.otherwise_consumers
        Enum.any?(endpoints, &(&1.step == binding.consumer and &1.input == binding.input))
      end)

  defp acceptance_scope(_region, nil, _carries, _context), do: {nil, nil, []}

  defp acceptance_scope(
         region,
         %ConditionBinding{kind: "review_verdict", producer: producer},
         carries,
         context
       ) do
    with %Step{} = step <- Enum.find(context.steps, &(&1.key == producer.producer)),
         %ArtifactOutput{review: review} <-
           Enum.find(step.produces, &(&1.name == producer.output)),
         %{gate_key: gate, subject_input: subject_input} <- review,
         %ArtifactInput{kind: subject_kind} <-
           Enum.find(step.consumes, &(&1.name == subject_input)),
         %ArtifactCarry{} <-
           Enum.find(carries, fn carry ->
             carry.kind == subject_kind and
               Enum.any?(
                 carry.check_consumers,
                 &(&1.step == step.key and &1.input == subject_input)
               )
           end) do
      {gate, subject_kind, []}
    else
      _ ->
        {nil, nil,
         [
           %CompileError{
             type: :invalid_acceptance_subject,
             region: region,
             artifact_type: "review_verdict",
             details: %{reason: :review_contract_must_target_one_loop_carried_input}
           }
         ]}
    end
  end

  defp acceptance_scope(_region, _condition, _carries, _context), do: {nil, nil, []}

  defp region_outputs(region, check, carries) do
    check_outputs =
      Enum.map(check.produced, fn entry ->
        %UntilOutput{
          region: region,
          name: entry.ref.output,
          kind: entry.kind,
          source_kind: :check,
          producer: entry.source
        }
      end)

    carried =
      Enum.map(carries, fn carry ->
        %UntilOutput{
          region: region,
          name: carry.kind,
          kind: carry.kind,
          source_kind: :carried,
          producer: nil
        }
      end)

    Enum.uniq(check_outputs ++ carried)
  end

  defp to_subtree(fragment),
    do: %ControlSubtree{
      entries: fragment.entries,
      exits: fragment.exits,
      step_keys: fragment.step_keys,
      control_dependencies: fragment.dependencies,
      control_regions: fragment.region_ids
    }

  defp add_entries(environment, entries),
    do:
      Enum.reduce(entries, environment, fn entry, env ->
        Map.update(env, entry.kind, [entry], &append_once(&1, entry))
      end)

  defp replace_kinds(environment, entries),
    do:
      entries
      |> Enum.group_by(& &1.kind)
      |> Enum.reduce(environment, fn {kind, values}, env -> Map.put(env, kind, values) end)

  defp append_once(values, value), do: if(value in values, do: values, else: values ++ [value])

  defp to_plan_step(%Step{} = step),
    do: %PlanStep{
      key: step.key,
      name: step.name,
      instruction: step.instruction,
      performer: step.performer,
      context: step.context,
      consumes: step.consumes,
      produces: step.produces
    }

  defp region_id([]), do: "until/root"
  defp region_id(path), do: "until/" <> Enum.map_join(path, "/", &to_string/1)
end
