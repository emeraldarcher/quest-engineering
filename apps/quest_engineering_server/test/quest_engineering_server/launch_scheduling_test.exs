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
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)
    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:test" => root})

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})

      Sandbox.stop_owner(owner)
    end)

    %{workspace_root: root}
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

  test "concurrent schedulers cannot partially acquire the last Worker slot", context do
    first_fixture = product_fixture()

    assert {:ok, second_quest} =
             Products.create_quest(%{
               title: "Second concurrent Quest",
               objective: "Compete for the final Worker slot.",
               workspace_id: first_fixture.quest.workspace_id,
               squad_id: first_fixture.quest.squad_id,
               tactic_source: first_fixture.quest.tactic_source
             })

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

    %{quest: quest, builder: builder, loadout: first_loadout}
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
          "workspaces" => [
            %{"ref" => "workspace:test", "root" => root, "max_access" => "read_write"}
          ]
        }
      ]
    }

    {:ok, worker} = WorkerStore.register(id, capabilities, Ecto.UUID.generate())
    worker
  end

  defp unique(prefix), do: prefix <> "-" <> Integer.to_string(System.unique_integer([:positive]))
end
