defmodule QuestEngineering.Server.Product.Repository do
  @moduledoc """
  Ecto persistence adapter for dependency-free Core product definitions.

  Mutable rows are returned as Core structs. Keys are immutable, archival is
  non-destructive, and `preview_launch_snapshot/2` builds a pure snapshot without
  creating a Runtime Run, outbox Action, or persisted Quest launch.
  """

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.Class
  alias QuestEngineering.Core.Product.LaunchSnapshot.Builder
  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.Member
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.Quest
  alias QuestEngineering.Core.Product.Squad
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Product.ValidationError
  alias QuestEngineering.Server.Persistence.ProductClass
  alias QuestEngineering.Server.Persistence.ProductLoadout
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.ProductSquad
  alias QuestEngineering.Server.Persistence.ProductSquadMember
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.TacticGraphLoader
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo

  defmodule Error do
    @moduledoc "A structured repository-resolution error independent of Ecto messages."
    @enforce_keys [:code, :details]
    defstruct [:code, :details]

    @type t :: %__MODULE__{code: atom(), details: map()}
  end

  @type persistence_result(value) ::
          {:ok, value} | {:error, [ValidationError.t()] | Changeset.t() | Error.t()}

  @spec create_class(map()) :: persistence_result(Class.t())
  def create_class(attributes) when is_map(attributes) do
    value = %Class{
      id: Ecto.UUID.generate(),
      key: attributes[:key],
      name: attributes[:name],
      description: Map.get(attributes, :description, ""),
      instructions: attributes[:instructions]
    }

    with {:ok, value} <- Validation.validate(value),
         {:ok, row} <- Repo.insert(ProductClass.create_changeset(Map.from_struct(value))) do
      {:ok, class_from_row(row)}
    end
  end

  @spec update_class(String.t(), map()) :: persistence_result(Class.t())
  def update_class(id, attributes) when is_map(attributes) do
    with {:ok, row} <- active_row(ProductClass, id, :class),
         :ok <- immutable_key(row.key, attributes),
         value <- %Class{
           id: row.id,
           key: row.key,
           name: Map.get(attributes, :name, row.name),
           description: Map.get(attributes, :description, row.description),
           instructions: Map.get(attributes, :instructions, row.instructions)
         },
         {:ok, value} <- Validation.validate(value),
         {:ok, updated} <-
           Repo.update(ProductClass.update_changeset(row, Map.from_struct(value))) do
      {:ok, class_from_row(updated)}
    end
  end

  @spec get_class(String.t(), keyword()) :: {:ok, Class.t()} | {:error, Error.t()}
  def get_class(id, options \\ []) do
    with {:ok, row} <- row(ProductClass, id, :class, options) do
      {:ok, class_from_row(row)}
    end
  end

  def list_classes(options \\ []) do
    ProductClass
    |> visible_query(options)
    |> order_by([row], asc: row.key)
    |> Repo.all()
    |> Enum.map(&class_from_row/1)
  end

  @spec create_loadout(map()) :: persistence_result(Loadout.t())
  def create_loadout(attributes) when is_map(attributes) do
    value = %Loadout{
      id: Ecto.UUID.generate(),
      key: attributes[:key],
      name: attributes[:name],
      description: Map.get(attributes, :description, ""),
      model: attributes[:model],
      reasoning: attributes[:reasoning],
      tools: attributes[:tools],
      workspace_access: attributes[:workspace_access]
    }

    with {:ok, value} <- Validation.validate(value),
         {:ok, row} <- Repo.insert(ProductLoadout.create_changeset(loadout_attributes(value))) do
      {:ok, loadout_from_row(row)}
    end
  end

  @spec update_loadout(String.t(), map()) :: persistence_result(Loadout.t())
  def update_loadout(id, attributes) when is_map(attributes) do
    with {:ok, row} <- active_row(ProductLoadout, id, :loadout),
         :ok <- immutable_key(row.key, attributes),
         current = loadout_from_row(row),
         value <- %Loadout{
           id: current.id,
           key: current.key,
           name: Map.get(attributes, :name, current.name),
           description: Map.get(attributes, :description, current.description),
           model: Map.get(attributes, :model, current.model),
           reasoning: Map.get(attributes, :reasoning, current.reasoning),
           tools: Map.get(attributes, :tools, current.tools),
           workspace_access: Map.get(attributes, :workspace_access, current.workspace_access)
         },
         {:ok, value} <- Validation.validate(value),
         {:ok, updated} <-
           Repo.update(ProductLoadout.update_changeset(row, loadout_attributes(value))) do
      {:ok, loadout_from_row(updated)}
    end
  end

  def get_loadout(id, options \\ []) do
    with {:ok, row} <- row(ProductLoadout, id, :loadout, options) do
      {:ok, loadout_from_row(row)}
    end
  end

  def list_loadouts(options \\ []) do
    ProductLoadout
    |> visible_query(options)
    |> order_by([row], asc: row.key)
    |> Repo.all()
    |> Enum.map(&loadout_from_row/1)
  end

  @spec create_squad(map()) :: persistence_result(Squad.t())
  def create_squad(attributes) when is_map(attributes) do
    id = Ecto.UUID.generate()
    squad = squad_from_attributes(id, attributes)

    transact(fn ->
      with {:ok, squad} <- validate_squad_references(squad),
           {:ok, row} <-
             insert_or_rollback(ProductSquad.create_changeset(squad_attributes(squad))),
           :ok <- insert_members(squad) do
        squad_from_row(row, squad.members)
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  @spec update_squad(String.t(), map()) :: persistence_result(Squad.t())
  def update_squad(id, attributes) when is_map(attributes) do
    transact(fn ->
      with {:ok, row} <- active_row(ProductSquad, id, :squad),
           :ok <- immutable_key(row.key, attributes),
           {:ok, current} <- load_squad(row),
           squad <- %Squad{
             id: current.id,
             key: current.key,
             name: Map.get(attributes, :name, current.name),
             description: Map.get(attributes, :description, current.description),
             members: normalize_members(Map.get(attributes, :members, current.members))
           },
           {:ok, squad} <- validate_squad_references(squad),
           {:ok, updated} <-
             update_or_rollback(ProductSquad.update_changeset(row, squad_attributes(squad))),
           {_count, _rows} <-
             Repo.delete_all(
               from member in ProductSquadMember, where: member.squad_id == ^squad.id
             ),
           :ok <- insert_members(squad) do
        squad_from_row(updated, squad.members)
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  def get_squad(id, options \\ []) do
    case row(ProductSquad, id, :squad, options) do
      {:ok, row} -> load_squad(row)
      {:error, _error} = error -> error
    end
  end

  def list_squads(options \\ []) do
    ProductSquad
    |> visible_query(options)
    |> order_by([row], asc: row.key)
    |> Repo.all()
    |> Enum.map(fn row ->
      {:ok, squad} = load_squad(row)
      squad
    end)
  end

  @spec create_quest(map()) :: persistence_result(Quest.t())
  def create_quest(attributes) when is_map(attributes) do
    value = %Quest{
      id: Ecto.UUID.generate(),
      title: attributes[:title],
      objective: attributes[:objective],
      workspace_ref: attributes[:workspace_ref],
      squad_id: attributes[:squad_id],
      tactic_source: attributes[:tactic_source]
    }

    with {:ok, value} <- validate_quest(value),
         {:ok, _squad} <- get_squad(value.squad_id),
         {:ok, row} <- Repo.insert(ProductQuest.create_changeset(quest_attributes(value))) do
      {:ok, quest_from_row!(row)}
    end
  end

  @spec update_quest(String.t(), map()) :: persistence_result(Quest.t())
  def update_quest(id, attributes) when is_map(attributes) do
    with {:ok, row} <- active_row(ProductQuest, id, :quest),
         {:ok, current} <- quest_from_row(row),
         value <- %Quest{
           id: current.id,
           title: Map.get(attributes, :title, current.title),
           objective: Map.get(attributes, :objective, current.objective),
           workspace_ref: Map.get(attributes, :workspace_ref, current.workspace_ref),
           squad_id: Map.get(attributes, :squad_id, current.squad_id),
           tactic_source: Map.get(attributes, :tactic_source, current.tactic_source)
         },
         {:ok, value} <- validate_quest(value),
         {:ok, _squad} <- get_squad(value.squad_id),
         {:ok, updated} <-
           Repo.update(ProductQuest.update_changeset(row, quest_attributes(value))) do
      {:ok, quest_from_row!(updated)}
    end
  end

  def get_quest(id, options \\ []) do
    case row(ProductQuest, id, :quest, options) do
      {:ok, row} -> quest_from_row(row)
      {:error, _error} = error -> error
    end
  end

  def list_quests(options \\ []) do
    ProductQuest
    |> visible_query(options)
    |> order_by([row], asc: row.inserted_at)
    |> Repo.all()
    |> Enum.map(&quest_from_row!/1)
  end

  @doc "Builds but does not persist a LaunchSnapshot and creates no Runtime state."
  def preview_launch_snapshot(quest_id, workspace_root) do
    transact_repeatable(fn ->
      with {:ok, quest} <- get_quest(quest_id),
           {:ok, squad} <- get_squad(quest.squad_id),
           classes <- classes_for(squad),
           loadouts <- loadouts_for(squad),
           {:ok, catalog} <- TacticGraphLoader.load(quest.tactic_source),
           {:ok, snapshot} <-
             Builder.build(quest, squad, classes, loadouts, workspace_root, catalog) do
        snapshot
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  def archive_class(id), do: archive(ProductClass, id, :class)
  def archive_loadout(id), do: archive(ProductLoadout, id, :loadout)
  def archive_squad(id), do: archive(ProductSquad, id, :squad)
  def archive_quest(id), do: archive(ProductQuest, id, :quest)

  defp validate_squad_references(squad) do
    with {:ok, squad} <- Validation.validate(squad) do
      classes = classes_for(squad)
      loadouts = loadouts_for(squad)
      Validation.validate_roster(squad, classes, loadouts)
    end
  end

  defp validate_quest(value) do
    with {:ok, value} <- Validation.validate(value),
         {:ok, _preview} <- TacticLibrary.preview_source(value.tactic_source) do
      {:ok, value}
    end
  end

  defp classes_for(squad) do
    ids = Enum.map(squad.members, & &1.class_id) |> Enum.uniq()

    ProductClass
    |> where([row], row.id in ^ids and is_nil(row.archived_at))
    |> Repo.all()
    |> Enum.map(&class_from_row/1)
  end

  defp loadouts_for(squad) do
    ids = Enum.map(squad.members, & &1.loadout_id) |> Enum.uniq()

    ProductLoadout
    |> where([row], row.id in ^ids and is_nil(row.archived_at))
    |> Repo.all()
    |> Enum.map(&loadout_from_row/1)
  end

  defp insert_members(squad) do
    squad.members
    |> Enum.with_index()
    |> Enum.reduce_while(:ok, fn {member, position}, :ok ->
      attributes = %{
        squad_id: squad.id,
        member_key: member.key,
        name: member.name,
        class_id: member.class_id,
        loadout_id: member.loadout_id,
        position: position
      }

      case Repo.insert(ProductSquadMember.changeset(attributes)) do
        {:ok, _row} -> {:cont, :ok}
        {:error, changeset} -> {:halt, {:error, changeset}}
      end
    end)
  end

  defp load_squad(row) do
    members =
      ProductSquadMember
      |> where([member], member.squad_id == ^row.id)
      |> order_by([member], asc: member.position)
      |> Repo.all()
      |> Enum.map(fn member ->
        %Member{
          key: member.member_key,
          name: member.name,
          class_id: member.class_id,
          loadout_id: member.loadout_id
        }
      end)

    {:ok, squad_from_row(row, members)}
  end

  defp squad_from_attributes(id, attributes) do
    members = normalize_members(attributes[:members])

    %Squad{
      id: id,
      key: attributes[:key],
      name: attributes[:name],
      description: Map.get(attributes, :description, ""),
      members: members
    }
  end

  defp normalize_members(members) when is_list(members) do
    Enum.map(members, fn
      %Member{} = member ->
        member

      member when is_map(member) ->
        %Member{
          key: member[:key],
          name: member[:name],
          class_id: member[:class_id],
          loadout_id: member[:loadout_id]
        }

      invalid ->
        invalid
    end)
  end

  defp normalize_members(invalid), do: invalid

  defp class_from_row(row) do
    %Class{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      instructions: row.instructions
    }
  end

  defp loadout_from_row(row) do
    %Loadout{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      model: %ModelRef{provider: row.model_provider, model: row.model_name},
      reasoning: reasoning(row.reasoning),
      tools: row.tools,
      workspace_access: workspace_access(row.workspace_access)
    }
  end

  defp squad_from_row(row, members) do
    %Squad{
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      members: members
    }
  end

  defp quest_from_row(row) do
    with {:ok, tactic_source} <- tactic_source_from_row(row) do
      {:ok,
       %Quest{
         id: row.id,
         title: row.title,
         objective: row.objective,
         workspace_ref: row.workspace_ref,
         squad_id: row.squad_id,
         tactic_source: tactic_source
       }}
    end
  end

  defp tactic_source_from_row(%{tactic_source_type: "inline", inline_tactic: encoded}) do
    case TacticCodec.decode(encoded) do
      {:ok, body} ->
        {:ok, %Inline{body: body}}

      {:error, error} ->
        {:error, %Error{code: :invalid_persisted_tactic, details: %{codec_error: error}}}
    end
  end

  defp tactic_source_from_row(%{
         tactic_source_type: "definition",
         tactic_definition_id: definition_id
       }) do
    {:ok, %Definition{tactic_definition_id: definition_id}}
  end

  defp tactic_source_from_row(row) do
    {:error,
     %Error{
       code: :invalid_persisted_tactic_source,
       details: %{type: row.tactic_source_type}
     }}
  end

  defp quest_from_row!(row) do
    case quest_from_row(row) do
      {:ok, quest} -> quest
      {:error, error} -> raise "invalid persisted product tactic: #{inspect(error)}"
    end
  end

  defp loadout_attributes(value) do
    %{
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      model_provider: value.model.provider,
      model_name: value.model.model,
      reasoning: Atom.to_string(value.reasoning),
      tools: value.tools,
      workspace_access: Atom.to_string(value.workspace_access)
    }
  end

  defp squad_attributes(value),
    do: %{id: value.id, key: value.key, name: value.name, description: value.description}

  defp quest_attributes(value) do
    %{
      id: value.id,
      title: value.title,
      objective: value.objective,
      workspace_ref: value.workspace_ref,
      squad_id: value.squad_id
    }
    |> Map.merge(tactic_source_attributes(value.tactic_source))
  end

  defp tactic_source_attributes(%Inline{body: body}) do
    %{
      tactic_source_type: "inline",
      inline_tactic: TacticCodec.encode(body),
      tactic_definition_id: nil
    }
  end

  defp tactic_source_attributes(%Definition{tactic_definition_id: definition_id}) do
    %{
      tactic_source_type: "definition",
      inline_tactic: nil,
      tactic_definition_id: definition_id
    }
  end

  defp reasoning("low"), do: :low
  defp reasoning("medium"), do: :medium
  defp reasoning("high"), do: :high

  defp workspace_access("none"), do: :none
  defp workspace_access("read_only"), do: :read_only
  defp workspace_access("read_write"), do: :read_write

  defp immutable_key(current, %{key: current}), do: :ok
  defp immutable_key(_current, attributes) when not is_map_key(attributes, :key), do: :ok

  defp immutable_key(current, attributes) do
    {:error,
     [
       %ValidationError{
         code: :immutable_key,
         path: ["key"],
         details: %{current: current, received: attributes[:key]}
       }
     ]}
  end

  defp archive(schema, id, kind) do
    with {:ok, row} <- active_row(schema, id, kind),
         {:ok, _updated} <-
           Repo.update(
             Changeset.change(row,
               archived_at: DateTime.utc_now() |> DateTime.truncate(:microsecond)
             )
           ) do
      :ok
    end
  end

  defp active_row(schema, id, kind), do: row(schema, id, kind, [])

  defp row(schema, id, kind, options) do
    query = from row in schema, where: row.id == ^id

    query =
      if options[:include_archived], do: query, else: where(query, [row], is_nil(row.archived_at))

    case Repo.one(query) do
      nil -> {:error, %Error{code: :not_found, details: %{kind: kind, id: id}}}
      found -> {:ok, found}
    end
  end

  defp visible_query(query, options) do
    if options[:include_archived], do: query, else: where(query, [row], is_nil(row.archived_at))
  end

  defp insert_or_rollback(changeset) do
    case Repo.insert(changeset) do
      {:ok, row} -> {:ok, row}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp update_or_rollback(changeset) do
    case Repo.update(changeset) do
      {:ok, row} -> {:ok, row}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp transact(fun), do: unwrap_transaction(Repo.transaction(fun))

  defp transact_repeatable(fun),
    do: unwrap_transaction(Repo.transaction(fun, isolation: :repeatable_read))

  defp unwrap_transaction({:ok, value}), do: {:ok, value}
  defp unwrap_transaction({:error, error}), do: {:error, error}
end
