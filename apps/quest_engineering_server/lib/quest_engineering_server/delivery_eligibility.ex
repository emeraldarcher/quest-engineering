defmodule QuestEngineering.Server.DeliveryEligibility do
  @moduledoc "Delivery requires exact implementation acceptance of the exact Change Set being published."

  alias QuestEngineering.Core.ReviewVerdict
  alias QuestEngineering.Core.Runtime.Run
  alias QuestEngineering.Server.RuntimeStore

  @publication_subject "change_set"
  @publication_gate "implementation_acceptance"
  @type status :: :not_required | :accepted | :rejected | :missing | :invalid

  @spec assess(Run.t()) :: map()
  def assess(%Run{} = run) do
    contracts = implementation_contracts(run)

    change_set_work? =
      Enum.any?(run.plan.steps, fn step ->
        Enum.any?(step.produces, &(&1.kind == @publication_subject))
      end)

    cond do
      not change_set_work? -> assessment(false, :not_required)
      contracts == [] -> assessment(true, :missing)
      true -> assess_latest(run, contracts)
    end
  end

  def check(run_id) when is_binary(run_id) do
    with {:ok, %{run: run}} <- RuntimeStore.fetch_run(run_id), do: check(run)
  end

  def check(%Run{status: :completed} = run) do
    case assess(run) do
      %{status: status} = value when status in [:not_required, :accepted] -> {:ok, value}
      value -> {:error, value}
    end
  end

  def check(%Run{} = run), do: {:error, assess(run)}

  def issue(%{status: :rejected} = value),
    do: %{
      code: "acceptance_not_satisfied",
      message: "The exact Change Set required for Delivery was rejected.",
      details: details(value)
    }

  def issue(%{status: :invalid} = value),
    do: %{
      code: "acceptance_not_satisfied",
      message:
        "The Review Verdict did not match the exact Change Set and Implementation Acceptance gate.",
      details: details(value)
    }

  def issue(value),
    do: %{
      code: "acceptance_not_satisfied",
      message: "Implementation Acceptance for the exact Change Set was not produced.",
      details: details(value)
    }

  defp implementation_contracts(run) do
    run.plan.steps
    |> Enum.flat_map(fn step ->
      Enum.flat_map(step.produces, fn
        %{
          name: output,
          kind: "review_verdict",
          review: %{gate_key: @publication_gate, subject_input: input}
        } ->
          [%{step: step.key, output: output, subject_input: input}]

        _ ->
          []
      end)
    end)
  end

  defp assess_latest(run, contracts) do
    occurrence =
      run.occurrence_order
      |> Enum.reverse()
      |> Enum.map(&Map.get(run.occurrences, &1))
      |> Enum.find(fn
        nil ->
          false

        value ->
          Enum.any?(
            contracts,
            &(&1.step == value.semantic_step_key and
                Map.has_key?(value.output_artifact_ids, &1.output))
          )
      end)

    case occurrence do
      nil ->
        assessment(true, :missing)

      occurrence ->
        contract =
          Enum.find(
            contracts,
            &(&1.step == occurrence.semantic_step_key and
                Map.has_key?(occurrence.output_artifact_ids, &1.output))
          )

        artifact_id = Map.fetch!(occurrence.output_artifact_ids, contract.output)
        subject_id = Map.get(occurrence.input_artifact_ids, contract.subject_input)
        artifact = Map.get(run.artifacts, artifact_id)
        status = verdict_status(artifact, subject_id)
        assessment(true, status, occurrence.current_attempt_id, occurrence.id, artifact_id)
    end
  end

  defp verdict_status(%{kind: "review_verdict", value: value}, subject_id) do
    cond do
      ReviewVerdict.accepted_for?(value, @publication_gate, @publication_subject, subject_id) ->
        :accepted

      ReviewVerdict.status(value) == {:ok, "rejected"} and value["gate_key"] == @publication_gate and
        value["subject_kind"] == @publication_subject and
          value["subject_artifact_id"] == subject_id ->
        :rejected

      true ->
        :invalid
    end
  end

  defp verdict_status(_, _), do: :invalid

  defp assessment(required, status, attempt_id \\ nil, occurrence_id \\ nil, artifact_id \\ nil),
    do: %{
      required: required,
      status: status,
      occurrence_id: occurrence_id,
      attempt_id: attempt_id,
      artifact_id: artifact_id
    }

  defp details(value),
    do:
      value
      |> Map.take([:status, :occurrence_id, :attempt_id])
      |> Map.update!(:status, &Atom.to_string/1)
end
