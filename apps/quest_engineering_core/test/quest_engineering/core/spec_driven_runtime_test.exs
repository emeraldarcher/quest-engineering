defmodule QuestEngineering.Core.SpecDrivenRuntimeTest do
  use ExUnit.Case, async: true
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.ArtifactSemantics
  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Runtime

  test "canonical kinds exclude obsolete plan and gate-specific verdict kinds while verdict remains an output name" do
    assert ArtifactSemantics.built_in_kinds() == ["quest_plan", "change_set", "review_verdict"]
    refute ArtifactSemantics.valid_kind?("implementation_plan")
    refute ArtifactSemantics.valid_kind?("plan_verdict")
    refute ArtifactSemantics.valid_kind?("implementation_verdict")
    refute ArtifactSemantics.valid_kind?("verdict")

    assert output("verdict", "review_verdict", review: review("plan_acceptance", "plan")).name ==
             "verdict"
  end

  test "Quest Plan revision history is immutable and the exact accepted version reaches implementation" do
    {:ok, plan} = Compiler.compile(plan_then_implement(2))

    assert {"plan_acceptance", "quest_plan"} ==
             {hd(plan.control_regions).acceptance_gate_key,
              hd(plan.control_regions).acceptance_subject_kind}

    {:ok, run, [planning]} = Runtime.start(plan, "plan-revision")
    {:ok, run, [review_v1]} = complete(run, planning, %{"plan" => "# Quest Plan v1"})
    plan_v1 = review_v1.inputs["plan"]
    assert plan_v1.kind == "quest_plan"
    assert plan_v1.version == 1

    {:ok, run, [revise]} =
      complete(run, review_v1, %{
        "verdict" => %{"status" => "rejected", "findings" => ["clarify rollout"]}
      })

    assert revise.inputs["plan"].id == plan_v1.id
    assert revise.inputs["verdict"].value["subject_artifact_id"] == plan_v1.id

    {:ok, run, [review_v2]} = complete(run, revise, %{"plan" => "# Quest Plan v2"})
    plan_v2 = review_v2.inputs["plan"]
    assert plan_v2.version == 2
    assert plan_v2.supersedes_artifact_id == plan_v1.id
    assert plan_v2.id != plan_v1.id

    {:ok, run, [implement]} = complete(run, review_v2, %{"verdict" => %{"status" => "accepted"}})
    assert implement.inputs["plan"].id == plan_v2.id
    assert run.artifacts[plan_v1.id].value["content"] == "# Quest Plan v1"
    assert run.artifacts[plan_v2.id].value["content"] == "# Quest Plan v2"
  end

  test "maximum two plan revisions permits three reviews then exhausts before implementation" do
    {:ok, plan} = Compiler.compile(plan_then_implement(2))
    {:ok, run, [action]} = Runtime.start(plan, "plan-exhaustion")
    {:ok, run, [action]} = complete(run, action, %{"plan" => "v1"})
    {:ok, run, [action]} = complete(run, action, %{"verdict" => %{"status" => "rejected"}})
    {:ok, run, [action]} = complete(run, action, %{"plan" => "v2"})
    {:ok, run, [action]} = complete(run, action, %{"verdict" => %{"status" => "rejected"}})
    {:ok, run, [action]} = complete(run, action, %{"plan" => "v3"})
    {:ok, run, []} = complete(run, action, %{"verdict" => %{"status" => "rejected"}})
    assert run.status == :failed
    assert run.failure.type == :until_exhausted
    assert length(run.artifact_order) == 6

    implement =
      Enum.find_value(run.occurrences, fn {_id, occurrence} ->
        if occurrence.semantic_step_key == "implement", do: occurrence
      end)

    assert implement.status == :pending
    assert implement.attempts == []
  end

  test "operational retry remains the same semantic Plan Review occurrence" do
    {:ok, plan} = Compiler.compile(plan_then_implement(2))
    {:ok, run, [planning]} = Runtime.start(plan, "plan-retry")
    {:ok, run, [review]} = complete(run, planning, %{"plan" => "v1"})
    {:ok, run, [retry]} = Runtime.transition(run, Runtime.retry_requested(review))
    assert retry.occurrence_id == review.occurrence_id
    assert retry.attempt_id != review.attempt_id
    {:ok, run, [_revise]} = complete(run, retry, %{"verdict" => %{"status" => "rejected"}})
    [region] = Map.values(run.regions)
    assert region.remediations_completed == 0
    assert length(region.check_scope_ids) == 1
  end

  test "Review Verdict cannot accept a different immutable subject" do
    {:ok, plan} = Compiler.compile(plan_then_implement(1))
    {:ok, run, [planning]} = Runtime.start(plan, "wrong-subject")
    {:ok, run, [review]} = complete(run, planning, %{"plan" => "v1"})

    wrong = %{
      "status" => "accepted",
      "gate_key" => "plan_acceptance",
      "subject_kind" => "quest_plan",
      "subject_artifact_id" => "another-plan"
    }

    {:ok, run, [revise]} = complete(run, review, %{"verdict" => wrong})
    assert revise.semantic_step_key == "revise_plan"
    verdict = run.artifacts[run.occurrences[review.occurrence_id].output_artifact_ids["verdict"]]
    assert verdict.value["subject_artifact_id"] == "another-plan"
  end

  defp plan_then_implement(max_revisions) do
    sequence([
      step("plan",
        name: "Plan",
        instruction: "Create a Quest Plan.",
        performer: class("planner"),
        produces: [output("plan", "quest_plan")]
      ),
      until(
        check:
          step("review_plan",
            name: "Review Plan",
            instruction: "Review the exact Quest Plan.",
            performer: class("plan-reviewer"),
            consumes: [input("plan", "quest_plan")],
            produces: [
              output("verdict", "review_verdict", review: review("plan_acceptance", "plan"))
            ]
          ),
        condition: equals(field(ref("review_plan", "verdict"), "status"), "accepted"),
        otherwise:
          step("revise_plan",
            name: "Revise Plan",
            instruction: "Revise from findings.",
            performer: same_as("plan"),
            context: continue_from("plan"),
            consumes: [input("plan", "quest_plan"), input("verdict", "review_verdict")],
            produces: [output("plan", "quest_plan")]
          ),
        max_remediations: max_revisions
      ),
      step("implement",
        name: "Implement",
        instruction: "Implement the accepted Quest Plan.",
        performer: class("builder"),
        consumes: [input("plan", "quest_plan")],
        produces: [output("change_set", "change_set")]
      )
    ])
  end

  defp complete(run, action, outputs),
    do: Runtime.transition(run, Runtime.completed(action, outputs))
end
