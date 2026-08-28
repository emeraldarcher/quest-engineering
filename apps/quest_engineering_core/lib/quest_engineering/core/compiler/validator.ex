defmodule QuestEngineering.Core.Compiler.Validator do
  @moduledoc false

  alias QuestEngineering.Core.CompileError
  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @spec validate(term()) :: {:ok, [Step.t()]} | {:error, [CompileError.t()]}
  def validate(tactic) do
    {steps, structure_errors} = collect(tactic, [])

    errors =
      structure_errors ++
        duplicate_step_errors(steps) ++
        duplicate_artifact_errors(steps) ++
        affinity_errors(tactic, steps) ++ context_reference_errors(tactic, steps)

    case errors do
      [] -> {:ok, steps}
      errors -> {:error, errors}
    end
  end

  defp collect(%Step{} = step, path), do: {[step], validate_step(step, path)}

  defp collect(%Sequence{children: children}, path) do
    collect_children(children, path, :sequence)
  end

  defp collect(%Parallel{children: children}, path) do
    collect_children(children, path, :parallel)
  end

  defp collect(%Until{} = until, path) do
    region = region_id(path)
    local_errors = validate_until(until, region)

    {check_steps, check_errors} =
      collect_until_child(until.check, path ++ [:check], region, :check)

    {otherwise_steps, otherwise_errors} =
      collect_until_child(until.otherwise, path ++ [:otherwise], region, :otherwise)

    {check_steps ++ otherwise_steps, local_errors ++ check_errors ++ otherwise_errors}
  end

  defp collect(other, path) do
    {[], [invalid_structure(path, %{reason: :unknown_tactic, value: other})]}
  end

  defp collect_until_child(nil, _path, region, phase) do
    {[],
     [
       %CompileError{
         type: :invalid_until_structure,
         region: region,
         details: %{reason: :missing_subtree, phase: phase}
       }
     ]}
  end

  defp collect_until_child(child, path, _region, _phase), do: collect(child, path)

  defp collect_children([], path, construct) do
    {[], [invalid_structure(path, %{reason: :empty_children, construct: construct})]}
  end

  defp collect_children(children, path, _construct) when is_list(children) do
    children
    |> Enum.with_index()
    |> Enum.reduce({[], []}, fn {child, index}, {steps, errors} ->
      {child_steps, child_errors} = collect(child, path ++ [index])
      {steps ++ child_steps, errors ++ child_errors}
    end)
  end

  defp collect_children(children, path, construct) do
    {[],
     [
       invalid_structure(path, %{
         reason: :children_must_be_a_non_empty_list,
         construct: construct,
         value: children
       })
     ]}
  end

  defp validate_until(until, region) do
    []
    |> maybe_add(
      not (is_integer(until.max_remediations) and until.max_remediations > 0),
      %CompileError{
        type: :invalid_until_limit,
        region: region,
        details: %{max_remediations: until.max_remediations, requirement: :positive_integer}
      }
    )
    |> maybe_add(
      not valid_condition?(until.condition),
      %CompileError{
        type: :invalid_condition,
        region: region,
        condition: until.condition,
        details: %{reason: :unsupported_condition}
      }
    )
  end

  defp maybe_add(errors, true, error), do: errors ++ [error]
  defp maybe_add(errors, false, _error), do: errors

  defp valid_condition?(%Condition{
         artifact: %Artifact{type: type, source: source},
         field: field,
         operator: :equals,
         value: value
       }) do
    valid_identifier?(type) and
      (is_nil(source) or valid_identifier?(source)) and
      is_binary(field) and field != "" and literal?(value)
  end

  defp valid_condition?(_condition), do: false

  defp literal?(value) do
    is_binary(value) or is_integer(value) or is_float(value) or is_boolean(value) or is_nil(value)
  end

  defp validate_step(step, path) do
    []
    |> require(valid_identifier?(step.key), path, %{reason: :invalid_step_key, step: step.key})
    |> require(is_binary(step.name) and step.name != "", path, %{
      reason: :invalid_step_name,
      step: step.key
    })
    |> require(valid_instruction?(step.instruction), path, %{
      reason: :invalid_step_instruction,
      step: step.key
    })
    |> require(valid_performer?(step.performer), path, %{
      reason: :invalid_performer_requirement,
      step: step.key,
      value: step.performer
    })
    |> validate_context(step, path)
    |> validate_artifacts(step, :consumes)
    |> validate_artifacts(step, :produces)
  end

  defp require(errors, true, _path, _details), do: errors
  defp require(errors, false, path, details), do: errors ++ [invalid_structure(path, details)]

  defp valid_instruction?(instruction) when is_binary(instruction) do
    String.valid?(instruction) and String.trim(instruction) != ""
  end

  defp valid_instruction?(_instruction), do: false

  defp valid_performer?(%PerformerRequirement{selector: selector, value: value})
       when selector in [:class, :same_as] do
    valid_identifier?(value)
  end

  defp valid_performer?(_performer), do: false

  defp validate_context(errors, %Step{context: context, key: step}, path) do
    if valid_context?(context) do
      errors
    else
      errors ++
        [
          %CompileError{
            type: :invalid_context_requirement,
            step: step,
            details: %{reason: :unsupported_requirement, value: context, path: path}
          }
        ]
    end
  end

  defp valid_context?(%ContextRequirement{selector: :fresh, value: nil}), do: true

  defp valid_context?(%ContextRequirement{selector: :continue_from, value: value}) do
    valid_identifier?(value)
  end

  defp valid_context?(_context), do: false

  defp validate_artifacts(errors, step, direction) do
    artifacts = Map.fetch!(step, direction)

    if is_list(artifacts) do
      errors ++ Enum.flat_map(artifacts, &validate_artifact(&1, step.key, direction))
    else
      errors ++
        [
          invalid_structure([], %{
            reason: :artifact_declarations_must_be_a_list,
            step: step.key,
            direction: direction
          })
        ]
    end
  end

  defp validate_artifact(%Artifact{type: type, source: source} = artifact, step, :consumes) do
    if valid_identifier?(type) and (is_nil(source) or valid_identifier?(source)) do
      []
    else
      invalid_artifact(artifact, step, :consumes)
    end
  end

  defp validate_artifact(%Artifact{type: type, source: nil} = artifact, step, :produces) do
    if valid_identifier?(type), do: [], else: invalid_artifact(artifact, step, :produces)
  end

  defp validate_artifact(%Artifact{source: source}, step, :produces) when not is_nil(source) do
    [
      invalid_structure([], %{
        reason: :artifact_output_cannot_have_source,
        step: step,
        source: source
      })
    ]
  end

  defp validate_artifact(artifact, step, direction) do
    invalid_artifact(artifact, step, direction)
  end

  defp invalid_artifact(artifact, step, direction) do
    [
      invalid_structure([], %{
        reason: :invalid_artifact_declaration,
        step: step,
        direction: direction,
        value: artifact
      })
    ]
  end

  defp duplicate_step_errors(steps) do
    steps
    |> Enum.map(& &1.key)
    |> Enum.filter(&valid_identifier?/1)
    |> duplicates()
    |> Enum.map(&%CompileError{type: :duplicate_step_key, step: &1})
  end

  defp duplicate_artifact_errors(steps) do
    Enum.flat_map(steps, fn step ->
      duplicate_artifact_errors(step, :consumes) ++ duplicate_artifact_errors(step, :produces)
    end)
  end

  defp duplicate_artifact_errors(step, direction) do
    case Map.fetch!(step, direction) do
      artifacts when is_list(artifacts) ->
        artifacts
        |> Enum.flat_map(&valid_artifact_type/1)
        |> duplicates()
        |> Enum.map(
          &%CompileError{
            type: :duplicate_artifact_declaration,
            step: step.key,
            artifact_type: &1,
            details: direction
          }
        )

      _invalid ->
        []
    end
  end

  defp valid_artifact_type(%Artifact{type: type}) do
    if valid_identifier?(type), do: [type], else: []
  end

  defp valid_artifact_type(_invalid), do: []

  defp affinity_errors(tactic, steps) do
    keys = steps |> Enum.map(& &1.key) |> Enum.filter(&valid_identifier?/1) |> MapSet.new()
    {_after, errors} = analyze_affinity(tactic, MapSet.new(), keys)
    errors
  end

  defp analyze_affinity(%Step{} = step, before, keys) do
    errors = performer_reference_errors(step, before, keys)
    {MapSet.put(before, step.key), errors}
  end

  defp analyze_affinity(%Sequence{children: children}, before, keys) when is_list(children) do
    Enum.reduce(children, {before, []}, fn child, {current, errors} ->
      {after_child, child_errors} = analyze_affinity(child, current, keys)
      {after_child, errors ++ child_errors}
    end)
  end

  defp analyze_affinity(%Parallel{children: children}, before, keys) when is_list(children) do
    Enum.reduce(children, {before, []}, fn child, {guaranteed_after, errors} ->
      {child_after, child_errors} = analyze_affinity(child, before, keys)
      {MapSet.union(guaranteed_after, child_after), errors ++ child_errors}
    end)
  end

  defp analyze_affinity(%Until{} = until, before, keys) do
    {check_after, check_errors} = analyze_affinity(until.check, before, keys)
    {_otherwise_after, otherwise_errors} = analyze_affinity(until.otherwise, check_after, keys)
    {check_after, check_errors ++ otherwise_errors}
  end

  defp analyze_affinity(_invalid, before, _keys), do: {before, []}

  defp performer_reference_errors(
         %Step{key: key, performer: %PerformerRequirement{selector: :same_as, value: reference}},
         before,
         keys
       )
       when is_binary(reference) do
    reason =
      cond do
        reference == key -> :self_reference
        not MapSet.member?(keys, reference) -> :unknown_step
        not MapSet.member?(before, reference) -> :not_guaranteed_to_execute_before
        true -> nil
      end

    if reason do
      [
        %CompileError{
          type: :invalid_performer_reference,
          step: key,
          referenced_step: reference,
          details: %{reason: reason}
        }
      ]
    else
      []
    end
  end

  defp performer_reference_errors(_step, _before, _keys), do: []

  defp context_reference_errors(tactic, steps) do
    keys = steps |> Enum.map(& &1.key) |> Enum.filter(&valid_identifier?/1) |> MapSet.new()
    {_after, errors} = analyze_context(tactic, MapSet.new(), keys, [], nil)
    errors
  end

  defp analyze_context(%Step{} = step, before, keys, _path, region) do
    errors = context_reference_errors(step, before, keys, region)
    {MapSet.put(before, step.key), errors}
  end

  defp analyze_context(%Sequence{children: children}, before, keys, path, region)
       when is_list(children) do
    children
    |> Enum.with_index()
    |> Enum.reduce({before, []}, fn {child, index}, {current, errors} ->
      {after_child, child_errors} =
        analyze_context(child, current, keys, path ++ [index], region)

      {after_child, errors ++ child_errors}
    end)
  end

  defp analyze_context(%Parallel{children: children}, before, keys, path, region)
       when is_list(children) do
    children
    |> Enum.with_index()
    |> Enum.reduce({before, []}, fn {child, index}, {guaranteed_after, errors} ->
      {child_after, child_errors} =
        analyze_context(child, before, keys, path ++ [index], region)

      {MapSet.union(guaranteed_after, child_after), errors ++ child_errors}
    end)
  end

  defp analyze_context(%Until{} = until, before, keys, path, _parent_region) do
    region = region_id(path)

    {check_after, check_errors} =
      analyze_context(until.check, before, keys, path ++ [:check], region)

    {_otherwise_after, otherwise_errors} =
      analyze_context(until.otherwise, check_after, keys, path ++ [:otherwise], region)

    {check_after, check_errors ++ otherwise_errors}
  end

  defp analyze_context(_invalid, before, _keys, _path, _region), do: {before, []}

  defp context_reference_errors(
         %Step{
           key: key,
           context: %ContextRequirement{selector: :continue_from, value: reference}
         },
         before,
         keys,
         region
       )
       when is_binary(reference) do
    reason =
      cond do
        reference == key -> :self_reference
        not MapSet.member?(keys, reference) -> :missing
        not MapSet.member?(before, reference) -> :not_upstream
        true -> nil
      end

    if reason do
      [
        %CompileError{
          type: :invalid_context_reference,
          step: key,
          referenced_step: reference,
          region: region,
          details: %{reason: reason}
        }
      ]
    else
      []
    end
  end

  defp context_reference_errors(_step, _before, _keys, _region), do: []

  defp duplicates(values) do
    {duplicates, _seen} =
      Enum.reduce(values, {[], MapSet.new()}, fn value, {found, seen} ->
        if MapSet.member?(seen, value) do
          {append_once(found, value), seen}
        else
          {found, MapSet.put(seen, value)}
        end
      end)

    duplicates
  end

  defp append_once(values, value), do: if(value in values, do: values, else: values ++ [value])

  defp valid_identifier?(value), do: is_binary(value) and value != ""

  defp invalid_structure(path, details) do
    %CompileError{type: :invalid_structure, details: Map.put(details, :path, path)}
  end

  defp region_id([]), do: "until/root"

  defp region_id(path) do
    "until/" <> Enum.map_join(path, "/", &to_string/1)
  end
end
