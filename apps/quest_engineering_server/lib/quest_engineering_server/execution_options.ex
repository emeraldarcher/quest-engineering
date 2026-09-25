defmodule QuestEngineering.Server.ExecutionOptions do
  @moduledoc "Product-safe discovery of coherent, advertised execution configurations."

  import Ecto.Query

  alias QuestEngineering.Server.ExecutionShellAuthority
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

      %{
        profile
        | available: Enum.any?(profiles, & &1.available),
          account_availability: merged_account_availability(profiles)
      }
    end)
    |> Enum.sort_by(
      &{&1.harness, &1.model.provider, &1.model.model, &1.tool_policy, &1.reasoning_capability}
    )
  end

  defp profiles(%Worker{capabilities: %{"executors" => executors}, status: status} = worker)
       when is_list(executors) do
    bindings = safe_bindings(worker)

    dispatch_active = Map.get(worker.capabilities, "dispatch_availability", "active") == "active"

    Enum.flat_map(executors, fn executor ->
      profile(executor, bindings, status == "connected" and dispatch_active)
    end)
  end

  defp profiles(_worker), do: []

  defp profile(
         %{
           "harness_kind" => harness,
           "models" => models,
           "supported_tool_policies" => supported_policies,
           "tool_enforcement" => tool_enforcement,
           "tool_profile" => %{"tools" => tools}
         } = executor,
         bindings,
         available
       )
       when is_binary(harness) and harness != "" and is_list(models) and is_list(tools) and
              is_list(supported_policies) and
              tool_enforcement in ["exact", "native_permissions"] do
    workspaces =
      bindings
      |> Enum.reject(fn binding ->
        "terminal.shell" in tools and not ExecutionShellAuthority.authorized?(executor, binding)
      end)
      |> Enum.map(fn binding ->
        %{workspace_id: binding.workspace_id, workspace_access: access_levels(binding.max_access)}
      end)
      |> Enum.sort_by(& &1.workspace_id)

    with {:ok, models} <- models(models),
         false <- workspaces == [] do
      Enum.flat_map(models, fn model ->
        Enum.map(
          supported_policies,
          &execution_option(&1, harness, model, tool_enforcement, tools, workspaces, available)
        )
      end)
    else
      _ -> []
    end
  end

  defp profile(_executor, _bindings, _available), do: []

  defp execution_option(
         policy_kind,
         harness,
         model,
         tool_enforcement,
         tools,
         workspaces,
         available
       ) do
    %{
      harness: harness,
      model: Map.take(model, [:provider, :model, :display_name]),
      reasoning_capability: model.reasoning_capability,
      tool_policy: %{kind: policy_kind},
      tool_enforcement: tool_enforcement,
      current_tool_profile: %{tools: Enum.sort(tools)},
      workspaces: workspaces,
      account_availability: model.account_availability,
      available: available and model.account_availability != "verified_unavailable"
    }
  end

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
          "account_availability" => account_availability,
          "reasoning_capability" => reasoning_capability
        }
        when is_binary(provider) and is_binary(model) and is_binary(display_name) and
               account_availability in ["verified_available", "verified_unavailable", "unknown"] ->
          case reasoning_capability do
            %{"kind" => "unsupported"} ->
              [
                %{
                  provider: provider,
                  model: model,
                  display_name: display_name,
                  account_availability: account_availability,
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
                  account_availability: account_availability,
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

  defp merged_account_availability(profiles) do
    states = Enum.map(profiles, & &1.account_availability)

    cond do
      "verified_available" in states -> "verified_available"
      "unknown" in states -> "unknown"
      true -> "verified_unavailable"
    end
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
      profile.tool_policy,
      profile.tool_enforcement,
      profile.current_tool_profile,
      Enum.map(profile.workspaces, &{&1.workspace_id, &1.workspace_access})
    }
end
