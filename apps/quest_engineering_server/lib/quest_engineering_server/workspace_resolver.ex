defmodule QuestEngineering.Server.WorkspaceResolver do
  @moduledoc "Resolves configured workspace references to canonical Git workspace roots."

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
    @type t :: %__MODULE__{code: atom(), details: map()}
  end

  @spec resolve(String.t()) :: {:ok, String.t()} | {:error, Error.t()}
  def resolve(workspace_ref) when is_binary(workspace_ref) do
    case Map.fetch(workspaces(), workspace_ref) do
      {:ok, configured} ->
        with {:ok, root, _label} <- workspace_config(configured) do
          validate(workspace_ref, root)
        end

      :error ->
        {:error, error(:workspace_not_configured, workspace_ref)}
    end
  end

  def resolve(value), do: {:error, error(:invalid_workspace_reference, value)}

  @doc "Lists configured references that are currently valid launch workspaces."
  def list do
    workspaces()
    |> Enum.sort_by(fn {ref, _value} -> ref end)
    |> Enum.flat_map(fn {ref, configured} ->
      with {:ok, _root} <- resolve(ref),
           {:ok, _configured_root, label} <- workspace_config(configured) do
        [%{ref: ref, name: label || ref}]
      else
        _ -> []
      end
    end)
  end

  defp workspaces, do: Application.get_env(:quest_engineering_server, :workspaces, %{})

  # Existing configuration remains `ref => root`. A future local configuration
  # may add a display-only label without creating a Workspace persistence model.
  defp workspace_config(root) when is_binary(root), do: {:ok, root, nil}

  defp workspace_config(%{"root" => root} = value) when is_binary(root),
    do: {:ok, root, Map.get(value, "label")}

  defp workspace_config(%{root: root} = value) when is_binary(root),
    do: {:ok, root, Map.get(value, :label)}

  defp workspace_config(_), do: {:error, :invalid_workspace_configuration}

  defp validate(workspace_ref, configured_root) do
    expanded = Path.expand(configured_root)

    with {:ok, canonical} <- canonicalize(expanded),
         true <- File.dir?(canonical),
         true <- File.exists?(Path.join(canonical, ".git")) do
      {:ok, canonical}
    else
      {:error, reason} ->
        {:error, error(:workspace_unavailable, workspace_ref, %{reason: reason})}

      false ->
        {:error, error(:workspace_not_git_directory, workspace_ref, %{root: expanded})}
    end
  end

  defp canonicalize(path),
    do: path |> Path.split() |> Enum.reduce_while({:ok, ""}, &canonical_component/2)

  defp canonical_component(component, {:ok, current}) do
    candidate = if current == "", do: component, else: Path.join(current, component)

    case File.lstat(candidate) do
      {:ok, %{type: :symlink}} -> resolve_symlink(candidate)
      {:ok, _stat} -> {:cont, {:ok, candidate}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp resolve_symlink(candidate) do
    case File.read_link(candidate) do
      {:ok, target} -> {:cont, {:ok, resolved_target(candidate, target)}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp resolved_target(candidate, target) do
    if Path.type(target) == :absolute,
      do: Path.expand(target),
      else: Path.expand(target, Path.dirname(candidate))
  end

  defp error(code, workspace_ref, details \\ %{}),
    do: %Error{code: code, details: Map.put(details, :workspace_ref, workspace_ref)}
end
