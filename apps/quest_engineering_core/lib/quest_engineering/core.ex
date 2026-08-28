defmodule QuestEngineering.Core do
  @moduledoc """
  Dependency-free semantic orchestration logic for Quest Engineering.

  Immutable `Step`, `Sequence`, `Parallel`, and bounded outcome-driven `Until`
  tactics compile into deterministic execution specifications. The pure runtime
  interprets those plans as immutable state plus external events, returning new
  state plus requested actions. Performer selection and context lineage remain
  independent semantic requirements; no infrastructure side effects occur in
  this application.
  """

  alias QuestEngineering.Core.Compiler

  @doc "Compiles a semantic tactic into a static execution specification."
  defdelegate compile(tactic), to: Compiler
end
