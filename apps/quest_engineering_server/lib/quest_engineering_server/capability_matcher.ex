defmodule QuestEngineering.Server.CapabilityMatcher do
  @moduledoc "Matches resolved requirements against any advertised compatible executor."

  alias QuestEngineering.Core.ResolvedExecution.Configuration

  @spec compatible?(map(), Configuration.t()) :: boolean()
  def compatible?(capabilities, %Configuration{} = requested),
    do: executor_compatible?(capabilities, requested)

  def compatible?(_capabilities, _requested), do: false

  def executor_compatible?(%{"executors" => executors}, requested)
      when is_list(executors) and is_map(requested) do
    Enum.any?(executors, &executor_profile_compatible?(&1, requested))
  end

  def executor_compatible?(_capabilities, _requested), do: false

  defp executor_profile_compatible?(executor, requested) when is_map(executor) do
    model?(executor["models"], requested.model.provider, requested.model.model) and
      Atom.to_string(requested.reasoning) in List.wrap(executor["reasoning"]) and
      subset?(requested.tools, executor["tools"]) and
      adapter_constraints?(executor["adapter"], requested)
  end

  defp executor_profile_compatible?(_executor, _requested), do: false

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

  # These are Pi-adapter constraints for currently well-known QE capabilities,
  # not universal Product validation. Other executors may represent capability
  # combinations differently.
  defp adapter_constraints?("pi", %{tools: tools, workspace_access: access}) do
    workspace_tools = ["workspace.filesystem", "workspace.search", "terminal.shell"]

    not ("terminal.shell" in tools and access != :read_write) and
      not (access == :none and Enum.any?(workspace_tools, &(&1 in tools)))
  end

  defp adapter_constraints?(_adapter, _requested), do: true
end
