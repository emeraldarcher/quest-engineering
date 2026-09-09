defmodule QuestEngineering.Core.Tactics do
  @moduledoc """
  Plain-data builders for human-authored semantic tactics.

  Artifact kinds, local slot names, exact binding references, and acceptance
  gates are separate values. Artifact kinds remain open strings; atoms are
  reserved for closed internal discriminators.
  """

  alias QuestEngineering.Core.Tactics.ArtifactField
  alias QuestEngineering.Core.Tactics.ArtifactInput
  alias QuestEngineering.Core.Tactics.ArtifactOutput
  alias QuestEngineering.Core.Tactics.ArtifactRef
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.ReviewContract
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @type t :: Step.t() | Sequence.t() | Parallel.t() | Until.t()

  @spec step(String.t(), keyword()) :: Step.t()
  def step(key, options) when is_list(options) do
    %Step{
      key: key,
      name: Keyword.get(options, :name),
      instruction: Keyword.get(options, :instruction),
      performer: Keyword.get(options, :performer),
      context: Keyword.get(options, :context, fresh()),
      consumes: Keyword.get(options, :consumes, []),
      produces: Keyword.get(options, :produces, [])
    }
  end

  @spec sequence([t()]) :: Sequence.t()
  def sequence(children), do: %Sequence{children: children}

  @spec parallel([t()]) :: Parallel.t()
  def parallel(children), do: %Parallel{children: children}

  @spec until(keyword()) :: Until.t()
  def until(options) when is_list(options) do
    %Until{
      check: Keyword.get(options, :check),
      condition: Keyword.get(options, :condition),
      otherwise: Keyword.get(options, :otherwise),
      max_remediations: Keyword.get(options, :max_remediations)
    }
  end

  @spec class(String.t()) :: PerformerRequirement.t()
  def class(class), do: %PerformerRequirement{selector: :class, value: class}

  @spec same_as(String.t()) :: PerformerRequirement.t()
  def same_as(step_key), do: %PerformerRequirement{selector: :same_as, value: step_key}

  @spec fresh() :: ContextRequirement.t()
  def fresh, do: %ContextRequirement{selector: :fresh, value: nil}

  @spec continue_from(String.t()) :: ContextRequirement.t()
  def continue_from(step_key),
    do: %ContextRequirement{selector: :continue_from, value: step_key}

  @doc "References one exact named output."
  @spec ref(String.t(), String.t()) :: ArtifactRef.t()
  def ref(producer, output), do: %ArtifactRef{producer: producer, output: output}

  @doc "Declares a named Step input. Optional inputs are omitted when their source is absent."
  @spec input(String.t(), String.t(), keyword()) :: ArtifactInput.t()
  def input(name, kind, options \\ []) do
    %ArtifactInput{
      name: name,
      kind: kind,
      source: Keyword.get(options, :from),
      required: Keyword.get(options, :required, true)
    }
  end

  @doc "Declares a named Step output."
  @spec output(String.t(), String.t(), keyword()) :: ArtifactOutput.t()
  def output(name, kind, options \\ []) do
    %ArtifactOutput{name: name, kind: kind, review: Keyword.get(options, :review)}
  end

  @doc "Scopes a Review Verdict to an explicit gate and exact Step input."
  @spec review(String.t(), String.t()) :: ReviewContract.t()
  def review(gate_key, subject_input),
    do: %ReviewContract{gate_key: gate_key, subject_input: subject_input}

  @spec field(ArtifactRef.t(), String.t()) :: ArtifactField.t()
  def field(%ArtifactRef{} = source, field), do: %ArtifactField{source: source, field: field}

  @spec equals(ArtifactField.t(), Condition.literal()) :: Condition.t()
  def equals(%ArtifactField{} = left, value) do
    %Condition{source: left.source, field: left.field, operator: :equals, value: value}
  end
end
