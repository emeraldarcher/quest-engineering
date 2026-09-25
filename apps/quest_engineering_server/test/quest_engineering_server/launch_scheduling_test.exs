defmodule QuestEngineering.Server.LaunchSchedulingTest do
  use ExUnit.Case, async: false

  import Ecto.Query
  import QuestEngineering.Core.Tactics

  alias Ecto.Adapters.SQL.Sandbox
  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.ExecutionCancellation
  alias QuestEngineering.Server.ExecutionRecovery
  alias QuestEngineering.Server.ExecutionOptions
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.OperationalRecovery
  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.OccurrenceContextBinding
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.OperationalAttemptAttribution
  alias QuestEngineering.Server.Persistence.OperationalRecoveryEpoch
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RuntimeTransition
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerMessageHandler
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

  test "isolated SBX shell authority exposes options and schedules with host shell prohibited",
       context do
    fixture = product_fixture(tools: ["workspace.filesystem", "terminal.shell"])
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)

    worker =
      register_worker("worker-isolated-shell", context.workspace_root,
        execution_environment: execution_environment("sbx")
      )

    insert_binding(worker, fixture.quest.workspace_id, context.workspace_root, false)

    assert Enum.any?(ExecutionOptions.list(), fn option ->
             option.harness == "fake" and
               Enum.any?(option.workspaces, &(&1.workspace_id == fixture.quest.workspace_id))
           end)

    assert {:provision, assignment} = RunWorkspaceStore.ensure_assignment(launched.run_id)
    assert assignment.worker_id == worker.id
    assert assignment.workspace_binding_id
    ready_assignment(assignment)

    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)
    assert dispatch.worker_id == worker.id

    assert dispatch.execution.configuration.resolved_tool_profile.tools == [
             "workspace.filesystem",
             "terminal.shell"
           ]
  end

  test "HostNative cannot use isolated shell authority without the host grant", context do
    fixture = product_fixture(tools: ["workspace.filesystem", "terminal.shell"])
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)

    worker =
      register_worker("worker-host-shell-denied", context.workspace_root,
        execution_environment: execution_environment("host_native")
      )

    insert_binding(worker, fixture.quest.workspace_id, context.workspace_root, false)

    refute Enum.any?(ExecutionOptions.list(), fn option ->
             option.harness == "fake" and
               Enum.any?(option.workspaces, &(&1.workspace_id == fixture.quest.workspace_id))
           end)

    assert {:waiting_for_host, assignment} =
             RunWorkspaceStore.ensure_assignment(launched.run_id)

    assert is_nil(assignment.worker_id)
    assert Repo.aggregate(ScheduledActionExecution, :count) == 0
  end

  test "a ready SBX assignment cannot transfer guest shell authority to HostNative", context do
    fixture = product_fixture(tools: ["workspace.filesystem", "terminal.shell"])
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)

    worker =
      register_worker("worker-shell-authority-change", context.workspace_root,
        execution_environment: execution_environment("sbx")
      )

    insert_binding(worker, fixture.quest.workspace_id, context.workspace_root, false)
    assert {:provision, assignment} = RunWorkspaceStore.ensure_assignment(launched.run_id)
    ready_assignment(assignment)

    host_capabilities =
      put_in(
        worker.capabilities,
        ["executors", Access.at(0), "execution_environment"],
        execution_environment("host_native")
      )

    worker
    |> Changeset.change(capabilities: host_capabilities)
    |> Repo.update!()

    assert {:waiting, waits} = SchedulingStore.schedule_next(launched.run_id)
    assert Enum.map(waits, & &1.code) == [:waiting_for_worker]
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

  test "retained terminal sessions do not consume Worker execution capacity", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-retained-terminal", context.workspace_root)
    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    %ExecutionSession{}
    |> ExecutionSession.changeset(%{
      id: "retained-terminal-session",
      worker_id: worker.id,
      harness_kind: "pi",
      harness_display_name: "Pi",
      state: "retained",
      capabilities: %{},
      last_connection_generation: worker.connection_generation,
      started_at: now,
      last_activity_at: now
    })
    |> Repo.insert!()

    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)
    assert dispatch.worker_id == worker.id
    assert dispatch.worker_slot == 0
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

  test "launch snapshot freezes the user-authored semantic remediation limit" do
    fixture = product_fixture()

    body =
      until(
        check:
          step("review",
            name: "Review",
            performer: class("reviewer"),
            instruction: "Review.",
            produces: [output("verdict", "check_result")]
          ),
        condition: equals(field(ref("review", "verdict"), "status"), "accepted"),
        otherwise:
          step("repair",
            name: "Repair",
            performer: class("builder"),
            instruction: "Repair."
          ),
        max_remediations: 1
      )

    assert {:ok, definition} =
             TacticLibrary.create(%{
               key: unique("bounded-review"),
               name: "Bounded Review",
               body: body
             })

    assert {:ok, _quest} =
             Products.update_quest(fixture.quest.id, %{
               tactic_source: TacticSource.definition(definition.id)
             })

    assert {:ok, first} = LaunchQuest.launch(fixture.quest.id)
    assert {:ok, %{run: first_run}} = RuntimeStore.fetch_run(first.run_id)
    assert hd(first_run.plan.control_regions).max_remediations == 1

    assert {:ok, _updated} =
             TacticLibrary.update(definition.id, %{
               body: %{body | max_remediations: 3}
             })

    assert {:ok, %{run: unchanged}} = RuntimeStore.fetch_run(first.run_id)
    assert hd(unchanged.plan.control_regions).max_remediations == 1

    assert {:ok, future_quest} =
             Products.create_quest(%{
               title: "Future bounded review",
               objective: fixture.quest.objective,
               workspace_id: fixture.quest.workspace_id,
               squad_id: fixture.squad.id,
               tactic_source: TacticSource.definition(definition.id)
             })

    assert {:ok, second} = LaunchQuest.launch(future_quest.id)
    assert {:ok, %{run: second_run}} = RuntimeStore.fetch_run(second.run_id)
    assert hd(second_run.plan.control_regions).max_remediations == 3
  end

  test "step-scoped takeover fixture resolves only into Implement and isolates Review context",
       context do
    objective =
      "Create a harmless test file according to the instructions you receive during implementation."

    forced_takeover =
      "Before making repository changes, immediately request conversational intervention and wait for explicit /qe-resume before implementing the human guidance."

    review_instruction =
      "Review the implementation against the Quest requirements. Do not deliberately invoke the takeover acceptance mechanism; request human assistance only for a genuine blocker."

    tactic =
      sequence([
        step("implement",
          name: "Implement",
          performer: class("builder"),
          context: fresh(),
          instruction: forced_takeover,
          produces: [output("change_set", "change_set")]
        ),
        step("review",
          name: "Review",
          performer: class("reviewer"),
          context: fresh(),
          instruction: review_instruction,
          consumes: [input("change_set", "change_set", from: ref("implement", "change_set"))],
          produces: [output("verdict", "check_result")]
        )
      ])

    fixture = product_fixture(tactic: tactic, objective: objective)
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-takeover-scope", context.workspace_root)

    assert {:ok, implement} = SchedulingStore.schedule_next(launched.run_id)
    assert implement.execution.work.quest_objective == objective
    assert implement.execution.work.step_instruction == forced_takeover
    assert implement.execution.performer.member_key == "alice"

    complete(worker, implement, %{
      "change_set" => %{"files" => ["human-picked.txt"], "status" => "completed"}
    })

    assert {:ok, review} = SchedulingStore.schedule_next(launched.run_id)
    assert review.execution.work.quest_objective == objective
    assert review.execution.work.step_instruction == review_instruction
    assert review.execution.work.class_instructions == "Review independently."

    assert review.execution.work.inputs["change_set"].value == %{
             "files" => ["human-picked.txt"],
             "status" => "completed"
           }

    refute inspect(review.execution.work) =~ forced_takeover
    assert implement.execution.context.mode == :fresh
    assert review.execution.context.mode == :fresh

    assert implement.execution.context.logical_lineage_id !=
             review.execution.context.logical_lineage_id

    assert implement.execution.performer.member_key != review.execution.performer.member_key
  end

  test "retryable operational failure appends a same-occurrence Attempt in epoch zero", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-auto-retry", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    first_attribution = Repo.get!(OperationalAttemptAttribution, first.action_id)
    epoch = Repo.get!(OperationalRecoveryEpoch, first_attribution.epoch_id)
    assert epoch.epoch_number == 0
    assert epoch.attempt_allowance == 2
    assert first_attribution.attempt_in_epoch == 1

    assert {:ok, %{"result" => "automatic_retry_scheduled"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: first.action_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               failure: %{
                 "classification" => "auto_retryable",
                 "reason" => "transient_harness_failure"
               }
             })

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    second_attribution = Repo.get!(OperationalAttemptAttribution, second.action_id)
    assert second.execution.identity.occurrence_id == first.execution.identity.occurrence_id
    assert second.execution.identity.attempt_id != first.execution.identity.attempt_id
    assert second_attribution.epoch_id == first_attribution.epoch_id
    assert second_attribution.global_attempt_number == 2
    assert second_attribution.attempt_in_epoch == 2
    assert Repo.get_by!(WorkerDispatch, action_id: first.action_id).state == "failed"
  end

  test "each recovery epoch snapshots the current server-owned allowance", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-policy-snapshot", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)
    initial_attribution = Repo.get!(OperationalAttemptAttribution, first.action_id)
    initial_epoch = Repo.get!(OperationalRecoveryEpoch, initial_attribution.epoch_id)
    assert initial_epoch.attempt_allowance == 2

    previous =
      Application.fetch_env!(:quest_engineering_server, :max_operational_attempts_per_epoch)

    Application.put_env(:quest_engineering_server, :max_operational_attempts_per_epoch, 3)

    on_exit(fn ->
      Application.put_env(
        :quest_engineering_server,
        :max_operational_attempts_per_epoch,
        previous
      )
    end)

    assert {:ok, _} = fail_operational(worker, first, "operator_recovery_required")

    assert {:ok, recovered} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               Ecto.UUID.generate()
             )

    assert recovered.attempt_allowance == 3
    assert Repo.get!(OperationalRecoveryEpoch, initial_epoch.id).attempt_allowance == 2
  end

  test "an exhausted epoch can be followed by multiple full human recovery epochs", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-multiple-recovery", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    fail_operational(worker, first, "auto_retryable")
    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, %{"result" => "exhausted"}} =
             fail_operational(worker, second, "auto_retryable")

    request_1 = Ecto.UUID.generate()

    assert {:ok, epoch_1} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               request_1
             )

    assert epoch_1.epoch_number == 1
    assert {:ok, third} = SchedulingStore.schedule_next(launched.run_id)
    third_attribution = Repo.get!(OperationalAttemptAttribution, third.action_id)
    assert third_attribution.global_attempt_number == 3
    assert third_attribution.attempt_in_epoch == 1

    assert {:ok, %{"result" => "automatic_retry_scheduled"}} =
             fail_operational(worker, third, "auto_retryable")

    assert {:ok, fourth} = SchedulingStore.schedule_next(launched.run_id)
    fourth_attribution = Repo.get!(OperationalAttemptAttribution, fourth.action_id)
    assert fourth_attribution.global_attempt_number == 4
    assert fourth_attribution.attempt_in_epoch == 2
    assert fourth_attribution.epoch_id == third_attribution.epoch_id

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             fail_operational(worker, fourth, "operator_recovery_required")

    request_2 = Ecto.UUID.generate()

    assert {:ok, epoch_2} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               request_2
             )

    assert epoch_2.epoch_number == 2
    assert {:ok, fifth} = SchedulingStore.schedule_next(launched.run_id)
    fifth_attribution = Repo.get!(OperationalAttemptAttribution, fifth.action_id)
    assert fifth_attribution.global_attempt_number == 5
    assert fifth_attribution.attempt_in_epoch == 1
    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 3
  end

  test "human recovery appends an idempotent fresh epoch with a full allowance", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-human-retry", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: first.action_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               failure: %{
                 "classification" => "operator_recovery_required",
                 "reason" => "authentication_required"
               }
             })

    request_id = Ecto.UUID.generate()

    requests =
      for _ <- 1..2 do
        Task.async(fn ->
          OperationalRecovery.authorize_fresh(
            launched.run_id,
            first.execution.identity.occurrence_id,
            request_id
          )
        end)
      end

    assert [{:ok, first_result}, {:ok, second_result}] = Enum.map(requests, &Task.await/1)
    assert first_result.id == second_result.id

    assert Enum.sort([first_result.idempotent_replay?, second_result.idempotent_replay?]) == [
             false,
             true
           ]

    recovery = first_result
    assert recovery.epoch_number == 1
    assert recovery.attempt_allowance == 2
    assert Repo.aggregate(OperationalAttemptAttribution, :count) == 1
    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 2
    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    second_attribution = Repo.get!(OperationalAttemptAttribution, second.action_id)
    second_epoch = Repo.get!(OperationalRecoveryEpoch, second_attribution.epoch_id)
    assert second_epoch.epoch_number == 1
    assert second_epoch.attempt_allowance == 2
    assert second_attribution.global_attempt_number == 2
    assert second_attribution.attempt_in_epoch == 1
    assert second.execution.identity.occurrence_id == first.execution.identity.occurrence_id
    assert Repo.get_by!(WorkerDispatch, action_id: first.action_id).state == "failed"
  end

  test "human recovery refuses an execution that remains uncertain", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-uncertain-human-retry", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               dispatch.action_id,
               %{
                 "reason" => "outcome_unknown"
               }
             )

    assert {:error, %OperationalRecovery.Error{code: :execution_still_uncertain}} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               Ecto.UUID.generate()
             )

    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 1
    assert Repo.aggregate(OperationalAttemptAttribution, :count) == 1
  end

  test "fresh retained-work recovery preserves uncertain history and appends a new epoch",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-retained-work-retry", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    failure = %{
      "code" => "harness_contract_violation",
      "classification" => "terminal_not_recoverable",
      "message" => "The native harness exited without a structured result."
    }

    assert {:ok, _} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               first.action_id,
               failure
             )

    assert {:ok, projection} = RunProjection.get(launched.run_id)

    projected =
      Enum.find(
        projection.steps,
        &(&1.occurrence_id == first.execution.identity.occurrence_id)
      )

    assert projected.recovery.can_retry_fresh
    refute projected.recovery.can_mark_failed

    request_id = Ecto.UUID.generate()

    assert {:ok, recovery} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               request_id
             )

    assert recovery.epoch_number == 1
    assert Repo.get_by!(WorkerDispatch, action_id: first.action_id).state == "uncertain"
    assert Repo.get_by!(WorkerDispatch, action_id: first.action_id).failure == failure
    assert Repo.get!(ScheduledActionExecution, first.action_id).state == "failed"

    assert {:ok, authorized_projection} = RunProjection.get(launched.run_id)

    authorized_step =
      Enum.find(
        authorized_projection.steps,
        &(&1.occurrence_id == first.execution.identity.occurrence_id)
      )

    assert authorized_step.state == "waiting"
    assert authorized_step.attempt.number == 2
    assert authorized_step.attempt.session == nil
    assert authorized_step.attempt.execution == nil
    assert authorized_step.attempt.operational == nil

    assert Enum.any?(
             authorized_projection.operational_recovery,
             &(&1.epoch_number == 1 and &1.attempts_scheduled == 0)
           )

    assert Enum.map(authorized_step.attempts, &{&1.number, &1.state}) == [
             {1, "uncertain"},
             {2, "waiting"}
           ]

    assert is_binary(Jason.encode!(authorized_projection))

    assert {:ok, replayed} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               request_id
             )

    assert replayed.id == recovery.id
    assert replayed.idempotent_replay?

    assert {:ok, intent_replay} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               Ecto.UUID.generate()
             )

    assert intent_replay.id == recovery.id
    assert intent_replay.request_id == request_id
    assert intent_replay.idempotent_replay?

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    assert second.execution.identity.occurrence_id == first.execution.identity.occurrence_id
    assert second.execution.identity.attempt_id != first.execution.identity.attempt_id
    assert second.operational_recovery.authorization_kind == "human"
    assert second.operational_recovery.continuation_mode == "fresh"

    assert second.operational_recovery.source_attempt_id ==
             first.execution.identity.attempt_id

    assert {:ok, active_replay} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               Ecto.UUID.generate()
             )

    assert active_replay.id == recovery.id
    assert active_replay.request_id == request_id
    assert active_replay.idempotent_replay?

    assert {:ok, replay_projection} = RunProjection.get(launched.run_id)

    replay_step =
      Enum.find(
        replay_projection.steps,
        &(&1.occurrence_id == first.execution.identity.occurrence_id)
      )

    assert Enum.map(replay_step.attempts, & &1.number) == [1, 2]
    assert Enum.map(replay_projection.operational_recovery, & &1.epoch_number) == [0, 1]
  end

  test "initial execution requires explicit authorization after native preparation", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-staged-initial", context.workspace_root)
    start_supervised!({WorkerConnections, []})

    assert :ok =
             WorkerConnections.activate(
               worker.id,
               "staged-initial-connection",
               worker.connection_generation,
               self()
             )

    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)
    assert dispatch.operational_recovery.authorization_kind == "initial"

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: Ecto.UUID.generate(),
               action_id: dispatch.action_id,
               run_id: launched.run_id,
               occurrence_id: dispatch.execution.identity.occurrence_id,
               attempt_id: dispatch.execution.identity.attempt_id,
               member_key: dispatch.execution.performer.member_key,
               harness_kind: "pi",
               harness_display_name: "Pi",
               state: :waiting_for_human,
               capabilities: %{"can_attach_terminal" => true},
               terminal: %{"supports_observation" => true, "supports_takeover" => true},
               native_session_id: nil,
               attention: %{
                 "attention_id" =>
                   "qe-prompt-authorization-#{dispatch.execution.identity.attempt_id}",
                 "category" => "needs_confirmation",
                 "message" => "Initial execution environment ready."
               },
               turn: %{
                 "phase" => "preparing",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil
               },
               started_at: now,
               last_activity_at: now
             })

    assert {:ok, staged_projection} = RunProjection.get(launched.run_id)
    [staged_step] = staged_projection.steps
    assert staged_step.attempt.operational.recovery_kind == "initial"
    assert staged_step.recovery.can_authorize_prompt
    assert staged_step.attempt.can_cancel

    request_id = Ecto.UUID.generate()

    assert {:ok, authorization} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               request_id
             )

    refute authorization.idempotent_replay?

    assert_receive {:worker_protocol,
                    %{
                      "type" => "authorize_dispatch_prompt",
                      "action_id" => action_id
                    }}

    assert action_id == dispatch.action_id
    persisted = Repo.get_by!(WorkerDispatch, action_id: dispatch.action_id)
    assert persisted.prompt_authorization_request_id == request_id
    assert persisted.prompt_authorized_at
  end

  test "Product cancellation is exact, idempotent, terminal, and excludes prompt authorization",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-product-cancellation", context.workspace_root)
    start_supervised!({WorkerConnections, []})

    assert :ok =
             WorkerConnections.activate(
               worker.id,
               "cancellation-connection",
               worker.connection_generation,
               self()
             )

    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    unauthorized_failure = %{
      "code" => "execution_cancelled",
      "reason" => "execution_cancelled",
      "classification" => "terminal_not_recoverable",
      "cancellation_request_id" => Ecto.UUID.generate(),
      "cancellation_origin" => "product_operator",
      "cancellation_worker_generation" => worker.connection_generation,
      "cancelled_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert {:error, %{type: :execution_cancellation_unauthorized}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: dispatch.action_id,
               occurrence_id: dispatch.execution.identity.occurrence_id,
               attempt_id: dispatch.execution.identity.attempt_id,
               failure: unauthorized_failure
             })

    request_id = Ecto.UUID.generate()

    assert {:ok, cancellation} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               request_id,
               "Disposable no-inference preflight complete."
             )

    refute cancellation.idempotent_replay
    assert cancellation.state == :cancellation_requested
    assert cancellation.delivery == :sent

    assert_receive {:worker_protocol,
                    %{
                      "type" => "cancel_dispatch",
                      "protocol_version" => 9,
                      "worker_id" => worker_id,
                      "connection_generation" => generation,
                      "action_id" => action_id,
                      "run_id" => run_id,
                      "occurrence_id" => occurrence_id,
                      "attempt_id" => attempt_id,
                      "cancellation" => %{
                        "request_id" => ^request_id,
                        "origin" => "product_operator",
                        "requested_at" => requested_at
                      }
                    }}

    assert worker_id == worker.id
    assert generation == worker.connection_generation
    assert action_id == dispatch.action_id
    assert run_id == launched.run_id
    assert occurrence_id == dispatch.execution.identity.occurrence_id
    assert attempt_id == dispatch.execution.identity.attempt_id
    assert is_binary(requested_at)

    assert {:ok, replay} =
             ExecutionCancellation.request(
               launched.run_id,
               occurrence_id,
               attempt_id,
               Ecto.UUID.generate(),
               "A replay must not replace provenance."
             )

    assert replay.idempotent_replay
    assert replay.request_id == request_id
    assert replay.delivery == :not_repeated
    refute_receive {:worker_protocol, %{"type" => "cancel_dispatch"}}, 20

    assert {:ok, pending_projection} = RunProjection.get(launched.run_id)
    [pending_step] = pending_projection.steps
    refute pending_step.attempt.can_cancel

    assert {:error, %{code: :execution_cancellation_pending}} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               occurrence_id,
               attempt_id,
               Ecto.UUID.generate()
             )

    assert {:error, %{type: :execution_cancellation_pending}} =
             CompletionAdapter.complete(worker.id, worker.connection_generation, %{
               action_id: action_id,
               occurrence_id: occurrence_id,
               attempt_id: attempt_id,
               outputs: %{}
             })

    assert {:ok, _} =
             WorkerStore.disconnect(
               worker.id,
               worker.connection_id,
               worker.connection_generation
             )

    assert {:ok, reconnected} =
             WorkerStore.register(
               worker.id,
               worker.capabilities,
               "cancellation-reconnected"
             )

    assert reconnected.connection_generation == worker.connection_generation + 1

    failure = %{
      "code" => "execution_cancelled",
      "reason" => "execution_cancelled",
      "classification" => "terminal_not_recoverable",
      "message" => "The QE Attempt was explicitly cancelled by the Product operator.",
      "cancellation_request_id" => request_id,
      "cancellation_origin" => "product_operator",
      "cancellation_reason" => "Disposable no-inference preflight complete.",
      "cancellation_requested_at" => requested_at,
      "cancellation_worker_generation" => generation,
      "cancelled_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    cancellation_message = %{
      type: :step_failed,
      action_id: action_id,
      occurrence_id: occurrence_id,
      attempt_id: attempt_id,
      failure: failure
    }

    assert {:ok,
            %{
              "result" => "execution_cancelled",
              "idempotent_replay" => false
            }} =
             WorkerMessageHandler.handle(
               reconnected.id,
               reconnected.connection_generation,
               cancellation_message
             )

    assert {:ok, %{"result" => "execution_cancelled", "idempotent_replay" => true}} =
             WorkerMessageHandler.handle(
               reconnected.id,
               reconnected.connection_generation,
               cancellation_message
             )

    persisted = Repo.get_by!(WorkerDispatch, action_id: action_id)
    assert persisted.state == "failed"
    assert persisted.failure == failure
    assert persisted.cancellation_request_id == request_id
    assert is_nil(persisted.prompt_authorization_request_id)
    assert is_nil(persisted.prompt_authorized_at)

    assert Repo.get!(RunWorkspaceAssignment, launched.run_id).state == "retained"
    assert Repo.reload!(worker).active_dispatches == 0
    assert Repo.get_by!(ScheduledActionExecution, action_id: action_id).state == "failed"

    cancellation_transition_count =
      Repo.aggregate(
        from(transition in RuntimeTransition,
          where: like(transition.transition_id, "worker-cancellation/v1/%")
        ),
        :count
      )

    assert cancellation_transition_count == 1

    assert {:ok, projection} = RunProjection.get(launched.run_id)
    assert projection.status == "cancelled"
    [step] = projection.steps
    assert step.state == "cancelled"
    assert step.issue.code == "execution_cancelled"
    assert is_nil(step.recovery)
    assert step.attempt.resolution == "cancelled"
    refute step.attempt.can_cancel
    assert step.attempt.cancellation.state == "cancelled"
    assert step.attempt.cancellation.request_id == request_id
    assert step.attempt.outputs == []
    assert projection.step_counts["cancelled"] == 1
  end

  test "authorization that commits before cancellation remains historical while cancellation wins terminal authority",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-authorization-before-cancel", context.workspace_root)
    start_supervised!({WorkerConnections, []})

    assert :ok =
             WorkerConnections.activate(
               worker.id,
               "authorization-before-cancel",
               worker.connection_generation,
               self()
             )

    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: Ecto.UUID.generate(),
               action_id: dispatch.action_id,
               run_id: launched.run_id,
               occurrence_id: dispatch.execution.identity.occurrence_id,
               attempt_id: dispatch.execution.identity.attempt_id,
               member_key: dispatch.execution.performer.member_key,
               harness_kind: "pi",
               harness_display_name: "Pi",
               state: :waiting_for_human,
               capabilities: %{"can_attach_terminal" => true},
               terminal: %{"supports_observation" => true, "supports_takeover" => true},
               native_session_id: nil,
               attention: %{
                 "attention_id" =>
                   "qe-prompt-authorization-#{dispatch.execution.identity.attempt_id}",
                 "category" => "needs_confirmation",
                 "message" => "Initial execution environment ready."
               },
               turn: %{
                 "phase" => "preparing",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil
               },
               started_at: now,
               last_activity_at: now
             })

    authorization_request_id = Ecto.UUID.generate()

    assert {:ok, _} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               authorization_request_id
             )

    assert_receive {:worker_protocol,
                    %{
                      "type" => "authorize_dispatch_prompt",
                      "action_id" => action_id
                    }}

    assert action_id == dispatch.action_id

    Repo.get_by!(ExecutionSession, current_action_id: action_id)
    |> Ecto.Changeset.change(state: "running", attention: nil)
    |> Repo.update!()

    assert {:ok, before_cancellation} = RunProjection.get(launched.run_id)
    [before_step] = before_cancellation.steps
    assert before_step.attempt.can_cancel
    assert before_step.attempt.session.attachment.can_takeover

    cancellation_request_id = Ecto.UUID.generate()

    assert {:ok, %{state: :cancellation_requested, delivery: :sent}} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               cancellation_request_id
             )

    assert_receive {:worker_protocol,
                    %{
                      "type" => "cancel_dispatch",
                      "action_id" => ^action_id,
                      "cancellation" => %{"request_id" => ^cancellation_request_id}
                    }}

    assert {:ok, after_cancellation} = RunProjection.get(launched.run_id)
    [after_step] = after_cancellation.steps
    refute after_step.attempt.can_cancel
    refute after_step.attempt.session.attachment.can_takeover
    refute after_step.attempt.session.attachment.can_recover

    assert {:ok, descriptor} =
             ExecutionSessionStore.attachment_descriptor(
               launched.run_id,
               dispatch.execution.identity.attempt_id,
               after_step.attempt.session.id
             )

    refute descriptor.takeover_allowed
    refute descriptor.recovery_allowed
    assert {:ok, _} = ExecutionSessionStore.record_opened(descriptor.descriptor_token, "observe")

    assert {:error, :attachment_unavailable} =
             ExecutionSessionStore.record_opened(descriptor.descriptor_token, "takeover")

    persisted = Repo.get_by!(WorkerDispatch, action_id: action_id)
    assert persisted.prompt_authorization_request_id == authorization_request_id
    assert persisted.prompt_authorized_at
    assert persisted.cancellation_request_id == cancellation_request_id
    assert persisted.cancellation_requested_at
  end

  test "disconnected cancellation stays pending and is redelivered with the reconnect generation",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-cancellation-reconnect", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    assert {:ok, _} =
             WorkerStore.disconnect(
               worker.id,
               worker.connection_id,
               worker.connection_generation
             )

    request_id = Ecto.UUID.generate()

    assert {:ok, %{delivery: :pending, state: :cancellation_requested}} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               request_id
             )

    [command] =
      ExecutionCancellation.pending_for_worker(worker.id, worker.connection_generation + 1)

    assert command["type"] == "cancel_dispatch"
    assert command["connection_generation"] == worker.connection_generation + 1
    assert command["action_id"] == dispatch.action_id
    assert command["cancellation"]["request_id"] == request_id

    persisted = Repo.get_by!(WorkerDispatch, action_id: dispatch.action_id)
    assert persisted.state == "acknowledged"
    assert is_nil(persisted.terminal_at)
    assert persisted.cancellation_request_id == request_id
  end

  test "already completed Attempt returns a non-mutating cancellation result", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-cancellation-terminal", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    complete(worker, dispatch)
    request_id = Ecto.UUID.generate()

    assert {:ok,
            %{
              state: :already_terminal,
              delivery: :not_repeated,
              request_id: nil,
              idempotent_replay: true
            }} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               request_id
             )

    persisted = Repo.get_by!(WorkerDispatch, action_id: dispatch.action_id)
    assert persisted.state == "completed"
    assert is_nil(persisted.cancellation_request_id)
  end

  test "Product cancellation rejects stale Attempt identity and uncertain dispatches", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-cancellation-rejections", context.workspace_root)
    assert {:ok, dispatch} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(
               worker.id,
               worker.connection_generation,
               dispatch.action_id
             )

    assert {:error, %{code: :execution_cancellation_identity_mismatch}} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               Ecto.UUID.generate(),
               Ecto.UUID.generate()
             )

    assert {:ok, _} =
             DispatchStore.mark_uncertain(
               worker.id,
               worker.connection_generation,
               dispatch.action_id,
               %{"reason" => "transport_lost"}
             )

    assert {:error, %{code: :execution_cancellation_requires_recovery}} =
             ExecutionCancellation.request(
               launched.run_id,
               dispatch.execution.identity.occurrence_id,
               dispatch.execution.identity.attempt_id,
               Ecto.UUID.generate()
             )
  end

  test "blocked fresh recovery retires immutably, appends one epoch, and stages paid inference",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-staged-fresh-recovery", context.workspace_root)
    start_supervised!({WorkerConnections, []})

    assert :ok =
             WorkerConnections.activate(
               worker.id,
               "staged-connection",
               worker.connection_generation,
               self()
             )

    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             fail_operational(worker, first, "operator_recovery_required")

    assert {:ok, _epoch_1} =
             OperationalRecovery.authorize_fresh(
               launched.run_id,
               first.execution.identity.occurrence_id,
               Ecto.UUID.generate()
             )

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             DispatchStore.acknowledge(worker.id, worker.connection_generation, second.action_id)

    assert {:ok, _} =
             DispatchStore.mark_running(worker.id, worker.connection_generation, second.action_id)

    request_id = Ecto.UUID.generate()

    assert {:ok, %{state: :retirement_requested}} =
             OperationalRecovery.request_fresh(
               launched.run_id,
               second.execution.identity.occurrence_id,
               second.execution.identity.attempt_id,
               request_id
             )

    assert_receive {:worker_protocol,
                    %{
                      "type" => "retire_dispatch_for_recovery",
                      "action_id" => action_id,
                      "failure" => failure
                    }}

    assert action_id == second.action_id
    assert failure["classification"] == "operator_recovery_required"
    assert failure["code"] == "execution_environment_recovery_required"

    assert {:ok, %{state: :retirement_requested, idempotent_replay?: true}} =
             OperationalRecovery.request_fresh(
               launched.run_id,
               second.execution.identity.occurrence_id,
               second.execution.identity.attempt_id,
               Ecto.UUID.generate()
             )

    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 2

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: second.action_id,
               occurrence_id: second.execution.identity.occurrence_id,
               attempt_id: second.execution.identity.attempt_id,
               failure: failure
             })

    immutable_second = Repo.get_by!(WorkerDispatch, action_id: second.action_id)
    assert immutable_second.state == "failed"
    assert immutable_second.failure == failure
    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 3

    assert {:ok, third} = SchedulingStore.schedule_next(launched.run_id)
    assert third.execution.identity.occurrence_id == second.execution.identity.occurrence_id
    assert third.execution.identity.attempt_id != second.execution.identity.attempt_id
    assert third.operational_recovery.epoch_number == 2
    assert third.operational_recovery.source_attempt_id == second.execution.identity.attempt_id

    assert {:ok, _} =
             DispatchStore.acknowledge(worker.id, worker.connection_generation, third.action_id)

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: Ecto.UUID.generate(),
               action_id: third.action_id,
               run_id: launched.run_id,
               occurrence_id: third.execution.identity.occurrence_id,
               attempt_id: third.execution.identity.attempt_id,
               member_key: third.execution.performer.member_key,
               harness_kind: "antigravity",
               harness_display_name: "Antigravity",
               state: :waiting_for_human,
               capabilities: %{"can_attach_terminal" => true},
               terminal: %{"supports_observation" => true, "supports_takeover" => true},
               native_session_id: nil,
               attention: %{
                 "attention_id" =>
                   "qe-prompt-authorization-#{third.execution.identity.attempt_id}",
                 "category" => "needs_confirmation",
                 "message" => "Recovery environment ready."
               },
               turn: %{
                 "phase" => "preparing",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil
               },
               started_at: now,
               last_activity_at: now
             })

    assert {:ok, staged_projection} = RunProjection.get(launched.run_id)

    staged_step =
      Enum.find(
        staged_projection.steps,
        &(&1.occurrence_id == third.execution.identity.occurrence_id)
      )

    assert Enum.map(staged_step.attempts, & &1.number) == [1, 2, 3]

    assert Enum.map(staged_step.attempts, & &1.id) == [
             first.execution.identity.attempt_id,
             second.execution.identity.attempt_id,
             third.execution.identity.attempt_id
           ]

    assert staged_step.attempt.id == third.execution.identity.attempt_id
    assert Enum.map(staged_step.attempts, & &1.can_cancel) == [false, false, true]
    assert staged_step.recovery.can_authorize_prompt
    assert staged_step.attempt.session.state == "waiting_for_human"
    refute staged_step.attempt.session.attachment.can_takeover
    assert staged_step.attempt.session.attachment.can_observe

    assert {:ok, descriptor} =
             ExecutionSessionStore.attachment_descriptor(
               launched.run_id,
               third.execution.identity.attempt_id,
               staged_step.attempt.session.id
             )

    refute descriptor.takeover_allowed
    assert {:ok, _} = ExecutionSessionStore.record_opened(descriptor.descriptor_token, "observe")

    assert {:error, :attachment_unavailable} =
             ExecutionSessionStore.record_opened(descriptor.descriptor_token, "takeover")

    staged_session = Repo.get_by!(ExecutionSession, current_action_id: third.action_id)

    Repo.update!(
      Ecto.Changeset.change(staged_session, native_session_id: "unauthorized-conversation")
    )

    assert {:ok, contaminated_projection} = RunProjection.get(launched.run_id)

    contaminated_step =
      Enum.find(
        contaminated_projection.steps,
        &(&1.occurrence_id == third.execution.identity.occurrence_id)
      )

    refute contaminated_step.recovery

    assert {:error, %{code: :prompt_authorization_not_ready}} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               third.execution.identity.occurrence_id,
               third.execution.identity.attempt_id,
               Ecto.UUID.generate()
             )

    Repo.get_by!(ExecutionSession, current_action_id: third.action_id)
    |> Ecto.Changeset.change(native_session_id: nil)
    |> Repo.update!()

    prompt_request_id = Ecto.UUID.generate()

    assert {:ok, authorization} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               third.execution.identity.occurrence_id,
               third.execution.identity.attempt_id,
               prompt_request_id
             )

    refute authorization.idempotent_replay?

    assert_receive {:worker_protocol,
                    %{
                      "type" => "authorize_dispatch_prompt",
                      "action_id" => third_action_id
                    }}

    assert third_action_id == third.action_id

    session = Repo.get_by!(ExecutionSession, current_action_id: third.action_id)

    Repo.update!(
      Ecto.Changeset.change(session,
        state: "running",
        attention: nil,
        turn: Map.put(session.turn, "prompt_intent_at", DateTime.to_iso8601(now))
      )
    )

    assert {:ok, replayed} =
             OperationalRecovery.authorize_prompt(
               launched.run_id,
               third.execution.identity.occurrence_id,
               third.execution.identity.attempt_id,
               Ecto.UUID.generate()
             )

    assert replayed.request_id == prompt_request_id
    assert replayed.idempotent_replay?
    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 3

    session = Repo.get_by!(ExecutionSession, current_action_id: third.action_id)

    Repo.update!(
      Ecto.Changeset.change(session,
        state: "retained",
        attention: nil,
        turn: Map.put(session.turn, "prompt_intent_at", nil)
      )
    )

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: third.action_id,
               occurrence_id: third.execution.identity.occurrence_id,
               attempt_id: third.execution.identity.attempt_id,
               failure: %{
                 "classification" => "operator_recovery_required",
                 "reason" => "execution_control_readiness_failed",
                 "message" => "Current bridge authority was unavailable before prompt submission."
               }
             })

    assert {:ok, failed_projection} = RunProjection.get(launched.run_id)

    failed_step =
      Enum.find(
        failed_projection.steps,
        &(&1.occurrence_id == third.execution.identity.occurrence_id)
      )

    refute failed_step.recovery.can_retry_fresh
    refute failed_step.recovery.can_human_retry
    assert failed_step.recovery.can_recover_pre_prompt
    assert failed_step.recovery.retained_session_available
    assert failed_step.recovery.message =~ "failed before prompt submission"
  end

  test "terminal pre-prompt control recovery appends one retained-process Attempt and stages inference",
       context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-pre-prompt-process", context.workspace_root)
    start_supervised!({WorkerConnections, []})

    assert :ok =
             WorkerConnections.activate(
               worker.id,
               "pre-prompt-process-connection",
               worker.connection_generation,
               self()
             )

    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    failure = %{
      "code" => "execution_control_readiness_failed",
      "reason" => "execution_control_readiness_failed",
      "classification" => "operator_recovery_required",
      "message" => "Current bridge authority was unavailable before prompt submission."
    }

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: first.action_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               failure: failure
             })

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)
    lineage_id = Ecto.UUID.generate()

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: lineage_id,
               action_id: first.action_id,
               run_id: launched.run_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               member_key: first.execution.performer.member_key,
               harness_kind: "antigravity",
               harness_display_name: "Antigravity",
               state: :retained,
               capabilities: %{"can_attach_terminal" => true},
               # Source terminal projection is corroborating presentation data. The Worker
               # proves the exact durable pane and terminal before process transfer.
               terminal: nil,
               native_session_id: nil,
               attention: nil,
               turn: %{
                 "phase" => "preparing",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil
               },
               started_at: now,
               last_activity_at: now
             })

    request_id = Ecto.UUID.generate()

    assert {:ok, recovery} =
             OperationalRecovery.request_pre_prompt_process(
               launched.run_id,
               first.execution.identity.occurrence_id,
               first.execution.identity.attempt_id,
               request_id
             )

    assert recovery.epoch_number == 1
    assert recovery.continuation_mode == "retained"

    assert {:ok, replay} =
             OperationalRecovery.request_pre_prompt_process(
               launched.run_id,
               first.execution.identity.occurrence_id,
               first.execution.identity.attempt_id,
               Ecto.UUID.generate()
             )

    assert replay.id == recovery.id
    assert replay.idempotent_replay?

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    assert second.execution.identity.occurrence_id == first.execution.identity.occurrence_id
    assert second.execution.identity.attempt_id != first.execution.identity.attempt_id
    assert second.operational_recovery.epoch_number == 1
    assert second.operational_recovery.continuation_mode == "retained"
    assert second.operational_recovery.retained_lineage_id == lineage_id
    assert second.operational_recovery.source_attempt_id == first.execution.identity.attempt_id

    assert {:ok, _} =
             DispatchStore.acknowledge(worker.id, worker.connection_generation, second.action_id)

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: lineage_id,
               action_id: second.action_id,
               run_id: launched.run_id,
               occurrence_id: second.execution.identity.occurrence_id,
               attempt_id: second.execution.identity.attempt_id,
               member_key: second.execution.performer.member_key,
               harness_kind: "antigravity",
               harness_display_name: "Antigravity",
               state: :waiting_for_human,
               capabilities: %{"can_attach_terminal" => true},
               terminal: %{
                 "terminal_target_id" => "w4:p6",
                 "supports_observation" => true,
                 "supports_takeover" => true
               },
               native_session_id: nil,
               attention: %{
                 "attention_id" =>
                   "qe-prompt-authorization-#{second.execution.identity.attempt_id}",
                 "category" => "needs_confirmation",
                 "message" => "Recovery ready."
               },
               turn: %{
                 "phase" => "blocked",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil,
                 "physical_process" => %{
                   "mode" => "prepared_process_adopted",
                   "source_attempt_id" => first.execution.identity.attempt_id,
                   "target_attempt_id" => second.execution.identity.attempt_id
                 }
               },
               started_at: now,
               last_activity_at: now
             })

    assert {:ok, projection} = RunProjection.get(launched.run_id)

    projected =
      Enum.find(projection.steps, &(&1.occurrence_id == second.execution.identity.occurrence_id))

    assert projected.attempt.number == 2
    assert projected.attempt.operational.source_attempt_id == first.execution.identity.attempt_id
    assert projected.attempt.operational.retained_lineage_id == lineage_id

    assert projected.attempt.session.turn["physical_process"]["mode"] ==
             "prepared_process_adopted"

    assert projected.recovery.can_authorize_prompt
    refute projected.recovery.can_recover_pre_prompt

    assert Enum.map(projected.attempts, &{&1.number, &1.state}) == [
             {1, "failed"},
             {2, "blocked"}
           ]

    false_conflict = %{
      "reason" => "harness_execution_failed",
      "classification" => "operator_recovery_required",
      "message" =>
        "Prepared process or worktree is already owned by #{first.execution.identity.attempt_id}."
    }

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: second.action_id,
               occurrence_id: second.execution.identity.occurrence_id,
               attempt_id: second.execution.identity.attempt_id,
               failure: false_conflict
             })

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: lineage_id,
               action_id: second.action_id,
               run_id: launched.run_id,
               occurrence_id: second.execution.identity.occurrence_id,
               attempt_id: second.execution.identity.attempt_id,
               member_key: second.execution.performer.member_key,
               harness_kind: "antigravity",
               harness_display_name: "Antigravity",
               state: :retained,
               capabilities: %{"can_attach_terminal" => true},
               terminal: nil,
               native_session_id: nil,
               attention: nil,
               turn: %{
                 "phase" => "preparing",
                 "prompt_intent_at" => nil,
                 "prompt_accepted_at" => nil,
                 "native_activity_at" => nil,
                 "stalled_at" => nil,
                 "settled_at" => nil
               },
               started_at: now,
               last_activity_at: now
             })

    assert {:ok, retry} =
             OperationalRecovery.request_pre_prompt_process(
               launched.run_id,
               first.execution.identity.occurrence_id,
               first.execution.identity.attempt_id,
               request_id
             )

    assert retry.id == recovery.id
    assert retry.epoch_number == 1
    refute retry.idempotent_replay?
    assert is_binary(retry.next_action_id)

    assert {:ok, third} = SchedulingStore.schedule_next(launched.run_id)
    assert third.execution.identity.attempt_id != second.execution.identity.attempt_id
    assert third.operational_recovery.epoch_number == 1
    assert third.operational_recovery.attempt_in_epoch == 2
    assert third.operational_recovery.attempt_allowance == 2
    assert third.operational_recovery.source_attempt_id == first.execution.identity.attempt_id
    assert third.operational_recovery.retained_lineage_id == lineage_id

    assert {:ok, replayed_retry} =
             OperationalRecovery.request_pre_prompt_process(
               launched.run_id,
               first.execution.identity.occurrence_id,
               first.execution.identity.attempt_id,
               request_id
             )

    assert replayed_retry.id == recovery.id
    assert replayed_retry.idempotent_replay?
    assert Repo.aggregate(OperationalRecoveryEpoch, :count) == 2
    assert Repo.aggregate(OperationalAttemptAttribution, :count) == 3

    assert {:ok, retried_projection} = RunProjection.get(launched.run_id)

    retried_step =
      Enum.find(
        retried_projection.steps,
        &(&1.occurrence_id == third.execution.identity.occurrence_id)
      )

    assert Enum.map(retried_step.attempts, &{&1.number, &1.state}) == [
             {1, "failed"},
             {2, "failed"},
             {3, "scheduled"}
           ]
  end

  test "retained human recovery carries the validated lineage into a new Attempt", context do
    fixture = product_fixture()
    assert {:ok, launched} = LaunchQuest.launch(fixture.quest.id)
    worker = register_worker("worker-retained-retry", context.workspace_root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, %{"result" => "operator_recovery_required"}} =
             WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
               type: :step_failed,
               action_id: first.action_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               failure: %{
                 "classification" => "operator_recovery_required",
                 "reason" => "manual_action_required"
               }
             })

    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)
    lineage_id = Ecto.UUID.generate()

    assert {:ok, _session} =
             ExecutionSessionStore.record(worker.id, worker.connection_generation, %{
               session_id: lineage_id,
               action_id: first.action_id,
               run_id: launched.run_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               member_key: first.execution.performer.member_key,
               harness_kind: "pi",
               harness_display_name: "Pi",
               state: :retained,
               capabilities: %{"can_attach_terminal" => true},
               terminal: %{"supports_takeover" => true},
               native_session_id: "pi-session-retained",
               attention: nil,
               started_at: now,
               last_activity_at: now
             })

    request_id = Ecto.UUID.generate()

    assert {:ok, recovery} =
             OperationalRecovery.authorize(%{
               request_id: request_id,
               run_id: launched.run_id,
               occurrence_id: first.execution.identity.occurrence_id,
               attempt_id: first.execution.identity.attempt_id,
               action_id: first.action_id,
               member_key: first.execution.performer.member_key,
               worker_id: worker.id,
               session_id: lineage_id,
               lineage_id: lineage_id,
               native_session_id: "pi-session-retained"
             })

    assert recovery.continuation_mode == "retained"
    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)
    assert second.execution.identity.occurrence_id == first.execution.identity.occurrence_id
    assert second.execution.identity.attempt_id != first.execution.identity.attempt_id
    assert second.operational_recovery.continuation_mode == "retained"
    assert second.operational_recovery.retained_lineage_id == lineage_id
    assert second.operational_recovery.attempt_in_epoch == 1
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
    assert fixture.loadout.tool_policy.tools == ["custom.company-capability"]
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
        objective: Keyword.get(options, :objective, "Prove product-to-execution binding."),
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
        harness: "fake",
        model: model,
        reasoning: "medium",
        tool_policy: %QuestEngineering.Core.Product.ToolPolicy.Exact{tools: tools},
        workspace_access: :read_write
      })

    value
  end

  defp fail_operational(worker, dispatch, classification) do
    WorkerMessageHandler.handle(worker.id, worker.connection_generation, %{
      type: :step_failed,
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      failure: %{
        "classification" => classification,
        "reason" => "simulated_operational_failure"
      }
    })
  end

  defp complete(worker, dispatch, outputs \\ %{}) do
    message = %{
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      outputs: outputs
    }

    assert {:ok, _result} =
             CompletionAdapter.complete(worker.id, worker.connection_generation, message)
  end

  defp register_worker(id, root, options \\ []) do
    adapter = Keyword.get(options, :adapter, "fake")

    tools =
      Keyword.get(options, :tools, ["workspace.filesystem", "workspace.search", "terminal.shell"])

    workspace_roots = Keyword.get(options, :workspace_roots, [{"workspace:test", root}])

    executor = %{
      "harness_kind" => adapter,
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
      "tool_profile" => %{"tools" => tools},
      "workspaces" =>
        Enum.map(workspace_roots, fn {ref, workspace_root} ->
          %{"ref" => ref, "root" => workspace_root, "max_access" => "read_write"}
        end)
    }

    executor =
      case Keyword.get(options, :execution_environment) do
        nil -> executor
        environment -> Map.put(executor, "execution_environment", environment)
      end

    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => Keyword.get(options, :max_concurrency, 1),
      "tags" => [],
      "executors" => [executor]
    }

    {:ok, worker} = WorkerStore.register(id, capabilities, Ecto.UUID.generate())
    worker
  end

  defp ready_assignment(assignment) do
    assignment
    |> Changeset.change(
      state: "ready",
      base_revision: String.duplicate("a", 40),
      canonical_worktree_root: "/managed/worktrees/" <> assignment.worktree_id,
      source_dirty_excluded: false,
      ready_at: DateTime.utc_now()
    )
    |> Repo.update!()
  end

  defp insert_binding(worker, workspace_id, root, allow_unconfined_shell) do
    Repo.insert!(
      WorkerWorkspaceBinding.changeset(%{
        binding_id: Ecto.UUID.generate(),
        worker_id: worker.id,
        workspace_id: workspace_id,
        authorized_root_key: "test",
        source_repository_root: root,
        source_fingerprint: nil,
        max_access: "read_write",
        allow_unconfined_shell: allow_unconfined_shell,
        status: "available",
        last_seen_generation: worker.connection_generation,
        last_seen_at: DateTime.utc_now()
      })
    )
  end

  defp execution_environment(backend_kind) do
    %{
      "backend_kind" => backend_kind,
      "profile" => %{"id" => "test", "digest" => "sha256:test"},
      "capabilities" => [
        %{"kind" => "filesystem_namespace", "mode" => "isolated"},
        %{"kind" => "host_filesystem", "mode" => "unexposed"},
        %{"kind" => "environment_exec", "mode" => "available"},
        %{"kind" => "pty_launcher", "mode" => "available"}
      ]
    }
  end

  defp unique(prefix), do: prefix <> "-" <> Integer.to_string(System.unique_integer([:positive]))
end
