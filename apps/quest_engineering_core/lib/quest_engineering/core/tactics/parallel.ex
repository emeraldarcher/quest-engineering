defmodule QuestEngineering.Core.Tactics.Parallel do
  @moduledoc """
  Concurrent semantic composition.

  Children have no ordering among themselves. The parallel composition is
  complete only after every child is complete; the compiler represents that
  barrier without adding a semantic join node.
  """

  @enforce_keys [:children]
  defstruct [:children]

  @type t :: %__MODULE__{children: [QuestEngineering.Core.Tactics.t()]}
end
