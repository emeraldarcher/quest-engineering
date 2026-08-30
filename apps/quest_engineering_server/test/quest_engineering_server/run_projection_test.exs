defmodule QuestEngineering.Server.RunProjectionTest do
  use QuestEngineering.Server.DataCase, async: false

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerStore

  test "distinguishes Core pending occurrences from dispatched work awaiting scheduling" do
    root = Path.expand(".pi/tmp/projection-workspace-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)
    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:projection" => root})

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})
    end)

    {:ok, class} =
      Products.create_class(%{key: "builder-projection", name: "Builder", instructions: "Build."})

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "loadout-projection",
        name: "Loadout",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :low,
        tools: [],
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "squad-projection",
        name: "Squad",
        members: [%{key: "alice", name: "Alice", class_id: class.id, loadout_id: loadout.id}]
      })

    tactic =
      sequence([
        step("first",
          name: "First",
          instruction: "First.",
          performer: class("builder-projection")
        ),
        step("second",
          name: "Second",
          instruction: "Second.",
          performer: same_as("first"),
          context: continue_from("first")
        )
      ])

    {:ok, quest} =
      Products.create_quest(%{
        title: "Projection",
        objective: "Projection.",
        workspace_ref: "workspace:projection",
        squad_id: squad.id,
        tactic_source: TacticSource.inline(tactic)
      })

    {:ok, launched} = LaunchQuest.launch(quest.id)
    {:ok, projection} = RunProjection.get(launched.run_id)

    assert projection.status == "waiting"
    assert projection.step_counts["pending"] == 1
    assert projection.step_counts["waiting"] == 1
    assert [%{state: "waiting"}, %{state: "pending"}] = projection.steps

    worker = register_worker(root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             CompletionAdapter.complete(
               worker.id,
               worker.connection_generation,
               completion(first)
             )

    assert {:ok, _second} = SchedulingStore.schedule_next(launched.run_id)
    {:ok, active} = RunProjection.get(launched.run_id)
    [first_step, second_step] = active.steps

    assert second_step.member.member_key == "alice"
    assert second_step.performer.source_occurrence_id == first_step.occurrence_id
    assert second_step.performer.source_semantic_step_key == "first"
    assert second_step.context.source_occurrence_id == first_step.occurrence_id
    assert second_step.context.source_semantic_step_key == "first"
  end

  defp completion(dispatch) do
    %{
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      outputs: %{}
    }
  end

  defp register_worker(root) do
    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => [],
          "workspaces" => [
            %{"ref" => "workspace:projection", "root" => root, "max_access" => "read_write"}
          ]
        }
      ]
    }

    {:ok, worker} = WorkerStore.register("worker-projection", capabilities, Ecto.UUID.generate())
    worker
  end
end
