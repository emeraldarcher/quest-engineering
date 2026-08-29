defmodule QuestEngineering.Core.ResolvedExecution do
  @moduledoc """
  Immutable, provider-neutral execution configuration resolved at scheduling time.

  This value deliberately separates semantic work, performer identity, executor
  configuration, and logical context. It contains no Worker-local or provider
  lineage identifiers.
  """

  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work

  @enforce_keys [:identity, :performer, :work, :configuration, :context]
  defstruct [:identity, :performer, :work, :configuration, :context]

  @type t :: %__MODULE__{
          identity: Identity.t(),
          performer: Performer.t(),
          work: Work.t(),
          configuration: Configuration.t(),
          context: Context.t()
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Identity do
  @moduledoc false
  @enforce_keys [:launch_id, :action_id, :run_id, :occurrence_id, :attempt_id, :semantic_step_key]
  defstruct [:launch_id, :action_id, :run_id, :occurrence_id, :attempt_id, :semantic_step_key]

  @type t :: %__MODULE__{
          launch_id: String.t(),
          action_id: String.t(),
          run_id: String.t(),
          occurrence_id: String.t(),
          attempt_id: String.t(),
          semantic_step_key: String.t()
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Performer do
  @moduledoc false
  @enforce_keys [:member_key, :member_name, :class_key, :class_name]
  defstruct [:member_key, :member_name, :class_key, :class_name]

  @type t :: %__MODULE__{
          member_key: String.t(),
          member_name: String.t(),
          class_key: String.t(),
          class_name: String.t()
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Work do
  @moduledoc false
  @enforce_keys [
    :quest_objective,
    :class_instructions,
    :step_instruction,
    :inputs,
    :declared_outputs
  ]
  defstruct [
    :quest_objective,
    :class_instructions,
    :step_instruction,
    :inputs,
    :declared_outputs
  ]

  @type t :: %__MODULE__{
          quest_objective: String.t(),
          class_instructions: String.t(),
          step_instruction: String.t(),
          inputs: %{optional(String.t()) => QuestEngineering.Core.Runtime.ArtifactInstance.t()},
          declared_outputs: [String.t()]
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Configuration do
  @moduledoc false

  alias QuestEngineering.Core.Product.Loadout
  alias QuestEngineering.Core.Product.ModelRef

  @enforce_keys [
    :model,
    :reasoning,
    :tools,
    :workspace_ref,
    :workspace_root,
    :workspace_access
  ]
  defstruct [
    :model,
    :reasoning,
    :tools,
    :workspace_ref,
    :workspace_root,
    :workspace_access
  ]

  @type t :: %__MODULE__{
          model: ModelRef.t(),
          reasoning: Loadout.reasoning(),
          tools: [String.t()],
          workspace_ref: String.t(),
          workspace_root: String.t(),
          workspace_access: Loadout.workspace_access()
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Context do
  @moduledoc false
  @enforce_keys [:mode, :logical_lineage_id]
  defstruct [:mode, :source_occurrence_id, :logical_lineage_id]

  @type t :: %__MODULE__{
          mode: :fresh | :continue_from,
          source_occurrence_id: String.t() | nil,
          logical_lineage_id: String.t()
        }
end

defmodule QuestEngineering.Core.ResolvedExecution.Builder do
  @moduledoc "Pure construction of a resolved execution from immutable launch-time values."

  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.Product.LaunchSnapshot.ResolvedMember
  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.Action

  @spec build(
          LaunchSnapshot.t(),
          Action.t(),
          String.t(),
          ResolvedMember.t(),
          String.t(),
          String.t() | nil
        ) :: ResolvedExecution.t()
  def build(snapshot, action, launch_id, member, logical_lineage_id, source_occurrence_id)
      when is_binary(launch_id) and is_binary(logical_lineage_id) do
    %ResolvedExecution{
      identity: %Identity{
        launch_id: launch_id,
        action_id: action.id,
        run_id: action.run_id,
        occurrence_id: action.occurrence_id,
        attempt_id: action.attempt_id,
        semantic_step_key: action.semantic_step_key
      },
      performer: %Performer{
        member_key: member.key,
        member_name: member.name,
        class_key: member.class.key,
        class_name: member.class.name
      },
      work: %Work{
        quest_objective: snapshot.quest.objective,
        class_instructions: member.class.instructions,
        step_instruction: action.instruction,
        inputs: action.inputs,
        declared_outputs: action.declared_outputs
      },
      configuration: %Configuration{
        model: member.loadout.model,
        reasoning: member.loadout.reasoning,
        tools: member.loadout.tools,
        workspace_ref: snapshot.workspace.ref,
        workspace_root: snapshot.workspace.root,
        workspace_access: member.loadout.workspace_access
      },
      context: %Context{
        mode: if(source_occurrence_id, do: :continue_from, else: :fresh),
        source_occurrence_id: source_occurrence_id,
        logical_lineage_id: logical_lineage_id
      }
    }
  end
end
