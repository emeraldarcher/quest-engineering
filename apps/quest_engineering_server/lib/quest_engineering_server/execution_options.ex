defmodule QuestEngineering.Server.ExecutionOptions do
  @moduledoc "Product-safe discovery of coherent, advertised execution configurations."

  import Ecto.Query

  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Repo

  @access_levels ["none", "read_only", "read_write"]

  def list do
    Worker
    |> Repo.all()
    |> Enum.flat_map(&profiles/1)
    |> Enum.group_by(&profile_key/1)
    |> Enum.map(fn {_key, profiles} ->
      profile = hd(profiles)
      %{profile | available: Enum.any?(profiles, & &1.available)}
    end)
    |> Enum.sort_by(
      &{&1.harness, &1.model.provider, &1.model.model, &1.tools, &1.reasoning_capability}
    )
  end

  defp profiles(%Worker{capabilities: %{"executors" => executors}, status: status} = worker)
       when is_list(executors) do
    bindings = safe_bindings(worker)

    Enum.flat_map(executors, fn executor -> profile(executor, bindings, status == "connected") end)
  end

  defp profiles(_worker), do: []

  defp profile(
         %{
           "harness_kind" => harness,
           "models" => models,
           "tools" => tools,
           "tool_enforcement" => tool_enforcement
         },
         bindings,
         available
       )
       when is_binary(harness) and harness != "" and is_list(models) and is_list(tools) and
              tool_enforcement in ["exact", "native_permissions"] do
    workspaces =
      bindings
      |> Enum.reject(fn binding ->
        "terminal.shell" in tools and not binding.allow_unconfined_shell
      end)
      |> Enum.map(fn binding ->
        %{workspace_id: binding.workspace_id, workspace_access: access_levels(binding.max_access)}
      end)
      |> Enum.sort_by(& &1.workspace_id)

    with {:ok, models} <- models(models),
         false <- workspaces == [] do
      Enum.map(models, fn model ->
        %{
          harness: harness,
          model: Map.take(model, [:provider, :model, :display_name]),
          reasoning_capability: model.reasoning_capability,
          tools: Enum.sort(tools),
          tool_enforcement: tool_enforcement,
          workspaces: workspaces,
          available: available
        }
      end)
    else
      _ -> []
    end
  end

  defp profile(_executor, _bindings, _available), do: []

  defp safe_bindings(worker) do
    explicit =
      Repo.all(
        from binding in WorkerWorkspaceBinding,
          join: workspace in ProductWorkspace,
          on: workspace.id == binding.workspace_id,
          where:
            binding.worker_id == ^worker.id and binding.status == "available" and
              is_nil(workspace.archived_at),
          select: %{
            workspace_id: workspace.id,
            max_access: binding.max_access,
            allow_unconfined_shell: binding.allow_unconfined_shell
          }
      )

    if explicit == [], do: legacy_bindings(worker), else: explicit
  end

  defp legacy_bindings(worker) do
    worker.capabilities
    |> Map.get("executors", [])
    |> Enum.flat_map(&Map.get(&1, "workspaces", []))
    |> Enum.flat_map(fn legacy ->
      case Repo.one(
             from workspace in ProductWorkspace,
               where: workspace.key == ^legacy["ref"] or workspace.name == ^legacy["ref"],
               select: workspace.id,
               limit: 1
           ) do
        nil ->
          []

        workspace_id ->
          [
            %{
              workspace_id: workspace_id,
              max_access: legacy["max_access"],
              allow_unconfined_shell: true
            }
          ]
      end
    end)
  end

  defp models(models) do
    values =
      Enum.flat_map(models, fn
        %{
          "provider" => provider,
          "model" => model,
          "display_name" => display_name,
          "reasoning_capability" => reasoning_capability
        }
        when is_binary(provider) and is_binary(model) and is_binary(display_name) ->
          case reasoning_capability do
            %{"kind" => "unsupported"} ->
              [
                %{
                  provider: provider,
                  model: model,
                  display_name: display_name,
                  reasoning_capability: %{kind: "unsupported"}
                }
              ]

            %{"kind" => "enumerated", "values" => values}
            when is_list(values) and values != [] ->
              [
                %{
                  provider: provider,
                  model: model,
                  display_name: display_name,
                  reasoning_capability: %{kind: "enumerated", values: Enum.sort(values)}
                }
              ]

            _other ->
              []
          end

        _ ->
          []
      end)

    if length(values) == length(models),
      do: {:ok, Enum.sort_by(values, &{&1.provider, &1.model})},
      else: :error
  end

  defp access_levels(max_access) do
    @access_levels
    |> Enum.take_while(&(&1 != max_access))
    |> Kernel.++([max_access])
  end

  defp profile_key(profile),
    do: {
      profile.harness,
      profile.model.provider,
      profile.model.model,
      profile.model.display_name,
      profile.reasoning_capability,
      profile.tools,
      profile.tool_enforcement,
      Enum.map(profile.workspaces, &{&1.workspace_id, &1.workspace_access})
    }
end
