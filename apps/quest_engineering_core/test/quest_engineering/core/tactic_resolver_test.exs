defmodule QuestEngineering.Core.TacticResolverTest do
  use ExUnit.Case, async: true

  import Kernel, except: [use: 2]
  import QuestEngineering.Core.Product.TacticAuthoring, only: [use: 2]
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Product.TacticDefinition
  alias QuestEngineering.Core.Product.TacticResolver
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.TacticResolver.Limits
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  test "scopes one composite and rewrites every current Step-key reference" do
    definition = implement_review("implement-review-id")
    source = TacticSource.inline(use("backend", definition.id))

    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([definition]))
    assert {:ok, plan} = Compiler.compile(resolution.tactic)

    assert Enum.map(plan.steps, & &1.key) == [
             "backend/implement",
             "backend/review",
             "backend/repair"
           ]

    repair = Enum.find(plan.steps, &(&1.key == "backend/repair"))

    assert repair.performer == %PerformerRequirement{
             selector: :same_as,
             value: "backend/implement"
           }

    assert repair.context == %ContextRequirement{
             selector: :continue_from,
             value: "backend/implement"
           }

    review = resolution.tactic.children |> Enum.at(1) |> Map.fetch!(:check)
    assert hd(review.consumes).source == "backend/implement"
    assert Enum.at(resolution.tactic.children, 1).condition.artifact.source == "backend/review"
  end

  test "the same composite expands twice without collisions or crossed affinity" do
    definition = implement_review("implement-review-id")

    source =
      TacticSource.inline(
        parallel([
          use("backend", definition.id),
          use("frontend", definition.id)
        ])
      )

    assert {:ok, first} = TacticResolver.resolve(source, catalog([definition]))
    assert {:ok, second} = TacticResolver.resolve(source, catalog([definition]))
    assert first == second
    assert {:ok, plan} = Compiler.compile(first.tactic)

    assert Enum.map(plan.steps, & &1.key) == [
             "backend/implement",
             "backend/review",
             "backend/repair",
             "frontend/implement",
             "frontend/review",
             "frontend/repair"
           ]

    for prefix <- ["backend", "frontend"] do
      repair = Enum.find(plan.steps, &(&1.key == "#{prefix}/repair"))
      assert repair.performer.value == "#{prefix}/implement"
      assert repair.context.value == "#{prefix}/implement"
    end
  end

  test "nested composites use deterministic instance paths and may consume parent context" do
    child = contextual_implement_review("implement-review-id")

    feature =
      definition(
        "feature-work-id",
        "feature-work",
        sequence([
          step("plan",
            name: "Plan",
            instruction: "Plan.",
            performer: class("planner"),
            produces: ["plan"]
          ),
          use("implementation", child.id),
          step("finalize",
            name: "Finalize",
            instruction: "Finalize.",
            performer: class("builder"),
            consumes: ["verdict"]
          )
        ])
      )

    source = TacticSource.inline(use("backend", feature.id))
    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([feature, child]))
    assert {:ok, plan} = Compiler.compile(resolution.tactic)

    assert Enum.map(plan.steps, & &1.key) == [
             "backend/plan",
             "backend/implementation/implement",
             "backend/implementation/review",
             "backend/finalize"
           ]

    assert Enum.map(resolution.provenance.definitions, & &1.instance_path) == [
             ["backend"],
             ["backend", "implementation"]
           ]
  end

  test "leaves ambiguous nested artifact output selection to the compiler" do
    producer =
      definition(
        "producer-id",
        "producer",
        step("implement",
          name: "Implement",
          instruction: "Implement.",
          performer: class("builder"),
          produces: ["change-set"]
        )
      )

    source =
      TacticSource.inline(
        sequence([
          parallel([use("backend", producer.id), use("frontend", producer.id)]),
          step("integrate",
            name: "Integrate",
            instruction: "Integrate.",
            performer: class("builder"),
            consumes: ["change-set"]
          )
        ])
      )

    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([producer]))
    assert {:error, errors} = Compiler.compile(resolution.tactic)

    assert [%{type: :ambiguous_artifact, candidate_sources: candidates}] =
             Enum.filter(errors, &(&1.type == :ambiguous_artifact))

    assert candidates == ["backend/implement", "frontend/implement"]
  end

  test "detects direct and indirect cycles with definition paths" do
    direct = definition("a-id", "a", use("self", "a-id"))

    assert {:error, [error]} =
             TacticResolver.resolve(TacticSource.definition(direct.id), catalog([direct]))

    assert error.code == :cyclic_tactic_reference
    assert error.definition_path == ["a", "a"]

    a = definition("a-id", "a", use("to-b", "b-id"))
    b = definition("b-id", "b", use("to-c", "c-id"))
    c = definition("c-id", "c", use("to-a", "a-id"))

    assert {:error, [error]} =
             TacticResolver.resolve(TacticSource.definition(a.id), catalog([a, b, c]))

    assert error.code == :cyclic_tactic_reference
    assert error.definition_path == ["a", "b", "c", "a"]
  end

  test "rejects missing and archived references distinctly" do
    parent = definition("parent-id", "parent", use("child", "child-id"))

    assert {:error, [%{code: :missing_tactic_definition}]} =
             TacticResolver.resolve(TacticSource.definition(parent.id), catalog([parent]))

    child = definition("child-id", "child", simple_step("work"))

    assert {:error, [%{code: :archived_tactic_definition}]} =
             TacticResolver.resolve(
               TacticSource.definition(parent.id),
               catalog([parent, child], [child.id])
             )
  end

  test "Step and Use identities share one namespace and deep references are invalid" do
    duplicate =
      definition(
        "duplicate-id",
        "duplicate",
        sequence([simple_step("backend"), use("backend", "child-id")])
      )

    assert {:error, errors} = Validation.validate(duplicate)
    assert Enum.any?(errors, &(&1.code == :duplicate_local_identity))

    deep =
      definition(
        "deep-id",
        "deep",
        step("later",
          name: "Later",
          instruction: "Later.",
          performer: same_as("backend/implement")
        )
      )

    assert {:error, errors} = Validation.validate(deep)
    assert Enum.any?(errors, &(&1.code == :invalid_local_step_reference))
  end

  test "returns structured expansion safety-limit errors" do
    leaf = definition("leaf-id", "leaf", simple_step("work"))
    middle = definition("middle-id", "middle", use("nested", leaf.id))
    root = definition("root-id", "root", use("middle", middle.id))
    catalog = catalog([root, middle, leaf])

    limits = %Limits{Limits.defaults() | max_use_depth: 1}

    assert {:error, [error]} =
             TacticResolver.resolve(TacticSource.definition(root.id), catalog, limits)

    assert error.code == :resolution_limit_exceeded
    assert error.details.limit == :max_use_depth

    limits = %Limits{Limits.defaults() | max_expanded_nodes: 0}

    assert {:error, [%{code: :resolution_limit_exceeded, details: %{limit: :max_expanded_nodes}}]} =
             TacticResolver.resolve(TacticSource.definition(root.id), catalog, limits)

    limits = %Limits{Limits.defaults() | max_resolved_key_bytes: 8}

    assert {:error,
            [%{code: :resolution_limit_exceeded, details: %{limit: :max_resolved_key_bytes}}]} =
             TacticResolver.resolve(TacticSource.definition(root.id), catalog, limits)
  end

  defp implement_review(id) do
    definition(
      id,
      "implement-review",
      sequence([
        step("implement",
          name: "Implement",
          instruction: "Implement.",
          performer: class("builder"),
          produces: ["change-set"]
        ),
        until(
          check:
            step("review",
              name: "Review",
              instruction: "Review.",
              performer: class("reviewer"),
              consumes: [artifact("change-set", from: "implement")],
              produces: ["verdict"]
            ),
          condition: equals(field(artifact("verdict", from: "review"), "accepted"), true),
          otherwise:
            step("repair",
              name: "Repair",
              instruction: "Repair.",
              performer: same_as("implement"),
              context: continue_from("implement"),
              consumes: ["change-set"],
              produces: ["change-set"]
            ),
          max_remediations: 2
        )
      ])
    )
  end

  defp contextual_implement_review(id) do
    definition(
      id,
      "implement-review",
      sequence([
        step("implement",
          name: "Implement",
          instruction: "Implement from plan.",
          performer: class("builder"),
          consumes: ["plan"],
          produces: ["change-set"]
        ),
        step("review",
          name: "Review",
          instruction: "Review.",
          performer: class("reviewer"),
          consumes: [artifact("change-set", from: "implement")],
          produces: ["verdict"]
        )
      ])
    )
  end

  defp simple_step(key) do
    step(key, name: String.capitalize(key), instruction: "Work.", performer: class("builder"))
  end

  defp definition(id, key, body) do
    %TacticDefinition{id: id, key: key, name: key, description: "", body: body}
  end

  defp catalog(definitions, archived_ids \\ []) do
    %Catalog{
      definitions: Map.new(definitions, &{&1.id, &1}),
      archived_ids: MapSet.new(archived_ids)
    }
  end
end
