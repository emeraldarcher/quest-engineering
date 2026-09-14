defmodule QuestEngineering.Core.ProductTest do
  use ExUnit.Case, async: true

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.Class
  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.Builder
  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.Member
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.Quest
  alias QuestEngineering.Core.Product.Squad
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Core.Product.ToolPolicy.Exact
  alias QuestEngineering.Core.Product.ToolPolicy.NativePermissions
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Product.Workspace
  alias QuestEngineering.Core.ResolvedExecution.Builder, as: ResolvedExecutionBuilder
  alias QuestEngineering.Core.ResolvedExecution.ReasoningCapability
  alias QuestEngineering.Core.ResolvedExecution.ToolProfile
  alias QuestEngineering.Core.Runtime

  describe "definition validation" do
    test "Class requires behavioral instructions and contains no capability configuration" do
      class = %{builder_class() | instructions: "   "}

      assert {:error, errors} = Validation.validate(class)
      assert Enum.any?(errors, &(&1.code == :invalid_instructions))
      refute Map.has_key?(Map.from_struct(builder_class()), :model)
      refute Map.has_key?(Map.from_struct(builder_class()), :tools)
    end

    test "Loadout accepts QE capability identifiers and contains no behavioral fields" do
      loadout = coding_loadout()

      assert {:ok, ^loadout} = Validation.validate(loadout)
      fields = Map.from_struct(loadout)
      refute Map.has_key?(fields, :instructions)
      refute Map.has_key?(fields, :system_prompt)
      refute Map.has_key?(fields, :runtime)
      refute Map.has_key?(fields, :agent_kind)
    end

    test "Loadout rejects duplicate or malformed capability keys" do
      loadout = %{
        coding_loadout()
        | tool_policy: %Exact{
            tools: ["workspace.filesystem", "workspace.filesystem", "Pi Native Read"]
          }
      }

      assert {:error, errors} = Validation.validate(loadout)
      assert Enum.any?(errors, &(&1.code == :duplicate_tool_key))
      assert Enum.any?(errors, &(&1.code == :invalid_tool_key))
    end

    test "Squad owns an ordered roster with Squad-scoped unique Member keys" do
      squad = %{
        engineering_squad()
        | members: engineering_squad().members ++ engineering_squad().members
      }

      assert {:error, errors} =
               Validation.validate_roster(
                 squad,
                 [builder_class(), reviewer_class()],
                 [coding_loadout(), review_loadout()]
               )

      assert Enum.any?(errors, &(&1.code == :duplicate_member_key))
    end

    test "open product identities remain strings" do
      assert is_binary(builder_class().id)
      assert is_binary(builder_class().key)
      assert is_binary(coding_loadout().model.provider)
      assert Enum.all?(coding_loadout().tool_policy.tools, &is_binary/1)
      assert is_binary(hd(engineering_squad().members).key)
    end
  end

  describe "pure launch snapshot construction" do
    test "compiles the embedded Tactic and resolves exact Class and Loadout values" do
      assert {:ok, snapshot} = valid_snapshot()

      assert %LaunchSnapshot{schema_version: 7} = snapshot

      assert snapshot.quest.objective ==
               "Implement and independently review the requested change."

      assert snapshot.workspace.key == "quest"
      refute Map.has_key?(Map.from_struct(snapshot.workspace), :root)
      assert Enum.map(snapshot.squad.members, & &1.key) == ["alice", "reviewer"]
      assert hd(snapshot.squad.members).class.instructions == builder_class().instructions
      assert hd(snapshot.squad.members).loadout.model == coding_loadout().model
      assert Enum.map(snapshot.execution_plan.steps, & &1.key) == ["implement", "review"]
      refute Map.has_key?(Map.from_struct(snapshot), :run_id)
      refute Map.has_key?(Map.from_struct(snapshot), :launch_id)
    end

    test "freezes unsupported reasoning and native tool policy without a fake effort" do
      unsupported = %{
        coding_loadout()
        | harness: "antigravity",
          model: %ModelRef{provider: "antigravity", model: "no-effort"},
          reasoning: nil,
          tool_policy: %NativePermissions{}
      }

      assert {:ok, snapshot} = valid_snapshot([unsupported, review_loadout()])
      frozen = hd(snapshot.squad.members).loadout
      assert frozen.reasoning == nil
      assert frozen.tool_policy == %NativePermissions{}
    end

    test "a later definition mutation cannot change an existing snapshot" do
      assert {:ok, snapshot} = valid_snapshot()

      updated_class = %{builder_class() | instructions: "Builder instructions version B"}

      updated_loadout = %{
        coding_loadout()
        | model: %ModelRef{provider: "anthropic", model: "model-b"}
      }

      assert snapshot.squad.members |> hd() |> Map.fetch!(:class) |> Map.fetch!(:instructions) ==
               "Builder instructions version A"

      assert snapshot.squad.members |> hd() |> Map.fetch!(:loadout) |> Map.fetch!(:model) ==
               %ModelRef{provider: "openai-codex", model: "model-a"}

      assert updated_class.instructions == "Builder instructions version B"
      assert updated_loadout.model.model == "model-b"
    end

    test "a missing performer Class blocks snapshot construction" do
      quest = %{
        quest()
        | tactic_source: %Inline{
            body:
              step("research",
                name: "Research",
                instruction: "Research.",
                performer: class("researcher")
              )
          }
      }

      assert {:error, errors} =
               Builder.build(
                 quest,
                 workspace(),
                 engineering_squad(),
                 [builder_class(), reviewer_class()],
                 [coding_loadout(), review_loadout()],
                 Catalog.empty()
               )

      assert [missing] = Enum.filter(errors, &(&1.code == :unsatisfied_performer_class))
      assert missing.details == %{step_key: "research", class_key: "researcher"}
    end

    test "one matching Member structurally satisfies parallel work without promising concurrency" do
      tactic =
        parallel([
          step("backend",
            name: "Backend",
            instruction: "Build backend.",
            performer: class("builder")
          ),
          step("frontend",
            name: "Frontend",
            instruction: "Build frontend.",
            performer: class("builder")
          )
        ])

      assert {:ok, snapshot} =
               Builder.build(
                 %{quest() | tactic_source: %Inline{body: tactic}},
                 workspace(),
                 %{engineering_squad() | members: [hd(engineering_squad().members)]},
                 [builder_class()],
                 [coding_loadout()],
                 Catalog.empty()
               )

      assert Enum.map(snapshot.execution_plan.steps, & &1.key) == ["backend", "frontend"]
    end

    test "same_as remains semantic and compiles without pre-binding a Member" do
      tactic =
        sequence([
          step("implement",
            name: "Implement",
            instruction: "Implement.",
            performer: class("builder")
          ),
          step("repair", name: "Repair", instruction: "Repair.", performer: same_as("implement"))
        ])

      assert {:ok, snapshot} =
               Builder.build(
                 %{quest() | tactic_source: %Inline{body: tactic}},
                 workspace(),
                 engineering_squad(),
                 [builder_class(), reviewer_class()],
                 [coding_loadout(), review_loadout()],
                 Catalog.empty()
               )

      repair = Enum.find(snapshot.execution_plan.steps, &(&1.key == "repair"))
      assert repair.performer == same_as("implement")
      refute Map.has_key?(Map.from_struct(repair), :member_key)
    end

    test "invalid same_as references return structured product validation errors" do
      tactic =
        step("repair", name: "Repair", instruction: "Repair.", performer: same_as("missing"))

      assert {:error, errors} =
               Builder.build(
                 %{quest() | tactic_source: %Inline{body: tactic}},
                 workspace(),
                 engineering_squad(),
                 [builder_class(), reviewer_class()],
                 [coding_loadout(), review_loadout()],
                 Catalog.empty()
               )

      assert Enum.any?(errors, &(&1.code == :unknown_local_reference))
    end
  end

  describe "resolved execution construction" do
    test "keeps work, performer, configuration, and logical context provider-neutral" do
      assert {:ok, snapshot} = valid_snapshot()
      assert {:ok, _run, [action]} = Runtime.start(snapshot.execution_plan, "run-resolved")
      member = hd(snapshot.squad.members)

      execution =
        ResolvedExecutionBuilder.build(
          snapshot,
          action,
          "launch-resolved",
          member,
          "logical-lineage",
          nil,
          %{
            worktree_id: "worktree-id",
            workspace_binding_id: "binding-id",
            canonical_root: "/canonical/run-worktree",
            reasoning_capability: %ReasoningCapability{
              kind: :enumerated,
              values: [member.loadout.reasoning]
            },
            tool_enforcement: :exact,
            resolved_tool_profile: %ToolProfile{tools: member.loadout.tool_policy.tools}
          }
        )

      assert execution.work.quest_objective == snapshot.quest.objective
      assert execution.work.class_instructions == member.class.instructions
      assert execution.work.step_instruction == action.instruction
      assert execution.performer.member_key == "alice"
      assert execution.configuration.model == member.loadout.model
      assert execution.context.mode == :fresh
      refute Map.has_key?(Map.from_struct(execution), :worker_id)
      refute Map.has_key?(Map.from_struct(execution.context), :pi_lineage_id)
    end

    test "keeps acceptance choreography local to Implement while Review retains shared context" do
      objective =
        "Create a harmless test file according to the instructions you receive during implementation."

      forced_takeover =
        "Before making repository changes, immediately request conversational intervention and wait for explicit /qe-resume before implementing the human guidance."

      review_instruction =
        "Review the implementation against the Quest requirements. Do not deliberately invoke the takeover acceptance mechanism; request human assistance only for a genuine blocker."

      tactic =
        sequence([
          step("implement",
            name: "Implement",
            instruction: forced_takeover,
            performer: class("builder"),
            context: fresh(),
            produces: [output("change_set", "change_set")]
          ),
          step("review",
            name: "Review",
            instruction: review_instruction,
            performer: class("reviewer"),
            context: fresh(),
            consumes: [input("change_set", "change_set", from: ref("implement", "change_set"))],
            produces: [output("verdict", "check_result")]
          )
        ])

      assert {:ok, snapshot} =
               Builder.build(
                 %{quest() | objective: objective, tactic_source: %Inline{body: tactic}},
                 workspace(),
                 engineering_squad(),
                 [builder_class(), reviewer_class()],
                 [coding_loadout(), review_loadout()],
                 Catalog.empty()
               )

      assert {:ok, run, [implement]} = Runtime.start(snapshot.execution_plan, "acceptance-run")
      builder = Enum.find(snapshot.squad.members, &(&1.key == "alice"))

      implement_execution =
        ResolvedExecutionBuilder.build(
          snapshot,
          implement,
          "acceptance-launch",
          builder,
          "builder-lineage",
          nil,
          execution_workspace("builder-worktree", "medium", [
            "workspace.filesystem",
            "terminal.shell"
          ])
        )

      assert implement_execution.work.quest_objective == objective
      assert implement_execution.work.step_instruction == forced_takeover

      assert {:ok, _run, [review]} =
               Runtime.transition(
                 run,
                 Runtime.completed(implement, %{
                   "change_set" => %{"files" => ["human-picked.txt"]}
                 })
               )

      reviewer = Enum.find(snapshot.squad.members, &(&1.key == "reviewer"))

      review_execution =
        ResolvedExecutionBuilder.build(
          snapshot,
          review,
          "acceptance-launch",
          reviewer,
          "reviewer-lineage",
          nil,
          execution_workspace("reviewer-worktree", "high", [
            "workspace.filesystem",
            "workspace.search"
          ])
        )

      assert review_execution.work.quest_objective == objective
      assert review_execution.work.step_instruction == review_instruction
      assert review_execution.work.class_instructions == reviewer_class().instructions

      assert review_execution.work.inputs["change_set"].value == %{
               "files" => ["human-picked.txt"]
             }

      refute review_execution.work.step_instruction =~ "Before making repository changes"
      refute inspect(review_execution.work) =~ forced_takeover
    end
  end

  defp execution_workspace(worktree_id, reasoning, tools),
    do: %{
      worktree_id: worktree_id,
      workspace_binding_id: "binding-id",
      canonical_root: "/canonical/run-worktree",
      access: :read_write,
      reasoning_capability: %ReasoningCapability{kind: :enumerated, values: [reasoning]},
      tool_enforcement: :exact,
      resolved_tool_profile: %ToolProfile{tools: tools}
    }

  defp valid_snapshot(loadouts \\ [coding_loadout(), review_loadout()]) do
    Builder.build(
      quest(),
      workspace(),
      engineering_squad(),
      [builder_class(), reviewer_class()],
      loadouts,
      Catalog.empty()
    )
  end

  defp builder_class do
    %Class{
      id: "class-builder-id",
      key: "builder",
      name: "Builder",
      description: "Builds production changes.",
      instructions: "Builder instructions version A"
    }
  end

  defp reviewer_class do
    %Class{
      id: "class-reviewer-id",
      key: "reviewer",
      name: "Reviewer",
      description: "Reviews independently.",
      instructions: "Be rigorous, skeptical, independent, and evidence-driven."
    }
  end

  defp coding_loadout do
    %Loadout{
      id: "loadout-coding-id",
      key: "coding",
      name: "Coding",
      description: "Writable engineering capabilities.",
      harness: "pi",
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: "medium",
      tool_policy: %Exact{tools: ["workspace.filesystem", "terminal.shell"]},
      workspace_access: :read_write
    }
  end

  defp review_loadout do
    %Loadout{
      id: "loadout-review-id",
      key: "review",
      name: "Review",
      description: "Read-only review capabilities.",
      harness: "pi",
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: "high",
      tool_policy: %Exact{tools: ["workspace.filesystem", "workspace.search"]},
      workspace_access: :read_only
    }
  end

  defp engineering_squad do
    %Squad{
      id: "squad-engineering-id",
      key: "engineering",
      name: "Engineering",
      description: "Builder and reviewer roster.",
      members: [
        %Member{
          key: "alice",
          name: "Alice",
          class_id: builder_class().id,
          loadout_id: coding_loadout().id
        },
        %Member{
          key: "reviewer",
          name: "Reviewer",
          class_id: reviewer_class().id,
          loadout_id: review_loadout().id
        }
      ]
    }
  end

  defp workspace do
    %Workspace{
      id: "workspace-id",
      key: "quest",
      name: "Quest Engineering",
      source_kind: :local_git,
      source_fingerprint: nil
    }
  end

  defp quest do
    %Quest{
      id: "quest-id",
      title: "Implement feature",
      objective: "Implement and independently review the requested change.",
      workspace_id: workspace().id,
      squad_id: engineering_squad().id,
      tactic_source: %Inline{
        body:
          sequence([
            step("implement",
              name: "Implement",
              instruction: "Implement the requested change.",
              performer: class("builder"),
              produces: [output("change_set", "change_set")]
            ),
            step("review",
              name: "Review",
              instruction: "Review the current change_set.",
              performer: class("reviewer"),
              consumes: [input("change_set", "change_set", from: ref("implement", "change_set"))],
              produces: [output("verdict", "check_result")]
            )
          ])
      }
    }
  end
end
