defmodule QuestEngineering.Server.Dispatcher do
  @moduledoc "Claims and sends Actions only to an explicitly named Worker."

  use GenServer

  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def dispatch(worker_id, options \\ []),
    do: GenServer.call(__MODULE__, {:dispatch, worker_id, options}, 10_000)

  def redeliver(worker_id, generation),
    do: GenServer.call(__MODULE__, {:redeliver, worker_id, generation}, 10_000)

  @impl true
  def init(options) do
    {:ok, %{claim_owner: Keyword.fetch!(options, :claim_owner)}}
  end

  @impl true
  def handle_call({:dispatch, worker_id, options}, _from, state) do
    result =
      with {:ok, %{generation: generation}} <- WorkerConnections.lookup(worker_id),
           {:ok, dispatch} <-
             DispatchStore.claim_next(worker_id, state.claim_owner, options),
           :ok <- send_execute(worker_id, generation, dispatch) do
        DispatchStore.mark_dispatched(dispatch.action_id, dispatch.claim_token, generation)
      end

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
    with :ok <- send_execute(worker_id, generation, dispatch) do
      DispatchStore.mark_dispatched(dispatch.action_id, dispatch.claim_token, generation)
    end
  end

  defp send_execute(worker_id, generation, dispatch) do
    message = WorkerProtocol.execute_action(worker_id, dispatch.action)
    WorkerConnections.send_protocol(worker_id, generation, message)
  end
end
