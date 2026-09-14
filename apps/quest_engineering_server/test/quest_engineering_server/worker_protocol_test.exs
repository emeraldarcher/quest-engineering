defmodule QuestEngineering.Server.WorkerProtocolTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.ToolPolicy.Exact
  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.ExecutionWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.LogicalWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.ReasoningCapability
  alias QuestEngineering.Core.ResolvedExecution.ToolProfile
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Tactics.ArtifactOutput
  alias QuestEngineering.Server.WorkerProtocol

  @worker_id "worker-protocol-test"
  @workspace_id "00000000-0000-4000-8000-000000000001"
  @worktree_id "00000000-0000-4000-8000-000000000002"
  @binding_id "00000000-0000-4000-8000-000000000003"

  test "accepts explicit protocol v7 logical Workspace bindings" do
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

  test "reasoning capability distinguishes unsupported from unknown" do
    unsupported =
      put_in(
        hello(),
        [
          "capabilities",
          "executors",
          Access.at(0),
          "models",
          Access.at(0),
          "reasoning_capability"
        ],
        %{"kind" => "unsupported"}
      )

    assert {:ok, _hello} = WorkerProtocol.decode_hello(unsupported)

    unknown =
      put_in(
        hello(),
        [
          "capabilities",
          "executors",
          Access.at(0),
          "models",
          Access.at(0),
          "reasoning_capability"
        ],
        %{"kind" => "unknown"}
      )

    assert {:error, %WorkerProtocol.Error{code: :invalid_capabilities}} =
             WorkerProtocol.decode_hello(unknown)
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
      "protocol_version" => 7,
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
      "protocol_version" => 7,
      "worker_id" => @worker_id,
      "action_id" => "action",
      "occurrence_id" => "occurrence",
      "attempt_id" => "attempt",
      "state" => "uncertain",
      "failure" => %{"reason" => "ambiguous"}
    }

    assert {:ok, %{state: :uncertain}} = WorkerProtocol.decode_worker_message(payload, @worker_id)
  end

  test "normalizes classified failures and validates retained recovery requests" do
    failed = %{
      "type" => "step_failed",
      "protocol_version" => 7,
      "worker_id" => @worker_id,
      "action_id" => "action",
      "occurrence_id" => "occurrence",
      "attempt_id" => "attempt",
      "failure" => %{"reason" => "transient", "classification" => "auto_retryable"}
    }

    assert {:ok, %{failure: %{"classification" => "auto_retryable"}}} =
             WorkerProtocol.decode_worker_message(failed, @worker_id)

    assert {:ok, %{failure: %{"classification" => "operator_recovery_required"}}} =
             failed
             |> put_in(["failure"], %{"reason" => "legacy"})
             |> WorkerProtocol.decode_worker_message(@worker_id)

    recovery = %{
      "type" => "human_recovery_requested",
      "protocol_version" => 7,
      "worker_id" => @worker_id,
      "recovery" => %{
        "request_id" => "request",
        "run_id" => "run",
        "occurrence_id" => "occurrence",
        "attempt_id" => "attempt",
        "action_id" => "action",
        "member_key" => "builder",
        "session_id" => "lineage",
        "lineage_id" => "lineage",
        "native_session_id" => "pi-session"
      }
    }

    assert {:ok, %{type: :human_recovery_requested, recovery: %{request_id: "request"}}} =
             WorkerProtocol.decode_worker_message(recovery, @worker_id)
  end

  test "decodes Product-safe harness session and structured attention state" do
    payload = %{
      "type" => "session_state",
      "protocol_version" => 7,
      "worker_id" => @worker_id,
      "session" => %{
        "session_id" => "session-1",
        "action_id" => "action",
        "run_id" => "run",
        "occurrence_id" => "occurrence",
        "attempt_id" => "attempt",
        "member_key" => "alice",
        "harness_kind" => "pi",
        "harness_display_name" => "Pi",
        "state" => "waiting_for_human",
        "capabilities" => %{
          "can_attach_terminal" => true,
          "can_send_input" => true,
          "can_interrupt" => true,
          "can_detect_attention" => true,
          "can_resume" => true,
          "can_observe_structured_events" => true,
          "structured_confirmation" => true,
          "structured_text_response" => false,
          "structured_choice_response" => false,
          "structured_multiline_response" => false,
          "native_prompt_control" => true,
          "conversational_takeover" => true,
          "automation_resume" => true
        },
        "terminal" => %{
          "attachment_mode" => "local_native_terminal",
          "backend_kind" => "herdr",
          "terminal_session_id" => "worker",
          "terminal_target_id" => "qe-agent",
          "supports_observation" => true,
          "supports_takeover" => true
        },
        "native_session_id" => "pi-session",
        "attention" => %{
          "attention_id" => "attention-1",
          "category" => "needs_input",
          "message" => "Choose an option.",
          "requested_at" => "2026-09-06T00:00:00Z",
          "interaction" => %{
            "kind" => "conversational_intervention",
            "control_state" => "intervention_pending",
            "resume_command" => "/qe-resume"
          }
        },
        "intervention" => %{
          "attention_id" => "attention-1",
          "kind" => "conversational_intervention",
          "state" => "intervention_pending",
          "requested_at" => "2026-09-06T00:00:00Z"
        },
        "started_at" => "2026-09-06T00:00:00Z",
        "last_activity_at" => "2026-09-06T00:00:01Z"
      }
    }

    assert {:ok,
            %{
              type: :session_state,
              session: %{
                state: :waiting_for_human,
                attention: attention,
                intervention: intervention,
                capabilities: capabilities
              }
            }} = WorkerProtocol.decode_worker_message(payload, @worker_id)

    assert attention["category"] == "needs_input"
    assert attention["interaction"]["resume_command"] == "/qe-resume"
    assert intervention["state"] == "intervention_pending"
    assert capabilities["conversational_takeover"]

    invalid = put_in(payload, ["session", "attention", "category"], "provider-prose")

    assert {:error, %WorkerProtocol.Error{field: "session.attention"}} =
             WorkerProtocol.decode_worker_message(invalid, @worker_id)
  end

  test "encodes logical and physical execution workspaces separately" do
    encoded = WorkerProtocol.execute_action(@worker_id, execution())
    wire = encoded["execution"]

    assert encoded["protocol_version"] == 7
    assert wire["configuration"]["harness_kind"] == "fake"
    assert wire["configuration"]["model"] == %{"provider" => "fake", "model" => "test"}

    assert wire["logical_workspace"] == %{
             "workspace_id" => @workspace_id,
             "workspace_key" => "test"
           }

    assert wire["execution_workspace"]["worktree_id"] == @worktree_id
    assert wire["execution_workspace"]["canonical_root"] == "/workspace"
    refute Map.has_key?(wire, "performer_requirement")
    refute Map.has_key?(wire, "pi_session")
    assert wire["configuration"]["reasoning"] == "medium"

    assert wire["configuration"]["reasoning_capability"] == %{
             "kind" => "enumerated",
             "values" => ["medium"]
           }

    assert wire["configuration"]["tool_policy"] == %{
             "kind" => "exact",
             "tools" => ["custom.qe-capability"]
           }

    assert wire["configuration"]["tool_enforcement"] == "exact"

    assert wire["configuration"]["resolved_tool_profile"] == %{
             "tools" => ["custom.qe-capability"]
           }

    malformed = put_in(execution().configuration.reasoning, nil)

    assert_raise ArgumentError, fn ->
      WorkerProtocol.execute_action(@worker_id, malformed)
    end

    no_effort = %{
      execution()
      | configuration: %{
          execution().configuration
          | reasoning: nil,
            reasoning_capability: %ReasoningCapability{kind: :unsupported, values: []}
        }
    }

    no_effort_wire = WorkerProtocol.execute_action(@worker_id, no_effort)
    assert no_effort_wire["execution"]["configuration"]["reasoning"] == nil
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
            kind: "quest_plan",
            output_name: "plan",
            producer_occurrence_id: "plan-occurrence",
            value: %{"summary" => "ship"}
          }
        },
        declared_outputs: [%ArtifactOutput{name: "change_set", kind: "change_set"}]
      },
      configuration: %Configuration{
        harness_kind: "fake",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: "medium",
        reasoning_capability: %ReasoningCapability{kind: :enumerated, values: ["medium"]},
        tool_policy: %Exact{tools: ["custom.qe-capability"]},
        tool_enforcement: :exact,
        resolved_tool_profile: %ToolProfile{tools: ["custom.qe-capability"]}
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
      "protocol_version" => 7,
      "worker_id" => @worker_id,
      "capabilities" => %{
        "os" => "test",
        "arch" => "test",
        "max_concurrency" => 2,
        "tags" => ["fake", "fake"],
        "features" => ["run_delivery_v1"],
        "executors" => [
          %{
            "harness_kind" => "other-executor",
            "models" => [
              %{
                "provider" => "fake",
                "model" => "test",
                "display_name" => "Test model",
                "reasoning_capability" => %{
                  "kind" => "enumerated",
                  "values" => ["medium"]
                }
              }
            ],
            "supported_tool_policies" => ["exact"],
            "tool_enforcement" => "exact",
            "tool_profile" => %{"tools" => ["custom.qe-capability"]}
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
