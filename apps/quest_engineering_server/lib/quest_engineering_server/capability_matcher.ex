defmodule QuestEngineering.Server.CapabilityMatcher do
  @moduledoc "Matches resolved requirements against any advertised compatible executor."

  alias QuestEngineering.Core.ResolvedExecution.Configuration

  @access_rank %{"none" => 0, "read_only" => 1, "read_write" => 2}

  @spec compatible?(map(), Configuration.t()) :: boolean()
  def compatible?(%{"executors" => executors}, %Configuration{} = requested)
      when is_list(executors) do
    Enum.any?(executors, &executor_compatible?(&1, requested))
  end

  def compatible?(_capabilities, _requested), do: false

  defp executor_compatible?(executor, requested) when is_map(executor) do
    model?(executor["models"], requested.model.provider, requested.model.model) and
      Atom.to_string(requested.reasoning) in List.wrap(executor["reasoning"]) and
      subset?(requested.tools, executor["tools"]) and
      workspace?(executor["workspaces"], requested) and
      adapter_constraints?(executor["adapter"], requested)
  end

  defp executor_compatible?(_executor, _requested), do: false

  defp model?(models, provider, model) when is_list(models) do
    Enum.any?(models, fn
      %{"provider" => ^provider, "model" => ^model} -> true
      _other -> false
    end)
  end

  defp model?(_models, _provider, _model), do: false

  defp subset?(requested, advertised) when is_list(advertised),
    do: MapSet.subset?(MapSet.new(requested), MapSet.new(advertised))

  defp subset?(_requested, _advertised), do: false

  defp workspace?(workspaces, requested) when is_list(workspaces) do
    requested_access = Atom.to_string(requested.workspace_access)

    Enum.any?(workspaces, fn
      %{"ref" => ref, "root" => root, "max_access" => max_access} ->
        ref == requested.workspace_ref and root == requested.workspace_root and
          access_at_least?(max_access, requested_access)

      _other ->
        false
    end)
  end

  defp workspace?(_workspaces, _requested), do: false

  defp access_at_least?(available, requested) do
    case {@access_rank[available], @access_rank[requested]} do
      {available_rank, requested_rank}
      when is_integer(available_rank) and is_integer(requested_rank) ->
        available_rank >= requested_rank

      _other ->
        false
    end
  end

  # These are Pi-adapter constraints for currently well-known QE capabilities,
  # not universal Product validation. Other executors may represent capability
  # combinations differently.
  defp adapter_constraints?("pi", %Configuration{tools: tools, workspace_access: access}) do
    workspace_tools = ["workspace.filesystem", "workspace.search", "terminal.shell"]

    not ("terminal.shell" in tools and access != :read_write) and
      not (access == :none and Enum.any?(workspace_tools, &(&1 in tools)))
  end

  defp adapter_constraints?(_adapter, _requested), do: true
end
