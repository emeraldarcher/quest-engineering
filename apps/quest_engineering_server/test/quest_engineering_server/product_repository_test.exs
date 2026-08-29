defmodule QuestEngineering.Server.Product.RepositoryTest do
  use QuestEngineering.Server.DataCase, async: true

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo

  test "persists mutable Classes while keeping keys immutable and archival non-destructive" do
    assert {:ok, class} =
             Products.create_class(%{
               key: "builder",
               name: "Builder",
               instructions: "Build carefully."
             })

    assert {:ok, updated} =
             Products.update_class(class.id, %{
               name: "Senior Builder",
               instructions: "Build carefully and verify evidence."
             })

    assert updated.key == "builder"
    assert updated.name == "Senior Builder"

    assert {:error, [%{code: :immutable_key}]} =
             Products.update_class(class.id, %{key: "renamed-builder"})

    assert :ok = Products.archive_class(class.id)
    assert {:error, %{code: :not_found}} = Products.get_class(class.id)
    assert {:ok, archived} = Products.get_class(class.id, include_archived: true)
    assert archived.instructions == "Build carefully and verify evidence."
  end

  test "persists provider-neutral Loadouts with QE capability keys" do
    assert {:ok, loadout} = coding_loadout()

    assert loadout.model == %ModelRef{provider: "openai-codex", model: "model-a"}
    assert loadout.tools == ["workspace.filesystem", "terminal.shell"]
    refute Map.has_key?(Map.from_struct(loadout), :runtime)
    refute Map.has_key?(Map.from_struct(loadout), :agent_kind)
    refute Map.has_key?(Map.from_struct(loadout), :instructions)

    assert {:error, errors} =
             Products.update_loadout(loadout.id, %{
               tools: ["workspace.filesystem", "workspace.filesystem"]
             })

    assert Enum.any?(errors, &(&1.code == :duplicate_tool_key))
  end

  test "stores Members as ordered Squad-owned components" do
    assert {:ok, builder} = builder_class()
    assert {:ok, reviewer} = reviewer_class()
    assert {:ok, coding} = coding_loadout()
    assert {:ok, review} = review_loadout()

    assert {:ok, squad} =
             Products.create_squad(%{
               key: "engineering",
               name: "Engineering",
               members: [
                 member("backend", "Backend", builder.id, coding.id),
                 member("reviewer", "Reviewer", reviewer.id, review.id)
               ]
             })

    assert Enum.map(squad.members, & &1.key) == ["backend", "reviewer"]

    assert {:ok, reordered} =
             Products.update_squad(squad.id, %{
               members: [
                 member("reviewer", "Reviewer", reviewer.id, review.id),
                 member("backend", "Backend", builder.id, coding.id)
               ]
             })

    assert Enum.map(reordered.members, & &1.key) == ["reviewer", "backend"]

    assert {:error, errors} =
             Products.update_squad(squad.id, %{
               members: [
                 member("backend", "One", builder.id, coding.id),
                 member("backend", "Two", builder.id, coding.id)
               ]
             })

    assert Enum.any?(errors, &(&1.code == :duplicate_member_key))
  end

  test "Quest persistence round-trips the semantic Tactic without creating atoms from keys" do
    %{squad: squad} = product_fixture()
    tactic = standard_tactic()

    assert {:ok, quest} =
             Products.create_quest(%{
               title: "Implement feature",
               objective: "Implement and review the feature.",
               workspace_ref: "workspace:fixture",
               squad_id: squad.id,
               tactic_source: %Inline{body: tactic}
             })

    assert quest.tactic_source == %Inline{body: tactic}
    assert {:ok, fetched} = Products.get_quest(quest.id)
    assert fetched == quest
    assert is_binary(hd(fetched.tactic_source.body.children).performer.value)
  end

  test "Tactic persistence round-trips bounded control and closed discriminators" do
    tactic =
      until(
        check:
          step("review",
            name: "Review",
            instruction: "Review.",
            performer: class("reviewer"),
            consumes: [artifact("change_set")],
            produces: ["verdict"]
          ),
        condition: equals(field(artifact("verdict", from: "review"), "accepted"), true),
        otherwise:
          step("repair",
            name: "Repair",
            instruction: "Repair.",
            performer: same_as("review"),
            context: continue_from("review"),
            consumes: [artifact("change_set")],
            produces: ["change_set"]
          ),
        max_remediations: 2
      )

    encoded = TacticCodec.encode(tactic)
    assert encoded["type"] == "until"
    assert {:ok, ^tactic} = TacticCodec.decode(encoded)
  end

  test "preview builds a pure LaunchSnapshot and does not create Runtime or outbox state" do
    %{quest: quest} = product_fixture()
    runs_before = Repo.aggregate(RuntimeRun, :count)
    outbox_before = Repo.aggregate(RuntimeOutbox, :count)

    assert {:ok, snapshot} =
             Products.preview_launch_snapshot(quest.id, "/canonical/worktree")

    assert snapshot.quest.id == quest.id
    refute Map.has_key?(Map.from_struct(snapshot.workspace), :root)
    assert Enum.map(snapshot.squad.members, & &1.key) == ["builder", "reviewer"]
    assert Enum.map(snapshot.execution_plan.steps, & &1.key) == ["implement", "review"]
    refute Map.has_key?(Map.from_struct(snapshot), :run_id)
    refute Map.has_key?(Map.from_struct(snapshot), :launch_id)
    assert Repo.aggregate(RuntimeRun, :count) == runs_before
    assert Repo.aggregate(RuntimeOutbox, :count) == outbox_before
    assert %{rows: [[0]]} = Repo.query!("SELECT count(*) FROM quest_launches")
  end

  test "an existing snapshot keeps old values while a new preview sees definition edits" do
    %{quest: quest, builder: builder, coding: coding} = product_fixture()
    assert {:ok, original} = Products.preview_launch_snapshot(quest.id, "/canonical/worktree")

    assert {:ok, _updated_class} =
             Products.update_class(builder.id, %{instructions: "Builder instructions version B"})

    assert {:ok, _updated_loadout} =
             Products.update_loadout(coding.id, %{
               model: %ModelRef{provider: "anthropic", model: "model-b"}
             })

    assert {:ok, current} = Products.preview_launch_snapshot(quest.id, "/canonical/worktree")
    original_builder = hd(original.squad.members)
    current_builder = hd(current.squad.members)

    assert original_builder.class.instructions == "Builder instructions version A"
    assert original_builder.loadout.model.model == "model-a"
    assert current_builder.class.instructions == "Builder instructions version B"
    assert current_builder.loadout.model.model == "model-b"
  end

  test "archiving a referenced definition preserves rows but blocks a new snapshot" do
    %{quest: quest, builder: builder, squad: squad} = product_fixture()
    assert :ok = Products.archive_class(builder.id)

    assert {:ok, _stored_squad} = Products.get_squad(squad.id)
    assert {:ok, _stored_class} = Products.get_class(builder.id, include_archived: true)

    assert {:error, errors} =
             Products.preview_launch_snapshot(quest.id, "/canonical/worktree")

    assert Enum.any?(errors, &(&1.code == :class_not_found))
  end

  test "invalid Tactics produce structured domain errors before persistence" do
    %{squad: squad} = product_fixture(create_quest: false)

    assert {:error, [%{code: :unknown_local_step_reference}]} =
             Products.create_quest(%{
               title: "Invalid",
               objective: "Invalid affinity.",
               workspace_ref: "workspace:fixture",
               squad_id: squad.id,
               tactic_source: %Inline{
                 body:
                   step("repair",
                     name: "Repair",
                     instruction: "Repair.",
                     performer: same_as("missing")
                   )
               }
             })
  end

  defp product_fixture(options \\ []) do
    assert {:ok, builder} = builder_class()
    assert {:ok, reviewer} = reviewer_class()
    assert {:ok, coding} = coding_loadout()
    assert {:ok, review} = review_loadout()

    assert {:ok, squad} =
             Products.create_squad(%{
               key: "engineering",
               name: "Engineering",
               description: "A reusable roster with no orchestration.",
               members: [
                 member("builder", "Builder", builder.id, coding.id),
                 member("reviewer", "Reviewer", reviewer.id, review.id)
               ]
             })

    fixture = %{
      builder: builder,
      reviewer: reviewer,
      coding: coding,
      review: review,
      squad: squad
    }

    if Keyword.get(options, :create_quest, true) do
      assert {:ok, quest} =
               Products.create_quest(%{
                 title: "Implement feature",
                 objective: "Implement and review the feature.",
                 workspace_ref: "workspace:fixture",
                 squad_id: squad.id,
                 tactic_source: %Inline{body: standard_tactic()}
               })

      Map.put(fixture, :quest, quest)
    else
      fixture
    end
  end

  defp builder_class do
    Products.create_class(%{
      key: "builder",
      name: "Builder",
      description: "Builds changes.",
      instructions: "Builder instructions version A"
    })
  end

  defp reviewer_class do
    Products.create_class(%{
      key: "reviewer",
      name: "Reviewer",
      description: "Reviews changes.",
      instructions: "Review independently and report evidence."
    })
  end

  defp coding_loadout do
    Products.create_loadout(%{
      key: "coding",
      name: "Coding",
      description: "Writable capabilities.",
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: :medium,
      tools: ["workspace.filesystem", "terminal.shell"],
      workspace_access: :read_write
    })
  end

  defp review_loadout do
    Products.create_loadout(%{
      key: "review",
      name: "Review",
      description: "Read-only capabilities.",
      model: %ModelRef{provider: "openai-codex", model: "model-a"},
      reasoning: :high,
      tools: ["workspace.filesystem", "workspace.search"],
      workspace_access: :read_only
    })
  end

  defp member(key, name, class_id, loadout_id) do
    %{key: key, name: name, class_id: class_id, loadout_id: loadout_id}
  end

  defp standard_tactic do
    sequence([
      step("implement",
        name: "Implement",
        instruction: "Implement the requested change.",
        performer: class("builder"),
        produces: ["change_set"]
      ),
      step("review",
        name: "Review",
        instruction: "Review the change.",
        performer: class("reviewer"),
        consumes: [artifact("change_set", from: "implement")],
        produces: ["verdict"]
      )
    ])
  end
end
