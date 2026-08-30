defmodule QuestEngineering.Server.WorkerProtocolTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.ExecutionWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.LogicalWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Server.WorkerProtocol

  @worker_id "worker-protocol-test"
  @workspace_id "00000000-0000-4000-8000-000000000001"
  @worktree_id "00000000-0000-4000-8000-000000000002"
  @binding_id "00000000-0000-4000-8000-000000000003"

  test "accepts explicit protocol v4 logical Workspace bindings" do
    assert {:ok, hello} = WorkerProtocol.decode_hello(hello())
    assert hello.worker_id == @worker_id
    assert hello.capabilities["max_concurrency"] == 2
    assert hello.capabilities["tags"] == ["fake"]
    assert hello.capabilities["features"] == ["run_delivery_v1"]
    assert hd(hello.capabilities["workspace_bindings"])["workspace_id"] == @workspace_id
  end

  test "rejects v3 and malformed capabilities" do
    assert {:error, %WorkerProtocol.Error{code: :unsupported_protocol_version}} =
             hello() |> Map.put("protocol_version", 3) |> WorkerProtocol.decode_hello()

    malformed = put_in(hello(), ["capabilities", "max_concurrency"], 0)

    assert {:error, %WorkerProtocol.Error{code: :invalid_capabilities}} =
             WorkerProtocol.decode_hello(malformed)
  end

  test "encodes persisted string source kinds in binding commands" do
    command =
      WorkerProtocol.bind_workspace_source(@worker_id, %{
        binding_id: @binding_id,
        workspace_id: @workspace_id,
        workspace_key: "test",
        source_kind: "git_remote",
        source_fingerprint: "github.com:example/repository",
        candidate_id: "candidate"
      })

    assert command["binding"]["source_kind"] == "git_remote"
  end

  test "decodes authoritative Delivery evidence messages" do
    payload = %{
      "type" => "run_delivery_inspected",
      "protocol_version" => 4,
      "worker_id" => @worker_id,
      "delivery" => %{
        "delivery_id" => Ecto.UUID.generate(),
        "run_id" => "run",
        "worktree_id" => @worktree_id,
        "identity_hash" => "identity",
        "fingerprint" => String.duplicate("a", 64),
        "evidence" => %{"summary" => %{"files_changed" => 1}},
        "no_changes" => false,
        "base_revision" => String.duplicate("b", 40),
        "base_branch_name" => "main",
        "branch_name" => "qe/run/11111111111111111111111111111111",
        "head_before_finalize" => String.duplicate("c", 40),
        "repository_host" => "github.com",
        "repository_identity" => "owner/repo",
        "remote_name" => "origin"
      }
    }

    assert {:ok, %{type: :run_delivery_inspected, delivery: %{no_changes: false}}} =
             WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "accepts uncertain reconciliation only with structured failure" do
    payload = %{
      "type" => "dispatch_state",
      "protocol_version" => 4,
      "worker_id" => @worker_id,
      "action_id" => "action",
      "occurrence_id" => "occurrence",
      "attempt_id" => "attempt",
      "state" => "uncertain",
      "failure" => %{"reason" => "ambiguous"}
    }

    assert {:ok, %{state: :uncertain}} = WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "encodes logical and physical execution workspaces separately" do
    encoded = WorkerProtocol.execute_action(@worker_id, execution())
    wire = encoded["execution"]

    assert encoded["protocol_version"] == 4
    assert wire["configuration"]["model"] == %{"provider" => "fake", "model" => "test"}

    assert wire["logical_workspace"] == %{
             "workspace_id" => @workspace_id,
             "workspace_key" => "test"
           }

    assert wire["execution_workspace"]["worktree_id"] == @worktree_id
    assert wire["execution_workspace"]["canonical_root"] == "/workspace"
    refute Map.has_key?(wire, "performer_requirement")
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
        tools: ["custom.qe-capability"]
      },
      logical_workspace: %LogicalWorkspace{workspace_id: @workspace_id, workspace_key: "test"},
      execution_workspace: %ExecutionWorkspace{
        worktree_id: @worktree_id,
        workspace_binding_id: @binding_id,
        canonical_root: "/workspace",
        access: :read_write
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
      "protocol_version" => 4,
      "worker_id" => @worker_id,
      "capabilities" => %{
        "os" => "test",
        "arch" => "test",
        "max_concurrency" => 2,
        "tags" => ["fake", "fake"],
        "features" => ["run_delivery_v1"],
        "executors" => [
          %{
            "adapter" => "other-executor",
            "models" => [%{"provider" => "fake", "model" => "test"}],
            "reasoning" => ["medium"],
            "tools" => ["custom.qe-capability"]
          }
        ],
        "workspace_bindings" => [
          %{
            "binding_id" => @binding_id,
            "workspace_id" => @workspace_id,
            "authorized_root_key" => "test",
            "source_repository_root" => "/workspace",
            "source_fingerprint" => nil,
            "max_access" => "read_write",
            "allow_unconfined_shell" => true
          }
        ]
      }
    }
  end
end
