defmodule QuestEngineering.Server.Persistence.Error do
  @moduledoc "Structured persistence, recovery, and idempotency failure."

  @enforce_keys [:type]
  defstruct [:type, :run_id, :transition_id, :action_id, :details]

  @type error_type ::
          :run_not_found
          | :action_not_found
          | :unsupported_snapshot_version
          | :invalid_persisted_term
          | :transition_id_conflict
          | :action_id_conflict
          | :stale_revision
          | :constraint_failure

  @type t :: %__MODULE__{
          type: error_type(),
          run_id: String.t() | nil,
          transition_id: String.t() | nil,
          action_id: String.t() | nil,
          details: term()
        }
end
