defmodule QuestEngineering.Server.Product.TacticLibrary do
  @moduledoc "Application service for reusable Tactic persistence, resolution, and preview."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Product.TacticDefinition
  alias QuestEngineering.Core.Product.TacticPreview
  alias QuestEngineering.Core.Product.TacticPreview.Error, as: PreviewError
  alias QuestEngineering.Core.Product.TacticResolver
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Product.ValidationError
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.TacticGraphLoader
  alias QuestEngineering.Server.Repo

  defmodule Error do
    @moduledoc "A structured Tactic Library persistence or graph-loading error."
    @enforce_keys [:code, :details]
    defstruct [:code, :details]

    @type t :: %__MODULE__{code: atom(), details: map()}
  end

  @type result(value) ::
          {:ok, value}
          | {:error,
             [ValidationError.t()]
             | Changeset.t()
             | Error.t()
             | PreviewError.t()
             | TacticGraphLoader.Error.t()}

  @spec create(map()) :: result(TacticDefinition.t())
  def create(attributes) when is_map(attributes) do
    definition = %TacticDefinition{
      id: Ecto.UUID.generate(),
      key: attributes[:key],
      name: attributes[:name],
      description: Map.get(attributes, :description, ""),
      body: attributes[:body]
    }

    transaction(fn ->
      with :ok <- validate_candidate(definition),
           {:ok, row} <- Repo.insert(ProductTactic.create_changeset(row_attributes(definition))) do
        definition_from_row!(row)
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  @spec update(String.t(), map()) :: result(TacticDefinition.t())
  def update(id, attributes) when is_map(attributes) do
    transaction(fn ->
      row = lock_active!(id)

      with :ok <- immutable_key(row.key, attributes),
           {:ok, current} <- TacticGraphLoader.definition_from_row(row),
           candidate = %TacticDefinition{
             id: current.id,
             key: current.key,
             name: Map.get(attributes, :name, current.name),
             description: Map.get(attributes, :description, current.description),
             body: Map.get(attributes, :body, current.body)
           },
           :ok <- validate_update(candidate, attributes),
           {:ok, updated} <-
             Repo.update(ProductTactic.update_changeset(row, row_attributes(candidate))) do
        definition_from_row!(updated)
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  @spec get(String.t(), keyword()) :: {:ok, TacticDefinition.t()} | {:error, Error.t()}
  def get(id, options \\ []) do
    query = from tactic in ProductTactic, where: tactic.id == ^id

    query =
      if options[:include_archived],
        do: query,
        else: where(query, [tactic], is_nil(tactic.archived_at))

    case Repo.one(query) do
      nil ->
        {:error, %Error{code: :not_found, details: %{kind: :tactic_definition, id: id}}}

      row ->
        case TacticGraphLoader.definition_from_row(row) do
          {:ok, definition} -> {:ok, definition}
          {:error, error} -> {:error, graph_error(error)}
        end
    end
  end

  @spec fetch(String.t(), keyword()) :: {:ok, TacticDefinition.t()} | {:error, Error.t()}
  def fetch(id, options \\ []), do: get(id, options)

  @spec list(keyword()) :: [TacticDefinition.t()]
  def list(options \\ []) do
    query = ProductTactic |> order_by([tactic], asc: tactic.key)

    query =
      if options[:include_archived],
        do: query,
        else: where(query, [tactic], is_nil(tactic.archived_at))

    query |> Repo.all() |> Enum.map(&definition_from_row!/1)
  end

  @spec list_active() :: [TacticDefinition.t()]
  def list_active, do: list()

  @spec archive(String.t()) :: :ok | {:error, Error.t()}
  def archive(id) do
    transaction(fn ->
      row = lock_active!(id)

      case Repo.update(
             Changeset.change(row,
               archived_at: DateTime.utc_now() |> DateTime.truncate(:microsecond)
             )
           ) do
        {:ok, _row} -> :ok
        {:error, changeset} -> Repo.rollback(changeset)
      end
    end)
  end

  @spec resolve_source(TacticSource.t()) ::
          {:ok, TacticResolver.Resolution.t()} | {:error, term()}
  def resolve_source(source) do
    transaction(fn ->
      with {:ok, catalog} <- TacticGraphLoader.load(source),
           {:ok, resolution} <- TacticResolver.resolve(source, catalog) do
        resolution
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  @spec resolve_definition(String.t()) ::
          {:ok, TacticResolver.Resolution.t()} | {:error, term()}
  def resolve_definition(id), do: resolve_source(TacticSource.definition(id))

  @spec preview_source(TacticSource.t()) ::
          {:ok, TacticPreview.Result.t()} | {:error, term()}
  def preview_source(source) do
    transaction(fn ->
      with {:ok, catalog} <- TacticGraphLoader.load(source),
           {:ok, preview} <- TacticPreview.preview(source, catalog) do
        preview
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  @spec preview_definition(String.t() | TacticDefinition.t()) ::
          {:ok, TacticPreview.Result.t()} | {:error, term()}
  def preview_definition(id) when is_binary(id),
    do: preview_source(TacticSource.definition(id))

  def preview_definition(%TacticDefinition{} = candidate) do
    source = TacticSource.definition(candidate.id)

    transaction(fn ->
      with {:ok, _candidate} <- validate_preview_candidate(candidate),
           {:ok, catalog} <- TacticGraphLoader.load(source, %{candidate.id => candidate}),
           {:ok, preview} <- TacticPreview.preview(source, catalog) do
        preview
      else
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  defp validate_preview_candidate(candidate) do
    case Validation.validate(candidate) do
      {:ok, definition} ->
        {:ok, definition}

      {:error, errors} ->
        {:error, %PreviewError{stage: :definition, errors: errors, step_origins: %{}}}
    end
  end

  defp validate_update(candidate, attributes) do
    if Map.has_key?(attributes, :body) do
      validate_candidate(candidate)
    else
      case Validation.validate(candidate) do
        {:ok, _definition} -> :ok
        {:error, errors} -> {:error, errors}
      end
    end
  end

  defp validate_candidate(definition) do
    with {:ok, _definition} <- Validation.validate(definition),
         source = TacticSource.definition(definition.id),
         {:ok, catalog} <- TacticGraphLoader.load(source, %{definition.id => definition}),
         {:ok, resolution} <- resolve_candidate(source, catalog) do
      valid_contextual_semantics(resolution)
    end
  end

  defp resolve_candidate(source, catalog) do
    case TacticResolver.resolve(source, catalog) do
      {:ok, resolution} ->
        {:ok, resolution}

      {:error, errors} ->
        {:error, %PreviewError{stage: :resolution, errors: errors, step_origins: %{}}}
    end
  end

  # Reusable definitions may intentionally require artifacts supplied by a
  # parent composition. Every other semantic compiler error remains a save
  # blocker; missing root artifacts alone are contextual, not malformed.
  defp valid_contextual_semantics(resolution) do
    case Compiler.compile(resolution.tactic) do
      {:ok, _plan} ->
        :ok

      {:error, errors} ->
        blockers = Enum.reject(errors, &(&1.type == :missing_artifact))

        if blockers == [] do
          :ok
        else
          {:error,
           %PreviewError{
             stage: :compilation,
             errors: blockers,
             step_origins: resolution.step_origins
           }}
        end
    end
  end

  defp lock_active!(id) do
    row =
      Repo.one(
        from tactic in ProductTactic,
          where: tactic.id == ^id and is_nil(tactic.archived_at),
          lock: "FOR UPDATE"
      )

    row ||
      Repo.rollback(%Error{code: :not_found, details: %{kind: :tactic_definition, id: id}})
  end

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

  defp row_attributes(definition) do
    %{
      id: definition.id,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      body: TacticCodec.encode(definition.body)
    }
  end

  defp definition_from_row!(row) do
    case TacticGraphLoader.definition_from_row(row) do
      {:ok, definition} -> definition
      {:error, error} -> raise "invalid persisted Tactic Definition: #{inspect(error)}"
    end
  end

  defp graph_error(error), do: %Error{code: error.code, details: error.details}

  defp transaction(fun) do
    case Repo.transaction(fun, isolation: :repeatable_read) do
      {:ok, value} -> normalize_transaction_value(value)
      {:error, error} -> {:error, error}
    end
  end

  defp normalize_transaction_value(:ok), do: :ok
  defp normalize_transaction_value(value), do: {:ok, value}
end
