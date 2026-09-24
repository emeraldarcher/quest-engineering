defmodule QuestEngineering.Server.MultiHarnessTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.ToolPolicy.Exact
  alias QuestEngineering.Core.Product.ToolPolicy.NativePermissions
  alias QuestEngineering.Core.ResolvedExecution.ToolProfile
  alias QuestEngineering.Server.CapabilityMatcher

  test "exact and native policies match only their advertised guarantees" do
    capabilities = capabilities(["a", "b", "c"])

    assert {:ok, %{tool_enforcement: :exact, resolved_tool_profile: %ToolProfile{tools: ["a"]}}} =
             CapabilityMatcher.resolve_executor(
               capabilities,
               request("pi", "high", %Exact{tools: ["a"]})
             )

    assert {:ok,
            %{
              tool_enforcement: :native_permissions,
              resolved_tool_profile: %ToolProfile{tools: ["a", "b", "c"]}
            }} =
             CapabilityMatcher.resolve_executor(
               capabilities,
               request("antigravity", nil, %NativePermissions{})
             )

    assert :error =
             CapabilityMatcher.resolve_executor(
               capabilities,
               request("antigravity", nil, %Exact{tools: ["a"]})
             )

    assert :error =
             CapabilityMatcher.resolve_executor(
               capabilities,
               request("pi", "high", %NativePermissions{})
             )
  end

  test "adapter semantic capability changes alter provenance without altering authored policy" do
    requested = request("antigravity", nil, %NativePermissions{})

    assert {:ok, first} =
             CapabilityMatcher.resolve_executor(capabilities(["a", "b", "c"]), requested)

    assert {:ok, second} =
             CapabilityMatcher.resolve_executor(capabilities(["a", "b", "c", "d"]), requested)

    assert first.resolved_tool_profile.tools == ["a", "b", "c"]
    assert second.resolved_tool_profile.tools == ["a", "b", "c", "d"]
    assert requested.tool_policy == %NativePermissions{}
  end

  test "unknown availability remains schedulable while verified unavailable is rejected" do
    unknown =
      put_in(
        capabilities([]),
        ["executors", Access.at(0), "models", Access.at(0), "account_availability"],
        "unknown"
      )

    assert {:ok, _resolution} =
             CapabilityMatcher.resolve_executor(
               unknown,
               request("pi", "high", %Exact{tools: ["a"]})
             )

    unavailable =
      put_in(
        unknown,
        ["executors", Access.at(0), "models", Access.at(0), "account_availability"],
        "verified_unavailable"
      )

    assert :error =
             CapabilityMatcher.resolve_executor(
               unavailable,
               request("pi", "high", %Exact{tools: ["a"]})
             )
  end

  test "maintenance Workers remain connected but cannot resolve an executor" do
    maintenance = Map.put(capabilities([]), "dispatch_availability", "maintenance")

    assert :error =
             CapabilityMatcher.resolve_executor(
               maintenance,
               request("pi", "high", %Exact{tools: ["a"]})
             )

    assert {:ok, _resolution} =
             maintenance
             |> Map.put("dispatch_availability", "active")
             |> CapabilityMatcher.resolve_executor(request("pi", "high", %Exact{tools: ["a"]}))
  end

  test "reasoning null matches only explicit unsupported capability" do
    assert {:ok, %{reasoning_capability: %{kind: :unsupported}}} =
             CapabilityMatcher.resolve_executor(
               capabilities([]),
               request("antigravity", nil, %NativePermissions{})
             )

    assert :error =
             CapabilityMatcher.resolve_executor(
               capabilities([]),
               request("antigravity", "high", %NativePermissions{})
             )

    assert :error =
             CapabilityMatcher.resolve_executor(
               capabilities([]),
               request("pi", nil, %Exact{tools: []})
             )
  end

  defp request(harness, reasoning, policy) do
    %{
      harness_kind: harness,
      model: %ModelRef{provider: "shared", model: if(harness == "pi", do: "pi", else: "agy")},
      reasoning: reasoning,
      tool_policy: policy,
      workspace_access: :read_write
    }
  end

  defp capabilities(qe_capabilities) do
    %{
      "executors" => [
        %{
          "harness_kind" => "pi",
          "models" => [
            %{
              "provider" => "shared",
              "model" => "pi",
              "display_name" => "Pi",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{"kind" => "enumerated", "values" => ["high"]}
            }
          ],
          "supported_tool_policies" => ["exact"],
          "tool_enforcement" => "exact",
          "tool_profile" => %{"tools" => ["a", "b"]}
        },
        %{
          "harness_kind" => "antigravity",
          "models" => [
            %{
              "provider" => "shared",
              "model" => "agy",
              "display_name" => "Antigravity",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{"kind" => "unsupported"}
            }
          ],
          "supported_tool_policies" => ["native_permissions"],
          "tool_enforcement" => "native_permissions",
          "tool_profile" => %{"tools" => qe_capabilities}
        }
      ]
    }
  end
end
