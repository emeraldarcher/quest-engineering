defmodule QuestEngineering.Core.ReviewVerdict do
  @moduledoc """
  Provider-neutral machine-readable review verdict contract.

  Review execution and review acceptance are intentionally separate. A
  successfully completed review Step satisfies an acceptance gate only when its
  `verdict` artifact has the exact structured status `"accepted"`.
  """

  @type status :: String.t()
  @type t :: %{required(String.t()) => term()}

  @spec status(term()) :: {:ok, status()} | {:error, :invalid_review_verdict}
  def status(%{"status" => status}) when status in ~w(accepted rejected), do: {:ok, status}
  def status(_value), do: {:error, :invalid_review_verdict}

  @spec accepted?(term()) :: boolean()
  def accepted?(value), do: status(value) == {:ok, "accepted"}
end
