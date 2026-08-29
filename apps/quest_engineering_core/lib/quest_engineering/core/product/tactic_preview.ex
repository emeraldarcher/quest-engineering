defmodule QuestEngineering.Core.Product.TacticPreview.Error do
  @moduledoc "A stage-labelled Tactic preview failure."

  @enforce_keys [:stage, :errors, :step_origins]
  defstruct [:stage, :errors, :step_origins]

  @type t :: %__MODULE__{
          stage: :definition | :resolution | :compilation,
          errors: [term()],
          step_origins: map()
        }
end

defmodule QuestEngineering.Core.Product.TacticPreview.Result do
  @moduledoc "Resolved and compiled data produced without launching a Quest."

  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Product.TacticProvenance
  alias QuestEngineering.Core.Tactics

  @enforce_keys [:resolved_tactic, :execution_plan, :provenance, :step_origins]
  defstruct [:resolved_tactic, :execution_plan, :provenance, :step_origins]

  @type t :: %__MODULE__{
          resolved_tactic: Tactics.t(),
          execution_plan: ExecutionPlan.t(),
          provenance: TacticProvenance.t(),
          step_origins: map()
        }
end

defmodule QuestEngineering.Core.Product.TacticPreview do
  @moduledoc "Pure resolution and compilation for authoring preview."

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Product.TacticPreview.Error
  alias QuestEngineering.Core.Product.TacticPreview.Result
  alias QuestEngineering.Core.Product.TacticResolver
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.TacticResolver.Limits

  @spec preview(term(), Catalog.t(), Limits.t()) :: {:ok, Result.t()} | {:error, Error.t()}
  def preview(source, catalog, limits \\ Limits.defaults()) do
    case TacticResolver.resolve(source, catalog, limits) do
      {:ok, resolution} -> compile(resolution)
      {:error, errors} -> {:error, %Error{stage: :resolution, errors: errors, step_origins: %{}}}
    end
  end

  defp compile(resolution) do
    case Compiler.compile(resolution.tactic) do
      {:ok, plan} ->
        {:ok,
         %Result{
           resolved_tactic: resolution.tactic,
           execution_plan: plan,
           provenance: resolution.provenance,
           step_origins: resolution.step_origins
         }}

      {:error, errors} ->
        {:error,
         %Error{
           stage: :compilation,
           errors: errors,
           step_origins: resolution.step_origins
         }}
    end
  end
end
