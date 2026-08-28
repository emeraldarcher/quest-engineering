defmodule QuestEngineering.Core.RuntimeTest do
  use ExUnit.Case, async: true

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Runtime.Error
  alias QuestEngineering.Core.Runtime.Event
  alias QuestEngineering.Core.Runtime.ExecutionAttempt
  alias QuestEngineering.Core.Runtime.Failure
  alias QuestEngineering.Core.Runtime.RegionOccurrence

  describe "static execution" do
    test "executes a sequence from static dependencies and completes" do
      plan = compile!(sequence([work("a"), work("b"), work("c")]))

      assert {:ok, run, [%Action{semantic_step_key: "a"} = a]} = Runtime.start(plan)
      assert a.instruction == "Execute test step a."
      assert occurrence(run, "b").status == :pending

      assert {:ok, run, [%Action{semantic_step_key: "b"} = b]} =
               Runtime.transition(run, Runtime.completed(a, %{}))

      assert {:ok, run, [%Action{semantic_step_key: "c"} = c]} =
               Runtime.transition(run, Runtime.completed(b, %{}))

      assert {:ok, run, []} = Runtime.transition(run, Runtime.completed(c, %{}))
      assert run.status == :completed

      assert Enum.map(run.occurrence_order, &run.occurrences[&1].semantic_step_key) == [
               "a",
               "b",
               "c"
             ]
    end

    test "parallel branches complete in either order before their join" do
      plan =
        compile!(
          sequence([
            work("plan"),
            parallel([
              work("backend", produces: ["backend"]),
              work("tests", produces: ["tests"])
            ]),
            work("integrate", consumes: ["backend", "tests"], produces: ["result"])
          ])
        )

      results =
        for order <- [["backend", "tests"], ["tests", "backend"]] do
          {:ok, run, [plan_action]} = Runtime.start(plan)
          {:ok, run, branch_actions} = complete(run, plan_action, %{})
          assert action_keys(branch_actions) == ["backend", "tests"]

          actions = Map.new(branch_actions, &{&1.semantic_step_key, &1})
          [first, second] = order

          {:ok, run, []} = complete(run, actions[first], %{first => %{"value" => first}})
          assert occurrence(run, "integrate").status == :pending

          {:ok, run, [%Action{semantic_step_key: "integrate"} = integrate]} =
            complete(run, actions[second], %{second => %{"value" => second}})

          assert integrate.inputs["backend"].value == %{"value" => "backend"}
          assert integrate.inputs["tests"].value == %{"value" => "tests"}

          {:ok, run, []} = complete(run, integrate, %{"result" => %{"status" => "done"}})
          assert run.status == :completed
          run.artifacts |> Map.values() |> Enum.find(&(&1.type == "result")) |> Map.fetch!(:value)
        end

      assert results == [%{"status" => "done"}, %{"status" => "done"}]
    end
  end

  describe "Until execution" do
    test "runs the full repair pressure test and preserves runtime identities and semantics" do
      plan = compile!(pressure_tactic(publish: true))
      {:ok, run, [plan_action]} = Runtime.start(plan)

      assert plan_action.semantic_step_key == "plan"
      assert plan_action.context_requirement == fresh()
      assert plan_action.context_lineage_occurrence_id == nil

      {:ok, run, [implement]} =
        complete(run, plan_action, %{"plan" => %{"summary" => "ship it"}})

      assert implement.semantic_step_key == "implement"
      assert implement.inputs["plan"].value == %{"summary" => "ship it"}

      {:ok, run, [review_0]} =
        complete(run, implement, %{"change_set" => %{"files" => ["lib/foo.ex"], "version" => 0}})

      assert review_0.semantic_step_key == "review"
      assert review_0.context_requirement == fresh()
      assert review_0.context_lineage_occurrence_id == nil
      assert review_0.inputs["change_set"].value["version"] == 0

      {:ok, run, [repair_1]} =
        complete(run, review_0, %{"verdict" => %{"status" => "rejected"}})

      assert repair_1.semantic_step_key == "repair"
      assert repair_1.instruction == "Repair the rejected change set and produce an updated change set."
      assert repair_1.performer_requirement == same_as("implement")
      assert repair_1.context_requirement == continue_from("implement")
      assert repair_1.performer_affinity_occurrence_id == implement.occurrence_id
      assert repair_1.context_lineage_occurrence_id == implement.occurrence_id
      assert repair_1.inputs["change_set"].value["version"] == 0
      assert repair_1.inputs["verdict"].value["status"] == "rejected"

      {:ok, run, [review_1]} =
        complete(run, repair_1, %{
          "change_set" => %{"files" => ["lib/foo.ex"], "version" => 1}
        })

      assert review_1.semantic_step_key == "review"
      assert review_1.instruction == review_0.instruction
      assert review_1.occurrence_id != review_0.occurrence_id
      assert review_1.attempt_id != review_0.attempt_id
      assert review_1.context_requirement == fresh()
      assert review_1.context_lineage_occurrence_id == nil
      assert review_1.inputs["change_set"].value["version"] == 1

      {:ok, run, [publish]} =
        complete(run, review_1, %{"verdict" => %{"status" => "accepted"}})

      assert publish.inputs["change_set"].value["version"] == 1
      assert publish.inputs["verdict"].value == %{"status" => "accepted"}

      {:ok, run, []} = complete(run, publish, %{})
      assert run.status == :completed

      assert semantic_occurrences(run, "review") |> length() == 2
      assert semantic_occurrences(run, "repair") |> length() == 1

      assert Enum.all?(semantic_occurrences(run, "review"), fn occurrence ->
               occurrence.semantic_step_key == "review" and occurrence.status == :completed
             end)

      [region] = Map.values(run.regions)
      assert region.status == :completed
      assert region.remediations_completed == 1
      assert length(region.check_scope_ids) == 2
      assert length(region.otherwise_scope_ids) == 1
    end

    test "immediate success never instantiates remediation and exports original carry" do
      plan = compile!(pressure_tactic(publish: true))
      {:ok, run, [plan_action]} = Runtime.start(plan)
      {:ok, run, [implement]} = complete(run, plan_action, %{"plan" => %{"summary" => "ok"}})

      {:ok, run, [review]} =
        complete(run, implement, %{"change_set" => %{"version" => 0}})

      {:ok, run, [publish]} =
        complete(run, review, %{"verdict" => %{"status" => "accepted"}})

      assert semantic_occurrences(run, "repair") == []
      assert publish.inputs["change_set"].value == %{"version" => 0}
      assert publish.inputs["verdict"].value == %{"status" => "accepted"}

      {:ok, run, []} = complete(run, publish, %{})
      assert run.status == :completed
    end

    test "exactly exhausts three remediations after four rejected checks" do
      plan = compile!(pressure_tactic())
      {:ok, run, [plan_action]} = Runtime.start(plan)
      {:ok, run, [implement]} = complete(run, plan_action, %{"plan" => %{}})
      {:ok, run, [review]} = complete(run, implement, %{"change_set" => %{"version" => 0}})

      {run, last_review} =
        Enum.reduce(1..3, {run, review}, fn cycle, {current_run, current_review} ->
          {:ok, current_run, [repair]} =
            complete(current_run, current_review, %{
              "verdict" => %{"status" => "rejected", "cycle" => cycle - 1}
            })

          assert repair.semantic_step_key == "repair"

          {:ok, current_run, [next_review]} =
            complete(current_run, repair, %{"change_set" => %{"version" => cycle}})

          {current_run, next_review}
        end)

      assert {:ok, run, []} =
               complete(run, last_review, %{
                 "verdict" => %{"status" => "rejected", "cycle" => 3}
               })

      assert run.status == :failed

      assert run.failure == %Failure{
               type: :until_exhausted,
               region_id: "until/2",
               region_occurrence_id: hd(run.region_order),
               remediations: 3,
               details: %{max_remediations: 3, checks: 4}
             }

      assert length(semantic_occurrences(run, "repair")) == 3
      assert length(semantic_occurrences(run, "review")) == 4

      assert [%RegionOccurrence{status: :exhausted, remediations_completed: 3}] =
               Map.values(run.regions)
    end

    test "recursively executes Sequence check and Parallel otherwise subtrees" do
      tactic =
        sequence([
          work("implement", produces: ["change_set"]),
          until(
            check:
              sequence([
                work("prepare_review", consumes: ["change_set"], produces: ["review_context"]),
                work("assess", consumes: ["review_context"], produces: ["verdict"])
              ]),
            condition: accepted_condition(source: "assess"),
            otherwise:
              parallel([
                work("repair",
                  consumes: ["change_set", "verdict"],
                  produces: ["change_set"]
                ),
                work("notify", consumes: ["verdict"])
              ]),
            max_remediations: 2
          ),
          work("publish", consumes: ["change_set", "verdict"])
        ])

      {:ok, run, [implement]} = tactic |> compile!() |> Runtime.start()
      {:ok, run, [prepare_0]} = complete(run, implement, %{"change_set" => %{"version" => 0}})
      {:ok, run, [assess_0]} = complete(run, prepare_0, %{"review_context" => %{"ready" => true}})

      {:ok, run, otherwise_actions} =
        complete(run, assess_0, %{"verdict" => %{"status" => "rejected"}})

      assert action_keys(otherwise_actions) == ["notify", "repair"]
      by_key = Map.new(otherwise_actions, &{&1.semantic_step_key, &1})

      {:ok, run, []} = complete(run, by_key["notify"], %{})

      {:ok, run, [prepare_1]} =
        complete(run, by_key["repair"], %{"change_set" => %{"version" => 1}})

      assert prepare_1.inputs["change_set"].value["version"] == 1

      {:ok, run, [assess_1]} = complete(run, prepare_1, %{"review_context" => %{}})

      {:ok, run, [publish]} =
        complete(run, assess_1, %{"verdict" => %{"status" => "accepted"}})

      assert publish.inputs["change_set"].value["version"] == 1
      assert publish.inputs["verdict"].value["status"] == "accepted"
      assert length(semantic_occurrences(run, "prepare_review")) == 2
      assert length(semantic_occurrences(run, "assess")) == 2
    end
  end

  describe "determinism and explicit attempts" do
    test "same plan and events reproduce identical state and actions" do
      plan = compile!(sequence([work("a", produces: ["value"]), work("b", consumes: ["value"])]))
      assert Runtime.start(plan) == Runtime.start(plan)

      {:ok, run_a, [action_a]} = Runtime.start(plan)
      {:ok, run_b, [action_b]} = Runtime.start(plan)
      event_a = Runtime.completed(action_a, %{"value" => %{"n" => 1}})
      event_b = Runtime.completed(action_b, %{"value" => %{"n" => 1}})

      assert Runtime.transition(run_a, event_a) == Runtime.transition(run_b, event_b)
      assert action_a.id == action_b.id
    end

    test "an occurrence contains a separate concrete attempt identity" do
      {:ok, run, [action]} = compile!(work("a")) |> Runtime.start()
      occurrence = run.occurrences[action.occurrence_id]

      assert occurrence.id == action.occurrence_id
      assert action.id == action.attempt_id <> "/action/execute-step"
      assert occurrence.current_attempt_id == action.attempt_id
      assert occurrence.status == :dispatched

      assert [%ExecutionAttempt{id: attempt_id, number: 1, status: :dispatched}] =
               occurrence.attempts

      assert attempt_id != occurrence.id
    end
  end

  describe "transition rejection" do
    test "rejects unknown, duplicate, pending, and wrong-attempt completions" do
      plan = compile!(sequence([work("a"), work("b")]))
      {:ok, run, [a]} = Runtime.start(plan)

      unknown = %Event{
        type: :step_completed,
        occurrence_id: "run/0/occurrence/999/missing",
        attempt_id: "attempt/1",
        outputs: %{}
      }

      assert {:error, %Error{type: :unknown_occurrence}} = Runtime.transition(run, unknown)

      pending = occurrence(run, "b")

      pending_event = %Event{
        type: :step_completed,
        occurrence_id: pending.id,
        attempt_id: pending.id <> "/attempt/1",
        outputs: %{}
      }

      assert {:error, %Error{type: :invalid_occurrence_state, details: %{status: :pending}}} =
               Runtime.transition(run, pending_event)

      wrong_attempt = %{Runtime.completed(a, %{}) | attempt_id: "wrong"}
      assert {:error, %Error{type: :invalid_attempt}} = Runtime.transition(run, wrong_attempt)

      {:ok, run, [_b]} = complete(run, a, %{})
      assert {:error, %Error{type: :duplicate_completion}} = complete(run, a, %{})
    end

    test "requires exactly declared outputs and serialization-friendly values" do
      {:ok, run, [action]} = compile!(work("a", produces: ["one", "two"])) |> Runtime.start()

      assert {:error, %Error{type: :missing_output, artifact_type: "two"}} =
               complete(run, action, %{"one" => 1})

      assert {:error, %Error{type: :undeclared_output, artifact_type: "extra"}} =
               complete(run, action, %{"one" => 1, "two" => 2, "extra" => 3})

      assert {:error, %Error{type: :invalid_artifact_value, artifact_type: "one"}} =
               complete(run, action, %{"one" => %{atom_key: "bad"}, "two" => 2})

      assert {:ok, run, []} =
               complete(run, action, %{
                 "one" => %{"nested" => [1, 2.0, true, nil, "ok"]},
                 "two" => false
               })

      assert run.status == :completed
    end

    test "rejects events after completed or failed terminal runs" do
      {:ok, run, [action]} = compile!(work("a")) |> Runtime.start()
      {:ok, completed_run, []} = complete(run, action, %{})

      assert {:error, %Error{type: :run_already_terminal, details: %{status: :completed}}} =
               complete(completed_run, action, %{})

      failed_run = exhausted_run()
      stale = %Event{type: :step_completed, occurrence_id: "x", attempt_id: "y", outputs: %{}}

      assert {:error, %Error{type: :run_already_terminal, details: %{status: :failed}}} =
               Runtime.transition(failed_run, stale)
    end

    test "rejects a cyclic externally constructed execution plan" do
      plan = compile!(sequence([work("a"), work("b")]))

      cyclic = %{
        plan
        | control_dependencies:
            plan.control_dependencies ++ [%ControlDependency{prerequisite: "b", dependent: "a"}]
      }

      assert {:error,
              %Error{
                type: :invalid_execution_plan,
                details: %{reason: :cyclic_control_dependencies}
              }} = Runtime.start(cyclic)
    end
  end

  defp exhausted_run do
    plan =
      compile!(
        until(
          check: work("review", produces: ["verdict"]),
          condition: accepted_condition(),
          otherwise: work("repair"),
          max_remediations: 1
        )
      )

    {:ok, run, [review_0]} = Runtime.start(plan)
    {:ok, run, [repair]} = complete(run, review_0, %{"verdict" => %{"status" => "no"}})
    {:ok, run, [review_1]} = complete(run, repair, %{})
    {:ok, run, []} = complete(run, review_1, %{"verdict" => %{"status" => "no"}})
    run
  end

  defp pressure_tactic(options \\ []) do
    children = [
      work("plan",
        instruction: "Analyze the available inputs and produce an implementation plan.",
        performer: class("architect"),
        context: fresh(),
        produces: ["plan"]
      ),
      work("implement",
        instruction: "Implement the supplied plan and produce a change set.",
        performer: class("builder"),
        context: fresh(),
        consumes: ["plan"],
        produces: ["change_set"]
      ),
      until(
        check:
          work("review",
            instruction:
              "Review the current change set and produce a verdict whose status is accepted or rejected.",
            performer: class("reviewer"),
            context: fresh(),
            consumes: ["change_set"],
            produces: ["verdict"]
          ),
        condition: accepted_condition(),
        otherwise:
          work("repair",
            instruction: "Repair the rejected change set and produce an updated change set.",
            performer: same_as("implement"),
            context: continue_from("implement"),
            consumes: ["change_set", "verdict"],
            produces: ["change_set"]
          ),
        max_remediations: 3
      )
    ]

    if Keyword.get(options, :publish, false) do
      sequence(children ++ [work("publish", consumes: ["change_set", "verdict"])])
    else
      sequence(children)
    end
  end

  defp accepted_condition(options \\ []) do
    equals(
      field(artifact("verdict", from: Keyword.get(options, :source)), "status"),
      "accepted"
    )
  end

  defp work(key, options \\ []) do
    defaults = [
      name: String.capitalize(key),
      instruction: "Execute test step #{key}.",
      performer: class("builder")
    ]

    step(key, Keyword.merge(defaults, options))
  end

  defp compile!(tactic) do
    assert {:ok, plan} = Compiler.compile(tactic)
    plan
  end

  defp complete(run, action, outputs),
    do: Runtime.transition(run, Runtime.completed(action, outputs))

  defp occurrence(run, semantic_step_key) do
    Enum.find_value(run.occurrence_order, fn id ->
      occurrence = run.occurrences[id]
      if occurrence.semantic_step_key == semantic_step_key, do: occurrence
    end)
  end

  defp semantic_occurrences(run, semantic_step_key) do
    run.occurrence_order
    |> Enum.map(&run.occurrences[&1])
    |> Enum.filter(&(&1.semantic_step_key == semantic_step_key))
  end

  defp action_keys(actions), do: Enum.map(actions, & &1.semantic_step_key)
end
