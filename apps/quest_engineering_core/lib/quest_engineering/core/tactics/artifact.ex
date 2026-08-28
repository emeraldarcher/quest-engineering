defmodule QuestEngineering.Core.Tactics.Artifact do
  @moduledoc """
  A typed semantic artifact declaration.

  Open-ended artifact types and explicit semantic step sources are strings so
  persisted or external values never need to become BEAM atoms. `source` is
  `nil` when the compiler should infer an input producer. Outputs never have a
  source.
  """

  @enforce_keys [:type]
  defstruct [:type, :source]

  @type artifact_type :: String.t()
  @type step_key :: String.t()
  @type t :: %__MODULE__{type: artifact_type(), source: step_key() | nil}
end
