defmodule QuestEngineering.Core.Product.ValidationError do
  @moduledoc "A structured, presentation-independent product-domain validation error."

  @enforce_keys [:code, :path, :details]
  defstruct [:code, :path, :details]

  @type t :: %__MODULE__{code: atom(), path: [String.t() | non_neg_integer()], details: map()}
end

defmodule QuestEngineering.Core.Product.Validation do
  @moduledoc "Pure validation for product definitions and their references."

  alias QuestEngineering.Core.Product.Class
  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.Member
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.Quest
  alias QuestEngineering.Core.Product.Squad
  alias QuestEngineering.Core.Product.TacticAuthoring
  alias QuestEngineering.Core.Product.TacticDefinition
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Core.Product.ValidationError

  @key ~r/\A[a-z][a-z0-9-]{0,63}\z/
  @capability_key ~r/\A[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\z/
  @provider_key ~r/\A[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\z/

  @type result(value) :: {:ok, value} | {:error, [ValidationError.t()]}

  @spec validate(
          Class.t()
          | Loadout.t()
          | Member.t()
          | Squad.t()
          | Quest.t()
          | TacticDefinition.t()
        ) ::
          result(
            Class.t()
            | Loadout.t()
            | Member.t()
            | Squad.t()
            | Quest.t()
            | TacticDefinition.t()
          )
  def validate(%Class{} = value), do: finish(value, class_errors(value))
  def validate(%Loadout{} = value), do: finish(value, loadout_errors(value))
  def validate(%Member{} = value), do: finish(value, member_errors(value, []))
  def validate(%Squad{} = value), do: finish(value, squad_errors(value))
  def validate(%Quest{} = value), do: finish(value, quest_errors(value))

  def validate(%TacticDefinition{} = value),
    do: finish(value, tactic_definition_errors(value))

  @doc "Validates a Squad and resolves every Member reference against supplied definitions."
  @spec validate_roster(Squad.t(), [Class.t()], [Loadout.t()]) :: result(Squad.t())
  def validate_roster(%Squad{} = squad, classes, loadouts)
      when is_list(classes) and is_list(loadouts) do
    class_by_id = index_by_id(classes)
    loadout_by_id = index_by_id(loadouts)

    reference_errors =
      squad.members
      |> Enum.with_index()
      |> Enum.flat_map(fn
        {%Member{} = member, index} ->
          path = ["members", index]

          missing_reference_errors(member, class_by_id, loadout_by_id, path)

        {_invalid, index} ->
          [error(:invalid_member, ["members", index], %{reason: :not_a_member})]
      end)

    definition_errors =
      Enum.flat_map(classes, &errors_for/1) ++
        Enum.flat_map(loadouts, &errors_for/1) ++ duplicate_definition_errors(classes, loadouts)

    finish(squad, squad_errors(squad) ++ definition_errors ++ reference_errors)
  end

  defp class_errors(value) do
    []
    |> require(opaque_id?(value.id), :invalid_id, ["id"], %{value: value.id})
    |> require(key?(value.key), :invalid_key, ["key"], %{value: value.key})
    |> require(non_blank?(value.name), :invalid_name, ["name"], %{})
    |> require(text?(value.description), :invalid_description, ["description"], %{})
    |> require(non_blank?(value.instructions), :invalid_instructions, ["instructions"], %{})
  end

  defp loadout_errors(value) do
    errors =
      []
      |> require(opaque_id?(value.id), :invalid_id, ["id"], %{value: value.id})
      |> require(key?(value.key), :invalid_key, ["key"], %{value: value.key})
      |> require(non_blank?(value.name), :invalid_name, ["name"], %{})
      |> require(text?(value.description), :invalid_description, ["description"], %{})
      |> require(model_ref?(value.model), :invalid_model_ref, ["model"], %{})
      |> require(value.reasoning in [:low, :medium, :high], :invalid_reasoning, ["reasoning"], %{
        value: value.reasoning
      })
      |> require(is_list(value.tools), :invalid_tools, ["tools"], %{reason: :not_a_list})
      |> require(
        value.workspace_access in [:none, :read_only, :read_write],
        :invalid_workspace_access,
        ["workspace_access"],
        %{value: value.workspace_access}
      )

    errors ++ tool_errors(value.tools)
  end

  defp tool_errors(tools) when is_list(tools) do
    invalid =
      tools
      |> Enum.with_index()
      |> Enum.flat_map(&tool_key_errors/1)

    duplicate =
      if Enum.uniq(tools) == tools,
        do: [],
        else: [error(:duplicate_tool_key, ["tools"], %{})]

    invalid ++ duplicate
  end

  defp tool_errors(_invalid), do: []

  defp tool_key_errors({tool, index}) do
    if capability_key?(tool),
      do: [],
      else: [error(:invalid_tool_key, ["tools", index], %{value: tool})]
  end

  defp member_errors(value, path) do
    []
    |> require(key?(value.key), :invalid_key, path ++ ["key"], %{value: value.key})
    |> require(non_blank?(value.name), :invalid_name, path ++ ["name"], %{})
    |> require(opaque_id?(value.class_id), :invalid_class_reference, path ++ ["class_id"], %{})
    |> require(
      opaque_id?(value.loadout_id),
      :invalid_loadout_reference,
      path ++ ["loadout_id"],
      %{}
    )
  end

  defp squad_errors(value) do
    errors =
      []
      |> require(opaque_id?(value.id), :invalid_id, ["id"], %{value: value.id})
      |> require(key?(value.key), :invalid_key, ["key"], %{value: value.key})
      |> require(non_blank?(value.name), :invalid_name, ["name"], %{})
      |> require(text?(value.description), :invalid_description, ["description"], %{})
      |> require(is_list(value.members), :invalid_members, ["members"], %{reason: :not_a_list})
      |> require(is_list(value.members) and value.members != [], :empty_squad, ["members"], %{})

    if is_list(value.members) do
      member_errors =
        value.members
        |> Enum.with_index()
        |> Enum.flat_map(fn
          {%Member{} = member, index} ->
            member_errors(member, ["members", index])

          {_invalid, index} ->
            [error(:invalid_member, ["members", index], %{reason: :not_a_member})]
        end)

      keys =
        Enum.flat_map(value.members, fn
          %Member{key: key} -> [key]
          _invalid -> []
        end)

      duplicate_errors =
        if Enum.uniq(keys) == keys,
          do: [],
          else: [error(:duplicate_member_key, ["members"], %{})]

      errors ++ member_errors ++ duplicate_errors
    else
      errors
    end
  end

  defp quest_errors(value) do
    []
    |> require(opaque_id?(value.id), :invalid_id, ["id"], %{value: value.id})
    |> require(non_blank?(value.title), :invalid_title, ["title"], %{})
    |> require(non_blank?(value.objective), :invalid_objective, ["objective"], %{})
    |> require(
      non_blank?(value.workspace_ref),
      :invalid_workspace_reference,
      ["workspace_ref"],
      %{}
    )
    |> require(opaque_id?(value.squad_id), :invalid_squad_reference, ["squad_id"], %{})
    |> then(&(&1 ++ tactic_source_errors(value.tactic_source)))
  end

  defp tactic_definition_errors(value) do
    []
    |> require(opaque_id?(value.id), :invalid_id, ["id"], %{value: value.id})
    |> require(key?(value.key), :invalid_key, ["key"], %{value: value.key})
    |> require(non_blank?(value.name), :invalid_name, ["name"], %{})
    |> require(text?(value.description), :invalid_description, ["description"], %{})
    |> then(&(&1 ++ TacticAuthoring.validate(value.body, ["body"])))
  end

  defp tactic_source_errors(%Inline{body: body}),
    do: TacticAuthoring.validate(body, ["tactic_source", "body"])

  defp tactic_source_errors(%Definition{tactic_definition_id: id}) do
    if opaque_id?(id) do
      []
    else
      [
        error(:invalid_tactic_definition_reference, ["tactic_source", "tactic_definition_id"], %{
          value: id
        })
      ]
    end
  end

  defp tactic_source_errors(value),
    do: [error(:invalid_tactic_source, ["tactic_source"], %{value: value})]

  defp missing_reference_errors(member, class_by_id, loadout_by_id, path) do
    class_errors =
      if Map.has_key?(class_by_id, member.class_id),
        do: [],
        else: [error(:class_not_found, path ++ ["class_id"], %{id: member.class_id})]

    loadout_errors =
      if Map.has_key?(loadout_by_id, member.loadout_id),
        do: [],
        else: [error(:loadout_not_found, path ++ ["loadout_id"], %{id: member.loadout_id})]

    class_errors ++ loadout_errors
  end

  defp duplicate_definition_errors(classes, loadouts) do
    duplicate_errors(classes, :duplicate_class_id, :duplicate_class_key) ++
      duplicate_errors(loadouts, :duplicate_loadout_id, :duplicate_loadout_key)
  end

  defp duplicate_errors(values, id_code, key_code) do
    ids = Enum.map(values, &Map.get(&1, :id))
    keys = Enum.map(values, &Map.get(&1, :key))

    []
    |> maybe_duplicate(ids, id_code, ["definitions"])
    |> maybe_duplicate(keys, key_code, ["definitions"])
  end

  defp maybe_duplicate(errors, values, code, path) do
    if Enum.uniq(values) == values, do: errors, else: errors ++ [error(code, path, %{})]
  end

  defp errors_for(value) do
    case validate(value) do
      {:ok, _valid} -> []
      {:error, errors} -> errors
    end
  end

  defp index_by_id(values) do
    Map.new(values, fn value -> {Map.get(value, :id), value} end)
  end

  defp model_ref?(%ModelRef{provider: provider, model: model}) do
    provider_key?(provider) and non_blank?(model)
  end

  defp model_ref?(_value), do: false

  defp opaque_id?(value), do: non_blank?(value)
  defp key?(value), do: is_binary(value) and Regex.match?(@key, value)

  defp capability_key?(value),
    do: is_binary(value) and byte_size(value) <= 128 and Regex.match?(@capability_key, value)

  defp provider_key?(value),
    do: is_binary(value) and byte_size(value) <= 128 and Regex.match?(@provider_key, value)

  defp non_blank?(value),
    do: text?(value) and String.trim(value) != ""

  defp text?(value),
    do: is_binary(value) and String.valid?(value) and not String.contains?(value, <<0>>)

  defp require(errors, true, _code, _path, _details), do: errors
  defp require(errors, false, code, path, details), do: errors ++ [error(code, path, details)]

  defp error(code, path, details), do: %ValidationError{code: code, path: path, details: details}

  defp finish(value, []), do: {:ok, value}
  defp finish(_value, errors), do: {:error, errors}
end
