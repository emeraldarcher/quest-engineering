defmodule QuestEngineering.Server.Product.TacticGraphLoader do
  @moduledoc "Loads a consistent reachable Product Tactic graph for the pure Core resolver."

  import Ecto.Query

  alias QuestEngineering.Core.Product.TacticAuthoring
  alias QuestEngineering.Core.Product.TacticDefinition
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Repo

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]

    @type t :: %__MODULE__{code: atom(), details: map()}
  end

  @spec load(term(), %{optional(String.t()) => TacticDefinition.t()}) ::
          {:ok, Catalog.t()} | {:error, Error.t()}
  def load(source, overrides \\ %{}) when is_map(overrides) do
    state = %{
      definitions: %{},
      archived_ids: MapSet.new(),
      processed_ids: MapSet.new()
    }

    load_frontier(source_ids(source), state, overrides)
  end

  defp load_frontier(ids, state, overrides) do
    ids =
      ids
      |> Enum.filter(&is_binary/1)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(state.processed_ids, &1))
      |> Enum.sort()

    case ids do
      [] ->
        {:ok, %Catalog{definitions: state.definitions, archived_ids: state.archived_ids}}

      ids ->
        rows =
          Repo.all(
            from tactic in ProductTactic,
              where: tactic.id in ^ids,
              lock: "FOR SHARE"
          )

        rows_by_id = Map.new(rows, &{&1.id, &1})

        case decode_frontier(ids, rows_by_id, overrides, state) do
          {:ok, next_ids, next_state} -> load_frontier(next_ids, next_state, overrides)
          {:error, _error} = error -> error
        end
    end
  end

  defp decode_frontier(ids, rows_by_id, overrides, state) do
    Enum.reduce_while(ids, {:ok, [], state}, fn id, {:ok, next_ids, current} ->
      current = %{current | processed_ids: MapSet.put(current.processed_ids, id)}

      case Map.fetch(overrides, id) do
        {:ok, definition} ->
          current = put_definition(current, definition, false)
          references = TacticAuthoring.referenced_definition_ids(definition.body)
          {:cont, {:ok, next_ids ++ references, current}}

        :error ->
          decode_row(Map.get(rows_by_id, id), next_ids, current)
      end
    end)
  end

  defp decode_row(nil, next_ids, state), do: {:cont, {:ok, next_ids, state}}

  defp decode_row(row, next_ids, state) do
    case definition_from_row(row) do
      {:ok, definition} ->
        archived? = not is_nil(row.archived_at)
        state = put_definition(state, definition, archived?)

        references =
          if archived?,
            do: [],
            else: TacticAuthoring.referenced_definition_ids(definition.body)

        {:cont, {:ok, next_ids ++ references, state}}

      {:error, error} ->
        {:halt, {:error, error}}
    end
  end

  @spec definition_from_row(term()) :: {:ok, TacticDefinition.t()} | {:error, Error.t()}
  def definition_from_row(row) do
    case TacticCodec.decode(row.body) do
      {:ok, body} ->
        {:ok,
         %TacticDefinition{
           id: row.id,
           key: row.key,
           name: row.name,
           description: row.description,
           body: body
         }}

      {:error, codec_error} ->
        {:error,
         %Error{
           code: :invalid_persisted_tactic_definition,
           details: %{definition_id: row.id, codec_error: codec_error}
         }}
    end
  end

  defp put_definition(state, definition, archived?) do
    archived_ids =
      if archived?,
        do: MapSet.put(state.archived_ids, definition.id),
        else: state.archived_ids

    %{
      state
      | definitions: Map.put(state.definitions, definition.id, definition),
        archived_ids: archived_ids
    }
  end

  defp source_ids(%Definition{tactic_definition_id: id}), do: [id]
  defp source_ids(%Inline{body: body}), do: TacticAuthoring.referenced_definition_ids(body)
  defp source_ids(_source), do: []
end
