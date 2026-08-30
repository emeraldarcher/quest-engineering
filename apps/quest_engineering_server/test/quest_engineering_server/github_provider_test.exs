defmodule QuestEngineering.Server.GitHubProviderTestRunner do
  @moduledoc false
  def run(args) do
    Agent.get_and_update(__MODULE__, fn %{responses: [response | rest]} = state ->
      {response, %{state | responses: rest, calls: state.calls ++ [args]}}
    end)
  end
end

defmodule QuestEngineering.Server.GitHubProviderTest do
  use ExUnit.Case, async: false

  alias QuestEngineering.Server.GitHubCliProvider
  alias QuestEngineering.Server.GitHubProviderTestRunner
  alias QuestEngineering.Server.Persistence.RunDelivery

  setup do
    previous = Application.get_env(:quest_engineering_server, :github_command_runner)
    agent = start_supervised!({Agent, fn -> %{responses: [], calls: []} end})
    Process.register(agent, GitHubProviderTestRunner)

    Application.put_env(
      :quest_engineering_server,
      :github_command_runner,
      GitHubProviderTestRunner
    )

    on_exit(fn ->
      if previous,
        do: Application.put_env(:quest_engineering_server, :github_command_runner, previous),
        else: Application.delete_env(:quest_engineering_server, :github_command_runner)
    end)

    :ok
  end

  test "preflight returns ok only for the exact writable repository" do
    responses = [
      {:ok, "authenticated"},
      {:ok,
       Jason.encode!(%{
         nameWithOwner: "owner/repo",
         url: "https://github.com/owner/repo",
         viewerPermission: "ADMIN",
         defaultBranchRef: %{name: "main"}
       })}
    ]

    Agent.update(GitHubProviderTestRunner, &%{&1 | responses: responses})
    assert :ok = GitHubCliProvider.preflight(delivery())

    assert [auth, repo] = Agent.get(GitHubProviderTestRunner, & &1.calls)
    assert auth == ["auth", "status", "--active", "--hostname", "github.com"]
    assert Enum.take(repo, 4) == ["repo", "view", "owner/repo", "--json"]
  end

  test "an uncertain create response rediscovers exactly one PR by its stable head branch" do
    responses = [
      {:error, %{code: "github_cli_failed", details: %{exit_code: 1}}},
      {:ok, Jason.encode!([%{number: 42}])},
      {:ok, Jason.encode!(provider_payload())},
      {:ok, Jason.encode!([%{number: 42}])},
      {:ok, Jason.encode!(provider_payload())}
    ]

    Agent.update(GitHubProviderTestRunner, &%{&1 | responses: responses})

    assert {:ok, metadata} = GitHubCliProvider.create(delivery(), "Quest title", "body")
    assert metadata.number == 42
    assert metadata.head_revision == String.duplicate("a", 40)
    assert metadata.merged_at.microsecond == {0, 6}

    assert {:ok, rediscovered} = GitHubCliProvider.find_by_head(delivery())
    assert rediscovered.number == 42

    calls = Agent.get(GitHubProviderTestRunner, & &1.calls)
    assert Enum.count(calls, &(Enum.take(&1, 2) == ["pr", "create"])) == 1
    assert Enum.count(calls, &(Enum.take(&1, 2) == ["pr", "list"])) == 2
    assert Enum.all?(calls, &("--repo" in &1 and "owner/repo" in &1))
  end

  defp delivery do
    %RunDelivery{
      repository_host: "github.com",
      repository_identity: "owner/repo",
      base_branch_name: "main",
      branch_name: "qe/run/11111111111111111111111111111111",
      head_revision: String.duplicate("a", 40),
      pull_request_number: 42
    }
  end

  defp provider_payload do
    %{
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "MERGED",
      mergedAt: "2026-08-30T03:12:25Z",
      baseRefName: "main",
      headRefName: "qe/run/11111111111111111111111111111111",
      headRefOid: String.duplicate("a", 40),
      headRepository: %{nameWithOwner: "owner/repo"}
    }
  end
end
