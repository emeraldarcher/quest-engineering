defmodule QuestEngineering.Server.ProductApi.Service do
  @moduledoc false

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.ProductClass
  alias QuestEngineering.Server.Persistence.ProductLoadout
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.ProductSquad
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.Repository
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  def list(:workspace, options), do: {:ok, Repository.list_workspaces(options)}
  def list(:class, options), do: {:ok, Repository.list_classes(options)}
  def list(:loadout, options), do: {:ok, Repository.list_loadouts(options)}
  def list(:squad, options), do: {:ok, Repository.list_squads(options)}
  def list(:quest, options), do: {:ok, Repository.list_quests(options)}
  def list(:tactic, options), do: {:ok, TacticLibrary.list(options)}

  def get(:workspace, id, options), do: Repository.get_workspace(id, options)
  def get(:class, id, options), do: Repository.get_class(id, options)
  def get(:loadout, id, options), do: Repository.get_loadout(id, options)
  def get(:squad, id, options), do: Repository.get_squad(id, options)
  def get(:quest, id, options), do: Repository.get_quest(id, options)
  def get(:tactic, id, options), do: TacticLibrary.get(id, options)

  def create(kind, payload) do
    with {:ok, attributes} <- attributes(kind, payload),
         :ok <- active_references(kind, attributes) do
      case kind do
        :workspace -> Repository.create_workspace(attributes)
        :class -> Repository.create_class(attributes)
        :loadout -> Repository.create_loadout(attributes)
        :squad -> Repository.create_squad(attributes)
        :quest -> Repository.create_quest(attributes)
        :tactic -> TacticLibrary.create(attributes)
      end
    end
  end

  def update(kind, id, payload) do
    with {:ok, attributes} <- attributes(kind, payload),
         {:ok, reference_attributes} <- complete_references(kind, id, attributes),
         :ok <- active_references(kind, reference_attributes) do
      case kind do
        :workspace -> Repository.update_workspace(id, attributes)
        :class -> Repository.update_class(id, attributes)
        :loadout -> Repository.update_loadout(id, attributes)
        :squad -> Repository.update_squad(id, attributes)
        :quest -> Repository.update_quest(id, attributes)
        :tactic -> TacticLibrary.update(id, attributes)
      end
    end
  end

  def archive(kind, id) do
    result =
      case kind do
        :workspace -> Repository.archive_workspace(id)
        :class -> Repository.archive_class(id)
        :loadout -> Repository.archive_loadout(id)
        :squad -> Repository.archive_squad(id)
        :quest -> Repository.archive_quest(id)
        :tactic -> TacticLibrary.archive(id)
      end

    case result do
      :ok -> get(kind, id, include_archived: true)
      {:error, _error} = error -> error
    end
  end

  def archived_at(kind, id) do
    case Repo.get(schema(kind), id) do
      nil -> nil
      row -> row.archived_at
    end
  end

  def preview_tactic(payload) do
    with {:ok, source} <- source(payload["tactic_source"] || payload[:tactic_source]) do
      TacticLibrary.preview_source(source)
    end
  end

  def preview_tactic_definition(id, payload \\ %{}) do
    case Map.fetch(payload, "body") do
      :error ->
        TacticLibrary.preview_definition(id)

      {:ok, body} ->
        with {:ok, decoded} <- tactic_body(body) do
          TacticLibrary.preview_definition(id, %{body: decoded})
        end
    end
  end

  def preview_quest(id), do: Repository.preview_launch_snapshot(id)

  def launch(id), do: LaunchQuest.launch(id)

  defp attributes(:workspace, payload) do
    case basic(payload, [:key, :name, :source_kind, :source_fingerprint]) do
      {:ok, attributes} ->
        enum(attributes, :source_kind, %{
          "git_remote" => :git_remote,
          "local_git" => :local_git
        })

      error ->
        error
    end
  end

  defp attributes(:class, payload), do: basic(payload, [:key, :name, :description, :instructions])

  defp attributes(:loadout, payload) do
    with {:ok, attributes} <-
           basic(payload, [:key, :name, :description, :reasoning, :tools, :workspace_access]),
         {:ok, attributes} <- loadout_enums(attributes),
         {:ok, model} <- model(Map.get(payload, "model", Map.get(payload, :model, :absent))) do
      {:ok, if(model == :absent, do: attributes, else: Map.put(attributes, :model, model))}
    end
  end

  defp attributes(:squad, payload) do
    with {:ok, attributes} <- basic(payload, [:key, :name, :description]),
         {:ok, members} <-
           members(Map.get(payload, "members", Map.get(payload, :members, :absent))) do
      {:ok, if(members == :absent, do: attributes, else: Map.put(attributes, :members, members))}
    end
  end

  defp attributes(:tactic, payload) do
    with {:ok, attributes} <- basic(payload, [:key, :name, :description]),
         {:ok, body} <- tactic_body(Map.get(payload, "body", Map.get(payload, :body, :absent))) do
      {:ok, if(body == :absent, do: attributes, else: Map.put(attributes, :body, body))}
    end
  end

  defp attributes(:quest, payload) do
    with {:ok, attributes} <-
           basic(payload, [:title, :objective, :workspace_id, :squad_id]),
         {:ok, source} <-
           tactic_source(
             Map.get(payload, "tactic_source", Map.get(payload, :tactic_source, :absent))
           ) do
      {:ok,
       if(source == :absent, do: attributes, else: Map.put(attributes, :tactic_source, source))}
    end
  end

  defp basic(payload, fields) when is_map(payload) do
    Enum.reduce_while(fields, {:ok, %{}}, fn field, {:ok, result} ->
      key = Atom.to_string(field)

      case Map.fetch(payload, key) do
        {:ok, value} -> {:cont, {:ok, Map.put(result, field, value)}}
        :error -> {:cont, {:ok, result}}
      end
    end)
  end

  defp basic(_, _), do: malformed([], :expected_object)

  defp loadout_enums(attributes) do
    with {:ok, attributes} <-
           enum(attributes, :reasoning, %{"low" => :low, "medium" => :medium, "high" => :high}) do
      enum(attributes, :workspace_access, %{
        "none" => :none,
        "read_only" => :read_only,
        "read_write" => :read_write
      })
    end
  end

  defp enum(attributes, field, values) do
    case Map.fetch(attributes, field) do
      :error ->
        {:ok, attributes}

      {:ok, value} when is_atom(value) ->
        {:ok, attributes}

      {:ok, value} ->
        case Map.fetch(values, value) do
          {:ok, atom} -> {:ok, Map.put(attributes, field, atom)}
          :error -> malformed([Atom.to_string(field)], :invalid_enum)
        end
    end
  end

  defp model(:absent), do: {:ok, :absent}

  defp model(%{"provider" => provider, "model" => model})
       when is_binary(provider) and is_binary(model),
       do: {:ok, %ModelRef{provider: provider, model: model}}

  defp model(_), do: malformed(["model"], :invalid_model)

  defp members(:absent), do: {:ok, :absent}

  defp members(values) when is_list(values) do
    values
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {value, index}, {:ok, result} ->
      case member(value, index) do
        {:ok, member} -> {:cont, {:ok, result ++ [member]}}
        error -> {:halt, error}
      end
    end)
  end

  defp members(_), do: malformed(["members"], :expected_list)

  defp member(
         %{
           "member_key" => key,
           "name" => name,
           "class_id" => class_id,
           "loadout_id" => loadout_id
         },
         _
       )
       when is_binary(key) and is_binary(name) and is_binary(class_id) and is_binary(loadout_id),
       do: {:ok, %{key: key, name: name, class_id: class_id, loadout_id: loadout_id}}

  defp member(_, index), do: malformed(["members", index], :invalid_member)

  defp tactic_body(:absent), do: {:ok, :absent}

  defp tactic_body(value) do
    case TacticCodec.decode(value) do
      {:ok, body} -> {:ok, body}
      {:error, error} -> malformed(["body" | error.path], error.reason)
    end
  end

  defp tactic_source(:absent), do: {:ok, :absent}
  defp tactic_source(value), do: source(value)

  defp source(%{"type" => "inline", "body" => body}) do
    with {:ok, decoded} <- tactic_body(body), do: {:ok, TacticSource.inline(decoded)}
  end

  defp source(%{"type" => "definition", "tactic_definition_id" => id}) when is_binary(id),
    do: {:ok, TacticSource.definition(id)}

  defp source(_), do: malformed(["tactic_source"], :invalid_tactic_source)

  defp complete_references(:squad, id, attributes) do
    if Map.has_key?(attributes, :members) do
      {:ok, attributes}
    else
      with {:ok, squad} <- Repository.get_squad(id),
           do: {:ok, Map.put(attributes, :members, squad.members)}
    end
  end

  defp complete_references(:quest, id, attributes) do
    with {:ok, quest} <- Repository.get_quest(id) do
      attributes =
        attributes
        |> Map.put_new(:workspace_id, quest.workspace_id)
        |> Map.put_new(:squad_id, quest.squad_id)

      {:ok, Map.put_new(attributes, :tactic_source, quest.tactic_source)}
    end
  end

  defp complete_references(_kind, _id, attributes), do: {:ok, attributes}

  defp active_references(:squad, %{members: members}) do
    members
    |> Enum.flat_map(fn member ->
      [{ProductClass, member.class_id}, {ProductLoadout, member.loadout_id}]
    end)
    |> active_rows()
  end

  defp active_references(:quest, attributes) do
    rows =
      case Map.get(attributes, :workspace_id) do
        nil -> []
        id -> [{ProductWorkspace, id}]
      end

    rows =
      case Map.get(attributes, :squad_id) do
        nil -> rows
        id -> rows ++ [{ProductSquad, id}]
      end

    rows =
      case Map.get(attributes, :tactic_source) do
        %QuestEngineering.Core.Product.TacticSource.Definition{tactic_definition_id: id} ->
          rows ++ [{ProductTactic, id}]

        _ ->
          rows
      end

    active_rows(rows)
  end

  defp active_references(_kind, _attributes), do: :ok

  defp active_rows(rows) do
    case Enum.find(rows, fn {schema, id} ->
           match?(%{archived_at: value} when not is_nil(value), Repo.get(schema, id))
         end) do
      nil -> :ok
      {_schema, id} -> {:error, %Error{code: :archived_reference, details: %{id: id}}}
    end
  end

  defp schema(:workspace), do: ProductWorkspace
  defp schema(:class), do: ProductClass
  defp schema(:loadout), do: ProductLoadout
  defp schema(:squad), do: ProductSquad
  defp schema(:quest), do: ProductQuest
  defp schema(:tactic), do: ProductTactic

  defp malformed(path, code), do: {:error, %Error{code: code, details: %{path: path}}}
end
