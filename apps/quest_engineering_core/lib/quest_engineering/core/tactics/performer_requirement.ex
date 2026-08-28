defmodule QuestEngineering.Core.Tactics.PerformerRequirement do
  @moduledoc """
  An immutable semantic performer selector for a future scheduler.

  `:class` selects a member by an open-ended string class key. `:same_as`
  selects the member who performed another semantic step in this run. Neither
  selector says anything about workers, processes, assignments, or sessions.
  """

  @enforce_keys [:selector, :value]
  defstruct [:selector, :value]

  @type t :: %__MODULE__{selector: :class | :same_as, value: String.t()}
end
