defmodule QuestEngineering.Server.Persistence.TacticCodec do
  @moduledoc "Explicit JSON-safe codec for semantic nodes and authoring-only Tactic Uses."

  alias QuestEngineering.Core.Product.TacticUse
  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  defmodule Error do
    @moduledoc false
    @enforce_keys [:path, :reason]
    defstruct [:path, :reason, :value]

    @type t :: %__MODULE__{
            path: [String.t() | non_neg_integer()],
            reason: atom(),
            value: term()
          }
  end

  @spec encode(QuestEngineering.Core.Product.TacticAuthoring.t()) :: map()
  def encode(%Step{} = step) do
    %{
      "type" => "step",
      "key" => step.key,
      "name" => step.name,
      "instruction" => step.instruction,
      "performer" => encode_requirement(step.performer),
      "context" => encode_requirement(step.context),
      "consumes" => Enum.map(step.consumes, &encode_artifact/1),
      "produces" => Enum.map(step.produces, &encode_artifact/1)
    }
  end

  def encode(%Sequence{children: children}) do
    %{"type" => "sequence", "children" => Enum.map(children, &encode/1)}
  end

  def encode(%Parallel{children: children}) do
    %{"type" => "parallel", "children" => Enum.map(children, &encode/1)}
  end

  def encode(%Until{} = until) do
    %{
      "type" => "until",
      "check" => encode(until.check),
      "condition" => encode_condition(until.condition),
      "otherwise" => encode(until.otherwise),
      "max_remediations" => until.max_remediations
    }
  end

  def encode(%TacticUse{} = use) do
    %{
      "type" => "use",
      "instance_key" => use.instance_key,
      "tactic_definition_id" => use.tactic_definition_id
    }
  end

  @spec decode(term()) ::
          {:ok, QuestEngineering.Core.Product.TacticAuthoring.t()} | {:error, Error.t()}
  def decode(value), do: decode_tactic(value, [])

  defp decode_tactic(%{"type" => "step"} = value, path) do
    with {:ok, key} <- string(value, "key", path),
         {:ok, name} <- string(value, "name", path),
         {:ok, instruction} <- string(value, "instruction", path),
         {:ok, performer} <- decode_performer(value["performer"], path ++ ["performer"]),
         {:ok, context} <- decode_context(value["context"], path ++ ["context"]),
         {:ok, consumes} <- decode_artifacts(value["consumes"], path ++ ["consumes"]),
         {:ok, produces} <- decode_artifacts(value["produces"], path ++ ["produces"]) do
      {:ok,
       %Step{
         key: key,
         name: name,
         instruction: instruction,
         performer: performer,
         context: context,
         consumes: consumes,
         produces: produces
       }}
    end
  end

  defp decode_tactic(%{"type" => type, "children" => children}, path)
       when type in ["sequence", "parallel"] and is_list(children) do
    with {:ok, decoded} <- decode_tactics(children, path ++ ["children"]) do
      case type do
        "sequence" -> {:ok, %Sequence{children: decoded}}
        "parallel" -> {:ok, %Parallel{children: decoded}}
      end
    end
  end

  defp decode_tactic(%{"type" => "use"} = value, path) do
    with {:ok, instance_key} <- string(value, "instance_key", path),
         {:ok, definition_id} <- string(value, "tactic_definition_id", path) do
      {:ok,
       %TacticUse{
         instance_key: instance_key,
         tactic_definition_id: definition_id
       }}
    end
  end

  defp decode_tactic(%{"type" => "until"} = value, path) do
    with {:ok, check} <- decode_tactic(value["check"], path ++ ["check"]),
         {:ok, condition} <- decode_condition(value["condition"], path ++ ["condition"]),
         {:ok, otherwise} <- decode_tactic(value["otherwise"], path ++ ["otherwise"]),
         {:ok, maximum} <-
           positive_integer(value["max_remediations"], path ++ ["max_remediations"]) do
      {:ok,
       %Until{
         check: check,
         condition: condition,
         otherwise: otherwise,
         max_remediations: maximum
       }}
    end
  end

  defp decode_tactic(value, path), do: invalid(path, :unknown_tactic, value)

  defp decode_tactics(values, path) do
    values
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {value, index}, {:ok, decoded} ->
      case decode_tactic(value, path ++ [index]) do
        {:ok, tactic} -> {:cont, {:ok, [tactic | decoded]}}
        {:error, _error} = error -> {:halt, error}
      end
    end)
    |> reverse_ok()
  end

  defp decode_artifacts(values, path) when is_list(values) do
    values
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {value, index}, {:ok, decoded} ->
      case decode_artifact(value, path ++ [index]) do
        {:ok, artifact} -> {:cont, {:ok, [artifact | decoded]}}
        {:error, _error} = error -> {:halt, error}
      end
    end)
    |> reverse_ok()
  end

  defp decode_artifacts(value, path), do: invalid(path, :expected_list, value)

  defp encode_artifact(%Artifact{} = artifact) do
    %{"type" => artifact.type, "source" => artifact.source}
  end

  defp decode_artifact(%{"type" => type, "source" => source}, _path)
       when is_binary(type) and (is_binary(source) or is_nil(source)) do
    {:ok, %Artifact{type: type, source: source}}
  end

  defp decode_artifact(value, path), do: invalid(path, :invalid_artifact, value)

  defp encode_requirement(%{selector: selector, value: value}) do
    %{"selector" => Atom.to_string(selector), "value" => value}
  end

  defp decode_performer(%{"selector" => "class", "value" => value}, _path)
       when is_binary(value) do
    {:ok, %PerformerRequirement{selector: :class, value: value}}
  end

  defp decode_performer(%{"selector" => "same_as", "value" => value}, _path)
       when is_binary(value) do
    {:ok, %PerformerRequirement{selector: :same_as, value: value}}
  end

  defp decode_performer(value, path), do: invalid(path, :invalid_performer_requirement, value)

  defp decode_context(%{"selector" => "fresh", "value" => nil}, _path) do
    {:ok, %ContextRequirement{selector: :fresh, value: nil}}
  end

  defp decode_context(%{"selector" => "continue_from", "value" => value}, _path)
       when is_binary(value) do
    {:ok, %ContextRequirement{selector: :continue_from, value: value}}
  end

  defp decode_context(value, path), do: invalid(path, :invalid_context_requirement, value)

  defp encode_condition(%Condition{} = condition) do
    %{
      "artifact" => encode_artifact(condition.artifact),
      "field" => condition.field,
      "operator" => Atom.to_string(condition.operator),
      "value" => condition.value
    }
  end

  defp decode_condition(
         %{"artifact" => artifact, "field" => field, "operator" => "equals", "value" => value},
         path
       )
       when is_binary(field) and
              (is_binary(value) or is_integer(value) or is_float(value) or is_boolean(value) or
                 is_nil(value)) do
    with {:ok, decoded_artifact} <- decode_artifact(artifact, path ++ ["artifact"]) do
      {:ok,
       %Condition{
         artifact: decoded_artifact,
         field: field,
         operator: :equals,
         value: value
       }}
    end
  end

  defp decode_condition(value, path), do: invalid(path, :invalid_condition, value)

  defp string(value, key, path) do
    case value[key] do
      item when is_binary(item) -> {:ok, item}
      invalid_value -> invalid(path ++ [key], :expected_string, invalid_value)
    end
  end

  defp positive_integer(value, _path) when is_integer(value) and value > 0, do: {:ok, value}
  defp positive_integer(value, path), do: invalid(path, :expected_positive_integer, value)

  defp reverse_ok({:ok, values}), do: {:ok, Enum.reverse(values)}
  defp reverse_ok({:error, _error} = error), do: error

  defp invalid(path, reason, value),
    do: {:error, %Error{path: path, reason: reason, value: value}}
end
