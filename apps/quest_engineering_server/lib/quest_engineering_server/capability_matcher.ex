defmodule QuestEngineering.Server.CapabilityMatcher do
  @moduledoc "Matches authored execution intent and resolves advertised executor guarantees."

  alias QuestEngineering.Core.Product.ToolPolicy.Exact
  alias QuestEngineering.Core.Product.ToolPolicy.NativePermissions
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.ReasoningCapability
  alias QuestEngineering.Core.ResolvedExecution.ToolProfile

  @spec compatible?(map(), Configuration.t() | map()) :: boolean()
  def compatible?(capabilities, requested),
    do: match?({:ok, _resolution}, resolve_executor(capabilities, requested))

  def executor_compatible?(capabilities, requested), do: compatible?(capabilities, requested)

  # Missing availability is treated as active for protocol-v8 compatibility.
  # A maintenance Worker remains registered and observable but is structurally
  # ineligible for workspace assignment or Action scheduling.
  def resolve_executor(%{"dispatch_availability" => "maintenance"}, _requested), do: :error

  def resolve_executor(%{"executors" => executors}, requested)
      when is_list(executors) and is_map(requested) do
    Enum.find_value(executors, :error, &resolve_profile(&1, requested))
  end

  def resolve_executor(_capabilities, _requested), do: :error

  defp resolve_profile(executor, requested) when is_map(executor) do
    with true <- executor["harness_kind"] == requested.harness_kind,
         {:ok, reasoning_capability} <-
           resolve_model(
             executor["models"],
             requested.model.provider,
             requested.model.model,
             requested.reasoning
           ),
         {:ok, tool_resolution} <- resolve_tools(executor, requested.tool_policy),
         true <- harness_constraints?(executor["harness_kind"], requested) do
      {:ok, Map.put(tool_resolution, :reasoning_capability, reasoning_capability)}
    else
      _other -> nil
    end
  end

  defp resolve_profile(_executor, _requested), do: nil

  defp resolve_model(models, provider, model, reasoning) when is_list(models) do
    Enum.find_value(models, :error, fn
      %{
        "provider" => ^provider,
        "model" => ^model,
        "account_availability" => account_availability,
        "reasoning_capability" => %{"kind" => "unsupported"}
      }
      when is_nil(reasoning) and account_availability != "verified_unavailable" ->
        {:ok, %ReasoningCapability{kind: :unsupported, values: []}}

      %{
        "provider" => ^provider,
        "model" => ^model,
        "account_availability" => account_availability,
        "reasoning_capability" => %{"kind" => "enumerated", "values" => values}
      }
      when is_binary(reasoning) and is_list(values) and
             account_availability != "verified_unavailable" ->
        if reasoning in values,
          do: {:ok, %ReasoningCapability{kind: :enumerated, values: values}},
          else: nil

      _other ->
        nil
    end)
  end

  defp resolve_model(_models, _provider, _model, _reasoning), do: :error

  defp resolve_tools(
         %{
           "supported_tool_policies" => policies,
           "tool_enforcement" => "exact",
           "tool_profile" => %{"tools" => available}
         },
         %Exact{tools: requested}
       )
       when is_list(policies) and is_list(available) and is_list(requested) do
    if "exact" in policies and MapSet.subset?(MapSet.new(requested), MapSet.new(available)) do
      {:ok, %{tool_enforcement: :exact, resolved_tool_profile: %ToolProfile{tools: requested}}}
    else
      :error
    end
  end

  defp resolve_tools(
         %{
           "supported_tool_policies" => policies,
           "tool_enforcement" => "native_permissions",
           "tool_profile" => %{"tools" => available}
         },
         %NativePermissions{}
       )
       when is_list(policies) and is_list(available) do
    if "native_permissions" in policies do
      {:ok,
       %{
         tool_enforcement: :native_permissions,
         resolved_tool_profile: %ToolProfile{tools: available}
       }}
    else
      :error
    end
  end

  defp resolve_tools(_executor, _policy), do: :error

  defp harness_constraints?("pi", %{tool_policy: %Exact{tools: tools}, workspace_access: access}) do
    workspace_tools = ["workspace.filesystem", "workspace.search", "terminal.shell"]

    not ("terminal.shell" in tools and access != :read_write) and
      not (access == :none and Enum.any?(workspace_tools, &(&1 in tools)))
  end

  defp harness_constraints?("pi", _requested), do: false
  defp harness_constraints?(_harness, _requested), do: true
end
