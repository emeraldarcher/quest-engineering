defmodule QuestEngineering.Core.Product.TacticUse do
  @moduledoc "An authoring-only instance of one reusable Tactic Definition."

  @enforce_keys [:instance_key, :tactic_definition_id]
  defstruct [:instance_key, :tactic_definition_id]

  @type t :: %__MODULE__{instance_key: String.t(), tactic_definition_id: String.t()}
end

defmodule QuestEngineering.Core.Product.TacticAuthoring do
  @moduledoc """
  The recursive authoring language accepted by reusable and inline Tactics.

  It reuses the four semantic node values and adds `TacticUse`. A resolved
  semantic Tactic is the strict subset containing no `TacticUse` values.
  """

  alias QuestEngineering.Core.Product.TacticUse
  alias QuestEngineering.Core.Product.ValidationError
  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @key ~r/\A[a-z][a-z0-9-]{0,63}\z/

  @type t ::
          Step.t()
          | %Sequence{children: [t()]}
          | %Parallel{children: [t()]}
          | %Until{check: t(), otherwise: t()}
          | TacticUse.t()

  @spec use(String.t(), String.t()) :: TacticUse.t()
  def use(instance_key, tactic_definition_id) do
    %TacticUse{instance_key: instance_key, tactic_definition_id: tactic_definition_id}
  end

  @doc "Validates one local authoring scope without resolving referenced definitions."
  @spec validate(term(), [String.t() | non_neg_integer()]) :: [ValidationError.t()]
  def validate(body, path \\ ["body"]) do
    {identities, references, errors} = inspect_node(body, path, [], [], [])
    step_keys = identities |> Enum.filter(&(&1.kind == :step)) |> MapSet.new(& &1.key)

    identity_errors(identities) ++
      reference_errors(references, step_keys) ++ errors
  end

  @doc "Returns referenced definition IDs in deterministic authoring traversal order."
  @spec referenced_definition_ids(term()) :: [String.t()]
  def referenced_definition_ids(body) do
    body
    |> collect_reference_ids([])
    |> Enum.reverse()
  end

  defp inspect_node(%Step{} = step, path, identities, references, errors) do
    identities = [%{kind: :step, key: step.key, path: path ++ ["key"]} | identities]
    references = step_references(step, path) ++ references
    {identities, references, errors}
  end

  defp inspect_node(%TacticUse{} = use, path, identities, references, errors) do
    identities =
      [%{kind: :use, key: use.instance_key, path: path ++ ["instance_key"]} | identities]

    errors =
      if opaque_id?(use.tactic_definition_id) do
        errors
      else
        [
          error(:invalid_tactic_definition_reference, path ++ ["tactic_definition_id"], %{
            value: use.tactic_definition_id
          })
          | errors
        ]
      end

    {identities, references, errors}
  end

  defp inspect_node(%Sequence{children: children}, path, identities, references, errors) do
    inspect_children(children, path, :sequence, identities, references, errors)
  end

  defp inspect_node(%Parallel{children: children}, path, identities, references, errors) do
    inspect_children(children, path, :parallel, identities, references, errors)
  end

  defp inspect_node(%Until{} = until, path, identities, references, errors) do
    errors =
      errors
      |> maybe_error(
        not (is_integer(until.max_remediations) and until.max_remediations > 0),
        :invalid_until_limit,
        path ++ ["max_remediations"],
        %{value: until.max_remediations}
      )
      |> maybe_error(
        not condition?(until.condition),
        :invalid_condition,
        path ++ ["condition"],
        %{value: until.condition}
      )

    references = condition_references(until.condition, path ++ ["condition"]) ++ references

    {identities, references, errors} =
      inspect_node(until.check, path ++ ["check"], identities, references, errors)

    inspect_node(
      until.otherwise,
      path ++ ["otherwise"],
      identities,
      references,
      errors
    )
  end

  defp inspect_node(value, path, identities, references, errors) do
    {identities, references,
     [error(:invalid_tactic_body, path, %{reason: :unknown_node, value: value}) | errors]}
  end

  defp inspect_children(children, path, _construct, identities, references, errors)
       when is_list(children) and children != [] do
    children
    |> Enum.with_index()
    |> Enum.reduce({identities, references, errors}, fn {child, index},
                                                        {ids, refs, current_errors} ->
      inspect_node(child, path ++ ["children", index], ids, refs, current_errors)
    end)
  end

  defp inspect_children(children, path, construct, identities, references, errors) do
    {identities, references,
     [
       error(:invalid_tactic_body, path ++ ["children"], %{
         reason: :children_must_be_a_non_empty_list,
         construct: construct,
         value: children
       })
       | errors
     ]}
  end

  defp identity_errors(identities) do
    ordered = Enum.reverse(identities)

    invalid =
      Enum.flat_map(ordered, fn identity ->
        if key?(identity.key) do
          []
        else
          [
            error(:invalid_local_identity, identity.path, %{
              kind: identity.kind,
              value: identity.key
            })
          ]
        end
      end)

    duplicate =
      ordered
      |> Enum.group_by(& &1.key)
      |> Enum.filter(fn {_key, occurrences} -> length(occurrences) > 1 end)
      |> Enum.sort_by(fn {_key, occurrences} -> occurrences |> hd() |> Map.fetch!(:path) end)
      |> Enum.map(fn {key, occurrences} ->
        error(:duplicate_local_identity, hd(occurrences).path, %{
          key: key,
          kinds: Enum.map(occurrences, & &1.kind),
          paths: Enum.map(occurrences, & &1.path)
        })
      end)

    invalid ++ duplicate
  end

  defp reference_errors(references, step_keys) do
    references
    |> Enum.reverse()
    |> Enum.flat_map(fn reference ->
      cond do
        not key?(reference.value) ->
          [
            error(:invalid_local_step_reference, reference.path, %{
              kind: reference.kind,
              value: reference.value
            })
          ]

        not MapSet.member?(step_keys, reference.value) ->
          [
            error(:unknown_local_step_reference, reference.path, %{
              kind: reference.kind,
              step_key: reference.value
            })
          ]

        true ->
          []
      end
    end)
  end

  defp step_references(step, path) do
    performer =
      case step.performer do
        %PerformerRequirement{selector: :same_as, value: value} ->
          [reference(:same_as, value, path ++ ["performer", "value"])]

        _other ->
          []
      end

    context =
      case step.context do
        %ContextRequirement{selector: :continue_from, value: value} ->
          [reference(:continue_from, value, path ++ ["context", "value"])]

        _other ->
          []
      end

    artifacts =
      [:consumes, :produces]
      |> Enum.flat_map(fn direction ->
        case Map.fetch!(step, direction) do
          values when is_list(values) ->
            values
            |> Enum.with_index()
            |> Enum.flat_map(fn
              {%Artifact{source: source}, index} when not is_nil(source) ->
                [
                  reference(
                    :artifact_source,
                    source,
                    path ++ [Atom.to_string(direction), index, "source"]
                  )
                ]

              {_artifact, _index} ->
                []
            end)

          _invalid ->
            []
        end
      end)

    performer ++ context ++ artifacts
  end

  defp condition_references(%Condition{artifact: %Artifact{source: source}}, path)
       when not is_nil(source) do
    [reference(:condition_source, source, path ++ ["artifact", "source"])]
  end

  defp condition_references(_condition, _path), do: []

  defp reference(kind, value, path), do: %{kind: kind, value: value, path: path}

  defp collect_reference_ids(%TacticUse{tactic_definition_id: id}, values), do: [id | values]

  defp collect_reference_ids(%Sequence{children: children}, values) when is_list(children),
    do: Enum.reduce(children, values, &collect_reference_ids/2)

  defp collect_reference_ids(%Parallel{children: children}, values) when is_list(children),
    do: Enum.reduce(children, values, &collect_reference_ids/2)

  defp collect_reference_ids(%Until{} = until, values) do
    values = collect_reference_ids(until.check, values)
    collect_reference_ids(until.otherwise, values)
  end

  defp collect_reference_ids(_node, values), do: values

  defp condition?(%Condition{
         artifact: %Artifact{type: type, source: source},
         field: field,
         operator: :equals,
         value: value
       }) do
    non_blank?(type) and (is_nil(source) or is_binary(source)) and non_blank?(field) and
      literal?(value)
  end

  defp condition?(_condition), do: false

  defp literal?(value),
    do:
      is_binary(value) or is_integer(value) or is_float(value) or is_boolean(value) or
        is_nil(value)

  defp key?(value), do: is_binary(value) and Regex.match?(@key, value)
  defp opaque_id?(value), do: non_blank?(value)

  defp non_blank?(value),
    do: is_binary(value) and String.valid?(value) and String.trim(value) != ""

  defp maybe_error(errors, false, _code, _path, _details), do: errors
  defp maybe_error(errors, true, code, path, details), do: [error(code, path, details) | errors]

  defp error(code, path, details),
    do: %ValidationError{code: code, path: path, details: details}
end
