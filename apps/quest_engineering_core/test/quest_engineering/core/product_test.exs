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
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Product.Workspace
  alias QuestEngineering.Core.ResolvedExecution.Builder, as: ResolvedExecutionBuilder
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
        | tools: ["workspace.filesystem", "workspace.filesystem", "Pi Native Read"]
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
      assert Enum.all?(coding_loadout().tools, &is_binary/1)
      assert is_binary(hd(engineering_squad().members).key)
    end
  end

  describe "pure launch snapshot construction" do
    test "compiles the embedded Tactic and resolves exact Class and Loadout values" do
      assert {:ok, snapshot} = valid_snapshot()

      assert %LaunchSnapshot{schema_version: 3} = snapshot

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

      assert Enum.any?(errors, &(&1.code == :unknown_local_step_reference))
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
            canonical_root: "/canonical/run-worktree"
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
  end

  defp valid_snapshot do
    Builder.build(
      quest(),
      workspace(),
      engineering_squad(),
      [builder_class(), reviewer_class()],
      [coding_loadout(), review_loadout()],
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
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: :medium,
      tools: ["workspace.filesystem", "terminal.shell"],
      workspace_access: :read_write
    }
  end

  defp review_loadout do
    %Loadout{
      id: "loadout-review-id",
      key: "review",
      name: "Review",
      description: "Read-only review capabilities.",
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: :high,
      tools: ["workspace.filesystem", "workspace.search"],
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
              produces: ["change_set"]
            ),
            step("review",
              name: "Review",
              instruction: "Review the current change_set.",
              performer: class("reviewer"),
              consumes: [artifact("change_set", from: "implement")],
              produces: ["verdict"]
            )
          ])
      }
    }
  end
end
