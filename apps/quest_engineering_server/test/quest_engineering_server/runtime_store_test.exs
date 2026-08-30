defmodule QuestEngineering.Server.RuntimeStoreTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Core.Runtime.Error, as: RuntimeError
  alias QuestEngineering.Server.Persistence.Error, as: PersistenceError
  alias QuestEngineering.Server.Persistence.OutboxWriter
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RuntimeTransition
  alias QuestEngineering.Server.RuntimeFixtures
  alias QuestEngineering.Server.RuntimeStore

  test "creates and recovers a run with its initial action atomically" do
    assert {:ok, created} =
             RuntimeStore.create_run("create-recovery", RuntimeFixtures.sequence_plan())

    assert created.revision == 0

    assert [
             %{
               semantic_step_key: "a",
               instruction: "Execute test step a.",
               id: action_id
             }
           ] = created.actions

    assert action_id == "create-recovery/occurrence/0/a/attempt/1/action/execute-step"

    created = nil
    assert created == nil

    assert {:ok, %{run: recovered, revision: 0}} = RuntimeStore.fetch_run("create-recovery")
    assert RuntimeCodec.snapshot_version() == 2
    assert hd(recovered.plan.steps).instruction == "Execute test step a."
    assert recovered.occurrences[hd(recovered.occurrence_order)].status == :dispatched

    assert {:ok,
            [
              %{
                action_id: ^action_id,
                run_revision: 0,
                action: %{instruction: "Execute test step a."}
              }
            ]} = RuntimeStore.pending_actions("create-recovery")

    assert count(RuntimeOutbox, "create-recovery") == 1
  end

  test "recovers static sequence and parallel partial-completion snapshots" do
    {:ok, %{actions: [a]}} =
      RuntimeStore.create_run("static-recovery", RuntimeFixtures.sequence_plan())

    assert {:ok, applied} =
             RuntimeStore.apply_transition(
               "static-recovery",
               "complete-a",
               Runtime.completed(a, %{})
             )

    assert [%{semantic_step_key: "b"}] = applied.actions
    assert {:ok, %{run: static_run, revision: 1}} = RuntimeStore.fetch_run("static-recovery")
    assert static_run == applied.run

    {:ok, %{actions: [start]}} =
      RuntimeStore.create_run("parallel-recovery", RuntimeFixtures.parallel_plan())

    {:ok, %{actions: branch_actions}} =
      RuntimeStore.apply_transition(
        "parallel-recovery",
        "complete-start",
        Runtime.completed(start, %{})
      )

    by_key = Map.new(branch_actions, &{&1.semantic_step_key, &1})

    {:ok, partial} =
      RuntimeStore.apply_transition(
        "parallel-recovery",
        "complete-left",
        Runtime.completed(by_key["left"], %{})
      )

    assert partial.actions == []
    assert {:ok, %{run: parallel_run, revision: 2}} = RuntimeStore.fetch_run("parallel-recovery")
    assert parallel_run == partial.run
    assert occurrence(parallel_run, "left").status == :completed
    assert occurrence(parallel_run, "right").status == :dispatched
    assert occurrence(parallel_run, "finish").status == :pending
  end

  test "deduplicates an accepted transition and returns its original result" do
    {:ok, %{actions: [a]}} =
      RuntimeStore.create_run("dedup", RuntimeFixtures.sequence_plan())

    event = Runtime.completed(a, %{})

    assert {:ok, first} = RuntimeStore.apply_transition("dedup", "completion-123", event)
    assert first.revision == 1
    refute first.idempotent_replay?

    assert [b] = first.actions

    assert {:ok, %{revision: 2}} =
             RuntimeStore.apply_transition("dedup", "completion-b", Runtime.completed(b, %{}))

    assert {:ok, replay} = RuntimeStore.apply_transition("dedup", "completion-123", event)
    assert replay.idempotent_replay?
    assert replay.revision == first.revision
    assert replay.run == first.run
    assert replay.actions == first.actions

    assert {:ok, %{revision: 2}} = RuntimeStore.fetch_run("dedup")
    assert count(RuntimeTransition, "dedup") == 2

    action_ids = Repo.all(from outbox in RuntimeOutbox, select: outbox.action_id)
    assert length(action_ids) == length(Enum.uniq(action_ids))
    assert count(RuntimeOutbox, "dedup") == 3
  end

  test "rejects reuse of a transition id for a different event" do
    {:ok, %{actions: [a]}} =
      RuntimeStore.create_run("conflict", RuntimeFixtures.sequence_plan())

    event = Runtime.completed(a, %{})
    assert {:ok, _result} = RuntimeStore.apply_transition("conflict", "completion-123", event)

    conflicting = %{event | outputs: %{"unexpected" => true}}

    assert {:error, %PersistenceError{type: :transition_id_conflict}} =
             RuntimeStore.apply_transition("conflict", "completion-123", conflicting)

    assert {:ok, %{revision: 1}} = RuntimeStore.fetch_run("conflict")
    assert count(RuntimeTransition, "conflict") == 1
  end

  test "invalid runtime events leave snapshot, history, and outbox unchanged" do
    {:ok, %{run: original, actions: [a]}} =
      RuntimeStore.create_run("invalid-event", RuntimeFixtures.sequence_plan())

    invalid = %{Runtime.completed(a, %{}) | attempt_id: "wrong-attempt"}

    assert {:error, %RuntimeError{type: :invalid_attempt}} =
             RuntimeStore.apply_transition("invalid-event", "invalid", invalid)

    assert {:ok, %{run: ^original, revision: 0}} = RuntimeStore.fetch_run("invalid-event")
    assert count(RuntimeTransition, "invalid-event") == 0
    assert count(RuntimeOutbox, "invalid-event") == 1
  end

  test "the same action id with a different payload is an integrity conflict" do
    {:ok, %{actions: [action]}} =
      RuntimeStore.create_run("action-integrity", RuntimeFixtures.sequence_plan())

    assert {:ok, %{action_id: action_id}} =
             OutboxWriter.insert_action("action-integrity", 0, action)

    assert action_id == action.id
    assert count(RuntimeOutbox, "action-integrity") == 1

    conflicting = %{action | semantic_step_key: "different-step"}

    assert {:error, %PersistenceError{type: :action_id_conflict, action_id: ^action_id}} =
             OutboxWriter.insert_action("action-integrity", 0, conflicting)

    assert count(RuntimeOutbox, "action-integrity") == 1
  end

  test "an outbox integrity failure rolls back state and transition history" do
    {:ok, %{run: run, actions: [a]}} =
      RuntimeStore.create_run("forced-rollback", RuntimeFixtures.sequence_plan())

    {:ok, _next_run, [b]} = Runtime.transition(run, Runtime.completed(a, %{}))
    corrupt_b = %{b | semantic_step_key: "corrupt"}
    assert {:ok, _row} = OutboxWriter.insert_action("forced-rollback", 1, corrupt_b)

    assert {:error, %PersistenceError{type: :action_id_conflict}} =
             RuntimeStore.apply_transition(
               "forced-rollback",
               "complete-a",
               Runtime.completed(a, %{})
             )

    assert {:ok, %{run: ^run, revision: 0}} = RuntimeStore.fetch_run("forced-rollback")
    assert count(RuntimeTransition, "forced-rollback") == 0
    assert count(RuntimeOutbox, "forced-rollback") == 2
  end

  test "durable action intents survive memory loss without embedding delivery state" do
    {:ok, %{actions: [action]}} =
      RuntimeStore.create_run("delivery", RuntimeFixtures.sequence_plan())

    action_id = action.id
    action = nil
    assert action == nil

    assert {:ok, [%{action_id: ^action_id} = intent]} =
             RuntimeStore.pending_actions("delivery")

    refute Map.has_key?(intent, :status)
    refute Map.has_key?(intent, :worker_id)
    assert count(RuntimeOutbox, "delivery") == 1
  end

  test "persists and recovers representative runtime states through PostgreSQL JSONB" do
    states = representative_states()

    states
    |> Enum.with_index()
    |> Enum.each(fn {{name, run}, revision} ->
      {:ok, snapshot} = RuntimeCodec.encode_snapshot(run)

      assert {:ok, _row} =
               Repo.insert(
                 RuntimeRun.create_changeset(%{
                   id: run.id,
                   snapshot: snapshot,
                   snapshot_version: RuntimeCodec.snapshot_version(),
                   status: Atom.to_string(run.status),
                   revision: revision
                 })
               )

      assert {:ok, %{run: recovered, revision: ^revision}} = RuntimeStore.fetch_run(run.id)
      assert recovered == run, "snapshot mismatch for #{name}"
    end)
  end

  test "decodes allowlisted closed atoms on a cold recovery path and rejects open atoms" do
    assert {:ok, :fresh} = RuntimeCodec.decode(%{"$atom" => "fresh"})

    unknown = "unknown_runtime_atom_#{System.unique_integer([:positive])}"

    assert {:error,
            %PersistenceError{type: :invalid_persisted_term, details: %{reason: :unknown_atom}}} =
             RuntimeCodec.decode(%{"$atom" => unknown})
  end

  test "returns a structured error for an unsupported snapshot version" do
    {:ok, _created} =
      RuntimeStore.create_run("unsupported-version", RuntimeFixtures.sequence_plan())

    {1, nil} =
      Repo.update_all(
        from(run in RuntimeRun, where: run.id == "unsupported-version"),
        set: [snapshot_version: 999]
      )

    assert {:error,
            %PersistenceError{
              type: :unsupported_snapshot_version,
              details: %{version: 999}
            }} = RuntimeStore.fetch_run("unsupported-version")
  end

  test "full crash/restart repair flow continues only from committed database state" do
    run_id = "repair-pressure"
    {:ok, %{actions: [plan]}} = RuntimeStore.create_run(run_id, RuntimeFixtures.pressure_plan())

    {:ok, %{actions: [implement]}} =
      RuntimeStore.apply_transition(
        run_id,
        "plan-completed",
        Runtime.completed(plan, %{"plan" => %{"summary" => "ship"}})
      )

    {:ok, %{actions: [review_0]}} =
      RuntimeStore.apply_transition(
        run_id,
        "implement-completed",
        Runtime.completed(implement, %{"change_set" => %{"version" => 0}})
      )

    review_event = Runtime.completed(review_0, %{"verdict" => %{"status" => "rejected"}})

    {:ok, rejected} = RuntimeStore.apply_transition(run_id, "review-rejected", review_event)
    assert [%{semantic_step_key: "repair"}] = rejected.actions

    plan = implement = review_0 = rejected = nil
    assert [plan, implement, review_0, rejected] == [nil, nil, nil, nil]

    assert {:ok, %{run: recovered, revision: 3}} = RuntimeStore.fetch_run(run_id)
    assert occurrence(recovered, "repair").status == :dispatched

    assert {:ok, durable_intents} = RuntimeStore.pending_actions(run_id)
    recovered_repair = durable_intents |> List.last() |> Map.fetch!(:action)
    assert recovered_repair.semantic_step_key == "repair"
    assert {:ok, history} = RuntimeStore.list_transitions(run_id)
    assert Enum.count(history, &(&1.transition_id == "review-rejected")) == 1

    assert Repo.aggregate(
             from(o in RuntimeOutbox, where: o.action_id == ^recovered_repair.id),
             :count
           ) == 1

    assert {:ok, replay} = RuntimeStore.apply_transition(run_id, "review-rejected", review_event)
    assert replay.idempotent_replay?
    assert replay.revision == 3
    assert [replayed_repair] = replay.actions
    assert replayed_repair.id == recovered_repair.id

    {:ok, %{actions: [review_1], revision: 4}} =
      RuntimeStore.apply_transition(
        run_id,
        "repair-completed",
        Runtime.completed(recovered_repair, %{"change_set" => %{"version" => 1}})
      )

    assert review_1.semantic_step_key == "review"

    {:ok, %{run: completed, actions: [], revision: 5}} =
      RuntimeStore.apply_transition(
        run_id,
        "review-accepted",
        Runtime.completed(review_1, %{"verdict" => %{"status" => "accepted"}})
      )

    assert completed.status == :completed
    assert {:ok, %{run: ^completed, revision: 5}} = RuntimeStore.fetch_run(run_id)
    assert length(Enum.filter(completed.occurrence_order, &(&1 =~ "/review"))) == 2
    assert length(Enum.filter(completed.occurrence_order, &(&1 =~ "/repair"))) == 1
  end

  defp representative_states do
    initial = start!(RuntimeFixtures.sequence_plan(), "snapshot-initial")
    static_initial = start!(RuntimeFixtures.sequence_plan(), "snapshot-static-mid")
    static_mid = complete!(static_initial, action(static_initial, "a"), %{})

    parallel_initial = start!(RuntimeFixtures.parallel_plan(), "snapshot-parallel")

    parallel_branches =
      complete_with_actions!(parallel_initial, action(parallel_initial, "start"), %{})

    {parallel_ready, branches} = parallel_branches

    parallel_partial =
      complete!(parallel_ready, Enum.find(branches, &(&1.semantic_step_key == "left")), %{})

    until_check = until_check_state("snapshot-until-check")

    remediation_check = until_check_state("snapshot-until-remediation")

    remediation =
      complete!(
        remediation_check,
        action(remediation_check, "review"),
        %{"verdict" => %{"status" => "rejected"}}
      )

    carried_check = until_check_state("snapshot-until-carried")

    carried_remediation =
      complete!(
        carried_check,
        action(carried_check, "review"),
        %{"verdict" => %{"status" => "rejected"}}
      )

    carried =
      complete!(
        carried_remediation,
        action(carried_remediation, "repair"),
        %{"change_set" => %{"version" => 1}}
      )

    completed_initial = start!(RuntimeFixtures.sequence_plan(), "snapshot-completed")
    completed_a = complete!(completed_initial, action(completed_initial, "a"), %{})
    completed_b = complete!(completed_a, action(completed_a, "b"), %{})
    completed = complete!(completed_b, action(completed_b, "c"), %{})

    exhausted_initial =
      start!(RuntimeFixtures.pressure_plan(max_remediations: 1), "snapshot-exhausted")

    exhausted_plan =
      complete!(exhausted_initial, action(exhausted_initial, "plan"), %{"plan" => %{}})

    exhausted_implement =
      complete!(
        exhausted_plan,
        action(exhausted_plan, "implement"),
        %{"change_set" => %{"version" => 0}}
      )

    exhausted_review_0 =
      complete!(
        exhausted_implement,
        action(exhausted_implement, "review"),
        %{"verdict" => %{"status" => "rejected"}}
      )

    exhausted_repair =
      complete!(
        exhausted_review_0,
        action(exhausted_review_0, "repair"),
        %{"change_set" => %{"version" => 1}}
      )

    exhausted =
      complete!(
        exhausted_repair,
        action(exhausted_repair, "review"),
        %{"verdict" => %{"status" => "rejected"}}
      )

    [
      initial: initial,
      static_sequence_mid_run: static_mid,
      parallel_partially_completed: parallel_partial,
      until_initial_check: until_check,
      until_remediation: remediation,
      until_after_carry_evolution: carried,
      completed: completed,
      failed_exhausted: exhausted
    ]
  end

  defp until_check_state(run_id) do
    initial = start!(RuntimeFixtures.pressure_plan(), run_id)
    after_plan = complete!(initial, action(initial, "plan"), %{"plan" => %{}})

    complete!(
      after_plan,
      action(after_plan, "implement"),
      %{"change_set" => %{"version" => 0}}
    )
  end

  defp start!(plan, run_id) do
    {:ok, run, _actions} = Runtime.start(plan, run_id)
    run
  end

  defp complete!(run, action, outputs) do
    {:ok, next_run, _actions} = Runtime.transition(run, Runtime.completed(action, outputs))
    next_run
  end

  defp complete_with_actions!(run, action, outputs) do
    {:ok, next_run, actions} = Runtime.transition(run, Runtime.completed(action, outputs))
    {next_run, actions}
  end

  defp action(run, semantic_step_key) do
    occurrence = occurrence(run, semantic_step_key)
    plan_step = Enum.find(run.plan.steps, &(&1.key == semantic_step_key))

    %Runtime.Action{
      id: occurrence.current_attempt_id <> "/action/execute-step",
      type: :execute_step,
      run_id: run.id,
      occurrence_id: occurrence.id,
      attempt_id: occurrence.current_attempt_id,
      semantic_step_key: semantic_step_key,
      instruction: plan_step.instruction,
      performer_requirement: plan_step.performer,
      performer_affinity_occurrence_id: nil,
      context_requirement: plan_step.context,
      context_lineage_occurrence_id: nil,
      inputs:
        Map.new(occurrence.input_artifact_ids, fn {type, id} -> {type, run.artifacts[id]} end),
      declared_outputs: plan_step.produces
    }
  end

  defp count(schema, run_id) do
    Repo.aggregate(from(row in schema, where: row.run_id == ^run_id), :count)
  end

  defp occurrence(run, semantic_step_key) do
    run.occurrence_order
    |> Enum.map(&run.occurrences[&1])
    |> Enum.reverse()
    |> Enum.find(&(&1.semantic_step_key == semantic_step_key))
  end
