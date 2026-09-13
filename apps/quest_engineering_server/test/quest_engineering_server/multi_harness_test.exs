defmodule QuestEngineering.Server.MultiHarnessTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Server.CapabilityMatcher

  test "scheduler matches effort capability and tool guarantee without cross-harness fallback" do
    capabilities = capabilities()

    assert CapabilityMatcher.executor_compatible?(capabilities, %Configuration{
             harness_kind: "antigravity",
             model: %ModelRef{provider: "shared", model: "same-name"},
             reasoning: "low",
             tools: ["workspace.filesystem", "workspace.search"],
             tool_enforcement: :native_permissions
           })

    refute CapabilityMatcher.executor_compatible?(capabilities, %Configuration{
             harness_kind: "antigravity",
             model: %ModelRef{provider: "shared", model: "same-name"},
             reasoning: "high",
             tools: ["workspace.filesystem", "workspace.search"],
             tool_enforcement: :native_permissions
           })

    refute CapabilityMatcher.executor_compatible?(capabilities, %Configuration{
             harness_kind: "antigravity",
             model: %ModelRef{provider: "shared", model: "same-name"},
             reasoning: "low",
             tools: ["workspace.search"],
             tool_enforcement: :native_permissions
           })

    refute CapabilityMatcher.executor_compatible?(capabilities, %Configuration{
             harness_kind: "pi",
             model: %ModelRef{provider: "shared", model: "same-name"},
             reasoning: "high",
             tools: ["workspace.search"],
             tool_enforcement: :exact
           })
  end

  test "unsupported reasoning is exact and is not a wildcard" do
    capabilities = capabilities()

    base = %Configuration{
      harness_kind: "antigravity",
      model: %ModelRef{provider: "shared", model: "no-effort"},
      reasoning: nil,
      tools: ["workspace.filesystem", "workspace.search"],
      tool_enforcement: :native_permissions
    }

    assert CapabilityMatcher.executor_compatible?(capabilities, base)
    refute CapabilityMatcher.executor_compatible?(capabilities, %{base | reasoning: "high"})
  end

  defp capabilities do
    %{
      "executors" => [
        %{
          "harness_kind" => "pi",
          "models" => [
            %{
              "provider" => "shared",
              "model" => "same-name",
              "display_name" => "Pi Same",
              "reasoning_capability" => %{"kind" => "enumerated", "values" => ["high"]}
            }
          ],
          "tools" => ["workspace.filesystem"],
          "tool_enforcement" => "exact"
        },
        %{
          "harness_kind" => "antigravity",
          "models" => [
            %{
              "provider" => "shared",
              "model" => "same-name",
              "display_name" => "Antigravity Same",
              "reasoning_capability" => %{"kind" => "enumerated", "values" => ["low"]}
            },
            %{
              "provider" => "shared",
              "model" => "no-effort",
              "display_name" => "Antigravity No Effort",
              "reasoning_capability" => %{"kind" => "unsupported"}
            }
          ],
          "tools" => ["workspace.filesystem", "workspace.search"],
          "tool_enforcement" => "native_permissions"
        }
      ]
    }
  end
end
