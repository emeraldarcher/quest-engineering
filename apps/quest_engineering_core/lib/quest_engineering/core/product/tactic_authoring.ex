defmodule QuestEngineering.Core.Product.TacticUse do
  @moduledoc "An authoring-only reusable Tactic instance with explicit input-port bindings."

  alias QuestEngineering.Core.Product.TacticInputBinding

  @enforce_keys [:instance_key, :tactic_definition_id]
  defstruct [:instance_key, :tactic_definition_id, input_bindings: []]

  @type t :: %__MODULE__{
          instance_key: String.t(),
          tactic_definition_id: String.t(),
          input_bindings: [TacticInputBinding.t()]
        }
end

defmodule QuestEngineering.Core.Product.TacticAuthoring do
  @moduledoc "The recursive semantic-tree authoring language, including reusable Tactic uses."

  alias QuestEngineering.Core.ArtifactSemantics
  alias QuestEngineering.Core.Product.TacticInputBinding
  alias QuestEngineering.Core.Product.TacticUse
  alias QuestEngineering.Core.Product.ValidationError
  alias QuestEngineering.Core.Tactics.ArtifactInput
  alias QuestEngineering.Core.Tactics.ArtifactOutput
  alias QuestEngineering.Core.Tactics.ArtifactRef
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.ReviewContract
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @key ~r/\A[a-z][a-z0-9_-]{0,63}\z/
  @slot ~r/\A[a-z][a-z0-9_]{0,63}\z/

  @type t ::
          Step.t()
          | %Sequence{children: [t()]}
          | %Parallel{children: [t()]}
          | %Until{check: t(), otherwise: t()}
          | TacticUse.t()

  @spec use(String.t(), String.t(), [TacticInputBinding.t()]) :: TacticUse.t()
  def use(instance_key, tactic_definition_id, bindings \\ []),
    do: %TacticUse{
      instance_key: instance_key,
      tactic_definition_id: tactic_definition_id,
      input_bindings: bindings
    }

  @spec validate(term(), [String.t() | non_neg_integer()]) :: [ValidationError.t()]
  def validate(body, path \\ ["body"]) do
    {identities, references, errors} = inspect_node(body, path, [], [], [])
    known = MapSet.new(identities, & &1.key)

    identity_errors(identities) ++ reference_errors(references, known) ++ Enum.reverse(errors)
  end

  @spec referenced_definition_ids(term()) :: [String.t()]
  def referenced_definition_ids(body), do: body |> collect_reference_ids([]) |> Enum.reverse()

  defp inspect_node(%Step{} = step, path, identities, references, errors) do
    identities = [%{kind: :step, key: step.key, path: path ++ ["key"]} | identities]
    errors = validate_step(step, path) ++ errors
    refs = step_refs(step, path) ++ references
    {identities, refs, errors}
  end

  defp inspect_node(%TacticUse{} = use, path, identities, references, errors) do
    identities = [
      %{kind: :use, key: use.instance_key, path: path ++ ["instance_key"]} | identities
    ]

    errors = validate_use(use, path) ++ errors
    refs = binding_refs(use.input_bindings, path ++ ["input_bindings"]) ++ references
    {identities, refs, errors}
  end

  defp inspect_node(%Sequence{children: children}, path, ids, refs, errors),
    do: inspect_children(children, path, :sequence, ids, refs, errors)

  defp inspect_node(%Parallel{children: children}, path, ids, refs, errors),
    do: inspect_children(children, path, :parallel, ids, refs, errors)

  defp inspect_node(%Until{} = value, path, ids, refs, errors) do
    errors =
      errors
      |> maybe(
        not (is_integer(value.max_remediations) and value.max_remediations > 0),
        :invalid_until_limit,
        path ++ ["max_remediations"],
        %{value: value.max_remediations}
      )
      |> maybe(
        not valid_condition?(value.condition),
        :invalid_condition,
        path ++ ["condition"],
        %{value: value.condition}
      )

    refs = condition_refs(value.condition, path ++ ["condition"]) ++ refs
    {ids, refs, errors} = inspect_node(value.check, path ++ ["check"], ids, refs, errors)
    inspect_node(value.otherwise, path ++ ["otherwise"], ids, refs, errors)
  end

  defp inspect_node(value, path, ids, refs, errors),
    do:
      {ids, refs,
       [error(:invalid_tactic_body, path, %{reason: :unknown_node, value: value}) | errors]}

  defp inspect_children(children, path, _construct, ids, refs, errors)
       when is_list(children) and children != [] do
    children
    |> Enum.with_index()
    |> Enum.reduce({ids, refs, errors}, fn {child, i}, {a, b, c} ->
      inspect_node(child, path ++ ["children", i], a, b, c)
    end)
  end

  defp inspect_children(children, path, construct, ids, refs, errors),
    do:
      {ids, refs,
       [
         error(:invalid_tactic_body, path ++ ["children"], %{
           reason: :children_must_be_a_non_empty_list,
           construct: construct,
           value: children
         })
         | errors
       ]}

  defp validate_step(step, path) do
    input_errors = validate_inputs(step.consumes, path ++ ["consumes"])
    output_errors = validate_outputs(step.produces, step.consumes, path ++ ["produces"])
    input_errors ++ output_errors
  end

  defp validate_inputs(values, path) when is_list(values) do
    values
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {%ArtifactInput{name: name, kind: kind, source: source, required: required}, i} ->
        []
        |> maybe_list(not slot?(name), :invalid_artifact_input_name, path ++ [i, "name"], %{
          value: name
        })
        |> maybe_list(
          not ArtifactSemantics.valid_kind?(kind),
          :invalid_artifact_kind,
          path ++ [i, "kind"],
          %{value: kind}
        )
        |> maybe_list(
          not (is_nil(source) or match?(%ArtifactRef{}, source)),
          :invalid_artifact_source,
          path ++ [i, "source"],
          %{value: source}
        )
        |> maybe_list(
          not is_boolean(required),
          :invalid_optional_input,
          path ++ [i, "required"],
          %{value: required}
        )

      {value, i} ->
        [error(:invalid_artifact_input, path ++ [i], %{value: value})]
    end)
    |> duplicate_slot_errors(path)
  end

  defp validate_inputs(value, path), do: [error(:invalid_artifact_inputs, path, %{value: value})]

  defp validate_outputs(values, inputs, path) when is_list(values) do
    input_names =
      if is_list(inputs),
        do:
          inputs
          |> Enum.flat_map(fn
            %ArtifactInput{name: name} -> [name]
            _ -> []
          end)
          |> MapSet.new(),
        else: MapSet.new()

    values
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {%ArtifactOutput{name: name, kind: kind, review: review}, i} ->
        []
        |> maybe_list(not slot?(name), :invalid_artifact_output_name, path ++ [i, "name"], %{
          value: name
        })
        |> maybe_list(
          not ArtifactSemantics.valid_kind?(kind),
          :invalid_artifact_kind,
          path ++ [i, "kind"],
          %{value: kind}
        )
        |> validate_review_output(kind, review, input_names, path ++ [i])

      {value, i} ->
        [error(:invalid_artifact_output, path ++ [i], %{value: value})]
    end)
    |> duplicate_slot_errors(path)
  end

  defp validate_outputs(value, _inputs, path),
    do: [error(:invalid_artifact_outputs, path, %{value: value})]

  defp validate_review_output(
         errors,
         "review_verdict",
         %ReviewContract{gate_key: gate, subject_input: subject},
         inputs,
         path
       ) do
    errors
    |> maybe_list(not slot?(gate), :invalid_acceptance_gate, path ++ ["review", "gate_key"], %{
      value: gate
    })
    |> maybe_list(
      not MapSet.member?(inputs, subject),
      :invalid_review_subject_input,
      path ++ ["review", "subject_input"],
      %{value: subject}
    )
  end

  defp validate_review_output(errors, "review_verdict", review, _inputs, path),
    do: errors ++ [error(:missing_review_contract, path ++ ["review"], %{value: review})]

  defp validate_review_output(errors, _kind, nil, _inputs, _path), do: errors

  defp validate_review_output(errors, kind, review, _inputs, path),
    do:
      errors ++
        [error(:unexpected_review_contract, path ++ ["review"], %{kind: kind, value: review})]

  defp validate_use(%TacticUse{} = use, path) do
    []
    |> maybe_list(
      not non_blank?(use.tactic_definition_id),
      :invalid_tactic_definition_reference,
      path ++ ["tactic_definition_id"],
      %{value: use.tactic_definition_id}
    )
    |> maybe_list(
      not is_list(use.input_bindings),
      :invalid_tactic_input_bindings,
      path ++ ["input_bindings"],
      %{value: use.input_bindings}
    )
  end

  defp duplicate_slot_errors(errors, _path), do: errors

  defp step_refs(step, path) do
    performer =
      case step.performer do
        %PerformerRequirement{selector: :same_as, value: value} ->
          [local_ref(:same_as, value, path ++ ["performer", "value"])]

        _ ->
          []
      end

    context =
      case step.context do
        %ContextRequirement{selector: :continue_from, value: value} ->
          [local_ref(:continue_from, value, path ++ ["context", "value"])]

        _ ->
          []
      end

    inputs =
      step.consumes
      |> List.wrap()
      |> Enum.with_index()
      |> Enum.flat_map(fn
        {%ArtifactInput{source: %ArtifactRef{} = source}, i} ->
          [artifact_ref(:artifact_source, source, path ++ ["consumes", i, "source"])]

        _ ->
          []
      end)

    performer ++ context ++ inputs
  end

  defp condition_refs(%Condition{source: %ArtifactRef{} = source}, path),
    do: [artifact_ref(:condition_source, source, path ++ ["source"])]

  defp condition_refs(_, _), do: []

  defp binding_refs(values, path) when is_list(values),
    do:
      values
      |> Enum.with_index()
      |> Enum.flat_map(fn
        {%TacticInputBinding{source: %ArtifactRef{} = source}, i} ->
          [artifact_ref(:tactic_input_source, source, path ++ [i, "source"])]

        _ ->
          []
      end)

  defp binding_refs(_, _), do: []

  defp artifact_ref(kind, %ArtifactRef{producer: "$inputs"}, path),
    do: %{kind: kind, value: "$inputs", path: path, external: true}

  defp artifact_ref(kind, %ArtifactRef{producer: producer}, path),
    do: local_ref(kind, producer, path)

  defp local_ref(kind, value, path), do: %{kind: kind, value: value, path: path, external: false}

  defp identity_errors(ids) do
    ordered = Enum.reverse(ids)

    invalid =
      for i <- ordered,
          not key?(i.key),
          do: error(:invalid_local_identity, i.path, %{kind: i.kind, value: i.key})

    duplicate =
      ordered
      |> Enum.group_by(& &1.key)
      |> Enum.filter(fn {_, xs} -> length(xs) > 1 end)
      |> Enum.map(fn {key, xs} ->
        error(:duplicate_local_identity, hd(xs).path, %{
          key: key,
          kinds: Enum.map(xs, & &1.kind),
          paths: Enum.map(xs, & &1.path)
        })
      end)

    invalid ++ duplicate
  end

  defp reference_errors(refs, known) do
    refs
    |> Enum.reverse()
    |> Enum.flat_map(fn ref ->
      cond do
        ref.external ->
          []

        not key?(ref.value) ->
          [error(:invalid_local_reference, ref.path, %{kind: ref.kind, value: ref.value})]

        not MapSet.member?(known, ref.value) ->
          [error(:unknown_local_reference, ref.path, %{kind: ref.kind, producer: ref.value})]

        true ->
          []
      end
    end)
  end

  defp valid_condition?(%Condition{
         source: %ArtifactRef{producer: p, output: o},
         field: field,
         operator: :equals,
         value: value
       }),
       do: non_blank?(p) and slot?(o) and non_blank?(field) and literal?(value)

  defp valid_condition?(_), do: false

  defp collect_reference_ids(%TacticUse{tactic_definition_id: id}, values), do: [id | values]

  defp collect_reference_ids(%Sequence{children: children}, values) when is_list(children),
    do: Enum.reduce(children, values, &collect_reference_ids/2)

  defp collect_reference_ids(%Parallel{children: children}, values) when is_list(children),
    do: Enum.reduce(children, values, &collect_reference_ids/2)

  defp collect_reference_ids(%Until{} = value, values),
    do: collect_reference_ids(value.otherwise, collect_reference_ids(value.check, values))

  defp collect_reference_ids(_, values), do: values

  defp literal?(value),
    do: is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value)

  defp key?(value), do: is_binary(value) and Regex.match?(@key, value)
  defp slot?(value), do: is_binary(value) and Regex.match?(@slot, value)

  defp non_blank?(value),
    do: is_binary(value) and String.valid?(value) and String.trim(value) != ""

  defp maybe(errors, false, _, _, _), do: errors
  defp maybe(errors, true, code, path, details), do: [error(code, path, details) | errors]
  defp maybe_list(errors, false, _, _, _), do: errors
  defp maybe_list(errors, true, code, path, details), do: errors ++ [error(code, path, details)]
  defp error(code, path, details), do: %ValidationError{code: code, path: path, details: details}
end
