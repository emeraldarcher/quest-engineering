defmodule QuestEngineering.Core.Tactics.Until do
  @moduledoc """
  Check-first, outcome-driven control with a bounded number of remediations.

  `max_remediations` counts executions of `otherwise`, not executions of
  `check`. A region with a bound of three can therefore check up to four times.
  """

  alias QuestEngineering.Core.Tactics.Condition

  @enforce_keys [:check, :condition, :otherwise, :max_remediations]
  defstruct [:check, :condition, :otherwise, :max_remediations]

  @type t :: %__MODULE__{
          check: QuestEngineering.Core.Tactics.t(),
          condition: Condition.t(),
          otherwise: QuestEngineering.Core.Tactics.t(),
          max_remediations: pos_integer()
        }
end
