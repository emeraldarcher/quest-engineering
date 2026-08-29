defmodule QuestEngineering.Server.Dispatcher do
  @moduledoc "Sends already-scheduled executions to their transactionally selected Worker."

  use GenServer

  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def deliver(dispatch), do: GenServer.call(__MODULE__, {:deliver, dispatch}, 10_000)

  def redeliver(worker_id, generation),
    do: GenServer.call(__MODULE__, {:redeliver, worker_id, generation}, 10_000)

  @impl true
  def init(_options), do: {:ok, %{}}

  @impl true
  def handle_call({:deliver, dispatch}, _from, state) do
    result =
      with {:ok, %{generation: generation}} <- WorkerConnections.lookup(dispatch.worker_id),
           :ok <- send_execute(dispatch.worker_id, generation, dispatch.execution) do
        DispatchStore.mark_dispatched(dispatch.action_id, dispatch.claim_token, generation)
      end

    if match?({:ok, _}, result), do: RunChangeNotifier.notify(dispatch.run_id)
    {:reply, result, state}
  end

  def handle_call({:redeliver, worker_id, generation}, _from, state) do
    result =
      case DispatchStore.redeliverable_for_worker(worker_id) do
        {:ok, dispatches} -> redeliver_all(dispatches, worker_id, generation)
        {:error, error} -> {:error, error}
      end

    {:reply, result, state}
  end

  defp redeliver_all(dispatches, worker_id, generation) do
    Enum.reduce_while(dispatches, {:ok, []}, fn dispatch, {:ok, sent} ->
      case redeliver_one(dispatch, worker_id, generation) do
        {:ok, updated} -> {:cont, {:ok, sent ++ [updated]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp redeliver_one(dispatch, worker_id, generation) do
    with {:ok, %{scheduled: scheduled, execution: execution}} <-
           SchedulingStore.fetch_execution(dispatch.action_id),
         :ok <- send_execute(worker_id, generation, execution),
         {:ok, updated} <-
           DispatchStore.mark_dispatched(dispatch.action_id, dispatch.claim_token, generation) do
      RunChangeNotifier.notify(scheduled.run_id)
      {:ok, updated}
    end
  end

  defp send_execute(worker_id, generation, execution) do
    message = WorkerProtocol.execute_action(worker_id, execution)
    WorkerConnections.send_protocol(worker_id, generation, message)
  end
end
