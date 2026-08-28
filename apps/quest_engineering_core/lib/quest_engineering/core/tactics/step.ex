defmodule QuestEngineering.Core.Tactics.Step do
  @moduledoc "A semantic unit of agent work, with no runtime state."

  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  @enforce_keys [:key, :name, :instruction, :performer, :context]
  defstruct [:key, :name, :instruction, :performer, :context, consumes: [], produces: []]

  @type t :: %__MODULE__{
          key: String.t(),
          name: String.t(),
          instruction: String.t(),
          performer: PerformerRequirement.t(),
          context: ContextRequirement.t(),
          consumes: [Artifact.t()],
          produces: [Artifact.t()]
        }
end
