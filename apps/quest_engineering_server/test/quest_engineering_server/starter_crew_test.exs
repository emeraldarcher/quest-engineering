defmodule QuestEngineering.Server.StarterCrewTest do
  use QuestEngineering.Server.DataCase, async: false

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Server.ExecutionOptions
  alias QuestEngineering.Server.Persistence.ProductClass
  alias QuestEngineering.Server.Persistence.ProductLoadout
  alias QuestEngineering.Server.Persistence.ProductSquad
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Product.StarterCrew
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerStore

  test "empty state creates the complete ordinary starter set" do
    workspace = compatible_workspace!()

    assert %{state: :empty} = StarterCrew.status()
    assert {:ok, result} = StarterCrew.create_or_reconcile(workspace.id)

    assert result.status == :ready
    assert Enum.map(result.classes, & &1.key) == ~w(builder reviewer)
    assert Enum.map(result.loadouts, & &1.key) == ~w(coding review)
    assert result.squad.key == "engineering-pair"
    assert result.tactic.key == "implement-and-review"
    assert %{state: :complete} = StarterCrew.status()
    assert_counts(2, 2, 1, 1)
  end

  test "a complete exact set remains idempotent after its Worker goes offline" do
    workspace = compatible_workspace!()
    assert {:ok, first} = StarterCrew.create_or_reconcile(workspace.id)
    disconnect_worker!("starter-worker")
    refute Enum.any?(ExecutionOptions.list(), & &1.available)

    assert {:ok, second} = StarterCrew.create_or_reconcile(workspace.id)
    assert_same_starter(first, second)
    assert_counts(2, 2, 1, 1)
  end

  test "a newly preferred option does not redefine persisted starter Loadouts" do
    workspace = compatible_workspace!()
    assert {:ok, first} = StarterCrew.create_or_reconcile(workspace.id)

    register_worker!("preferred-worker", workspace, [
      %{"provider" => "aaa", "model" => "new-preferred"}
    ])

    assert %{model: %{provider: "aaa", model: "new-preferred"}} =
             ExecutionOptions.list() |> Enum.filter(& &1.available) |> hd()

    assert {:ok, second} = StarterCrew.create_or_reconcile(workspace.id)
    assert_same_starter(first, second)
    assert Enum.map(second.loadouts, & &1.model.model) == ["starter", "starter"]
  end

  test "fresh creation deterministically orders models independent of Worker registration" do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "deterministic-starter-project",
        name: "workspace:deterministic-starter",
        source_kind: :local_git
      })

    register_worker!("registered-first", workspace, [
      %{"provider" => "zeta", "model" => "second"}
    ])

    register_worker!("registered-second", workspace, [
      %{"provider" => "alpha", "model" => "later"},
      %{"provider" => "alpha", "model" => "first"}
    ])

    assert {:ok, result} = StarterCrew.create_or_reconcile(workspace.id)

    assert Enum.map(result.loadouts, &{&1.model.provider, &1.model.model}) == [
             {"alpha", "first"},
             {"alpha", "first"}
           ]
  end

  test "recoverable legacy partial Classes are reused and missing entities are created" do
    workspace = compatible_workspace!()
    {:ok, builder} = Products.create_class(class_attributes("builder"))
    {:ok, reviewer} = Products.create_class(class_attributes("reviewer"))

    assert %{state: :recoverable_partial} = StarterCrew.status()
    assert {:ok, result} = StarterCrew.create_or_reconcile(workspace.id)
    assert Enum.map(result.classes, & &1.id) == [builder.id, reviewer.id]
    assert %{state: :complete} = StarterCrew.status()
    assert_counts(2, 2, 1, 1)
  end

  test "recoverable partial Loadouts retain exact rows and use current configuration only for missing rows" do
    workspace = compatible_workspace!()
    {:ok, builder} = Products.create_class(class_attributes("builder"))
    {:ok, reviewer} = Products.create_class(class_attributes("reviewer"))
    {:ok, coding} = Products.create_loadout(loadout_attributes("coding"))

    register_worker!("preferred-partial-worker", workspace, [
      %{"provider" => "aaa", "model" => "new-preferred"}
    ])

    assert %{state: :recoverable_partial} = StarterCrew.status()
    assert {:ok, result} = StarterCrew.create_or_reconcile(workspace.id)
    assert Enum.find(result.loadouts, &(&1.key == "coding")).id == coding.id
    assert Enum.find(result.loadouts, &(&1.key == "review")).model.model == "starter"

    assert result.squad.members == [
             %QuestEngineering.Core.Product.Member{
               key: "builder",
               name: "Builder",
               class_id: builder.id,
               loadout_id: coding.id
             },
             %QuestEngineering.Core.Product.Member{
               key: "reviewer",
               name: "Reviewer",
               class_id: reviewer.id,
               loadout_id: Enum.find(result.loadouts, &(&1.key == "review")).id
             }
           ]
  end

  test "partial state with both exact Loadouts needs no available execution option" do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "offline-partial-project",
        name: "Offline partial",
        source_kind: :local_git
      })

    {:ok, builder} = Products.create_class(class_attributes("builder"))
    {:ok, reviewer} = Products.create_class(class_attributes("reviewer"))
    {:ok, coding} = Products.create_loadout(loadout_attributes("coding"))
    {:ok, review} = Products.create_loadout(loadout_attributes("review"))

    assert %{state: :recoverable_partial} = StarterCrew.status()
    assert {:ok, result} = StarterCrew.create_or_reconcile(workspace.id)
    assert Enum.map(result.classes, & &1.id) == [builder.id, reviewer.id]
    assert Enum.map(result.loadouts, & &1.id) == [coding.id, review.id]
    assert_counts(2, 2, 1, 1)
  end

  test "a conflicting Class aborts without creating anything else" do
    compatible_workspace!()

    {:ok, _class} =
      Products.create_class(%{key: "builder", name: "Custom Builder", instructions: "Custom."})

    assert %{state: :conflict, conflict: %{entity_type: :class, key: "builder"}} =
             StarterCrew.status()

    assert {:error, %StarterCrew.Error{code: :conflict, entity_type: :class, key: "builder"}} =
             StarterCrew.create_or_reconcile(workspace_id())

    assert_counts(1, 0, 0, 0)
  end

  test "a conflicting Loadout aborts without overwriting it" do
    compatible_workspace!()

    {:ok, _loadout} =
      Products.create_loadout(%{
        loadout_attributes("coding")
        | model: %ModelRef{provider: "custom", model: "different"}
      })

    assert_conflict(:loadout, "coding")
    assert_counts(0, 1, 0, 0)
  end

  test "customizing Coding suppresses onboarding while explicit setup remains non-destructive" do
    workspace = compatible_workspace!()
    assert {:ok, starter} = StarterCrew.create_or_reconcile(workspace.id)
    coding = Enum.find(starter.loadouts, &(&1.key == "coding"))

    assert {:ok, customized} =
             Products.update_loadout(coding.id, %{
               model: %ModelRef{provider: "custom", model: "evolved"},
               reasoning: :high,
               tools: ["workspace.filesystem"]
             })

    assert %{state: :manual_configuration, conflict: nil} = StarterCrew.status()

    assert {:error, %StarterCrew.Error{code: :conflict, entity_type: :loadout, key: "coding"}} =
             StarterCrew.create_or_reconcile(workspace.id)

    assert {:ok, persisted} = Products.get_loadout(coding.id)
    assert persisted == customized
    assert_counts(2, 2, 1, 1)
  end

  test "customizing Builder through Product CRUD suppresses onboarding" do
    workspace = compatible_workspace!()
    assert {:ok, starter} = StarterCrew.create_or_reconcile(workspace.id)
    builder = Enum.find(starter.classes, &(&1.key == "builder"))

    assert {:ok, customized} =
             Products.update_class(builder.id, %{instructions: "Use the team's evolved practice."})

    assert %{state: :manual_configuration, conflict: nil} = StarterCrew.status()

    assert {:error, %StarterCrew.Error{code: :conflict, entity_type: :class, key: "builder"}} =
             StarterCrew.create_or_reconcile(workspace.id)

    assert {:ok, persisted} = Products.get_class(builder.id)
    assert persisted == customized
  end

  test "a customized complete Squad suppresses onboarding but explicit setup still conflicts" do
    workspace = compatible_workspace!()
    assert {:ok, starter} = StarterCrew.create_or_reconcile(workspace.id)
    squad = starter.squad
    assert {:ok, _updated} = Products.update_squad(squad.id, %{name: "Custom Pair"})

    assert %{state: :manual_configuration, conflict: nil} = StarterCrew.status()

    assert {:error,
            %StarterCrew.Error{code: :conflict, entity_type: :squad, key: "engineering-pair"}} =
             StarterCrew.create_or_reconcile(workspace.id)

    assert_counts(2, 2, 1, 1)
  end

  test "a conflicting Tactic aborts without overwriting its semantics" do
    compatible_workspace!()

    {:ok, _tactic} =
      TacticLibrary.create(%{
        key: "implement-and-review",
        name: "Different Workflow",
        description: "User-authored.",
        body:
          step("custom",
            name: "Custom",
            instruction: "Do custom work.",
            performer: class("builder")
          )
      })

    assert_conflict(:tactic, "implement-and-review")
    assert_counts(0, 0, 0, 1)
  end

  test "an archived canonical identity is a conflict and is never resurrected" do
    compatible_workspace!()
    {:ok, builder} = Products.create_class(class_attributes("builder"))
    assert :ok = Products.archive_class(builder.id)

    assert_conflict(:class, "builder")
    assert {:ok, archived} = Products.get_class(builder.id, include_archived: true)
    assert archived.id == builder.id
    assert_counts(1, 0, 0, 0)
  end

  test "a late failure rolls back all entities created by the transaction" do
    workspace = compatible_workspace!()
    failure = %StarterCrew.Error{code: :forced_test_failure}

    assert {:error, ^failure} =
             StarterCrew.create_or_reconcile(workspace.id,
               before_tactic: fn -> {:error, failure} end
             )

    assert %{state: :empty} = StarterCrew.status()
    assert_counts(0, 0, 0, 0)
  end

  test "no compatible execution option is a precondition failure with no writes" do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "unavailable-starter-project",
        name: "Unavailable",
        source_kind: :local_git
      })

    assert {:error, %StarterCrew.Error{code: :no_compatible_execution_option}} =
             StarterCrew.create_or_reconcile(workspace.id)

    assert_counts(0, 0, 0, 0)
  end

  test "manual Product configuration suppresses starter classification" do
    {:ok, _class} =
      Products.create_class(%{key: "architect", name: "Architect", instructions: "Design."})

    assert %{state: :manual_configuration, conflict: nil} = StarterCrew.status()
  end

  test "the canonical Tactic preserves Implement to Review artifact semantics" do
    workspace = compatible_workspace!()
    assert {:ok, %{tactic: tactic}} = StarterCrew.create_or_reconcile(workspace.id)

    assert tactic.body == canonical_tactic()
  end

  defp assert_conflict(type, key) do
    assert %{state: :conflict, conflict: %{entity_type: ^type, key: ^key}} =
             StarterCrew.status()

    assert {:error, %StarterCrew.Error{code: :conflict, entity_type: ^type, key: ^key}} =
             StarterCrew.create_or_reconcile(workspace_id())
  end

  defp assert_same_starter(first, second) do
    assert Enum.map(first.classes, & &1.id) == Enum.map(second.classes, & &1.id)
    assert Enum.map(first.loadouts, & &1.id) == Enum.map(second.loadouts, & &1.id)
    assert first.squad.id == second.squad.id
    assert first.tactic.id == second.tactic.id
  end

  defp assert_counts(classes, loadouts, squads, tactics) do
    assert Repo.aggregate(ProductClass, :count) == classes
    assert Repo.aggregate(ProductLoadout, :count) == loadouts
    assert Repo.aggregate(ProductSquad, :count) == squads
    assert Repo.aggregate(ProductTactic, :count) == tactics
  end

  defp compatible_workspace!(models \\ [%{"provider" => "fake", "model" => "starter"}]) do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "starter-project",
        name: "workspace:starter",
        source_kind: :local_git
      })

    register_worker!("starter-worker", workspace, models)
    Process.put(:starter_workspace_id, workspace.id)
    workspace
  end

  defp register_worker!(worker_id, workspace, models) do
    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => models,
          "reasoning" => ["low", "medium"],
          "tools" => ["workspace.filesystem", "workspace.search"],
          "workspaces" => [
            %{
              "ref" => workspace.name,
              "root" => "/not-exposed",
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }

    {:ok, worker} = WorkerStore.register(worker_id, capabilities, Ecto.UUID.generate())
    worker
  end

  defp disconnect_worker!(worker_id) do
    {:ok, worker} = WorkerStore.fetch(worker_id)

    {:ok, _worker} =
      WorkerStore.disconnect(worker.id, worker.connection_id, worker.connection_generation)
  end

  defp workspace_id, do: Process.get(:starter_workspace_id)

  defp class_attributes("builder"),
    do: %{
      key: "builder",
      name: "Builder",
      description: "Builds the requested change.",
      instructions: "Implement the requested change carefully and report the declared result."
    }

  defp class_attributes("reviewer"),
    do: %{
      key: "reviewer",
      name: "Reviewer",
      description: "Independently reviews completed work.",
      instructions: "Review the supplied work independently and report the declared result."
    }

  defp loadout_attributes("coding"),
    do: %{
      key: "coding",
      name: "Coding",
      description: "Writable engineering capabilities.",
      model: %ModelRef{provider: "fake", model: "starter"},
      reasoning: :medium,
      tools: ["workspace.filesystem", "workspace.search"],
      workspace_access: :read_write
    }

  defp loadout_attributes("review"),
    do: %{
      key: "review",
      name: "Review",
      description: "Read-only review capabilities.",
      model: %ModelRef{provider: "fake", model: "starter"},
      reasoning: :medium,
      tools: ["workspace.filesystem", "workspace.search"],
      workspace_access: :read_only
    }

  defp canonical_tactic do
    sequence([
      step("implement",
        name: "Implement",
        instruction: "Implement the Quest objective.",
        performer: class("builder"),
        context: fresh(),
        consumes: [],
        produces: [artifact("change_set")]
      ),
      step("review",
        name: "Review",
        instruction: "Review the implementation against the Quest objective.",
        performer: class("reviewer"),
        context: fresh(),
        consumes: [artifact("change_set", from: "implement")],
        produces: [artifact("verdict")]
      )
    ])
  end
end
