defmodule QuestEngineering.Core.Tactics.ContextRequirement do
  @moduledoc """
  An immutable semantic context-lineage selector for a future runtime.

  `:fresh` requests no inherited reasoning or conversation lineage for each
  execution of the step. `:continue_from` references the lineage established by
  another semantic step in the same run. The requirement is independent of
  performer selection and contains no provider or runtime execution identity.
  """

  @enforce_keys [:selector, :value]
  defstruct [:selector, :value]

  @type t ::
          %__MODULE__{selector: :fresh, value: nil}
          | %__MODULE__{selector: :continue_from, value: String.t()}
end
