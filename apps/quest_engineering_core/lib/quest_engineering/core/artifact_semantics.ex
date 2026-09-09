defmodule QuestEngineering.Core.ArtifactSemantics do
  @moduledoc "Canonical built-in artifact and acceptance identities. Custom kinds remain open."

  @built_in_kinds ~w(quest_plan change_set review_verdict)
  @obsolete_kinds ~w(implementation_plan plan_verdict implementation_verdict verdict)
  @gates ~w(plan_acceptance implementation_acceptance)

  @spec built_in_kinds() :: [String.t()]
  def built_in_kinds, do: @built_in_kinds

  @spec acceptance_gates() :: [String.t()]
  def acceptance_gates, do: @gates

  @spec obsolete_kind?(term()) :: boolean()
  def obsolete_kind?(kind), do: kind in @obsolete_kinds

  @spec valid_kind?(term()) :: boolean()
  def valid_kind?(kind),
    do:
      is_binary(kind) and String.valid?(kind) and
        String.match?(kind, ~r/\A[a-z][a-z0-9_]{0,63}\z/) and not obsolete_kind?(kind)
end
