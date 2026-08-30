defmodule QuestEngineering.Server.DeliveryCoordinator do
  @moduledoc "Durable post-Run Delivery wakeup and central GitHub reconciliation loop."
  use GenServer

  import Ecto.Query
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  @poll_ms 10_000

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def wake(run_id) do
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, {:wake, run_id})
    :ok
  end

  def wake_all do
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, :wake_all)
    :ok
  end

  @impl true
  def init(options) do
    DeliveryStore.ensure_latest_completed_runs()

    state = %{
      provider: Keyword.get(options, :provider, configured_provider()),
      pending: MapSet.new()
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl true
  def handle_cast({:wake, run_id}, state), do: schedule(run_id, state)

  def handle_cast(:wake_all, state) do
    Enum.each(DeliveryStore.list_reconcilable(), &send(self(), {:process, &1.run_id}))
    {:noreply, state}
  end

  @impl true
  def handle_info(:poll, state) do
    Enum.each(DeliveryStore.list_reconcilable(), &send(self(), {:process, &1.run_id}))
    Process.send_after(self(), :poll, @poll_ms)
    {:noreply, state}
  end

  def handle_info({:process, run_id}, state) do
    _result = process_delivery(DeliveryStore.fetch(run_id), state.provider)
    {:noreply, %{state | pending: MapSet.delete(state.pending, run_id)}}
  end

  defp schedule(run_id, state) do
    if MapSet.member?(state.pending, run_id) do
      {:noreply, state}
    else
      send(self(), {:process, run_id})
      {:noreply, %{state | pending: MapSet.put(state.pending, run_id)}}
    end
  end

  defp process_delivery(nil, _provider), do: :ok

  defp process_delivery(%{state: "pending"} = delivery, _provider) do
    with {:ok, assignment, worker} <- eligible(delivery),
         true <- not is_nil(assignment.retention_confirmed_at),
         {:ok, _} <- DeliveryStore.preparing(delivery.run_id),
         :ok <-
           send_message(
             worker,
             WorkerProtocol.inspect_run_delivery(worker.id, delivery, assignment)
           ) do
      :ok
    else
      false ->
        send_retention(delivery)

      {:error, :worker_upgrade_required} ->
        DeliveryStore.mark_attention(delivery.run_id, "eligibility", "worker_upgrade_required")

      _ ->
        :ok
    end
  end

  defp process_delivery(%{state: "preparing"} = delivery, _provider) do
    with {:ok, assignment, worker} <- eligible(delivery),
         :ok <-
           send_message(
             worker,
             WorkerProtocol.inspect_run_delivery(worker.id, delivery, assignment)
           ) do
      :ok
    else
      _ -> :ok
    end
  end

  defp process_delivery(%{state: "publishing"} = delivery, provider) do
    with {:ok, _} <- provider.preflight(delivery),
         {:ok, assignment, worker} <- eligible(delivery),
         message =
           WorkerProtocol.publish_run_delivery(worker.id, delivery, assignment)
           |> put_in(["delivery", "quest_title"], title(delivery)),
         :ok <- send_message(worker, message) do
      :ok
    else
      {:error, %{code: code, details: details}} ->
        DeliveryStore.mark_attention(delivery.run_id, "provider_preflight", code, details)
        :ok

      _ ->
        :ok
    end
  end

  defp process_delivery(%{state: "creating_review"} = delivery, provider) do
    result =
      with {:ok, existing} <- provider.find_by_head(delivery) do
        if existing,
          do: {:ok, existing},
          else: provider.create(delivery, title(delivery), body(delivery))
      end

    case result do
      {:ok, metadata} ->
        DeliveryStore.observe_review(delivery.id, metadata)
        :ok

      {:error, %{code: code, details: details}} ->
        DeliveryStore.mark_attention(delivery.run_id, "pull_request", code, details)
        :ok
    end
  end

  defp process_delivery(%{state: "review_open"} = delivery, provider) do
    case provider.inspect(delivery) do
      {:ok, metadata} ->
        DeliveryStore.observe_review(delivery.id, metadata)
        :ok

      {:error, _failure} ->
        :ok
    end
  end

  defp process_delivery(_delivery, _provider), do: :ok

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp eligible(delivery) do
    assignment = Repo.get(RunWorkspaceAssignment, delivery.run_id)
    worker = assignment && assignment.worker_id && Repo.get(Worker, assignment.worker_id)

    active =
      Repo.exists?(
        from execution in ScheduledActionExecution,
          where: execution.run_id == ^delivery.run_id and execution.state == "active"
      )

    action_ids =
      Repo.all(
        from execution in ScheduledActionExecution,
          where: execution.run_id == ^delivery.run_id,
          select: execution.action_id
      )

    uncertain =
      action_ids != [] and
        Repo.exists?(
          from dispatch in WorkerDispatch,
            where:
              dispatch.action_id in ^action_ids and
                dispatch.state in [
                  "claimed",
                  "dispatched",
                  "acknowledged",
                  "running",
                  "uncertain"
                ]
        )

    features = worker && (worker.capabilities["features"] || [])

    cond do
      is_nil(assignment) or assignment.state != "retained" -> {:error, :workspace_not_retained}
      is_nil(worker) or worker.status != "connected" -> {:error, :worker_offline}
      "run_delivery_v1" not in features -> {:error, :worker_upgrade_required}
      active or uncertain -> {:error, :execution_not_settled}
      true -> {:ok, assignment, worker}
    end
  end

  defp send_retention(delivery) do
    assignment = Repo.get(RunWorkspaceAssignment, delivery.run_id)
    worker = assignment && assignment.worker_id && Repo.get(Worker, assignment.worker_id)

    if worker && worker.status == "connected",
      do: send_message(worker, WorkerProtocol.retain_run_worktree(worker.id, assignment))

    :ok
  end

  defp send_message(worker, message),
    do: WorkerConnections.send_protocol(worker.id, worker.connection_generation, message)

  defp title(delivery) do
    quest = Repo.get!(ProductQuest, delivery.quest_id)

    quest.title
    |> String.replace(~r/[\r\n\x00-\x1f]+/, " ")
    |> String.trim()
    |> String.slice(0, 240)
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp body(delivery) do
    quest = Repo.get!(ProductQuest, delivery.quest_id)
    summary = get_in(delivery.change_evidence || %{}, ["summary"]) || %{}
    files = get_in(delivery.change_evidence || %{}, ["files"]) || []
    result_summary = change_set_summary(delivery.run_id)

    paths =
      files
      |> Enum.take(100)
      |> Enum.map_join("\n", fn value -> "- `#{String.replace(value["path"] || "", "`", "")}`" end)

    """
    ## Quest
    #{String.slice(quest.objective, 0, 4000)}

    ## Result
    #{result_summary}

    ## Changes
    #{summary["files_changed"] || 0} files · +#{summary["additions"] || 0} / -#{summary["deletions"] || 0}
    #{paths}

    ## Delivery
    Agent Tactic completed successfully.
    Base revision: #{String.slice(delivery.base_revision || "unknown", 0, 12)}

    ---
    Created by Quest Engineering
    """
  end

  defp change_set_summary(run_id) do
    with {:ok, %{run: run}} <- RuntimeStore.fetch_run(run_id),
         artifact when not is_nil(artifact) <-
           run.artifact_order
           |> Enum.reverse()
           |> Enum.map(&Map.get(run.artifacts, &1))
           |> Enum.find(&(&1.type == "change_set")),
         value when is_map(value) <- artifact.value,
         summary when is_binary(summary) <- value["summary"] || value[:summary] do
      String.slice(summary, 0, 2_000)
    else
      _ -> "Agent work completed successfully."
    end
  end

  defp configured_provider,
    do:
      Application.get_env(
        :quest_engineering_server,
        :github_provider,
        QuestEngineering.Server.GitHubCliProvider
      )
end
