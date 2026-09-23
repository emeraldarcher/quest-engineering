defmodule QuestEngineering.Server.ReviewDeliveryGatingTest do
  use QuestEngineering.Server.DataCase, async: false

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ExecutionRecovery
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerStore

  setup do
    root = Path.expand(".pi/tmp/review-gate-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)

    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:review-gate" => root})

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})
    end)

    %{root: root}
  end

  test "a technically completed rejected Review cannot create Delivery", %{root: root} do
    fixture = fixture(implementation_review_sequence())
    {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker(root)

    implement = schedule!(launched.run_id, "implement")
    complete!(worker, implement, %{"change_set" => %{"version" => 1}})
    review = schedule!(launched.run_id, "review")
    result = complete!(worker, review, %{"verdict" => %{"status" => "rejected"}})

    assert result.transition.run.status == :completed
    assert is_nil(result.delivery)
    refute Repo.get_by(RunDelivery, run_id: launched.run_id)

    assert {:ok, projection} = RunProjection.get(launched.run_id)
    assert projection.review_gate.status == "rejected"
    assert Enum.any?(projection.issues, &(&1.code == "acceptance_not_satisfied"))

    assert View.quest(fixture.quest).lifecycle == %{
             state: "needs_attention",
             label: "Review Not Accepted",
             current_run_id: launched.run_id,
             primary_action: "run_again",
             issue: %{
               code: "acceptance_not_satisfied",
               message: "The exact Change Set required for Delivery was rejected."
             }
           }

    assert {:ok, _new_run} = LaunchQuest.launch(fixture.quest.id)

    historical_delivery =
      Repo.insert!(
        RunDelivery.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: launched.run_id,
          quest_id: fixture.quest.id,
          state: "review_open",
          command_revision: 1,
          provider: "github",
          pull_request_number: 11
        })
      )

    assert %RunDelivery{id: historical_id, state: "review_open"} =
             DeliveryStore.ensure_for_completed_run(launched.run_id)

    assert historical_id == historical_delivery.id
  end

  test "an accepted structured verdict makes a completed Run Delivery eligible", %{root: root} do
    fixture = fixture(implementation_review_sequence())
    {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker(root)

    implement = schedule!(launched.run_id, "implement")
    complete!(worker, implement, %{"change_set" => %{"version" => 1}})
    review = schedule!(launched.run_id, "review")
    result = complete!(worker, review, %{"verdict" => %{"status" => "accepted"}})

    assert result.transition.run.status == :completed
    assert %RunDelivery{state: "pending"} = result.delivery
    assert Repo.get_by!(RunDelivery, run_id: launched.run_id).id == result.delivery.id
    assert {:ok, %{review_gate: %{status: "accepted"}}} = RunProjection.get(launched.run_id)
  end

  test "review remediation exhaustion fails semantically and never starts Delivery", %{root: root} do
    fixture = fixture(gated_tactic(1))
    {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker(root)

    implement = schedule!(launched.run_id, "implement")
    complete!(worker, implement, %{"change_set" => %{"version" => 1}})
    review_1 = schedule!(launched.run_id, "review")
    complete!(worker, review_1, %{"verdict" => %{"status" => "rejected"}})
    repair = schedule!(launched.run_id, "repair")
    complete!(worker, repair, %{"change_set" => %{"version" => 2}})
    review_2 = schedule!(launched.run_id, "review")
    result = complete!(worker, review_2, %{"verdict" => %{"status" => "rejected"}})

    assert result.transition.run.status == :failed
    assert result.transition.run.failure.type == :until_exhausted
    assert is_nil(result.delivery)
    refute Repo.get_by(RunDelivery, run_id: launched.run_id)

    assert {:ok, projection} = RunProjection.get(launched.run_id)
    assert projection.review_gate.status == "rejected"
    assert Enum.any?(projection.issues, &(&1.code == "review_exhausted"))
    assert View.quest(fixture.quest).lifecycle.state == "needs_attention"
  end

  test "uncertain retry stays in one Review occurrence and rejection alone starts remediation", %{
    root: root
  } do
    fixture = fixture(gated_tactic(1))
    {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker(root)

    implement = schedule!(launched.run_id, "implement")
    complete!(worker, implement, %{"change_set" => %{"version" => 1}})
    review_1 = schedule!(launched.run_id, "review")

    assert {:ok, _uncertain} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               review_1.action_id,
               %{"reason" => "physical outcome unknown"}
             )

    occurrence_id = review_1.execution.identity.occurrence_id
    assert {:ok, _recovery} = ExecutionRecovery.retry(launched.run_id, occurrence_id)
    review_2 = schedule!(launched.run_id, "review")
    complete!(worker, review_2, %{"verdict" => %{"status" => "rejected"}})

    assert review_2.execution.identity.occurrence_id == occurrence_id
    assert review_2.execution.identity.attempt_id != review_1.execution.identity.attempt_id

    assert {:ok, %{run: run}} = RuntimeStore.fetch_run(launched.run_id)
    assert Enum.count(run.occurrence_order, &String.ends_with?(&1, "/review")) == 1
    assert Enum.count(run.occurrence_order, &String.ends_with?(&1, "/repair")) == 1

    assert {:ok, projection} = RunProjection.get(launched.run_id)
    review = Enum.find(projection.steps, &(&1.occurrence_id == occurrence_id))

    assert Enum.map(review.attempts, &{&1.number, &1.state, &1.resolution}) ==
             [{1, "uncertain", "retried"}, {2, "completed", nil}]

    assert Enum.map(review.attempts, & &1.output_produced) == [false, true]
    assert [verdict] = Enum.filter(projection.artifacts, &(&1.type == "review_verdict"))
    assert verdict.producer_attempt_id == review_2.execution.identity.attempt_id
    refute Repo.get_by(RunDelivery, run_id: launched.run_id)
  end

  test "uncertain retry followed by acceptance skips Repair and creates Delivery", %{root: root} do
    fixture = fixture(gated_tactic(1))
    {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker(root)

    implement = schedule!(launched.run_id, "implement")
    complete!(worker, implement, %{"change_set" => %{"version" => 1}})
    review_1 = schedule!(launched.run_id, "review")

    assert {:ok, _uncertain} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               review_1.action_id,
               %{"reason" => "physical outcome unknown"}
             )

    occurrence_id = review_1.execution.identity.occurrence_id
    assert {:ok, _recovery} = ExecutionRecovery.retry(launched.run_id, occurrence_id)
    review_2 = schedule!(launched.run_id, "review")
    result = complete!(worker, review_2, %{"verdict" => %{"status" => "accepted"}})

    assert result.transition.run.status == :completed
    assert %RunDelivery{} = result.delivery

    assert Enum.count(result.transition.run.occurrence_order, &String.ends_with?(&1, "/review")) ==
             1

    refute Enum.any?(result.transition.run.occurrence_order, &String.ends_with?(&1, "/repair"))
  end

  defp implementation_review_sequence do
    sequence([
      implement_step(),
      step("review",
        name: "Review",
        instruction: "Produce a structured review verdict.",
        performer: class("reviewer"),
        consumes: [input("change_set", "change_set")],
        produces: [
          output("verdict", "review_verdict",
            review: review("implementation_acceptance", "change_set")
          )
        ]
      )
    ])
  end

  defp gated_tactic(max_remediations) do
    sequence([
      implement_step(),
      until(
        check:
          step("review",
            name: "Review",
            instruction: "Produce a structured review verdict.",
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
            instruction: "Repair using the current change set and rejected verdict.",
            performer: same_as("implement"),
            context: continue_from("implement"),
            consumes: [input("change_set", "change_set"), input("verdict", "review_verdict")],
            produces: [output("change_set", "change_set")]
          ),
        max_remediations: max_remediations
      )
    ])
  end

  defp implement_step do
    step("implement",
      name: "Implement",
      instruction: "Implement.",
      performer: class("builder"),
      produces: [output("change_set", "change_set")]
    )
  end

  defp fixture(tactic) do
    suffix = Integer.to_string(System.unique_integer([:positive]))

    {:ok, workspace} =
      Products.create_workspace(%{
        key: "review-gate-#{suffix}",
        name: "workspace:review-gate",
        source_kind: :local_git
      })

    {:ok, builder} =
      Products.create_class(%{
        key: "builder",
        name: "Builder",
        instructions: "Build."
      })

    {:ok, reviewer} =
      Products.create_class(%{
        key: "reviewer",
        name: "Reviewer",
        instructions: "Review."
      })

    {:ok, coding} = loadout("coding-#{suffix}", :read_write)
    {:ok, review} = loadout("review-#{suffix}", :read_only)

    {:ok, squad} =
      Products.create_squad(%{
        key: "review-squad-#{suffix}",
        name: "Review Squad",
        members: [
          %{key: "builder", name: "Builder", class_id: builder.id, loadout_id: coding.id},
          %{key: "reviewer", name: "Reviewer", class_id: reviewer.id, loadout_id: review.id}
        ]
      })

    {:ok, quest} =
      Products.create_quest(%{
        title: "Review gate #{suffix}",
        objective: "Prove semantic review gating.",
        workspace_id: workspace.id,
        squad_id: squad.id,
        tactic_source: TacticSource.inline(tactic)
      })

    %{quest: quest}
  end

  defp loadout(key, access) do
    Products.create_loadout(%{
      key: key,
      name: key,
      harness: "fake",
      model: %ModelRef{provider: "fake", model: "test"},
      reasoning: "low",
      tool_policy: %QuestEngineering.Core.Product.ToolPolicy.Exact{tools: []},
      workspace_access: access
    })
  end

  defp register_worker(root) do
    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "harness_kind" => "fake",
          "models" => [
            %{
              "provider" => "fake",
              "model" => "test",
              "display_name" => "Test model",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{
                "kind" => "enumerated",
                "values" => ["low", "medium", "high"]
              }
            }
          ],
          "supported_tool_policies" => ["exact"],
          "tool_enforcement" => "exact",
          "tool_profile" => %{"tools" => []},
          "workspaces" => [
            %{
              "ref" => "workspace:review-gate",
              "root" => root,
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }

    {:ok, worker} =
      WorkerStore.register(
        "review-worker-#{System.unique_integer([:positive])}",
        capabilities,
        Ecto.UUID.generate()
      )

    worker
  end

  defp schedule!(run_id, semantic_step_key) do
    assert {:ok, dispatch} = SchedulingStore.schedule_next(run_id)
    assert dispatch.execution.identity.semantic_step_key == semantic_step_key
    dispatch
  end

  defp complete!(worker, dispatch, outputs) do
    assert {:ok, result} =
             CompletionAdapter.complete(worker.id, worker.connection_generation, %{
               action_id: dispatch.action_id,
               occurrence_id: dispatch.execution.identity.occurrence_id,
               attempt_id: dispatch.execution.identity.attempt_id,
               outputs: outputs
             })

    result
  end
end
