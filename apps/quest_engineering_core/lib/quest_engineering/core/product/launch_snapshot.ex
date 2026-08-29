defmodule QuestEngineering.Core.Product.LaunchSnapshot do
  @moduledoc """
  A pure immutable resolution of mutable product definitions for a future launch.

  The value itself has no launch or Runtime identity. The v0.8b server atomically
  persists it beside an actual Runtime Run while leaving these dependency-free
  snapshot contents unchanged.
  """

  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Product.LaunchSnapshot.QuestSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.SquadSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.WorkspaceSnapshot
  alias QuestEngineering.Core.Product.TacticProvenance
  alias QuestEngineering.Core.Tactics

  @enforce_keys [
    :schema_version,
    :quest,
    :workspace,
    :squad,
    :tactic,
    :tactic_provenance,
    :execution_plan
  ]
  defstruct [
    :schema_version,
    :quest,
    :workspace,
    :squad,
    :tactic,
    :tactic_provenance,
    :execution_plan
  ]

  @type t :: %__MODULE__{
          schema_version: pos_integer(),
          quest: QuestSnapshot.t(),
          workspace: WorkspaceSnapshot.t(),
          squad: SquadSnapshot.t(),
          tactic: Tactics.t(),
          tactic_provenance: TacticProvenance.t() | nil,
          execution_plan: ExecutionPlan.t()
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.QuestSnapshot do
  @moduledoc false
  @enforce_keys [:id, :title, :objective]
  defstruct [:id, :title, :objective]

  @type t :: %__MODULE__{id: String.t(), title: String.t(), objective: String.t()}
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.WorkspaceSnapshot do
  @moduledoc false
  @enforce_keys [:id, :key, :name, :source_kind]
  defstruct [:id, :key, :name, :source_kind, :source_fingerprint]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          source_kind: :git_remote | :local_git,
          source_fingerprint: String.t() | nil
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.SquadSnapshot do
  @moduledoc false

  alias QuestEngineering.Core.Product.LaunchSnapshot.ResolvedMember

  @enforce_keys [:id, :key, :name, :description, :members]
  defstruct [:id, :key, :name, :description, :members]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          members: [ResolvedMember.t()]
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.ResolvedMember do
  @moduledoc false

  alias QuestEngineering.Core.Product.LaunchSnapshot.ClassSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.LoadoutSnapshot

  @enforce_keys [:key, :name, :class, :loadout]
  defstruct [:key, :name, :class, :loadout]

  @type t :: %__MODULE__{
          key: String.t(),
          name: String.t(),
          class: ClassSnapshot.t(),
          loadout: LoadoutSnapshot.t()
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.ClassSnapshot do
  @moduledoc false
  @enforce_keys [:id, :key, :name, :description, :instructions]
  defstruct [:id, :key, :name, :description, :instructions]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          instructions: String.t()
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.LoadoutSnapshot do
  @moduledoc false

  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.ModelRef

  @enforce_keys [
    :id,
    :key,
    :name,
    :description,
    :model,
    :reasoning,
    :tools,
    :workspace_access
  ]
  defstruct [
    :id,
    :key,
    :name,
    :description,
    :model,
    :reasoning,
    :tools,
    :workspace_access
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          model: ModelRef.t(),
          reasoning: Loadout.reasoning(),
          tools: [String.t()],
          workspace_access: Loadout.workspace_access()
        }
end

defmodule QuestEngineering.Core.Product.LaunchSnapshot.Builder do
  @moduledoc "Pure validation, compilation, satisfiability, and snapshot construction."

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Product.Class
  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.ClassSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.LoadoutSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.QuestSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.ResolvedMember
  alias QuestEngineering.Core.Product.LaunchSnapshot.SquadSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.WorkspaceSnapshot
  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.Quest
  alias QuestEngineering.Core.Product.Squad
  alias QuestEngineering.Core.Product.TacticResolver
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.Validation
  alias QuestEngineering.Core.Product.ValidationError
  alias QuestEngineering.Core.Product.Workspace
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  @schema_version 3

  @spec build(Quest.t(), Workspace.t(), Squad.t(), [Class.t()], [Loadout.t()], Catalog.t()) ::
          {:ok, LaunchSnapshot.t()} | {:error, [ValidationError.t()]}
  def build(
        %Quest{} = quest,
        %Workspace{} = workspace,
        %Squad{} = squad,
        classes,
        loadouts,
        %Catalog{} = catalog
      )
      when is_list(classes) and is_list(loadouts) do
    errors =
      validation_errors(quest) ++
        validation_errors(workspace) ++
        roster_errors(squad, classes, loadouts) ++
        squad_reference_errors(quest, squad) ++ workspace_reference_errors(quest, workspace)

    with [] <- errors,
         {:ok, resolution} <- TacticResolver.resolve(quest.tactic_source, catalog),
         {:ok, plan} <- compile(resolution.tactic),
         [] <- satisfiability_errors(plan, squad, classes) do
      {:ok, snapshot(quest, workspace, squad, classes, loadouts, resolution, plan)}
    else
      {:error, [%TacticResolver.Error{} | _rest] = resolution_errors} ->
        {:error, Enum.map(resolution_errors, &resolution_error/1)}

      {:error, compile_errors} ->
        {:error, compile_errors}

      errors when is_list(errors) ->
        {:error, errors}
    end
  end

  def build(_quest, _workspace, _squad, _classes, _loadouts, _catalog) do
    {:error,
     [
       error(:invalid_launch_input, [], %{
         reason: :expected_quest_workspace_squad_definition_lists_and_tactic_catalog
       })
     ]}
  end

  defp compile(tactic) do
    case Compiler.compile(tactic) do
      {:ok, plan} ->
        {:ok, plan}

      {:error, errors} ->
        {:error, [error(:invalid_tactic, ["tactic_source"], %{compiler_errors: errors})]}
    end
  end

  defp satisfiability_errors(%ExecutionPlan{} = plan, squad, classes) do
    class_by_id = Map.new(classes, &{&1.id, &1})

    available =
      squad.members
      |> Enum.flat_map(fn member ->
        case Map.fetch(class_by_id, member.class_id) do
          {:ok, class} -> [class.key]
          :error -> []
        end
      end)
      |> MapSet.new()

    plan.steps
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {%ExecutionPlan.Step{
         key: step_key,
         performer: %PerformerRequirement{selector: :class, value: class_key}
       }, index} ->
        if MapSet.member?(available, class_key) do
          []
        else
          [
            error(
              :unsatisfied_performer_class,
              ["execution_plan", "steps", index, "performer"],
              %{
                step_key: step_key,
                class_key: class_key
              }
            )
          ]
        end

      {_step, _index} ->
        []
    end)
  end

  defp snapshot(quest, workspace, squad, classes, loadouts, resolution, plan) do
    class_by_id = Map.new(classes, &{&1.id, &1})
    loadout_by_id = Map.new(loadouts, &{&1.id, &1})

    members =
      Enum.map(squad.members, fn member ->
        %ResolvedMember{
          key: member.key,
          name: member.name,
          class: class_snapshot(Map.fetch!(class_by_id, member.class_id)),
          loadout: loadout_snapshot(Map.fetch!(loadout_by_id, member.loadout_id))
        }
      end)

    %LaunchSnapshot{
      schema_version: @schema_version,
      quest: %QuestSnapshot{id: quest.id, title: quest.title, objective: quest.objective},
      workspace: %WorkspaceSnapshot{
        id: workspace.id,
        key: workspace.key,
        name: workspace.name,
        source_kind: workspace.source_kind,
        source_fingerprint: workspace.source_fingerprint
      },
      squad: %SquadSnapshot{
        id: squad.id,
        key: squad.key,
        name: squad.name,
        description: squad.description,
        members: members
      },
      tactic: resolution.tactic,
      tactic_provenance: resolution.provenance,
      execution_plan: plan
    }
  end

  defp class_snapshot(class) do
    %ClassSnapshot{
      id: class.id,
      key: class.key,
      name: class.name,
      description: class.description,
      instructions: class.instructions
    }
  end

  defp loadout_snapshot(loadout) do
    %LoadoutSnapshot{
      id: loadout.id,
      key: loadout.key,
      name: loadout.name,
      description: loadout.description,
      model: loadout.model,
      reasoning: loadout.reasoning,
      tools: loadout.tools,
      workspace_access: loadout.workspace_access
    }
  end

  defp validation_errors(value) do
    case Validation.validate(value) do
      {:ok, _valid} -> []
      {:error, errors} -> errors
    end
  end

  defp roster_errors(squad, classes, loadouts) do
    case Validation.validate_roster(squad, classes, loadouts) do
      {:ok, _valid} -> []
      {:error, errors} -> errors
    end
  end

  defp squad_reference_errors(%Quest{squad_id: squad_id}, %Squad{id: squad_id}), do: []

  defp squad_reference_errors(quest, squad) do
    [
      error(:quest_squad_mismatch, ["squad_id"], %{
        quest_squad_id: quest.squad_id,
        supplied_squad_id: squad.id
      })
    ]
  end

  defp workspace_reference_errors(%Quest{workspace_id: id}, %Workspace{id: id}), do: []

  defp workspace_reference_errors(quest, workspace) do
    [
      error(:quest_workspace_mismatch, ["workspace_id"], %{
        quest_workspace_id: quest.workspace_id,
        supplied_workspace_id: workspace.id
      })
    ]
  end

  defp resolution_error(error) do
    %ValidationError{
      code: error.code,
      path: ["tactic_source" | error.path],
      details: %{
        instance_path: error.instance_path,
        definition_path: error.definition_path,
        resolution_details: error.details
      }
    }
  end

  defp error(code, path, details), do: %ValidationError{code: code, path: path, details: details}
end
