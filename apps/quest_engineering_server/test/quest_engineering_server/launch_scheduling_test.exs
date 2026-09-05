defmodule QuestEngineering.Server.LaunchSchedulingTest do
  use ExUnit.Case, async: false

  import Ecto.Query
  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ExecutionRecovery
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.OccurrenceContextBinding
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerStore

  setup do
    owner = Sandbox.start_owner!(Repo, shared: true)
    root = Path.expand(".pi/tmp/v08b-workspace-#{System.unique_integer([:positive])}")
    second_root = Path.expand(".pi/tmp/v08b-workspace-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    File.mkdir_p!(Path.join(second_root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)

    Application.put_env(:quest_engineering_server, :workspaces, %{
      "workspace:test" => root,
      "workspace:second" => second_root
    })

    on_exit(fn ->
      File.rm_rf!(root)
      File.rm_rf!(second_root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})

      Sandbox.stop_owner(owner)
    end)

    %{workspace_root: root, second_workspace_root: second_root}
  end

  test "launch atomically persists one immutable snapshot, Run, and ordered Actions" do
    fixture = product_fixture(parallel?: true)
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)

    assert %QuestLaunch{run_id: run_id} = Repo.get_by!(QuestLaunch, run_id: launched.run_id)
    assert run_id == launched.run_id
    assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(run_id)

    outbox =
      Repo.all(
        from row in RuntimeOutbox,
          where: row.run_id == ^run_id,
          order_by: [row.run_revision, row.emission_index]
      )

    assert Enum.map(outbox, & &1.emission_index) == [0, 1]
    assert Enum.map(launched.actions, & &1.semantic_step_key) == ["first", "second"]
    refute Map.has_key?(Map.from_struct(launched.snapshot.workspace), :root)

    assert {:ok, _updated} =
             Products.update_class(fixture.builder.id, %{instructions: "Changed after launch"})

    persisted = Repo.get_by!(QuestLaunch, run_id: run_id)

    {:ok, snapshot} =
      LaunchSnapshotCodec.decode(
        persisted.snapshot,
        persisted.snapshot_version
      )

    assert hd(snapshot.squad.members).class.instructions == "Build from the immutable snapshot."
  end

  test "definition-backed Quest launches through the unchanged Runtime substrate" do
    fixture = product_fixture()

    assert {:ok, definition} =
             TacticLibrary.create(%{
               key: unique("launch-tactic"),
               name: "Launch Tactic",
               body:
                 step("reusable",
                   name: "Reusable",
                   performer: class("builder"),
                   instruction: "Reusable work."
                 )
             })

    assert {:ok, _quest} =
             Products.update_quest(fixture.quest.id, %{
               tactic_source: TacticSource.definition(definition.id)
             })

    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    assert Enum.map(launched.actions, & &1.semantic_step_key) == ["reusable"]
    assert launched.snapshot.tactic_provenance.root.definition_id == definition.id

    persisted = Repo.get_by!(QuestLaunch, run_id: launched.run_id)

    assert {:ok, _updated} =
             TacticLibrary.update(definition.id, %{
               body:
                 step("reusable",
                   name: "Reusable",
                   performer: class("builder"),
                   instruction: "Changed reusable work."
                 )
             })

    assert {:error, %{code: :run_active}} = LaunchQuest.launch(fixture.quest.id)

    assert {:ok, later_quest} =
             Products.create_quest(%{
               title: "Later definition Quest",
               objective: "Run the updated definition.",
               workspace_id: fixture.quest.workspace_id,
               squad_id: fixture.quest.squad_id,
               tactic_source: TacticSource.definition(definition.id)
             })

    assert {:ok, later_launch} = LaunchQuest.launch(later_quest.id)
    assert launched.snapshot.tactic.instruction == "Reusable work."
    assert later_launch.snapshot.tactic.instruction == "Changed reusable work."

    assert :ok = TacticLibrary.archive(definition.id)

    assert {:ok, historical} =
             LaunchSnapshotCodec.decode(persisted.snapshot, persisted.snapshot_version)

    assert historical.tactic.key == "reusable"
    assert historical.tactic.instruction == "Reusable work."
    assert historical.tactic_provenance.root.definition_id == definition.id
  end

  test "launch failure leaves no partial Run, outbox, or launch rows" do
    fixture = product_fixture()
    runs_before = Repo.aggregate(RuntimeRun, :count)
    outbox_before = Repo.aggregate(RuntimeOutbox, :count)
    launches_before = Repo.aggregate(QuestLaunch, :count)
    assert :ok = Products.archive_class(fixture.builder.id)

    assert {:error, %LaunchQuest.Error{code: :missing_or_archived_definition}} =
             LaunchQuest.launch(fixture.quest.id)

    assert Repo.aggregate(RuntimeRun, :count) == runs_before
    assert Repo.aggregate(RuntimeOutbox, :count) == outbox_before
    assert Repo.aggregate(QuestLaunch, :count) == launches_before
  end

  test "whole-Run preflight refuses a host missing any potentially used configuration", context do
    fixture =
      product_fixture(parallel?: true, first_model: %ModelRef{provider: "missing", model: "x"})

    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    register_worker("worker-other", context.workspace_root, adapter: "not-pi")

    assert {:waiting, waits} = SchedulingStore.schedule_next(launched.run_id)
    assert Enum.map(waits, & &1.code) == [:waiting_for_run_workspace]
    assert Repo.aggregate(ScheduledActionExecution, :count) == 0
  end

  test "earlier emitted contenders win roster order and later work waits until release",
       context do
    fixture = product_fixture(parallel?: true, one_member?: true)
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-capacity", context.workspace_root, max_concurrency: 2)

    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)
    assert first.execution.identity.semantic_step_key == "first"
    assert first.execution.performer.member_key == "alice"

    assert {:waiting, waits} = SchedulingStore.schedule_next(launched.run_id)
    assert Enum.any?(waits, &(&1.code == :waiting_for_member))

    assert {:ok, _failed} =
             DispatchStore.mark_failed(
               worker.id,
               worker.connection_generation,
               first.action_id,
               %{"code" => "known_terminal_test_failure"}
             )

    assert {:ok, %{revision: 0}} = RuntimeStore.fetch_run(launched.run_id)
    assert Repo.get!(ScheduledActionExecution, first.action_id).state == "failed"

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    assert second.execution.identity.semantic_step_key == "second"
    assert second.execution.performer.member_key == "alice"
  end

  test "the frozen logical Member is globally occupied across racing Runs and released",
       context do
    fixture = product_fixture()
    {:ok, second_quest} = create_quest(fixture, title: "same-member-racer")
    assert {:ok, first_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(second_quest.id)
    worker = register_worker("worker-global-member", context.workspace_root, max_concurrency: 2)

    results =
      [first_launch.run_id, second_launch.run_id]
      |> Enum.map(&Task.async(fn -> SchedulingStore.schedule_next(&1) end))
      |> Task.await_many(5_000)

    assert Enum.count(results, &match?({:ok, _dispatch}, &1)) == 1
    assert Enum.count(results, &match?({:waiting, waits} when is_list(waits), &1)) == 1

    assert Enum.any?(results, fn
             {:waiting, waits} -> Enum.any?(waits, &(&1.code == :waiting_for_member))
             _ -> false
           end)

    [{winner_run_id, {:ok, winner}}, {waiting_run_id, {:waiting, _waits}}] =
      [first_launch.run_id, second_launch.run_id]
      |> Enum.zip(results)
      |> Enum.sort_by(fn {_run_id, result} -> if match?({:ok, _}, result), do: 0, else: 1 end)

    assert winner.run_id == winner_run_id
    assert Repo.get!(ScheduledActionExecution, winner.action_id).squad_id == fixture.squad.id

    assert {:ok, _failed} =
             DispatchStore.mark_failed(
               worker.id,
               worker.connection_generation,
               winner.action_id,
               %{"code" => "release_global_member"}
             )

    assert {:ok, released} = SchedulingStore.schedule_next(waiting_run_id)
    assert released.execution.performer.member_key == "alice"
  end

  test "builder release allows another Run's builder beside the first Run's reviewer", context do
    tactic =
      sequence([
        step("implement",
          name: "Implement",
          performer: class("builder"),
          instruction: "Implement."
        ),
        step("review", name: "Review", performer: class("reviewer"), instruction: "Review.")
      ])

    fixture = product_fixture(tactic: tactic)
    {:ok, second_quest} = create_quest(fixture, title: "second-sequence", tactic: tactic)
    assert {:ok, first_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(second_quest.id)
    worker = register_worker("worker-member-handoff", context.workspace_root, max_concurrency: 2)

    assert {:ok, first_builder} = SchedulingStore.schedule_next(first_launch.run_id)
    assert {:waiting, waits} = SchedulingStore.schedule_next(second_launch.run_id)
    assert Enum.any?(waits, &(&1.code == :waiting_for_member))
    complete(worker, first_builder)

    assert {:ok, first_reviewer} = SchedulingStore.schedule_next(first_launch.run_id)
    assert {:ok, second_builder} = SchedulingStore.schedule_next(second_launch.run_id)

    assert MapSet.new([first_reviewer.worker_slot, second_builder.worker_slot]) ==
             MapSet.new([0, 1])

    assert first_reviewer.execution.performer.member_key == "bob"
    assert second_builder.execution.performer.member_key == "alice"
    assert mark_running(worker, first_reviewer).state == :running
    assert mark_running(worker, second_builder).state == :running

    active_members =
      Repo.all(
        from execution in ScheduledActionExecution,
          where: execution.state == "active",
          select: {execution.squad_id, execution.member_key}
      )

    assert MapSet.new(active_members) ==
             MapSet.new([{fixture.squad.id, "alice"}, {fixture.squad.id, "bob"}])
  end

  test "different Squads execute concurrently on one Project", context do
    fixture = product_fixture()
    {:ok, other_squad} = create_squad(fixture)
    {:ok, other_quest} = create_quest(fixture, title: "other-squad", squad_id: other_squad.id)
    assert {:ok, first_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(other_quest.id)
    register_worker("worker-two-squads", context.workspace_root, max_concurrency: 2)

    assert {:ok, first} = SchedulingStore.schedule_next(first_launch.run_id)
    assert {:ok, second} = SchedulingStore.schedule_next(second_launch.run_id)
    assert MapSet.new([first.worker_slot, second.worker_slot]) == MapSet.new([0, 1])

    assert MapSet.new([
             Repo.get!(ScheduledActionExecution, first.action_id).squad_id,
             Repo.get!(ScheduledActionExecution, second.action_id).squad_id
           ]) == MapSet.new([fixture.squad.id, other_squad.id])
  end

  test "different Squads and Projects execute concurrently", context do
    fixture = product_fixture()
    {:ok, other_squad} = create_squad(fixture, "other-project-squad")

    {:ok, other_workspace} =
      Products.create_workspace(%{
        key: unique("other-project"),
        name: "workspace:second",
        source_kind: :local_git,
        source_fingerprint: nil
      })

    {:ok, other_quest} =
      create_quest(fixture,
        title: "other-project",
        squad_id: other_squad.id,
        workspace_id: other_workspace.id
      )

    assert {:ok, first_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(other_quest.id)

    register_worker("worker-two-projects", context.workspace_root,
      max_concurrency: 2,
      workspace_roots: [
        {"workspace:test", context.workspace_root},
        {"workspace:second", context.second_workspace_root}
      ]
    )

    assert {:ok, first} = SchedulingStore.schedule_next(first_launch.run_id)
    assert {:ok, second} = SchedulingStore.schedule_next(second_launch.run_id)
    assert MapSet.new([first.worker_slot, second.worker_slot]) == MapSet.new([0, 1])

    assert first.execution.logical_workspace.workspace_id !=
             second.execution.logical_workspace.workspace_id
  end

  test "a busy first candidate does not block a later free Member in either order", context do
    fixture = product_fixture()
    worker = register_worker("worker-head-of-line", context.workspace_root, max_concurrency: 3)
    assert {:ok, blocker_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, blocker} = SchedulingStore.schedule_next(blocker_launch.run_id)
    assert blocker.execution.performer.member_key == "alice"

    for {name, children} <- [
          {"blocked-first",
           [
             step("builder", name: "Builder", performer: class("builder"), instruction: "Build."),
             step("reviewer",
               name: "Reviewer",
               performer: class("reviewer"),
               instruction: "Review."
             )
           ]},
          {"free-first",
           [
             step("reviewer",
               name: "Reviewer",
               performer: class("reviewer"),
               instruction: "Review."
             ),
             step("builder", name: "Builder", performer: class("builder"), instruction: "Build.")
           ]}
        ] do
      {:ok, quest} = create_quest(fixture, title: name, tactic: parallel(children))
      assert {:ok, launch} = LaunchQuest.launch(quest.id)
      assert {:ok, scheduled} = SchedulingStore.schedule_next(launch.run_id)
      assert scheduled.execution.performer.member_key == "bob"

      assert {:ok, _failed} =
               DispatchStore.mark_failed(
                 worker.id,
                 worker.connection_generation,
                 scheduled.action_id,
                 %{"code" => "release_reviewer_between_orderings"}
               )
    end
  end

  test "uncertain global Member occupancy survives Worker re-registration", context do
    fixture = product_fixture()
    {:ok, second_quest} = create_quest(fixture, title: "uncertain-waiter")
    assert {:ok, first_launch} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(second_quest.id)
    worker = register_worker("worker-member-recovery", context.workspace_root, max_concurrency: 2)
    assert {:ok, first} = SchedulingStore.schedule_next(first_launch.run_id)

    assert {:ok, %{state: :uncertain}} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               first.action_id,
               %{"reason" => "outcome unknown"}
             )

    binding = Repo.get_by!(WorkerWorkspaceBinding, worker_id: worker.id)

    restarted =
      register_worker("worker-member-recovery", context.workspace_root, max_concurrency: 2)

    assert restarted.connection_generation == worker.connection_generation + 1

    assert {:ok, [%{status: "accepted"}]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               restarted.connection_generation,
               [
                 %{
                   "binding_id" => binding.binding_id,
                   "workspace_id" => binding.workspace_id,
                   "authorized_root_key" => binding.authorized_root_key,
                   "source_repository_root" => binding.source_repository_root,
                   "source_fingerprint" => binding.source_fingerprint,
                   "publication_remote_name" => binding.publication_remote_name,
                   "publication_repository_identity" => binding.publication_repository_identity,
                   "max_access" => binding.max_access,
                   "allow_unconfined_shell" => binding.allow_unconfined_shell
                 }
               ]
             )

    assert {:waiting, waits} = SchedulingStore.schedule_next(second_launch.run_id)
    assert Enum.any?(waits, &(&1.code == :waiting_for_member))
    assert Repo.get!(ScheduledActionExecution, first.action_id).state == "active"
  end

  test "Member affinity and continued logical context remain independent", context do
    tactic =
      sequence([
        step("build",
          name: "Build",
          performer: class("builder"),
          context: fresh(),
          instruction: "Build."
        ),
        step("review",
          name: "Review",
          performer: class("reviewer"),
          context: continue_from("build"),
          instruction: "Review in the supplied logical context."
        ),
        step("follow-up",
          name: "Follow up",
          performer: same_as("build"),
          context: fresh(),
          instruction: "Follow up in a fresh context."
        )
      ])

    fixture = product_fixture(tactic: tactic)
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-affinity", context.workspace_root)

    assert {:ok, build} = SchedulingStore.schedule_next(launched.run_id)
    assert build.execution.performer.member_key == "alice"
    complete(worker, build)

    assert {:ok, review} = SchedulingStore.schedule_next(launched.run_id)
    assert review.execution.performer.member_key == "bob"

    assert review.execution.context.logical_lineage_id ==
             build.execution.context.logical_lineage_id

    complete(worker, review)

    assert {:ok, follow_up} = SchedulingStore.schedule_next(launched.run_id)
    assert follow_up.execution.performer.member_key == "alice"

    assert follow_up.execution.context.logical_lineage_id !=
             build.execution.context.logical_lineage_id
  end

  test "open custom QE capability remains valid Product data and waits for support", context do
    fixture = product_fixture(tools: ["custom.company-capability"])
    assert fixture.loadout.tools == ["custom.company-capability"]
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    register_worker("worker-no-custom", context.workspace_root, adapter: "general-executor")

    assert {:waiting, waits} = SchedulingStore.schedule_next(launched.run_id)
    assert Enum.map(waits, & &1.code) == [:waiting_for_run_workspace]
    assert Repo.aggregate(OccurrenceMemberBinding, :count) == 0
    assert Repo.aggregate(OccurrenceContextBinding, :count) == 0
    assert Repo.aggregate(ScheduledActionExecution, :count) == 0
  end

  test "post-execution worktree integrity failure fences every later Action", context do
    fixture = product_fixture(parallel?: true)
    worker = register_worker("worker-fence", context.workspace_root, max_concurrency: 2)
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, assignment} =
             RunWorkspaceStore.fence_for_action(
               worker.id,
               worker.connection_generation,
               first.action_id,
               %{
                 "code" => "run_worktree_branch_mismatch",
                 "message" => "Execution changed the Run branch."
               }
             )

    assert assignment.state == "attention_required"

    assert Repo.get!(RunWorkspaceAssignment, launched.run_id).failure_code ==
             "run_worktree_branch_mismatch"

    assert {:waiting, waits} = SchedulingStore.schedule_next(launched.run_id)
    assert Enum.map(waits, & &1.code) == [:waiting_for_run_workspace]
    assert Repo.aggregate(ScheduledActionExecution, :count) == 1
  end

  test "concurrent unrelated Members cannot partially acquire the last Worker slot", context do
    first_fixture = product_fixture()
    assert {:ok, second_squad} = create_squad(first_fixture, "last-slot-squad")

    assert {:ok, second_quest} =
             create_quest(first_fixture, title: "last-slot", squad_id: second_squad.id)

    assert {:ok, first_launch} = LaunchQuest.launch(first_fixture.quest.id)
    assert {:ok, second_launch} = LaunchQuest.launch(second_quest.id)
    register_worker("worker-last-slot", context.workspace_root, max_concurrency: 1)

    tasks =
      for run_id <- [first_launch.run_id, second_launch.run_id] do
        Task.async(fn -> SchedulingStore.schedule_next(run_id) end)
      end

    results = Task.await_many(tasks, 5_000)
    assert Enum.count(results, &match?({:ok, _dispatch}, &1)) == 1
    assert Enum.count(results, &match?({:waiting, _waits}, &1)) == 1
    assert Repo.aggregate(ScheduledActionExecution, :count) == 1
    assert Repo.aggregate(OccurrenceMemberBinding, :count) == 1
    assert Repo.aggregate(OccurrenceContextBinding, :count) == 1

    assert %{rows: [[1]]} =
             Repo.query!("""
             SELECT count(*) FROM worker_dispatches
             WHERE state IN ('claimed','dispatched','acknowledged','running','uncertain')
             """)
  end

  test "Run Again is allowed only after terminal non-integrated attempts" do
    fixture = product_fixture()

    for {terminal, quest} <-
          Enum.zip(["closed_unmerged", "no_changes"], sibling_quests(fixture.quest, 2)) do
      assert {:ok, launched} = LaunchQuest.launch(quest.id)
      run = Repo.get!(RuntimeRun, launched.run_id)
      Repo.update!(Ecto.Changeset.change(run, status: "completed"))

      Repo.insert!(
        RunDelivery.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: launched.run_id,
          quest_id: quest.id,
          state: terminal,
          command_revision: 1
        })
      )

      assert {:ok, _new_run} = LaunchQuest.launch(quest.id)
    end
  end

  test "active and recoverable Delivery attempts require Retry Publishing" do
    states = [
      "pending",
      "preparing",
      "publishing",
      "creating_review",
      "review_open",
      "attention_required"
    ]

    fixture = product_fixture()

    for {state, quest} <- Enum.zip(states, sibling_quests(fixture.quest, length(states))) do
      assert {:ok, launched} = LaunchQuest.launch(quest.id)
      run = Repo.get!(RuntimeRun, launched.run_id)
      Repo.update!(Ecto.Changeset.change(run, status: "completed"))

      Repo.insert!(
        RunDelivery.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: launched.run_id,
          quest_id: quest.id,
          state: state,
          command_revision: 1
        })
      )

      expected =
        if state == "attention_required", do: :retry_publishing_required, else: :delivery_active

      assert {:error, %{code: ^expected}} = LaunchQuest.launch(quest.id)
    end
  end

  test "nonrecoverable Delivery identity attention permits an explicit new Run" do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    run = Repo.get!(RuntimeRun, launched.run_id)
    Repo.update!(Ecto.Changeset.change(run, status: "completed"))

    Repo.insert!(
      RunDelivery.changeset(%{
        id: Ecto.UUID.generate(),
        run_id: launched.run_id,
        quest_id: fixture.quest.id,
        state: "attention_required",
        command_revision: 1,
        failure_code: "pull_request_identity_mismatch"
      })
    )

    assert {:ok, _new_run} = LaunchQuest.launch(fixture.quest.id)
  end

  test "cleanup requests are explicit, safe, and idempotent" do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    run = Repo.get!(RuntimeRun, launched.run_id)
    Repo.update!(Ecto.Changeset.change(run, status: "completed"))
    assignment = Repo.get!(RunWorkspaceAssignment, launched.run_id)

    Repo.update!(
      Ecto.Changeset.change(assignment, state: "retained", retained_at: DateTime.utc_now())
    )

    Repo.insert!(
      RunDelivery.changeset(%{
        id: Ecto.UUID.generate(),
        run_id: launched.run_id,
        quest_id: fixture.quest.id,
        state: "no_changes",
        command_revision: 1
      })
    )

    assert {:ok, %{state: "cleanup_requested"}} =
             RunWorkspaceStore.request_cleanup(launched.run_id)

    assert {:ok, %{state: "cleanup_requested"}} =
             RunWorkspaceStore.request_cleanup(launched.run_id)
  end

  test "an unchanged merged Pull Request atomically completes its Quest" do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    run = Repo.get!(RuntimeRun, launched.run_id)
    Repo.update!(Ecto.Changeset.change(run, status: "completed"))
    head = String.duplicate("a", 40)

    delivery =
      Repo.insert!(
        RunDelivery.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: launched.run_id,
          quest_id: fixture.quest.id,
          state: "review_open",
          command_revision: 1,
          repository_identity: "owner/repo",
          base_branch_name: "main",
          branch_name: "qe/run/11111111111111111111111111111111",
          head_revision: head,
          provider: "github",
          pull_request_number: 12
        })
      )

    assert {:ok, merged} =
             DeliveryStore.observe_review(delivery.id, %{
               number: 12,
               url: "https://github.com/owner/repo/pull/12",
               state: "merged",
               merged_at: DateTime.utc_now(),
               repository_identity: "owner/repo",
               base_branch: "main",
               head_repository_identity: "owner/repo",
               head_branch: "qe/run/11111111111111111111111111111111",
               head_revision: head
             })

    assert merged.state == "merged"
    quest = Repo.get!(QuestEngineering.Server.Persistence.ProductQuest, fixture.quest.id)
    assert quest.completed_by_run_id == launched.run_id
    assert {:error, %{code: :quest_completed}} = LaunchQuest.launch(fixture.quest.id)
  end

  test "an altered merged Pull Request cannot complete its Quest" do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    run = Repo.get!(RuntimeRun, launched.run_id)
    Repo.update!(Ecto.Changeset.change(run, status: "completed"))
    head = String.duplicate("a", 40)

    delivery =
      Repo.insert!(
        RunDelivery.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: launched.run_id,
          quest_id: fixture.quest.id,
          state: "review_open",
          command_revision: 1,
          repository_identity: "owner/repo",
          base_branch_name: "main",
          branch_name: "qe/run/11111111111111111111111111111111",
          head_revision: head,
          provider: "github",
          pull_request_number: 13
        })
      )

    assert {:ok, attention} =
             DeliveryStore.observe_review(delivery.id, %{
               number: 13,
               url: "https://github.com/owner/repo/pull/13",
               state: "merged",
               merged_at: DateTime.utc_now(),
               repository_identity: "owner/repo",
               base_branch: "release",
               head_repository_identity: "owner/repo",
               head_branch: "qe/run/11111111111111111111111111111111",
               head_revision: head
             })

    assert attention.state == "attention_required"
    assert attention.failure_code == "pull_request_identity_mismatch"

    refute Repo.get!(QuestEngineering.Server.Persistence.ProductQuest, fixture.quest.id).completed_at
  end

  test "previous Runtime failure permits an explicit new Run" do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    run = Repo.get!(RuntimeRun, launched.run_id)
    Repo.update!(Ecto.Changeset.change(run, status: "failed"))
    assert {:ok, _new_run} = LaunchQuest.launch(fixture.quest.id)
  end

  test "operator retry terminalizes uncertainty and schedules a new attempt", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-retry-uncertain", context.workspace_root)
    assert {:ok, dispatch_1} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _uncertain} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               dispatch_1.action_id,
               %{"reason" => "physical outcome unknown"}
             )

    occurrence_id = dispatch_1.execution.identity.occurrence_id
    assert {:ok, recovery} = ExecutionRecovery.retry(launched.run_id, occurrence_id)
    assert recovery.resolution == :retry
    assert recovery.transition.revision == 1

    assert Repo.get!(ScheduledActionExecution, dispatch_1.action_id).state == "failed"

    old_dispatch =
      Repo.get_by!(QuestEngineering.Server.Persistence.WorkerDispatch,
        action_id: dispatch_1.action_id
      )

    assert old_dispatch.state == "failed"
    assert old_dispatch.failure["code"] == "operator_retry_requested"

    assert {:ok, %{run: run}} = RuntimeStore.fetch_run(launched.run_id)
    occurrence = Map.fetch!(run.occurrences, occurrence_id)
    assert occurrence.current_attempt_id == occurrence_id <> "/attempt/2"

    assert Enum.map(occurrence.attempts, &{&1.number, &1.status}) == [
             {1, :failed},
             {2, :dispatched}
           ]

    assert {:ok, dispatch_2} = SchedulingStore.schedule_next(launched.run_id)
    assert dispatch_2.action_id == occurrence_id <> "/attempt/2/action/execute-step"
  end

  test "operator mark-failed terminalizes the Run and retains its workspace", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-fail-uncertain", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _uncertain} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               dispatch.action_id,
               %{"reason" => "physical outcome unknown"}
             )

    occurrence_id = dispatch.execution.identity.occurrence_id
    assert {:ok, recovery} = ExecutionRecovery.mark_failed(launched.run_id, occurrence_id)
    assert recovery.resolution == :mark_failed
    assert recovery.transition.run.status == :failed

    assert Repo.get!(RunWorkspaceAssignment, launched.run_id).state == "retained"

    assert {:error, %ExecutionRecovery.Error{code: :execution_not_uncertain}} =
             ExecutionRecovery.mark_failed(launched.run_id, occurrence_id)
  end

  test "uncertain execution retains Member, context, and Worker occupancy", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-uncertain", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, uncertain} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               dispatch.action_id,
               %{"reason" => "physical outcome unknown"}
             )

    assert uncertain.state == :uncertain
    assert Repo.get!(ScheduledActionExecution, dispatch.action_id).state == "active"
    assert {:ok, persisted_worker} = WorkerStore.fetch(worker.id)
    assert persisted_worker.active_dispatches == 1
  end

  defp create_quest(fixture, options) do
    tactic = Keyword.get(options, :tactic, fixture.quest.tactic_source.body)

    Products.create_quest(%{
      title: unique(Keyword.get(options, :title, "concurrency-quest")),
      objective: "Exercise durable concurrency resources.",
      workspace_id: Keyword.get(options, :workspace_id, fixture.quest.workspace_id),
      squad_id: Keyword.get(options, :squad_id, fixture.squad.id),
      tactic_source: %Inline{body: tactic}
    })
  end

  defp create_squad(fixture, prefix \\ "concurrency-squad") do
    Products.create_squad(%{
      key: unique(prefix),
      name: "Independent Squad",
      members: [
        %{
          key: "builder",
          name: "Builder",
          class_id: fixture.builder.id,
          loadout_id: fixture.loadout.id
        },
        %{
          key: "reviewer",
          name: "Reviewer",
          class_id: fixture.reviewer.id,
          loadout_id: fixture.reviewer_loadout.id
        }
      ]
    })
  end

  defp mark_running(worker, dispatch) do
    assert {:ok, _dispatched} =
             DispatchStore.mark_dispatched(
               dispatch.action_id,
               dispatch.claim_token,
               worker.connection_generation
             )

    assert {:ok, running} =
             DispatchStore.mark_running(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    running
  end

  defp sibling_quests(quest, count) do
    Enum.map(1..count, fn index ->
      {:ok, sibling} =
        Products.create_quest(%{
          title: "Sibling #{index}",
          objective: "Exercise Delivery state.",
          workspace_id: quest.workspace_id,
          squad_id: quest.squad_id,
          tactic_source: quest.tactic_source
        })

      sibling
    end)
  end

  defp product_fixture(options \\ []) do
    builder =
      create_class("builder", "Build from the immutable snapshot.")

    reviewer = create_class("reviewer", "Review independently.")

    first_model = Keyword.get(options, :first_model, %ModelRef{provider: "fake", model: "test"})
    tools = Keyword.get(options, :tools, ["workspace.filesystem"])
    first_loadout = create_loadout("first-loadout", first_model, tools)

    second_loadout =
      create_loadout("second-loadout", %ModelRef{provider: "fake", model: "test"}, tools)

    members = [
      %{key: "alice", name: "Alice", class_id: builder.id, loadout_id: first_loadout.id}
    ]

    members =
      if Keyword.get(options, :one_member?, false) do
        members
      else
        members ++
          [%{key: "bob", name: "Bob", class_id: reviewer.id, loadout_id: second_loadout.id}]
      end

    {:ok, squad} =
      Products.create_squad(%{
        key: unique("squad"),
        name: "Launch Squad",
        members: members
      })

    second_class = if Keyword.get(options, :one_member?, false), do: "builder", else: "reviewer"

    tactic =
      Keyword.get_lazy(options, :tactic, fn ->
        if Keyword.get(options, :parallel?, false) do
          parallel([
            step("first", name: "First", performer: class("builder"), instruction: "First work."),
            step("second",
              name: "Second",
              performer: class(second_class),
              instruction: "Second work."
            )
          ])
        else
          step("first", name: "First", performer: class("builder"), instruction: "First work.")
        end
      end)

    {:ok, quest} =
      Products.create_quest(%{
        title: "Launch test",
        objective: "Prove product-to-execution binding.",
        workspace_ref: "workspace:test",
        squad_id: squad.id,
        tactic_source: %Inline{body: tactic}
      })

    %{
      quest: quest,
      squad: squad,
      builder: builder,
      reviewer: reviewer,
      loadout: first_loadout,
      reviewer_loadout: second_loadout
    }
  end

  defp create_class(key, instructions) do
    {:ok, value} =
      Products.create_class(%{
        key: key,
        name: String.capitalize(key),
        instructions: instructions
      })

    value
  end

  defp create_loadout(key, model, tools) do
    {:ok, value} =
      Products.create_loadout(%{
        key: key,
        name: key,
        model: model,
        reasoning: :medium,
        tools: tools,
        workspace_access: :read_write
      })

    value
  end

  defp complete(worker, dispatch) do
    message = %{
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      outputs: %{}
    }

    assert {:ok, _result} =
             CompletionAdapter.complete(worker.id, worker.connection_generation, message)
  end

  defp register_worker(id, root, options \\ []) do
    adapter = Keyword.get(options, :adapter, "fake")

    tools =
      Keyword.get(options, :tools, ["workspace.filesystem", "workspace.search", "terminal.shell"])

    workspace_roots = Keyword.get(options, :workspace_roots, [{"workspace:test", root}])

    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => Keyword.get(options, :max_concurrency, 1),
      "tags" => [],
      "executors" => [
        %{
          "adapter" => adapter,
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => tools,
          "workspaces" =>
            Enum.map(workspace_roots, fn {ref, workspace_root} ->
              %{"ref" => ref, "root" => workspace_root, "max_access" => "read_write"}
            end)
        }
      ]
    }

    {:ok, worker} = WorkerStore.register(id, capabilities, Ecto.UUID.generate())
    worker
  end

  defp unique(prefix), do: prefix <> "-" <> Integer.to_string(System.unique_integer([:positive]))
end
