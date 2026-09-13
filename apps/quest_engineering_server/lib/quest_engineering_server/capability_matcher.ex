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
    executor["harness_kind"] == requested.harness_kind and
      model?(
        executor["models"],
        requested.model.provider,
        requested.model.model,
        requested.reasoning
      ) and tool_selection?(executor, requested) and
      harness_constraints?(executor["harness_kind"], requested)
  end

  defp executor_profile_compatible?(_executor, _requested), do: false

  defp model?(models, provider, model, reasoning) when is_list(models) do
    Enum.any?(models, fn
      %{
        "provider" => ^provider,
        "model" => ^model,
        "reasoning_capability" => %{"kind" => "unsupported"}
      } ->
        is_nil(reasoning)

      %{
        "provider" => ^provider,
        "model" => ^model,
        "reasoning_capability" => %{"kind" => "enumerated", "values" => values}
      }
      when is_list(values) ->
        is_binary(reasoning) and reasoning in values

      _other ->
        false
    end)
  end

  defp model?(_models, _provider, _model, _reasoning), do: false

  defp tool_selection?(executor, requested) do
    advertised = executor["tools"]
    requested_enforcement = Atom.to_string(requested.tool_enforcement)

    executor["tool_enforcement"] == requested_enforcement and is_list(advertised) and
      MapSet.subset?(MapSet.new(requested.tools), MapSet.new(advertised)) and
      (requested_enforcement == "exact" or
         MapSet.equal?(MapSet.new(requested.tools), MapSet.new(advertised)))
  end

  # These are Pi-adapter constraints for currently well-known QE capabilities,
  # not universal Product validation. Other executors may represent capability
  # combinations differently.
  defp harness_constraints?("pi", %{tools: tools, workspace_access: access}) do
    workspace_tools = ["workspace.filesystem", "workspace.search", "terminal.shell"]

    not ("terminal.shell" in tools and access != :read_write) and
      not (access == :none and Enum.any?(workspace_tools, &(&1 in tools)))
  end

  defp harness_constraints?(_harness, _requested), do: true
end
