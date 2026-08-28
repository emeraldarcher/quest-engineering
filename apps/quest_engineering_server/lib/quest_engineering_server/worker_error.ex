defmodule QuestEngineering.Server.WorkerError do
  @moduledoc "Machine-readable worker registration, dispatch, and reconciliation failure."

  @enforce_keys [:type]
  defstruct [:type, :worker_id, :action_id, :details]

  @type t :: %__MODULE__{
          type: atom(),
          worker_id: String.t() | nil,
          action_id: String.t() | nil,
          details: term()
        }
end
