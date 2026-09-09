defmodule QuestEngineering.Core.TacticResolverTest do
  use ExUnit.Case, async: true
  import Kernel, except: [use: 2]
  import QuestEngineering.Core.Product.TacticAuthoring, only: [use: 2, use: 3]
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Runtime

  alias QuestEngineering.Core.Product.{
    AcceptedArtifactSource,
    TacticDefinition,
    TacticInputBinding,
    TacticInputPort,
    TacticInterface,
    TacticOutputPort
  }

  alias QuestEngineering.Core.Product.TacticResolver
  alias QuestEngineering.Core.Product.TacticResolver.{Catalog, Limits}
  alias QuestEngineering.Core.Product.TacticSource

  test "slash-scoped uses preserve identities while exposing only declared outputs" do
    child = plan_review("planning-id")

    source =
      TacticSource.inline(
        sequence([
          use("planning", child.id),
          step("consume",
            name: "Consume",
            instruction: "Consume.",
            performer: class("builder"),
            consumes: [input("plan", "quest_plan", from: ref("planning", "accepted_plan"))]
          )
        ])
      )

    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([child]))
    assert {:ok, plan} = Compiler.compile(resolution)

    assert Enum.map(plan.steps, & &1.key) == [
             "planning/plan",
             "planning/review_plan",
             "planning/revise_plan",
             "consume"
           ]

    [binding] = Enum.filter(plan.artifact_bindings, &(&1.consumer == "consume"))
    assert binding.kind == "quest_plan"

    assert match?(
             %QuestEngineering.Core.ExecutionPlan.UntilOutput{source_kind: :carried},
             binding.producer
           )

    refute Enum.any?(plan.artifact_bindings, &(&1.producer == ref("planning/plan", "plan")))
  end

  test "two uses produce collision-free scoped exports and ambiguous automatic selection is rejected" do
    child = plan_review("planning-id")

    source =
      TacticSource.inline(
        sequence([
          use("planning_a", child.id),
          use("planning_b", child.id),
          step("consume",
            name: "Consume",
            instruction: "Consume.",
            performer: class("builder"),
            consumes: [input("plan", "quest_plan")]
          )
        ])
      )

    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([child]))
    assert {:error, errors} = Compiler.compile(resolution)
    assert Enum.any?(errors, &(&1.type == :ambiguous_artifact))
  end

  test "required child inputs are explicit and kind checked" do
    child = required_consumer("consumer-id")
    missing = TacticSource.inline(use("child", child.id))
    assert {:ok, resolution} = TacticResolver.resolve(missing, catalog([child]))
    assert {:error, errors} = Compiler.compile(resolution)
    assert Enum.any?(errors, &(&1.type == :missing_required_tactic_input))

    mismatch =
      TacticSource.inline(
        sequence([
          step("build",
            name: "Build",
            instruction: "Build.",
            performer: class("builder"),
            produces: [output("change_set", "change_set")]
          ),
          use("child", child.id, [
            %TacticInputBinding{input: "plan", source: ref("build", "change_set")}
          ])
        ])
      )

    assert {:ok, resolution} = TacticResolver.resolve(mismatch, catalog([child]))
    assert {:error, errors} = Compiler.compile(resolution)
    assert Enum.any?(errors, &(&1.type == :incompatible_tactic_input_kind))
  end

  test "nested uses expose only the immediate child interface" do
    leaf = plan_review("leaf-id")

    wrapper = %TacticDefinition{
      id: "wrapper-id",
      key: "wrapper",
      name: "Wrapper",
      description: "",
      body: use("inner", leaf.id),
      interface: %TacticInterface{
        outputs: [
          %TacticOutputPort{
            key: "plan",
            label: "Plan",
            kind: "quest_plan",
            source: ref("inner", "accepted_plan")
          }
        ]
      }
    }

    source =
      TacticSource.inline(
        sequence([
          use("outer", wrapper.id),
          step("consume",
            name: "Consume",
            instruction: "Consume.",
            performer: class("builder"),
            consumes: [input("plan", "quest_plan", from: ref("outer", "plan"))]
          )
        ])
      )

    assert {:ok, resolution} = TacticResolver.resolve(source, catalog([leaf, wrapper]))
    assert {:ok, plan} = Compiler.compile(resolution)
    assert Enum.any?(plan.artifact_bindings, &(&1.consumer == "consume"))
    refute Enum.any?(plan.artifact_bindings, &(&1.producer == ref("outer/inner/plan", "plan")))
  end

  test "composed accepted Quest Plan handoff preserves exact artifact identity, hash, and provenance" do
    planning = plan_review("planning-id")
    implementation = implement_review("implementation-id")

    composite = %TacticDefinition{
      id: "composite-id",
      key: "plan-implement-review",
      name: "Plan, Implement & Review",
      description: "",
      body:
        sequence([
          use("planning", planning.id),
          use("implementation", implementation.id, [
            %TacticInputBinding{input: "plan", source: ref("planning", "accepted_plan")}
          ])
        ])
    }

    assert {:ok, resolution} =
             TacticResolver.resolve(
               TacticSource.definition(composite.id),
               catalog([planning, implementation, composite])
             )

    assert {:ok, plan} = Compiler.compile(resolution)
    {:ok, run, [action]} = Runtime.start(plan, "composed-handoff")

    {:ok, run, [action]} =
      Runtime.transition(run, Runtime.completed(action, %{"plan" => "# Plan v1"}))

    {:ok, run, [action]} =
      Runtime.transition(
        run,
        Runtime.completed(action, %{"verdict" => %{"status" => "rejected"}})
      )

    {:ok, run, [action]} =
      Runtime.transition(run, Runtime.completed(action, %{"plan" => "# Plan v2"}))

    accepted_plan = action.inputs["plan"]

    {:ok, _run, [implement]} =
      Runtime.transition(
        run,
        Runtime.completed(action, %{"verdict" => %{"status" => "accepted"}})
      )

    handed_off = implement.inputs["plan"]
    assert handed_off.id == accepted_plan.id
    assert handed_off.content_hash == accepted_plan.content_hash
    assert handed_off.producer_occurrence_id == accepted_plan.producer_occurrence_id
  end

  test "accepted-subject root export resolves to the exact accepted immutable artifact" do
    definition = plan_review("planning-id")

    assert {:ok, resolution} =
             TacticResolver.resolve(TacticSource.definition(definition.id), catalog([definition]))

    assert {:ok, plan} = Compiler.compile(resolution)
    {:ok, run, [planning]} = Runtime.start(plan, "planning-export")

    {:ok, run, [review]} =
      Runtime.transition(run, Runtime.completed(planning, %{"plan" => "# Accepted"}))

    subject_id = review.inputs["plan"].id

    {:ok, run, []} =
      Runtime.transition(
        run,
        Runtime.completed(review, %{"verdict" => %{"status" => "accepted"}})
      )

    assert run.tactic_output_artifact_ids == %{"accepted_plan" => subject_id}
    assert run.artifacts[subject_id].content_hash == review.inputs["plan"].content_hash
  end

  test "standalone Implement & Review omits its optional Quest Plan without a synthetic artifact" do
    definition = implement_review("implementation-id")

    assert {:ok, resolution} =
             TacticResolver.resolve(TacticSource.definition(definition.id), catalog([definition]))

    assert {:ok, plan} = Compiler.compile(resolution)
    assert {:ok, run, [implement]} = Runtime.start(plan, "standalone-implementation")
    assert implement.inputs == %{}
    assert run.artifacts == %{}
  end

  test "cycle detection and conservative depth limits remain" do
    a = %TacticDefinition{id: "a", key: "a", name: "A", description: "", body: use("b", "b")}
    b = %TacticDefinition{id: "b", key: "b", name: "B", description: "", body: use("a", "a")}

    assert {:error, [%{code: :cyclic_tactic_reference}]} =
             TacticResolver.resolve(TacticSource.definition(a.id), catalog([a, b]))

    limits = %Limits{Limits.defaults() | max_use_depth: 0}

    assert {:error, [%{code: :resolution_limit_exceeded}]} =
             TacticResolver.resolve(TacticSource.inline(use("a", a.id)), catalog([a, b]), limits)
  end

  defp plan_review(id) do
    %TacticDefinition{
      id: id,
      key: "plan-review",
      name: "Plan & Review",
      description: "",
      body:
        sequence([
          step("plan",
            name: "Plan",
            instruction: "Plan.",
            performer: class("planner"),
            produces: [output("plan", "quest_plan")]
          ),
          until(
            check:
              step("review_plan",
                name: "Review Plan",
                instruction: "Review.",
                performer: class("reviewer"),
                consumes: [input("plan", "quest_plan")],
                produces: [
                  output("verdict", "review_verdict", review: review("plan_acceptance", "plan"))
                ]
              ),
            condition: equals(field(ref("review_plan", "verdict"), "status"), "accepted"),
            otherwise:
              step("revise_plan",
                name: "Revise Plan",
                instruction: "Revise.",
                performer: same_as("plan"),
                consumes: [input("plan", "quest_plan"), input("verdict", "review_verdict")],
                produces: [output("plan", "quest_plan")]
              ),
            max_remediations: 2
          )
        ]),
      interface: %TacticInterface{
        outputs: [
          %TacticOutputPort{
            key: "accepted_plan",
            label: "Accepted Quest Plan",
            kind: "quest_plan",
            source: %AcceptedArtifactSource{gate_key: "plan_acceptance"}
          }
        ]
      }
    }
  end

  defp implement_review(id) do
    %TacticDefinition{
      id: id,
      key: "implement-review",
      name: "Implement & Review",
      description: "",
      body:
        sequence([
          step("implement",
            name: "Implement",
            instruction: "Implement.",
            performer: class("builder"),
            consumes: [input("plan", "quest_plan", from: ref("$inputs", "plan"), required: false)],
            produces: [output("change_set", "change_set")]
          ),
          until(
            check:
              step("review",
                name: "Review",
                instruction: "Review.",
                performer: class("reviewer"),
                consumes: [input("change_set", "change_set")],
                produces: [
                  output("verdict", "review_verdict",
                    review: review("implementation_acceptance", "change_set")
                  )
                ]
              ),
            condition: equals(field(ref("review", "verdict"), "status"), "accepted"),
            otherwise:
              step("repair",
                name: "Repair",
                instruction: "Repair.",
                performer: same_as("implement"),
                consumes: [input("change_set", "change_set"), input("verdict", "review_verdict")],
                produces: [output("change_set", "change_set")]
              ),
            max_remediations: 3
          )
        ]),
      interface: %TacticInterface{
        inputs: [
          %TacticInputPort{key: "plan", label: "Quest Plan", kind: "quest_plan", required: false}
        ],
        outputs: [
          %TacticOutputPort{
            key: "accepted_change_set",
            label: "Accepted Change Set",
            kind: "change_set",
            source: %AcceptedArtifactSource{gate_key: "implementation_acceptance"}
          }
        ]
      }
    }
  end

  defp required_consumer(id),
    do: %TacticDefinition{
      id: id,
      key: "consumer",
      name: "Consumer",
      description: "",
      body:
        step("consume",
          name: "Consume",
          instruction: "Consume.",
          performer: class("builder"),
          consumes: [input("plan", "quest_plan", from: ref("$inputs", "plan"))]
        ),
      interface: %TacticInterface{
        inputs: [
          %TacticInputPort{key: "plan", label: "Quest Plan", kind: "quest_plan", required: true}
        ]
      }
    }

  defp catalog(definitions), do: %Catalog{definitions: Map.new(definitions, &{&1.id, &1})}
end
