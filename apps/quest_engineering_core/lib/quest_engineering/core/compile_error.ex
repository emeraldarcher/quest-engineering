defmodule QuestEngineering.Core.CompileError do
  @moduledoc "Programmatically inspectable validation or compilation failure."

  @type error_type ::
          :duplicate_step_key
          | :missing_artifact
          | :ambiguous_artifact
          | :invalid_artifact_source
          | :duplicate_artifact_declaration
          | :invalid_structure
          | :invalid_performer_reference
          | :invalid_context_requirement
          | :invalid_context_reference
          | :invalid_until_structure
          | :invalid_until_limit
          | :invalid_condition
          | :invalid_condition_artifact
          | :ambiguous_condition_artifact
          | :invalid_carried_artifact
          | :ambiguous_carried_artifact

  @enforce_keys [:type]
  defstruct [
    :type,
    :step,
    :referenced_step,
    :artifact_type,
    :candidate_sources,
    :referenced_source,
    :region,
    :condition,
    :details
  ]

  @type t :: %__MODULE__{
          type: error_type(),
          step: String.t() | nil,
          referenced_step: String.t() | nil,
          artifact_type: String.t() | nil,
          candidate_sources: [term()] | nil,
          referenced_source: String.t() | nil,
          region: String.t() | nil,
          condition: term(),
          details: term()
        }

  @doc "Formats an error for logs or a human-facing interface."
  @spec message(t()) :: String.t()
  def message(%__MODULE__{type: :duplicate_step_key, step: step}) do
    "duplicate semantic step key #{inspect(step)}"
  end

  def message(%__MODULE__{type: :missing_artifact, step: step, artifact_type: type}) do
    "step #{inspect(step)} has no visible producer for artifact #{inspect(type)}"
  end

  def message(%__MODULE__{
        type: :ambiguous_artifact,
        step: step,
        artifact_type: type,
        candidate_sources: sources
      }) do
    "step #{inspect(step)} has ambiguous visible producers for #{inspect(type)}: #{inspect(sources)}"
  end

  def message(%__MODULE__{
        type: :invalid_artifact_source,
        step: step,
        artifact_type: type,
        referenced_source: source,
        details: reason
      }) do
    "step #{inspect(step)} cannot consume #{inspect(type)} from #{inspect(source)} (#{inspect(reason)})"
  end

  def message(%__MODULE__{
        type: :duplicate_artifact_declaration,
        step: step,
        artifact_type: type,
        details: direction
      }) do
    "step #{inspect(step)} declares #{inspect(type)} more than once in #{direction}"
  end

  def message(%__MODULE__{type: :invalid_performer_reference, step: step, details: details}) do
    "step #{inspect(step)} has an invalid same_as performer reference (#{inspect(details)})"
  end

  def message(%__MODULE__{type: :invalid_context_requirement, step: step, details: details}) do
    "step #{inspect(step)} has an invalid context requirement (#{inspect(details)})"
  end

  def message(%__MODULE__{
        type: :invalid_context_reference,
        step: step,
        referenced_step: referenced_step,
        details: details
      }) do
    "step #{inspect(step)} cannot continue context from #{inspect(referenced_step)} (#{inspect(details)})"
  end

  def message(%__MODULE__{type: type, region: region, details: details})
      when type in [
             :invalid_until_structure,
             :invalid_until_limit,
             :invalid_condition,
             :invalid_condition_artifact,
             :ambiguous_condition_artifact,
             :invalid_carried_artifact,
             :ambiguous_carried_artifact
           ] do
    "#{type} in #{inspect(region)}: #{inspect(details)}"
  end

  def message(%__MODULE__{type: :invalid_structure, details: details}) do
    "invalid tactic structure: #{inspect(details)}"
  end
end