end

defmodule QuestEngineering.Server.RuntimeStoreConcurrencyTest do
  use ExUnit.Case, async: false

  import Ecto.Query

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Core.Runtime.Error, as: RuntimeError
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RuntimeTransition
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeFixtures
  alias QuestEngineering.Server.RuntimeStore

  test "PostgreSQL row locking permits only one concurrent transition from a revision" do
    Sandbox.unboxed_run(Repo, fn ->
      run_id = "concurrent-transition-run"
      delete_run(run_id)

      try do
        {:ok, %{actions: [action]}} =
          RuntimeStore.create_run(run_id, RuntimeFixtures.sequence_plan())

        event = Runtime.completed(action, %{})

        parent = self()

        tasks =
          for transition_id <- ["concurrent-a", "concurrent-b"] do
            Task.async(fn ->
              result = RuntimeStore.apply_transition(run_id, transition_id, event)
              send(parent, {:transition_finished, self()})

              receive do
                :release_connection_client -> result
              end
            end)
          end

        for _task <- tasks do
          assert_receive {:transition_finished, _pid}, 5_000
        end

        Enum.each(tasks, &send(&1.pid, :release_connection_client))
        results = Task.await_many(tasks, 5_000)

        assert Enum.count(results, &match?({:ok, %{revision: 1}}, &1)) == 1

        assert Enum.count(
                 results,
                 &match?({:error, %RuntimeError{type: :duplicate_completion}}, &1)
               ) == 1

        assert {:ok, %{revision: 1}} = RuntimeStore.fetch_run(run_id)
        assert {:ok, [_transition]} = RuntimeStore.list_transitions(run_id)
      after
        delete_run(run_id)
      end
    end)
  end

  defp delete_run(run_id) do
    Repo.delete_all(from outbox in RuntimeOutbox, where: outbox.run_id == ^run_id)
    Repo.delete_all(from transition in RuntimeTransition, where: transition.run_id == ^run_id)
    Repo.delete_all(from run in RuntimeRun, where: run.id == ^run_id)
  end
end
