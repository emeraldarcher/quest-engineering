defmodule QuestEngineering.Server.WorkerProtocolTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Server.WorkerProtocol

  @worker_id "worker-protocol-test"

  test "accepts the explicit protocol v3 hello and normalized executor capabilities" do
    assert {:ok, hello} = WorkerProtocol.decode_hello(hello())
    assert hello.worker_id == @worker_id
    assert hello.capabilities["max_concurrency"] == 2
    assert hello.capabilities["tags"] == ["fake"]
    assert hd(hello.capabilities["executors"])["adapter"] == "other-executor"
  end

  test "rejects v2 and malformed capabilities" do
    assert {:error, %WorkerProtocol.Error{code: :unsupported_protocol_version}} =
             hello() |> Map.put("protocol_version", 2) |> WorkerProtocol.decode_hello()

    malformed = put_in(hello(), ["capabilities", "max_concurrency"], 0)

    assert {:error, %WorkerProtocol.Error{code: :invalid_capabilities}} =
             WorkerProtocol.decode_hello(malformed)
  end

  test "rejects unknown messages without creating atoms" do
    payload = %{
      "type" => "not_a_real_message_#{System.unique_integer([:positive])}",
      "protocol_version" => 3,
      "worker_id" => @worker_id
    }

    assert {:error, %WorkerProtocol.Error{code: :unknown_message_type}} =
             WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "accepts uncertain reconciliation only with structured failure" do
    payload = %{
      "type" => "dispatch_state",
      "protocol_version" => 3,
      "worker_id" => @worker_id,
      "action_id" => "action",
      "occurrence_id" => "occurrence",
      "attempt_id" => "attempt",
      "state" => "uncertain",
      "failure" => %{"reason" => "ambiguous"}
    }

    assert {:ok, %{state: :uncertain}} =
             WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "encodes immutable ResolvedExecution without unresolved product requirements" do
    execution = execution()
    encoded = WorkerProtocol.execute_action(@worker_id, execution)
    wire = encoded["execution"]

    assert encoded["protocol_version"] == 3
    assert wire["identity"]["action_id"] == execution.identity.action_id
    assert wire["work"]["quest_objective"] == "Ship the Quest"
    assert wire["work"]["class_instructions"] == "Build carefully."
    assert wire["configuration"]["model"] == %{"provider" => "fake", "model" => "test"}
    assert wire["performer"]["member_key"] == "alice"
    refute Map.has_key?(wire, "performer_requirement")
    refute Map.has_key?(wire, "context_requirement")
    refute Map.has_key?(wire, "pi_session")
  end

  defp execution do
    %ResolvedExecution{
      identity: %Identity{
        launch_id: "launch",
        action_id: "action",
        run_id: "run",
        occurrence_id: "occurrence",
        attempt_id: "attempt",
        semantic_step_key: "build"
      },
      performer: %Performer{
        member_key: "alice",
        member_name: "Alice",
        class_key: "builder",
        class_name: "Builder"
      },
      work: %Work{
        quest_objective: "Ship the Quest",
        class_instructions: "Build carefully.",
        step_instruction: "Implement.",
        inputs: %{
          "plan" => %ArtifactInstance{
            id: "artifact",
            type: "plan",
            producer_occurrence_id: "plan-occurrence",
            value: %{"summary" => "ship"}
          }
        },
        declared_outputs: ["change_set"]
      },
      configuration: %Configuration{
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :medium,
        tools: ["custom.qe-capability"],
        workspace_ref: "workspace:test",
        workspace_root: "/workspace",
        workspace_access: :read_write
      },
      context: %Context{
        mode: :fresh,
        source_occurrence_id: nil,
        logical_lineage_id: Ecto.UUID.generate()
      }
    }
  end

  defp hello do
    %{
      "type" => "worker_hello",
      "protocol_version" => 3,
      "worker_id" => @worker_id,
      "capabilities" => %{
        "os" => "test",
        "arch" => "test",
        "max_concurrency" => 2,
        "tags" => ["fake", "fake"],
        "executors" => [
          %{
            "adapter" => "other-executor",
            "models" => [%{"provider" => "fake", "model" => "test"}],
            "reasoning" => ["medium"],
            "tools" => ["custom.qe-capability"],
            "workspaces" => [
              %{
                "ref" => "workspace:test",
                "root" => "/workspace",
                "max_access" => "read_write"
              }
            ]
          }
        ]
      }
    }
  end
end
