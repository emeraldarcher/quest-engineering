defmodule QuestEngineering.Server.SpecDeliveryEligibilityTest do
  use ExUnit.Case, async: true

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.DeliveryEligibility

  test "accepted plan verdict cannot authorize Delivery when implementation acceptance is absent" do
    tactic =
      sequence([
        step("plan",
          name: "Plan",
          instruction: "Plan.",
          performer: class("planner"),
          produces: [output("plan", "quest_plan")]
        ),
        until(
          check:
            step("plan_review",
              name: "Plan Review",
              instruction: "Review plan.",
              performer: class("plan-reviewer"),
              consumes: [input("plan", "quest_plan")],
              produces: [
                output("verdict", "review_verdict", review: review("plan_acceptance", "plan"))
              ]
            ),
          condition: equals(field(ref("plan_review", "verdict"), "status"), "accepted"),
          otherwise:
            step("revise_plan",
              name: "Revise Plan",
              instruction: "Revise.",
              performer: class("planner"),
              consumes: [input("plan", "quest_plan"), input("verdict", "review_verdict")],
              produces: [output("plan", "quest_plan")]
            ),
          max_remediations: 1
        ),
        step("implement",
          name: "Implement",
          instruction: "Implement.",
          performer: class("builder"),
          consumes: [input("plan", "quest_plan")],
          produces: [output("change_set", "change_set")]
        )
      ])

    {:ok, plan} = Compiler.compile(tactic)
    {:ok, run, [action]} = Runtime.start(plan)
    {:ok, run, [action]} = complete(run, action, %{"plan" => "# Plan"})
    {:ok, run, [action]} = complete(run, action, %{"verdict" => %{"status" => "accepted"}})
    {:ok, run, []} = complete(run, action, %{"change_set" => %{}})

    assert run.status == :completed
    assert DeliveryEligibility.assess(run).status == :missing
  end

  test "typed implementation acceptance authorizes Delivery only for its exact change set" do
    tactic =
      sequence([
        step("implement",
          name: "Implement",
          instruction: "Implement.",
          performer: class("builder"),
          produces: [output("change_set", "change_set")]
        ),
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
        )
      ])

    {:ok, plan} = Compiler.compile(tactic)
    {:ok, run, [action]} = Runtime.start(plan)
    {:ok, run, [review]} = complete(run, action, %{"change_set" => %{}})
    subject_id = review.inputs["change_set"].id

    {:ok, run, []} =
      complete(run, review, %{"verdict" => %{"status" => "accepted"}})

    assert %{status: :accepted, artifact_id: verdict_id} = DeliveryEligibility.assess(run)
    assert run.artifacts[verdict_id].value["subject_artifact_id"] == subject_id
    assert run.artifacts[verdict_id].value["gate_key"] == "implementation_acceptance"
  end

  test "implementation verdict must name the exact change set and implementation gate" do
    tactic =
      sequence([
        step("implement",
          name: "Implement",
          instruction: "Implement.",
          performer: class("builder"),
          produces: [output("change_set", "change_set")]
        ),
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
        )
      ])

    {:ok, plan} = Compiler.compile(tactic)
    {:ok, run, [action]} = Runtime.start(plan)
    {:ok, run, [review]} = complete(run, action, %{"change_set" => %{}})

    {:ok, run, []} =
      complete(run, review, %{
        "verdict" => %{
          "status" => "accepted",
          "gate_key" => "implementation_acceptance",
          "subject_kind" => "change_set",
          "subject_artifact_id" => "different-change-set"
        }
      })

    assert run.status == :completed
    assert DeliveryEligibility.assess(run).status == :invalid
  end

  defp complete(run, action, outputs),
    do: Runtime.transition(run, Runtime.completed(action, outputs))
end
