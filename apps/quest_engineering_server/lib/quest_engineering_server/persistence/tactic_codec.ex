defmodule QuestEngineering.Server.Persistence.TacticCodec do
  @moduledoc "Strict JSON codec for named artifact slots, exact refs, semantic interfaces, and trees."

  alias QuestEngineering.Core.Product.{
    AcceptedArtifactSource,
    ResolvedTacticUse,
    TacticInputBinding,
    TacticInputPort,
    TacticInterface,
    TacticOutputPort,
    TacticUse
  }

  alias QuestEngineering.Core.Tactics.{
    ArtifactInput,
    ArtifactOutput,
    ArtifactRef,
    Condition,
    ContextRequirement,
    Parallel,
    PerformerRequirement,
    ReviewContract,
    Sequence,
    Step,
    Until
  }

  defmodule Error do
    @moduledoc false
    @enforce_keys [:path, :reason]
    defstruct [:path, :reason, :value]
  end

  def encode(%Step{} = step),
    do: %{
      "type" => "step",
      "key" => step.key,
      "name" => step.name,
      "instruction" => step.instruction,
      "performer" => encode_requirement(step.performer),
      "context" => encode_requirement(step.context),
      "consumes" => Enum.map(step.consumes, &encode_input/1),
      "produces" => Enum.map(step.produces, &encode_output/1)
    }

  def encode(%Sequence{children: children}),
    do: %{"type" => "sequence", "children" => Enum.map(children, &encode/1)}

  def encode(%Parallel{children: children}),
    do: %{"type" => "parallel", "children" => Enum.map(children, &encode/1)}

  def encode(%Until{} = value),
    do: %{
      "type" => "until",
      "check" => encode(value.check),
      "condition" => encode_condition(value.condition),
      "otherwise" => encode(value.otherwise),
      "max_remediations" => value.max_remediations
    }

  def encode(%TacticUse{} = use),
    do: %{
      "type" => "use",
      "instance_key" => use.instance_key,
      "tactic_definition_id" => use.tactic_definition_id,
      "input_bindings" => Enum.map(use.input_bindings, &encode_input_binding/1)
    }

  def encode(%ResolvedTacticUse{} = use),
    do: %{
      "type" => "use",
      "instance_key" => use.instance_key,
      "tactic_definition_id" => use.tactic_definition_id,
      "input_bindings" => Enum.map(use.input_bindings, &encode_input_binding/1),
      "resolved_body" => encode(use.body),
      "interface" =>
        encode_interface(%TacticInterface{inputs: use.input_ports, outputs: use.output_ports})
    }

  def encode_interface(%TacticInterface{} = interface),
    do: %{
      "inputs" => Enum.map(interface.inputs, &encode_port/1),
      "outputs" => Enum.map(interface.outputs, &encode_port/1)
    }

  def decode(value), do: decode_tactic(value, [])
  def decode_interface(value), do: decode_interface(value, [])

  defp decode_tactic(%{"type" => "step"} = value, path) do
    with {:ok, key} <- string(value, "key", path),
         {:ok, name} <- string(value, "name", path),
         {:ok, instruction} <- string(value, "instruction", path),
         {:ok, performer} <- decode_performer(value["performer"], path ++ ["performer"]),
         {:ok, context} <- decode_context(value["context"], path ++ ["context"]),
         {:ok, consumes} <- decode_list(value["consumes"], path ++ ["consumes"], &decode_input/2),
         {:ok, produces} <- decode_list(value["produces"], path ++ ["produces"], &decode_output/2) do
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
       when type in ["sequence", "parallel"] do
    with {:ok, decoded} <- decode_list(children, path ++ ["children"], &decode_tactic/2),
         do:
           {:ok,
            if(type == "sequence",
              do: %Sequence{children: decoded},
              else: %Parallel{children: decoded}
            )}
  end

  defp decode_tactic(%{"type" => "until"} = value, path) do
    with {:ok, check} <- decode_tactic(value["check"], path ++ ["check"]),
         {:ok, condition} <- decode_condition(value["condition"], path ++ ["condition"]),
         {:ok, otherwise} <- decode_tactic(value["otherwise"], path ++ ["otherwise"]),
         {:ok, maximum} <- positive(value["max_remediations"], path ++ ["max_remediations"]) do
      {:ok,
       %Until{check: check, condition: condition, otherwise: otherwise, max_remediations: maximum}}
    end
  end

  defp decode_tactic(%{"type" => "use"} = value, path) do
    with {:ok, key} <- string(value, "instance_key", path),
         {:ok, id} <- string(value, "tactic_definition_id", path),
         {:ok, bindings} <-
           decode_list(
             Map.get(value, "input_bindings", []),
             path ++ ["input_bindings"],
             &decode_input_binding/2
           ) do
      {:ok, %TacticUse{instance_key: key, tactic_definition_id: id, input_bindings: bindings}}
    end
  end

  defp decode_tactic(value, path), do: invalid(path, :unknown_tactic, value)

  defp encode_ref(%ArtifactRef{} = ref), do: %{"producer" => ref.producer, "output" => ref.output}

  defp decode_ref(%{"producer" => producer, "output" => output}, _path)
       when is_binary(producer) and is_binary(output),
       do: {:ok, %ArtifactRef{producer: producer, output: output}}

  defp decode_ref(value, path), do: invalid(path, :invalid_artifact_ref, value)

  defp encode_input(%ArtifactInput{} = input),
    do: %{
      "name" => input.name,
      "kind" => input.kind,
      "source" => input.source && encode_ref(input.source),
      "required" => input.required
    }

  defp decode_input(%{"name" => name, "kind" => kind} = value, path)
       when is_binary(name) and is_binary(kind) do
    with {:ok, source} <- optional_ref(Map.get(value, "source"), path ++ ["source"]),
         required = Map.get(value, "required", true),
         true <- is_boolean(required) do
      {:ok, %ArtifactInput{name: name, kind: kind, source: source, required: required}}
    else
      false -> invalid(path ++ ["required"], :expected_boolean, value["required"])
      {:error, _} = error -> error
    end
  end

  defp decode_input(value, path), do: invalid(path, :invalid_artifact_input, value)

  defp encode_output(%ArtifactOutput{} = output),
    do: %{"name" => output.name, "kind" => output.kind, "review" => encode_review(output.review)}

  defp decode_output(%{"name" => name, "kind" => kind} = value, path)
       when is_binary(name) and is_binary(kind) do
    with {:ok, review} <- decode_review(Map.get(value, "review"), path ++ ["review"]),
         do: {:ok, %ArtifactOutput{name: name, kind: kind, review: review}}
  end

  defp decode_output(value, path), do: invalid(path, :invalid_artifact_output, value)
  defp encode_review(nil), do: nil

  defp encode_review(%ReviewContract{} = value),
    do: %{"gate_key" => value.gate_key, "subject_input" => value.subject_input}

  defp decode_review(nil, _path), do: {:ok, nil}

  defp decode_review(%{"gate_key" => gate, "subject_input" => input}, _path)
       when is_binary(gate) and is_binary(input),
       do: {:ok, %ReviewContract{gate_key: gate, subject_input: input}}

  defp decode_review(value, path), do: invalid(path, :invalid_review_contract, value)

  defp encode_condition(%Condition{} = value),
    do: %{
      "source" => encode_ref(value.source),
      "field" => value.field,
      "operator" => "equals",
      "value" => value.value
    }

  defp decode_condition(
         %{"source" => source, "field" => field, "operator" => "equals", "value" => value},
         path
       )
       when is_binary(field) and
              (is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value)) do
    with {:ok, source} <- decode_ref(source, path ++ ["source"]),
         do: {:ok, %Condition{source: source, field: field, operator: :equals, value: value}}
  end

  defp decode_condition(value, path), do: invalid(path, :invalid_condition, value)

  defp encode_input_binding(%TacticInputBinding{} = value),
    do: %{"input" => value.input, "source" => encode_ref(value.source)}

  defp decode_input_binding(%{"input" => input, "source" => source}, path)
       when is_binary(input) do
    with {:ok, source} <- decode_ref(source, path ++ ["source"]),
         do: {:ok, %TacticInputBinding{input: input, source: source}}
  end

  defp decode_input_binding(value, path), do: invalid(path, :invalid_tactic_input_binding, value)

  defp encode_port(%TacticInputPort{} = value),
    do: %{
      "key" => value.key,
      "label" => value.label,
      "kind" => value.kind,
      "required" => value.required
    }

  defp encode_port(%TacticOutputPort{} = value),
    do: %{
      "key" => value.key,
      "label" => value.label,
      "kind" => value.kind,
      "source" => encode_port_source(value.source)
    }

  defp encode_port_source(%ArtifactRef{} = value),
    do: %{"type" => "binding", "binding" => encode_ref(value)}

  defp encode_port_source(%AcceptedArtifactSource{} = value),
    do: %{"type" => "accepted_subject", "gate_key" => value.gate_key}

  defp decode_interface(%{"inputs" => inputs, "outputs" => outputs}, path) do
    with {:ok, inputs} <- decode_list(inputs, path ++ ["inputs"], &decode_input_port/2),
         {:ok, outputs} <- decode_list(outputs, path ++ ["outputs"], &decode_output_port/2),
         do: {:ok, %TacticInterface{inputs: inputs, outputs: outputs}}
  end

  defp decode_interface(value, path), do: invalid(path, :invalid_tactic_interface, value)

  defp decode_input_port(
         %{"key" => key, "label" => label, "kind" => kind, "required" => required},
         _path
       )
       when is_binary(key) and is_binary(label) and is_binary(kind) and is_boolean(required),
       do: {:ok, %TacticInputPort{key: key, label: label, kind: kind, required: required}}

  defp decode_input_port(value, path), do: invalid(path, :invalid_tactic_input_port, value)

  defp decode_output_port(
         %{"key" => key, "label" => label, "kind" => kind, "source" => source},
         path
       )
       when is_binary(key) and is_binary(label) and is_binary(kind) do
    with {:ok, source} <- decode_port_source(source, path ++ ["source"]),
         do: {:ok, %TacticOutputPort{key: key, label: label, kind: kind, source: source}}
  end

  defp decode_output_port(value, path), do: invalid(path, :invalid_tactic_output_port, value)

  defp decode_port_source(%{"type" => "binding", "binding" => value}, path),
    do: decode_ref(value, path ++ ["binding"])

  defp decode_port_source(%{"type" => "accepted_subject", "gate_key" => gate}, _path)
       when is_binary(gate), do: {:ok, %AcceptedArtifactSource{gate_key: gate}}

  defp decode_port_source(value, path), do: invalid(path, :invalid_tactic_output_source, value)

  defp encode_requirement(%{selector: selector, value: value}),
    do: %{"selector" => Atom.to_string(selector), "value" => value}

  defp decode_performer(%{"selector" => "class", "value" => value}, _path) when is_binary(value),
    do: {:ok, %PerformerRequirement{selector: :class, value: value}}

  defp decode_performer(%{"selector" => "same_as", "value" => value}, _path)
       when is_binary(value), do: {:ok, %PerformerRequirement{selector: :same_as, value: value}}

  defp decode_performer(value, path), do: invalid(path, :invalid_performer_requirement, value)

  defp decode_context(%{"selector" => "fresh", "value" => nil}, _path),
    do: {:ok, %ContextRequirement{selector: :fresh, value: nil}}

  defp decode_context(%{"selector" => "continue_from", "value" => value}, _path)
       when is_binary(value),
       do: {:ok, %ContextRequirement{selector: :continue_from, value: value}}

  defp decode_context(value, path), do: invalid(path, :invalid_context_requirement, value)

  defp optional_ref(nil, _path), do: {:ok, nil}
  defp optional_ref(value, path), do: decode_ref(value, path)

  defp decode_list(values, path, fun) when is_list(values) do
    values
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {value, i}, {:ok, acc} ->
      case fun.(value, path ++ [i]) do
        {:ok, item} -> {:cont, {:ok, [item | acc]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
    |> reverse_ok()
  end

  defp decode_list(value, path, _fun), do: invalid(path, :expected_list, value)

  defp string(value, key, path) do
    case value[key] do
      item when is_binary(item) -> {:ok, item}
      item -> invalid(path ++ [key], :expected_string, item)
    end
  end

  defp positive(value, _path) when is_integer(value) and value > 0, do: {:ok, value}
  defp positive(value, path), do: invalid(path, :expected_positive_integer, value)
  defp reverse_ok({:ok, values}), do: {:ok, Enum.reverse(values)}
  defp reverse_ok(error), do: error

  defp invalid(path, reason, value),
    do: {:error, %Error{path: path, reason: reason, value: value}}
end
