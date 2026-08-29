defmodule QuestEngineering.Core.CompilerTest do
  use ExUnit.Case, async: true

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.CompileError
  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ArtifactCarry
  alias QuestEngineering.Core.ExecutionPlan.ConditionBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference
  alias QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  describe "string identities" do
    test "uses strings for every open-ended identity" do
      tactic =
        sequence([
          work("plan", performer: class("architect"), produces: ["plan"]),
          work("implement", consumes: [artifact("plan", from: "plan")])
        ])

      plan = compile!(tactic)

      assert [%{key: "plan", performer: %PerformerRequirement{value: "architect"}} | _] =
               plan.steps

      assert [%ArtifactBinding{type: "plan", producer: "plan"}] = plan.artifact_bindings
    end

    test "rejects atom step, class, artifact, and source identities" do
      tactic =
        step(:implement,
          name: "Implement",
          instruction: "Implement the supplied plan.",
          performer: class(:builder),
          consumes: [artifact(:plan, from: :plan)]
        )

      assert {:error, errors} = Compiler.compile(tactic)
      reasons = Enum.map(errors, & &1.details.reason)

      assert :invalid_step_key in reasons
      assert :invalid_performer_requirement in reasons
      assert :invalid_artifact_declaration in reasons
    end
  end

  describe "step instructions" do
    test "preserves a non-empty serialization-safe instruction unchanged" do
      instruction = "Inspect the inputs.\nProduce the requested résumé artifact."
      plan = compile!(work("inspect", instruction: instruction))

      assert [%{instruction: ^instruction}] = plan.steps
    end

    test "rejects missing, blank, non-string, and invalid UTF-8 instructions" do
      for instruction <- [nil, "", " \n\t", :inspect, <<255>>] do
        assert {:error, errors} =
                 Compiler.compile(
                   step("inspect",
                     name: "Inspect",
                     instruction: instruction,
                     performer: class("builder")
                   )
                 )

        assert Enum.any?(errors, fn
                 %CompileError{
                   type: :invalid_structure,
                   details: %{reason: :invalid_step_instruction}
                 } ->
                   true

                 _error ->
                   false
               end)
      end
    end
  end

  describe "static structural compilation" do
    test "compiles a simple sequence in order without control regions" do
      plan = compile!(sequence([work("a"), work("b"), work("c")]))

      assert dependency_pairs(plan) == [{"a", "b"}, {"b", "c"}]
      assert Enum.map(plan.steps, & &1.key) == ["a", "b", "c"]
      assert plan.control_regions == []
    end

    test "does not order parallel children" do
      plan = compile!(parallel([work("a"), work("b"), work("c")]))

      assert plan.control_dependencies == []
      assert Enum.map(plan.steps, & &1.key) == ["a", "b", "c"]
    end

    test "a sequence after parallel waits for every branch" do
      plan =
        compile!(
          sequence([
            work("a"),
            parallel([work("b"), work("c")]),
            work("d")
          ])
        )

      assert dependency_pairs(plan) == [
               {"a", "b"},
               {"a", "c"},
               {"b", "d"},
               {"c", "d"}
             ]
    end

    test "compiles nested static structures recursively" do
      tactic =
        parallel([
          sequence([work("a"), work("b")]),
          sequence([work("c"), work("d")])
        ])

      assert tactic |> compile!() |> dependency_pairs() == [{"a", "b"}, {"c", "d"}]
    end
  end

  describe "static artifact resolution" do
    test "binds unique, transitive, and parallel upstream producers" do
      tactic =
        sequence([
          parallel([
            work("plan", produces: ["plan"]),
            work("tests", produces: ["test_suite"])
          ]),
          work("prepare"),
          work("implement", consumes: ["plan", "test_suite"])
        ])

      plan = compile!(tactic)

      assert plan.artifact_bindings == [
               %ArtifactBinding{consumer: "implement", type: "plan", producer: "plan"},
               %ArtifactBinding{
                 consumer: "implement",
                 type: "test_suite",
                 producer: "tests"
               }
             ]
    end

    test "returns missing and ordered ambiguous errors" do
      assert {:error, [%CompileError{type: :missing_artifact, candidate_sources: []}]} =
               Compiler.compile(work("implement", consumes: ["plan"]))

      tactic =
        sequence([
          parallel([
            work("backend_plan", produces: ["plan"]),
            work("frontend_plan", produces: ["plan"])
          ]),
          work("implement", consumes: ["plan"])
        ])

      assert {:error,
              [
                %CompileError{
                  type: :ambiguous_artifact,
                  candidate_sources: ["backend_plan", "frontend_plan"]
                }
              ]} = Compiler.compile(tactic)
    end

    test "uses explicit semantic sources and validates them" do
      tactic =
        sequence([
          parallel([
            work("backend_plan", produces: ["plan"]),
            work("frontend_plan", produces: ["plan"])
          ]),
          work("implement", consumes: [artifact("plan", from: "backend_plan")])
        ])

      assert [%ArtifactBinding{producer: "backend_plan"}] = compile!(tactic).artifact_bindings

      assert_invalid_source(
        sequence([
          work("plan", produces: ["plan"]),
          work("implement", consumes: [artifact("plan", from: "unknown")])
        ]),
        :unknown_step
      )

      assert_invalid_source(
        sequence([
          work("plan", produces: ["findings"]),
          work("implement", consumes: [artifact("plan", from: "plan")])
        ]),
        :artifact_not_produced
      )

      assert_invalid_source(
        parallel([
          work("plan", produces: ["plan"]),
          work("implement", consumes: [artifact("plan", from: "plan")])
        ]),
        :not_upstream
      )
    end
  end

  describe "performer affinity" do
    test "preserves valid same_as affinity inside every remediation" do
      plan = compile!(pressure_test_tactic())
      repair = Enum.find(plan.steps, &(&1.key == "repair"))

      assert repair.performer == %PerformerRequirement{selector: :same_as, value: "implement"}
    end

    test "rejects missing, self, future, parallel, and optional-path references" do
      cases = [
        {sequence([work("a"), work("b", performer: same_as("missing"))]), :unknown_step},
        {work("a", performer: same_as("a")), :self_reference},
        {sequence([work("a", performer: same_as("b")), work("b")]),
         :not_guaranteed_to_execute_before},
        {parallel([work("a"), work("b", performer: same_as("a"))]),
         :not_guaranteed_to_execute_before},
        {sequence([
           base_until(otherwise: work("repair")),
           work("after", performer: same_as("repair"))
         ]), :not_guaranteed_to_execute_before}
      ]

      Enum.each(cases, fn {tactic, reason} ->
        assert {:error, errors} = Compiler.compile(tactic)

        assert Enum.any?(errors, fn
                 %CompileError{type: :invalid_performer_reference, details: %{reason: ^reason}} ->
                   true

                 _error ->
                   false
               end)
      end)
    end

    test "allows affinity to a check step from remediation and after the region" do
      tactic =
        sequence([
          until(
            check: work("review", produces: ["verdict"]),
            condition: accepted_condition(),
            otherwise: work("repair", performer: same_as("review")),
            max_remediations: 1
          ),
          work("publish", performer: same_as("review"))
        ])

      assert {:ok, _plan} = Compiler.compile(tactic)
    end
  end

  describe "context lineage" do
    test "preserves explicit fresh context in the compiled step" do
      plan = compile!(work("review", context: fresh()))

      assert [%{context: %ContextRequirement{selector: :fresh, value: nil}}] = plan.steps
    end

    test "uses fresh context as the deterministic Step default" do
      tactic = work("review")

      assert tactic.context == fresh()
      assert hd(compile!(tactic).steps).context == fresh()
    end

    test "allows continuation from a guaranteed upstream step" do
      plan =
        compile!(
          sequence([
            work("implement"),
            work("repair", context: continue_from("implement"))
          ])
        )

      assert Enum.find(plan.steps, &(&1.key == "repair")).context ==
               %ContextRequirement{selector: :continue_from, value: "implement"}
    end

    test "rejects malformed, missing, self, future, and parallel sibling requirements" do
      assert {:error, errors} =
               Compiler.compile(
                 work("a", context: %ContextRequirement{selector: :fresh, value: "a"})
               )

      assert [%CompileError{type: :invalid_context_requirement, step: "a"}] = errors

      cases = [
        {work("a", context: continue_from("missing")), :missing},
        {work("a", context: continue_from("a")), :self_reference},
        {sequence([
           work("a", context: continue_from("b")),
           work("b")
         ]), :not_upstream},
        {parallel([
           work("a", context: continue_from("b")),
           work("b")
         ]), :not_upstream}
      ]

      Enum.each(cases, fn {tactic, reason} ->
        assert {:error, reference_errors} = Compiler.compile(tactic)

        assert Enum.any?(reference_errors, fn
                 %CompileError{
                   type: :invalid_context_reference,
                   details: %{reason: ^reason}
                 } ->
                   true

                 _error ->
                   false
               end)
      end)
    end

    test "allows a deeply nested step to continue an upstream external lineage" do
      tactic =
        sequence([
          work("implement"),
          sequence([
            parallel([
              sequence([
                work("prepare"),
                work("repair", context: continue_from("implement"))
              ]),
              work("observe")
            ])
          ])
        ])

      assert {:ok, _plan} = Compiler.compile(tactic)
    end

    test "keeps performer affinity and context lineage independent" do
      plan =
        compile!(
          sequence([
            work("implement", performer: class("builder")),
            work("same_performer_fresh",
              performer: same_as("implement"),
              context: fresh()
            ),
            work("different_performer_continuation",
              performer: class("maintainer"),
              context: continue_from("implement")
            )
          ])
        )

      same_performer = Enum.find(plan.steps, &(&1.key == "same_performer_fresh"))
      continuation = Enum.find(plan.steps, &(&1.key == "different_performer_continuation"))

      assert same_performer.performer == same_as("implement")
      assert same_performer.context == fresh()
      assert continuation.performer == class("maintainer")
      assert continuation.context == continue_from("implement")
    end

    test "allows continuation after a completed parallel barrier" do
      tactic =
        sequence([
          parallel([work("implementation"), work("tests")]),
          work("verify", context: continue_from("implementation"))
        ])

      assert {:ok, _plan} = Compiler.compile(tactic)
    end

    test "allows otherwise to continue from its guaranteed preceding check" do
      tactic =
        until(
          check: work("diagnose", context: fresh(), produces: ["verdict"]),
          condition: accepted_condition(source: "diagnose"),
          otherwise: work("repair", context: continue_from("diagnose")),
          max_remediations: 2
        )

      assert {:ok, _plan} = Compiler.compile(tactic)
    end

    test "rejects continuation from an optional otherwise step after Until" do
      tactic =
        sequence([
          base_until(otherwise: work("repair")),
          work("publish", context: continue_from("repair"))
        ])

      assert {:error,
              [
                %CompileError{
                  type: :invalid_context_reference,
                  referenced_step: "repair",
                  details: %{reason: :not_upstream}
                }
              ]} = Compiler.compile(tactic)
    end

    test "reports the containing Until region on context reference errors" do
      tactic = base_until(otherwise: work("repair", context: continue_from("missing")))

      assert {:error,
              [
                %CompileError{
                  type: :invalid_context_reference,
                  referenced_step: "missing",
                  region: "until/root",
                  details: %{reason: :missing}
                }
              ]} = Compiler.compile(tactic)
    end

    test "retains fresh on the one repeated review definition" do
      plan = compile!(pressure_test_tactic())
      [region] = plan.control_regions
      review_steps = Enum.filter(plan.steps, &(&1.key == "review"))

      assert [%{context: %ContextRequirement{selector: :fresh, value: nil}}] = review_steps
      assert region.check.step_keys == ["review"]
    end

    test "compiles the complete repair flow deterministically" do
      tactic = pressure_test_tactic()
      assert Compiler.compile(tactic) == Compiler.compile(tactic)

      plan = compile!(tactic)
      plan_step = Enum.find(plan.steps, &(&1.key == "plan"))
      implement = Enum.find(plan.steps, &(&1.key == "implement"))
      review = Enum.find(plan.steps, &(&1.key == "review"))
      repair = Enum.find(plan.steps, &(&1.key == "repair"))

      assert plan_step.context == fresh()
      assert implement.context == fresh()
      assert review.context == fresh()
      assert repair.performer == same_as("implement")
      assert repair.context == continue_from("implement")
    end
  end

  describe "Until control regions" do
    test "represents immediate success as a check-first region" do
      plan = compile!(base_until())
      [region] = plan.control_regions

      assert region.id == "until/root"
      assert region.check.step_keys == ["review"]
      assert region.otherwise.step_keys == ["repair"]
      assert region.max_remediations == 3

      assert region.condition_binding == %ConditionBinding{
               artifact_type: "verdict",
               producer: "review",
               field: "status",
               operator: :equals,
               value: "accepted"
             }

      # No edge forces remediation before the initial check.
      assert plan.control_dependencies == []
    end

    test "encodes one-or-more remediations without cloning steps or adding cycles" do
      plan = compile!(base_until(max_remediations: 3))
      [region] = plan.control_regions

      assert Enum.map(plan.steps, & &1.key) == ["review", "repair"]
      assert region.max_remediations == 3
      assert region.check.entries == ["review"]
      assert region.otherwise.entries == ["repair"]

      refute %ControlDependency{prerequisite: "review", dependent: "repair"} in plan.control_dependencies

      refute %ControlDependency{prerequisite: "repair", dependent: "review"} in plan.control_dependencies
    end

    test "max_remediations counts remediation executions, so three permits four checks" do
      [region] = compile!(base_until(max_remediations: 3)).control_regions

      assert region.max_remediations == 3
      assert region.max_remediations + 1 == 4
    end

    test "uses a region completion endpoint when nested in Sequence" do
      plan = compile!(pressure_test_tactic(publish: true))
      ref = %ControlRegionReference{id: "until/2"}

      assert {"implement", ref} in dependency_pairs(plan)
      assert {ref, "publish"} in dependency_pairs(plan)
      refute {"review", "publish"} in dependency_pairs(plan)
    end

    test "supports Until nested in Parallel" do
      tactic =
        sequence([
          parallel([base_until(), work("other")]),
          work("finish")
        ])

      plan = compile!(tactic)
      ref = %ControlRegionReference{id: "until/0/0"}

      assert {ref, "finish"} in dependency_pairs(plan)
      assert {"other", "finish"} in dependency_pairs(plan)
    end

    test "supports static Sequence and Parallel subtrees inside Until" do
      tactic =
        sequence([
          work("implement", produces: ["change_set"]),
          until(
            check:
              sequence([
                work("prepare_review",
                  consumes: ["change_set"],
                  produces: ["review_context"]
                ),
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
          )
        ])

      plan = compile!(tactic)
      [region] = plan.control_regions

      assert region.check.control_dependencies == [
               %ControlDependency{prerequisite: "prepare_review", dependent: "assess"}
             ]

      assert region.otherwise.control_dependencies == []
      assert Enum.map(region.artifact_carries, & &1.type) == ["change_set"]
    end

    test "is deterministic including region IDs, bindings, carries, and errors" do
      tactic = pressure_test_tactic(publish: true)
      assert Compiler.compile(tactic) == Compiler.compile(tactic)

      invalid =
        base_until(
          check:
            parallel([
              work("review_a", produces: ["verdict"]),
              work("review_b", produces: ["verdict"])
            ])
        )

      assert Compiler.compile(invalid) == Compiler.compile(invalid)
    end

    test "ordinary control dependencies are acyclic" do
      plan = compile!(pressure_test_tactic(publish: true))
      assert acyclic?(plan.control_dependencies)
      assert plan.control_regions != []
    end
  end

  describe "Until condition binding" do
    test "binds one check-local producer" do
      [region] = compile!(base_until()).control_regions
      assert region.condition_binding.producer == "review"
    end

    test "rejects an artifact not produced by check" do
      tactic =
        base_until(
          check: work("review", produces: ["report"]),
          condition: accepted_condition()
        )

      assert {:error,
              [%CompileError{type: :invalid_condition_artifact, artifact_type: "verdict"}]} =
               Compiler.compile(tactic)
    end

    test "requires explicit source when check has multiple producers" do
      check =
        parallel([
          work("review_a", produces: ["verdict"]),
          work("review_b", produces: ["verdict"])
        ])

      assert {:error,
              [
                %CompileError{
                  type: :ambiguous_condition_artifact,
                  candidate_sources: ["review_a", "review_b"]
                }
              ]} = Compiler.compile(base_until(check: check))

      plan = compile!(base_until(check: check, condition: accepted_condition(source: "review_b")))
      assert hd(plan.control_regions).condition_binding.producer == "review_b"
    end
  end

  describe "Until artifact carry and exit" do
    test "makes the real ChangeSet evolution explicit" do
      plan = compile!(pressure_test_tactic())
      [region] = plan.control_regions

      assert region.artifact_carries == [
               %ArtifactCarry{
                 type: "change_set",
                 initial_producer: "implement",
                 remediation_producer: "repair",
                 check_consumers: ["review"],
                 otherwise_consumers: ["repair"]
               }
             ]

      assert region.artifact_bindings == [
               %RegionArtifactBinding{
                 consumer: "review",
                 type: "change_set",
                 phase: :check,
                 source: :current
               },
               %RegionArtifactBinding{
                 consumer: "repair",
                 type: "change_set",
                 phase: :otherwise,
                 source: :current
               }
             ]

      assert %ArtifactBinding{consumer: "repair", type: "verdict", producer: "review"} in plan.artifact_bindings
    end

    test "exposes final current ChangeSet and final Verdict downstream" do
      plan = compile!(pressure_test_tactic(publish: true))
      [region] = plan.control_regions
      bindings = Enum.filter(plan.artifact_bindings, &(&1.consumer == "publish"))

      assert [change_set, verdict] = bindings

      assert %UntilOutput{kind: :carried, type: "change_set", producer: nil} =
               change_set.producer

      assert %UntilOutput{kind: :check, type: "verdict", producer: "review"} =
               verdict.producer

      assert change_set.producer in region.outputs
      assert verdict.producer in region.outputs
    end

    test "fails rather than guessing among multiple remediation producers" do
      tactic =
        sequence([
          work("implement", produces: ["change_set"]),
          until(
            check: work("review", consumes: ["change_set"], produces: ["verdict"]),
            condition: accepted_condition(),
            otherwise:
              parallel([
                work("repair_a", produces: ["change_set"]),
                work("repair_b", produces: ["change_set"])
              ]),
            max_remediations: 2
          )
        ])

      assert {:error,
              [
                %CompileError{
                  type: :ambiguous_carried_artifact,
                  artifact_type: "change_set",
                  candidate_sources: ["repair_a", "repair_b"]
                }
              ]} = Compiler.compile(tactic)
    end
  end

  describe "validation" do
    test "rejects duplicate step keys across Until phases" do
      tactic =
        sequence([
          work("work"),
          base_until(otherwise: work("work"))
        ])

      assert {:error, errors} = Compiler.compile(tactic)
      assert %CompileError{type: :duplicate_step_key, step: "work"} in errors
    end

    test "rejects invalid Until bounds and missing phases" do
      assert {:error, errors} = Compiler.compile(base_until(max_remediations: 0))
      assert Enum.any?(errors, &(&1.type == :invalid_until_limit))

      tactic =
        until(
          check: nil,
          condition: accepted_condition(),
          otherwise: nil,
          max_remediations: 1
        )

      assert {:error, missing_errors} = Compiler.compile(tactic)
      assert Enum.count(missing_errors, &(&1.type == :invalid_until_structure)) == 2
    end

    test "rejects empty static constructs, invalid conditions, and duplicate artifacts" do
      assert {:error, [%CompileError{type: :invalid_structure}]} = Compiler.compile(sequence([]))

      assert {:error, errors} =
               Compiler.compile(
                 base_until(condition: equals(field(artifact("verdict"), ""), "ok"))
               )

      assert Enum.any?(errors, &(&1.type == :invalid_condition))

      tactic = work("bad", produces: ["plan", "plan"])

      assert {:error, [%CompileError{type: :duplicate_artifact_declaration}]} =
               Compiler.compile(tactic)
    end
  end

  defp pressure_test_tactic(options \\ []) do
    children = [
      work("plan", performer: class("architect"), context: fresh(), produces: ["plan"]),
      work("implement",
        performer: class("builder"),
        context: fresh(),
        consumes: ["plan"],
        produces: ["change_set"]
      ),
      until(
        check:
          work("review",
            performer: class("reviewer"),
            context: fresh(),
            consumes: ["change_set"],
            produces: ["verdict"]
          ),
        condition: accepted_condition(),
        otherwise:
          work("repair",
            performer: same_as("implement"),
            context: continue_from("implement"),
            consumes: ["change_set", "verdict"],
            produces: ["change_set"]
          ),
        max_remediations: 3
      )
    ]

    children =
      if Keyword.get(options, :publish, false) do
        children ++ [work("publish", consumes: ["change_set", "verdict"])]
      else
        children
      end

    sequence(children)
  end

  defp base_until(options \\ []) do
    defaults = [
      check: work("review", produces: ["verdict"]),
      condition: accepted_condition(),
      otherwise: work("repair"),
      max_remediations: 3
    ]

    until(Keyword.merge(defaults, options))
  end

  defp accepted_condition(options \\ []) do
    source = Keyword.get(options, :source)
    equals(field(artifact("verdict", from: source), "status"), "accepted")
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

  defp dependency_pairs(plan) do
    Enum.map(plan.control_dependencies, fn %ControlDependency{
                                             prerequisite: prerequisite,
                                             dependent: dependent
                                           } ->
      {prerequisite, dependent}
    end)
  end

  defp assert_invalid_source(tactic, reason) do
    assert {:error,
            [
              %CompileError{
                type: :invalid_artifact_source,
                step: "implement",
                artifact_type: "plan",
                details: ^reason
              }
            ]} = Compiler.compile(tactic)
  end

  defp acyclic?(dependencies) do
    adjacency = Enum.group_by(dependencies, & &1.prerequisite, & &1.dependent)

    nodes =
      dependencies
      |> Enum.flat_map(&[&1.prerequisite, &1.dependent])
      |> Enum.uniq()

    Enum.all?(nodes, fn node -> not reaches?(node, node, adjacency, MapSet.new(), true) end)
  end

  defp reaches?(_current, _target, _adjacency, _visited, false), do: false

  defp reaches?(current, target, adjacency, visited, true) do
    current
    |> then(&Map.get(adjacency, &1, []))
    |> Enum.any?(fn next ->
      next == target or
        (not MapSet.member?(visited, next) and
           reaches?(next, target, adjacency, MapSet.put(visited, next), true))
    end)
  end
end
