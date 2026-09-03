defmodule QuestEngineering.Server.Product.TacticLibraryTest do
  use QuestEngineering.Server.DataCase, async: false

  import Kernel, except: [use: 2]
  import QuestEngineering.Core.Product.TacticAuthoring, only: [use: 2]
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticPreview.Error, as: PreviewError
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo

  test "persists contextual definitions without requiring standalone root compilation" do
    assert {:ok, child} = TacticLibrary.create(contextual_child_attributes("contextual-child"))
    assert {:ok, fetched} = TacticLibrary.fetch(child.id)
    assert fetched == child
    assert {:ok, resolution} = TacticLibrary.resolve_definition(child.id)
    assert resolution.tactic.key == "implement"

    assert {:error, %PreviewError{stage: :compilation, errors: errors}} =
             TacticLibrary.preview_definition(child.id)

    assert Enum.all?(errors, &(&1.type == :missing_artifact))

    assert {:ok, parent} =
             TacticLibrary.create(%{
               key: "parent",
               name: "Parent",
               body:
                 sequence([
                   step("plan",
                     name: "Plan",
                     instruction: "Plan.",
                     performer: class("builder"),
                     produces: ["plan"]
                   ),
                   use("implementation", child.id)
                 ])
             })

    assert {:ok, preview} = TacticLibrary.preview_definition(parent.id)

    assert Enum.map(preview.execution_plan.steps, & &1.key) == [
             "plan",
             "implementation/implement"
           ]
  end

  test "uses one local namespace and keeps keys immutable" do
    assert {:ok, child} = TacticLibrary.create(simple_attributes("child"))

    assert {:error, errors} =
             TacticLibrary.create(%{
               key: "collision",
               name: "Collision",
               body: sequence([simple_step("same"), use("same", child.id)])
             })

    assert Enum.any?(errors, &(&1.code == :duplicate_local_identity))

    assert {:error, [%{code: :immutable_key}]} =
             TacticLibrary.update(child.id, %{key: "renamed"})
  end

  test "rejects missing references and cycles with structured resolution errors" do
    assert {:error, %PreviewError{stage: :resolution, errors: [missing]}} =
             TacticLibrary.create(%{
               key: "missing-parent",
               name: "Missing",
               body: use("missing", Ecto.UUID.generate())
             })

    assert missing.code == :missing_tactic_definition

    assert {:ok, b} = TacticLibrary.create(simple_attributes("b"))

    assert {:ok, a} =
             TacticLibrary.create(%{key: "a", name: "A", body: use("to-b", b.id)})

    assert {:error, %PreviewError{stage: :resolution, errors: [cycle]}} =
             TacticLibrary.update(b.id, %{body: use("to-a", a.id)})

    assert cycle.code == :cyclic_tactic_reference
    assert cycle.definition_path == ["b", "a", "b"]
  end

  test "candidate preview detects new transitive cycles without mutating persisted definitions" do
    assert {:ok, a} = TacticLibrary.create(simple_attributes("candidate-a"))

    assert {:ok, c} =
             TacticLibrary.create(%{
               key: "candidate-c",
               name: "Candidate C",
               body: use("back-to-a", a.id)
             })

    assert {:ok, b} =
             TacticLibrary.create(%{
               key: "candidate-b",
               name: "Candidate B",
               body: use("to-c", c.id)
             })

    candidate_body = use("to-b", b.id)
    before_preview = Repo.get!(ProductTactic, a.id)

    assert {:error, %PreviewError{stage: :resolution, errors: [cycle]}} =
             TacticLibrary.preview_definition(a.id, %{body: candidate_body})

    assert cycle.code == :cyclic_tactic_reference
    assert cycle.definition_path == ["candidate-a", "candidate-b", "candidate-c", "candidate-a"]
    assert {:ok, persisted} = TacticLibrary.get(a.id)
    after_preview = Repo.get!(ProductTactic, a.id)
    assert persisted.body == a.body
    assert after_preview.body == before_preview.body
    assert after_preview.updated_at == before_preview.updated_at
  end

  test "archiving a child preserves definitions and blocks new parent resolution" do
    assert {:ok, child} = TacticLibrary.create(simple_attributes("archived-child"))

    assert {:ok, parent} =
             TacticLibrary.create(%{
               key: "archived-parent",
               name: "Parent",
               body: use("child", child.id)
             })

    assert :ok = TacticLibrary.archive(child.id)
    assert {:ok, _archived} = TacticLibrary.get(child.id, include_archived: true)
    assert {:error, %{code: :not_found}} = TacticLibrary.get(child.id)

    assert {:error, %PreviewError{stage: :resolution, errors: [error]}} =
             TacticLibrary.preview_definition(parent.id)

    assert error.code == :archived_tactic_definition

    assert {:ok, renamed_parent} = TacticLibrary.update(parent.id, %{name: "Still editable"})
    assert renamed_parent.name == "Still editable"
  end

  test "definition-backed Quest snapshots freeze resolved bodies and provenance" do
    %{squad: squad, class: class} = product_fixture()

    assert {:ok, tactic} =
             TacticLibrary.create(%{
               key: "quest-tactic",
               name: "Quest Tactic",
               body:
                 step("work",
                   name: "Work",
                   instruction: "Work.",
                   performer: class(class.key)
                 )
             })

    assert {:ok, quest} =
             Products.create_quest(%{
               title: "Reusable",
               objective: "Launch a reusable Tactic.",
               workspace_ref: "workspace:fixture",
               squad_id: squad.id,
               tactic_source: TacticSource.definition(tactic.id)
             })

    assert {:ok, old_snapshot} =
             Products.preview_launch_snapshot(quest.id, "/canonical/worktree")

    assert old_snapshot.tactic.instruction == "Work."
    assert old_snapshot.tactic_provenance.root.definition_key == "quest-tactic"

    assert {:ok, _updated} =
             TacticLibrary.update(tactic.id, %{
               body:
                 step("work",
                   name: "Work",
                   instruction: "Changed work.",
                   performer: class(class.key)
                 )
             })

    assert {:ok, new_snapshot} =
             Products.preview_launch_snapshot(quest.id, "/canonical/worktree")

    assert old_snapshot.tactic.instruction == "Work."
    assert new_snapshot.tactic.instruction == "Changed work."
  end

  test "authoring codec explicitly round-trips Use values" do
    value = use("backend", Ecto.UUID.generate())
    encoded = TacticCodec.encode(value)

    assert encoded["type"] == "use"
    assert {:ok, ^value} = TacticCodec.decode(encoded)
  end

  defp contextual_child_attributes(key) do
    %{
      key: key,
      name: "Contextual Child",
      body:
        step("implement",
          name: "Implement",
          instruction: "Implement from the parent plan.",
          performer: class("builder"),
          consumes: ["plan"],
          produces: ["change-set"]
        )
    }
  end

  defp simple_attributes(key),
    do: %{key: key, name: String.capitalize(key), body: simple_step("work")}

  defp simple_step(key) do
    step(key, name: String.capitalize(key), instruction: "Work.", performer: class("builder"))
  end

  defp product_fixture do
    suffix = Integer.to_string(System.unique_integer([:positive]))

    assert {:ok, class} =
             Products.create_class(%{
               key: "builder-#{suffix}",
               name: "Builder",
               instructions: "Build."
             })

    assert {:ok, loadout} =
             Products.create_loadout(%{
               key: "coding-#{suffix}",
               name: "Coding",
               model: %ModelRef{provider: "fake", model: "test"},
               reasoning: :medium,
               tools: ["workspace.filesystem"],
               workspace_access: :read_write
             })

    assert {:ok, squad} =
             Products.create_squad(%{
               key: "squad-#{suffix}",
               name: "Squad",
               members: [
                 %{key: "member", name: "Member", class_id: class.id, loadout_id: loadout.id}
               ]
             })

    %{squad: squad, class: class}
  end
end
