defmodule QuestEngineering.Core.Tactics.Sequence do
  @moduledoc """
  Ordered semantic composition.

  Every child completes before the next child starts. Artifact flow remains
  independently declared and is not implied by this ordering.
  """

  @enforce_keys [:children]
  defstruct [:children]

  @type t :: %__MODULE__{children: [QuestEngineering.Core.Tactics.t()]}
end
