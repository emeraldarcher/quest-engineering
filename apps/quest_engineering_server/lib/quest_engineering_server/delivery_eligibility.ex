defmodule QuestEngineering.Server.DeliveryEligibility do
  @moduledoc """
  Server-side semantic acceptance gate for post-Run Delivery.

  A Tactic declares review gating by producing a `verdict` artifact. Such a Run
  is eligible only when the latest completed verdict-producing semantic
  occurrence emitted a valid structured accepted verdict.
  """

  alias QuestEngineering.Core.ReviewVerdict
  alias QuestEngineering.Core.Runtime.Run
  alias QuestEngineering.Server.RuntimeStore

  @type status :: :not_required | :accepted | :rejected | :missing | :invalid
  @type assessment :: %{
          required: boolean(),
          status: status(),
          occurrence_id: String.t() | nil,
          attempt_id: String.t() | nil,
          artifact_id: String.t() | nil
        }

  @spec assess(Run.t()) :: assessment()
  def assess(%Run{} = run) do
    review_keys =
      run.plan.steps
      |> Enum.filter(&("verdict" in &1.produces))
      |> MapSet.new(& &1.key)

    if MapSet.size(review_keys) == 0 do
      assessment(false, :not_required)
    else
      assess_latest_verdict(run, review_keys)
    end
  end

  @spec check(String.t()) :: {:ok, assessment()} | {:error, assessment() | term()}
  def check(run_id) when is_binary(run_id) do
    with {:ok, %{run: run}} <- RuntimeStore.fetch_run(run_id) do
      check(run)
    end
  end

  @spec check(Run.t()) :: {:ok, assessment()} | {:error, assessment()}
  def check(%Run{status: :completed} = run) do
    case assess(run) do
      %{status: status} = value when status in [:not_required, :accepted] -> {:ok, value}
      value -> {:error, value}
    end
  end

  def check(%Run{} = run), do: {:error, assess(run)}

  @spec issue(assessment()) :: %{code: String.t(), message: String.t(), details: map()}
  def issue(%{status: :rejected} = value) do
    %{
      code: "acceptance_not_satisfied",
      message: "The latest completed review rejected the implementation.",
      details: details(value)
    }
  end

  def issue(%{status: :invalid} = value) do
    %{
      code: "acceptance_not_satisfied",
      message: "The latest completed review did not produce a valid structured verdict.",
      details: details(value)
    }
  end

  def issue(value) do
    %{
      code: "acceptance_not_satisfied",
      message: "Required semantic review acceptance was not produced.",
      details: details(value)
    }
  end

  defp assess_latest_verdict(run, review_keys) do
    occurrence =
      run.occurrence_order
      |> Enum.reverse()
      |> Enum.map(&Map.get(run.occurrences, &1))
      |> Enum.find(fn
        nil ->
          false

        value ->
          MapSet.member?(review_keys, value.semantic_step_key) and
            Map.has_key?(value.output_artifact_ids, "verdict")
      end)

    case occurrence do
      nil ->
        assessment(true, :missing)

      occurrence ->
        artifact_id = Map.fetch!(occurrence.output_artifact_ids, "verdict")
        artifact = Map.get(run.artifacts, artifact_id)

        status =
          case artifact && ReviewVerdict.status(artifact.value) do
            {:ok, "accepted"} -> :accepted
            {:ok, "rejected"} -> :rejected
            _ -> :invalid
          end

        assessment(true, status, occurrence.current_attempt_id, occurrence.id, artifact_id)
    end
  end

  defp assessment(required, status, attempt_id \\ nil, occurrence_id \\ nil, artifact_id \\ nil) do
    %{
      required: required,
      status: status,
      occurrence_id: occurrence_id,
      attempt_id: attempt_id,
      artifact_id: artifact_id
    }
  end

  defp details(value) do
    value
    |> Map.take([:status, :occurrence_id, :attempt_id])
    |> Map.update!(:status, &Atom.to_string/1)
  end
end
