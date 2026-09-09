defmodule QuestEngineering.Core.ReviewVerdict do
  @moduledoc "A generic exact-subject decision for one explicit semantic acceptance gate."

  @kind "review_verdict"
  @type status :: String.t()
  @type t :: %{required(String.t()) => term()}

  @spec kind() :: String.t()
  def kind, do: @kind

  @spec status(term()) :: {:ok, status()} | {:error, :invalid_review_verdict}
  def status(%{"status" => status}) when status in ~w(accepted rejected), do: {:ok, status}
  def status(_), do: {:error, :invalid_review_verdict}

  @spec accepted?(term()) :: boolean()
  def accepted?(value), do: status(value) == {:ok, "accepted"}

  @spec scope(term(), String.t(), String.t(), String.t()) :: term()
  def scope(value, gate_key, subject_kind, subject_artifact_id)
      when is_map(value) and is_binary(gate_key) and is_binary(subject_kind) and
             is_binary(subject_artifact_id) do
    value
    |> Map.put_new("gate_key", gate_key)
    |> Map.put_new("subject_kind", subject_kind)
    |> Map.put_new("subject_artifact_id", subject_artifact_id)
  end

  def scope(value, _, _, _), do: value

  @spec valid?(term()) :: boolean()
  def valid?(value), do: match?({:ok, _}, status(value)) and valid_scope?(value)

  @spec accepted_for?(term(), String.t(), String.t(), String.t()) :: boolean()
  def accepted_for?(value, gate_key, subject_kind, subject_artifact_id),
    do:
      accepted?(value) and value["gate_key"] == gate_key and value["subject_kind"] == subject_kind and
        value["subject_artifact_id"] == subject_artifact_id

  defp valid_scope?(%{"gate_key" => gate, "subject_kind" => kind, "subject_artifact_id" => id}),
    do:
      is_binary(gate) and gate != "" and is_binary(kind) and kind != "" and is_binary(id) and
        id != ""

  defp valid_scope?(_), do: false
end
