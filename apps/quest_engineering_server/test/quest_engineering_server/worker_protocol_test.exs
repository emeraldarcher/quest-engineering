defmodule QuestEngineering.Server.WorkerProtocolTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Server.WorkerProtocol

  @worker_id "worker-protocol-test"

  test "accepts the explicit protocol v2 hello and normalizes capability lists" do
    assert {:ok, hello} = WorkerProtocol.decode_hello(hello())
    assert hello.worker_id == @worker_id
    assert hello.capabilities["max_concurrency"] == 2
    assert hello.capabilities["tags"] == ["fake"]
  end

  test "rejects v1 and malformed capabilities" do
    assert {:error, %WorkerProtocol.Error{code: :unsupported_protocol_version}} =
             hello()
             |> Map.put("protocol_version", 1)
             |> WorkerProtocol.decode_hello()

    malformed = put_in(hello(), ["capabilities", "max_concurrency"], 0)

    assert {:error, %WorkerProtocol.Error{code: :invalid_capabilities}} =
             WorkerProtocol.decode_hello(malformed)
  end

  test "rejects unknown messages without creating atoms" do
    payload = %{
      "type" => "not_a_real_message_#{System.unique_integer([:positive])}",
      "protocol_version" => 2,
      "worker_id" => @worker_id
    }

    assert {:error, %WorkerProtocol.Error{code: :unknown_message_type}} =
             WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "rejects mismatched Worker identity and malformed dispatch identity" do
    heartbeat = %{
      "type" => "worker_heartbeat",
      "protocol_version" => 2,
      "worker_id" => "different-worker"
    }

    assert {:error, %WorkerProtocol.Error{code: :worker_id_mismatch}} =
             WorkerProtocol.decode_worker_message(heartbeat, @worker_id)

    accepted = %{
      "type" => "dispatch_accepted",
      "protocol_version" => 2,
      "worker_id" => @worker_id,
      "action_id" => "action"
    }

    assert {:error,
            %WorkerProtocol.Error{code: :missing_or_invalid_field, field: "occurrence_id"}} =
             WorkerProtocol.decode_worker_message(accepted, @worker_id)
  end

  test "rejects invalid reconcile states and artifact values" do
    reconcile = %{
      "type" => "reconcile_state",
      "protocol_version" => 2,
      "worker_id" => @worker_id,
      "dispatches" => [
        %{
          "action_id" => "action",
          "occurrence_id" => "occurrence",
          "attempt_id" => "attempt",
          "state" => "invented"
        }
      ]
    }

    assert {:error, %WorkerProtocol.Error{code: :invalid_field, field: "state"}} =
             WorkerProtocol.decode_worker_message(reconcile, @worker_id)

    completed = %{
      "type" => "step_completed",
      "protocol_version" => 2,
      "worker_id" => @worker_id,
      "action_id" => "action",
      "occurrence_id" => "occurrence",
      "attempt_id" => "attempt",
      "outputs" => %{"artifact" => self()}
    }

    assert {:error, %WorkerProtocol.Error{code: :invalid_artifact_value}} =
             WorkerProtocol.decode_worker_message(completed, @worker_id)
  end

  test "encodes an Action through an explicit provider-independent wire adapter" do
    action = %Action{
      id: "run/occurrence/attempt/action/execute-step",
      type: :execute_step,
      run_id: "run",
      occurrence_id: "occurrence",
      attempt_id: "attempt",
      semantic_step_key: "build",
      instruction: "Implement the supplied plan and produce a change set.",
      performer_requirement: %PerformerRequirement{selector: :class, value: "builder"},
      performer_affinity_occurrence_id: nil,
      context_requirement: %ContextRequirement{selector: :fresh, value: nil},
      context_lineage_occurrence_id: nil,
      inputs: %{
        "plan" => %ArtifactInstance{
          id: "artifact",
          type: "plan",
          producer_occurrence_id: "plan-occurrence",
          value: %{"summary" => "ship"}
        }
      },
      declared_outputs: ["change_set"]
    }

    encoded = WorkerProtocol.execute_action(@worker_id, action)
    assert encoded["type"] == "execute_action"
    assert encoded["protocol_version"] == 2
    assert encoded["action_id"] == action.id
    assert encoded["instruction"] == action.instruction
    assert encoded["performer_requirement"] == %{"selector" => "class", "value" => "builder"}
    assert encoded["inputs"]["plan"]["value"] == %{"summary" => "ship"}
    refute Map.has_key?(encoded, "herdr_session")
    refute Map.has_key?(encoded, "pi_session")

    assert_raise ArgumentError, ~r/requires a valid non-empty instruction/, fn ->
      WorkerProtocol.execute_action(@worker_id, %{action | instruction: "  "})
    end
  end

  defp hello do
    %{
      "type" => "worker_hello",
      "protocol_version" => 2,
      "worker_id" => @worker_id,
      "capabilities" => %{
        "os" => "test",
        "arch" => "test",
        "max_concurrency" => 2,
        "tags" => ["fake", "fake"],
        "capabilities" => ["git"]
      }
    }
  end
end
