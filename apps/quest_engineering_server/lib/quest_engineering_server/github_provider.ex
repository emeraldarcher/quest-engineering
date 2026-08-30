defmodule QuestEngineering.Server.GitHubProvider do
  @moduledoc "GitHub Pull Request provider boundary."
  @callback preflight(map()) :: {:ok, map()} | {:error, map()}
  @callback find_by_head(map()) :: {:ok, nil | map()} | {:error, map()}
  @callback create(map(), String.t(), String.t()) :: {:ok, map()} | {:error, map()}
  @callback inspect(map()) :: {:ok, map()} | {:error, map()}
end

defmodule QuestEngineering.Server.GitHubCliCommand do
  @moduledoc false

  def run(args) do
    task =
      Task.async(fn ->
        try do
          case System.cmd("gh", args,
                 env: [{"GH_PROMPT_DISABLED", "1"}, {"GIT_TERMINAL_PROMPT", "0"}],
                 stderr_to_stdout: true
               ) do
            {output, 0} ->
              {:ok, output}

            {_output, code} ->
              {:error, %{code: "github_cli_failed", details: %{exit_code: code}}}
          end
        rescue
          error in ErlangError ->
            {:error,
             %{
               code: "github_cli_unavailable",
               details: %{
                 message:
                   if(String.contains?(Exception.message(error), "executable"),
                     do: "GitHub CLI is unavailable.",
                     else: "GitHub CLI could not start."
                   )
               }
             }}
        end
      end)

    case Task.yield(task, 30_000) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      _ -> {:error, %{code: "github_cli_timeout", details: %{}}}
    end
  end
end

defmodule QuestEngineering.Server.GitHubCliProvider do
  @moduledoc "Exact-argv gh CLI adapter; tokens and process environment never enter Product state."
  import Kernel, except: [inspect: 1]
  @behaviour QuestEngineering.Server.GitHubProvider

  @impl true
  def preflight(delivery) do
    with :ok <- same_repository(delivery),
         {:ok, _} <-
           command([
             "auth",
             "status",
             "--active",
             "--hostname",
             delivery.repository_host || "github.com"
           ]),
         {:ok, json} <-
           command([
             "repo",
             "view",
             delivery.repository_identity,
             "--json",
             "nameWithOwner,url,viewerPermission,defaultBranchRef"
           ]),
         {:ok, value} <- decode(json),
         :ok <-
           require_equal(
             value["nameWithOwner"],
             delivery.repository_identity,
             "repository_identity_mismatch"
           ),
         :ok <- require_write(value["viewerPermission"]) do
      :ok
    else
      {:error, _} = error -> error
    end
  end

  @impl true
  def find_by_head(delivery) do
    with {:ok, output} <-
           command([
             "pr",
             "list",
             "--repo",
             delivery.repository_identity,
             "--head",
             delivery.branch_name,
             "--state",
             "all",
             "--limit",
             "20",
             "--json",
             "number"
           ]),
         {:ok, values} when is_list(values) <- decode(output) do
      case values do
        [] -> {:ok, nil}
        [%{"number" => number}] -> inspect(Map.put(delivery, :pull_request_number, number))
        _ -> failure("pull_request_lookup_ambiguous")
      end
    else
      {:error, _} = error -> error
      _ -> failure("pull_request_lookup_invalid")
    end
  end

  @impl true
  def create(delivery, title, body) do
    with :ok <- same_repository(delivery) do
      create_result =
        command([
          "pr",
          "create",
          "--repo",
          delivery.repository_identity,
          "--base",
          delivery.base_branch_name,
          "--head",
          delivery.branch_name,
          "--title",
          title,
          "--body",
          body
        ])

      case {find_by_head(delivery), create_result} do
        {{:ok, metadata}, _} when not is_nil(metadata) ->
          {:ok, metadata}

        {{:ok, nil}, {:ok, _}} ->
          failure("pull_request_not_found_after_create")

        {{:ok, nil}, create_error} ->
          create_error

        {{:error, _} = lookup_error, {:ok, _}} ->
          lookup_error

        {{:error, _}, create_error} ->
          create_error
      end
    end
  end

  @impl true
  def inspect(delivery) do
    with {:ok, output} <-
           command([
             "pr",
             "view",
             to_string(delivery.pull_request_number),
             "--repo",
             delivery.repository_identity,
             "--json",
             "number,url,state,mergedAt,baseRefName,headRefName,headRefOid,headRepository"
           ]),
         {:ok, value} <- decode(output) do
      {:ok, metadata(delivery.repository_identity, value)}
    end
  end

  defp metadata(repository, value) do
    raw_state = String.downcase(value["state"] || "")
    state = if value["mergedAt"], do: "merged", else: raw_state
    head_repository = value["headRepository"] || %{}

    %{
      number: value["number"],
      url: value["url"],
      state: state,
      merged_at: parse_time(value["mergedAt"]),
      repository_identity: normalize(repository),
      base_branch: value["baseRefName"],
      head_repository_identity: normalize(head_repository["nameWithOwner"]),
      head_branch: value["headRefName"],
      head_revision: value["headRefOid"]
    }
  end

  defp same_repository(delivery) do
    if normalize(delivery.repository_identity) ==
         normalize(Map.get(delivery, :base_repository_identity, delivery.repository_identity)),
       do: :ok,
       else: failure("cross_repository_pull_request_not_supported")
  end

  defp command(args) do
    Application.get_env(
      :quest_engineering_server,
      :github_command_runner,
      QuestEngineering.Server.GitHubCliCommand
    ).run(args)
  end

  defp decode(value) do
    case Jason.decode(value) do
      {:ok, decoded} -> {:ok, decoded}
      _ -> failure("github_response_invalid")
    end
  end

  defp require_equal(left, right, code),
    do: if(normalize(left) == normalize(right), do: :ok, else: failure(code))

  defp require_write(permission),
    do:
      if(permission in ["ADMIN", "MAINTAIN", "WRITE"],
        do: :ok,
        else: failure("repository_not_writable")
      )

  defp failure(code), do: {:error, %{code: code, details: %{}}}
  defp normalize(nil), do: nil
  defp normalize(value), do: value |> String.trim() |> String.downcase()
  defp parse_time(nil), do: nil

  defp parse_time(value) do
    case DateTime.from_iso8601(value) do
      {:ok, time, _} -> %{time | microsecond: {elem(time.microsecond, 0), 6}}
      _ -> nil
    end
  end
end
