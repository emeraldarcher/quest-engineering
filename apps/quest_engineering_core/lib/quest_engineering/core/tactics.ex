defmodule QuestEngineering.Core.Tactics do
  @moduledoc """
  Plain-data builders for human-authored semantic tactics.

  Open-ended domain identities (step keys, performer classes, artifact types,
  and artifact sources) are strings. Atoms are reserved for closed internal
  discriminators such as `:class`, `:same_as`, `:fresh`, `:continue_from`,
  and `:equals`. Performer selection and context lineage are independent.
  """

  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.ArtifactField
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @type t :: Step.t() | Sequence.t() | Parallel.t() | Until.t()

  @doc "Creates a semantic step. String artifact declarations become typed data."
  @spec step(String.t(), keyword()) :: Step.t()
  def step(key, options) when is_list(options) do
    %Step{
      key: key,
      name: Keyword.get(options, :name),
      instruction: Keyword.get(options, :instruction),
      performer: Keyword.get(options, :performer),
      context: Keyword.get(options, :context, fresh()),
      consumes: normalize_artifacts(Keyword.get(options, :consumes, [])),
      produces: normalize_artifacts(Keyword.get(options, :produces, []))
    }
  end

  @doc "Creates ordered semantic composition."
  @spec sequence([t()]) :: Sequence.t()
  def sequence(children), do: %Sequence{children: children}

  @doc "Creates concurrent semantic composition with all-children completion semantics."
  @spec parallel([t()]) :: Parallel.t()
  def parallel(children), do: %Parallel{children: children}

  @doc "Creates check-first bounded outcome-driven control."
  @spec until(keyword()) :: Until.t()
  def until(options) when is_list(options) do
    %Until{
      check: Keyword.get(options, :check),
      condition: Keyword.get(options, :condition),
      otherwise: Keyword.get(options, :otherwise),
      max_remediations: Keyword.get(options, :max_remediations)
    }
  end

  @doc "Requires a performer belonging to the given semantic class."
  @spec class(String.t()) :: PerformerRequirement.t()
  def class(class), do: %PerformerRequirement{selector: :class, value: class}

  @doc "Requires the member who performed the referenced semantic step."
  @spec same_as(String.t()) :: PerformerRequirement.t()
  def same_as(step_key), do: %PerformerRequirement{selector: :same_as, value: step_key}

  @doc "Requests no inherited reasoning or conversation lineage for each execution."
  @spec fresh() :: ContextRequirement.t()
  def fresh, do: %ContextRequirement{selector: :fresh, value: nil}

  @doc "Continues the context lineage established by the referenced semantic step."
  @spec continue_from(String.t()) :: ContextRequirement.t()
  def continue_from(step_key) do
    %ContextRequirement{selector: :continue_from, value: step_key}
  end

  @doc "Creates a typed artifact declaration with an optional semantic source."
  @spec artifact(String.t(), keyword()) :: Artifact.t()
  def artifact(type, options \\ []) do
    %Artifact{type: type, source: Keyword.get(options, :from)}
  end

  @doc "References a named field on an artifact for condition construction."
  @spec field(Artifact.t(), String.t()) :: ArtifactField.t()
  def field(%Artifact{} = artifact, field), do: %ArtifactField{artifact: artifact, field: field}

  @doc "Creates the v0.2 artifact-field-equals-literal condition."
  @spec equals(ArtifactField.t(), Condition.literal()) :: Condition.t()
  def equals(%ArtifactField{} = left, value) do
    %Condition{
      artifact: left.artifact,
      field: left.field,
      operator: :equals,
      value: value
    }
  end

  defp normalize_artifacts(artifacts) when is_list(artifacts) do
    Enum.map(artifacts, fn
      %Artifact{} = artifact -> artifact
      type when is_binary(type) -> artifact(type)
      invalid -> invalid
    end)
  end

  defp normalize_artifacts(invalid), do: invalid
end
