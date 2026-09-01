defmodule QuestEngineering.Server.DeliveryCoordinatorTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Server.DeliveryCoordinator

  defmodule SuccessfulProvider do
    def preflight(_delivery), do: :ok
  end

  defmodule FailingProvider do
    def preflight(_delivery),
      do: {:error, %{code: "github_cli_timeout", details: %{}}}
  end

  defmodule InvalidProvider do
    def preflight(_delivery), do: {:ok, %{}}
  end

  test "a successful GitHub preflight continues to publication" do
    assert :published =
             DeliveryCoordinator.run_after_preflight(SuccessfulProvider, %{}, fn -> :published end)
  end

  test "a provider failure does not continue to publication" do
    assert {:error, %{code: "github_cli_timeout", details: %{}}} =
             DeliveryCoordinator.run_after_preflight(FailingProvider, %{}, fn ->
               flunk("publication must not run")
             end)
  end

  test "an unexpected provider result becomes a recoverable contract failure" do
    assert {:error,
            %{
              code: "github_provider_contract_invalid",
              details: %{received: "{ok, _}"}
            }} =
             DeliveryCoordinator.run_after_preflight(InvalidProvider, %{}, fn ->
               flunk("publication must not run")
             end)
  end
end
