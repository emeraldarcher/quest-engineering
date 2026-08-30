defmodule QuestEngineering.Server.DeliveryIdentityTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Persistence.RunDelivery

  @head String.duplicate("a", 40)

  test "ordinary unchanged Pull Request merge retains exact Delivery identity" do
    assert :ok = DeliveryStore.verify_review_identity(delivery(), metadata())
  end

  test "head branch externally advanced is rejected" do
    assert {:error, [%{field: :head_revision}]} =
             DeliveryStore.verify_review_identity(
               delivery(),
               metadata(head_revision: String.duplicate("b", 40))
             )
  end

  test "head branch force-modified is rejected by the exact published OID" do
    assert {:error, mismatches} =
             DeliveryStore.verify_review_identity(
               delivery(),
               metadata(head_revision: String.duplicate("f", 40))
             )

    assert Enum.map(mismatches, & &1.field) == [:head_revision]
  end

  test "changed Pull Request base branch is rejected" do
    assert {:error, [%{field: :base_branch}]} =
             DeliveryStore.verify_review_identity(delivery(), metadata(base_branch: "release"))
  end

  test "repository and head-repository mismatch are rejected" do
    assert {:error, mismatches} =
             DeliveryStore.verify_review_identity(
               delivery(),
               metadata(repository_identity: "other/repo", head_repository_identity: "fork/repo")
             )

    assert Enum.map(mismatches, & &1.field) == [:repository, :head_repository]
  end

  defp delivery do
    %RunDelivery{
      repository_identity: "owner/repo",
      base_branch_name: "main",
      branch_name: "qe/run/0123456789abcdef0123456789abcdef",
      head_revision: @head
    }
  end

  defp metadata(overrides \\ []) do
    Map.merge(
      %{
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        repository_identity: "owner/repo",
        base_branch: "main",
        head_repository_identity: "owner/repo",
        head_branch: "qe/run/0123456789abcdef0123456789abcdef",
        head_revision: @head,
        state: "merged"
      },
      Map.new(overrides)
    )
  end
end
