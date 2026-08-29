defmodule QuestEngineering.Server.Scheduler do
  @moduledoc "Best-effort wakeup loop over the PostgreSQL-authoritative scheduler."

  use GenServer

  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.SchedulingStore

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def wake(run_id) when is_binary(run_id) do
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, {:wake, run_id})
    :ok
  end

  def wake_all do
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, :wake_all)
    :ok
  end

  @impl true
  def init(options),
    do:
      {:ok,
       %{claim_owner: Keyword.get(options, :claim_owner, "scheduler"), pending: MapSet.new()}}

  @impl true
  def handle_cast({:wake, run_id}, state) do
    send(self(), {:schedule, run_id})
    {:noreply, %{state | pending: MapSet.put(state.pending, run_id)}}
  end

  def handle_cast(:wake_all, state) do
    Enum.each(Repo.all(QuestLaunch), &send(self(), {:schedule, &1.run_id}))
    {:noreply, state}
  end

  @impl true
  def handle_info({:schedule, run_id}, state) do
    next_state = %{state | pending: MapSet.delete(state.pending, run_id)}

    case SchedulingStore.schedule_next(run_id, claim_owner: state.claim_owner) do
      {:ok, dispatch} ->
        _result = Dispatcher.deliver(dispatch)
        send(self(), {:schedule, run_id})
        {:noreply, %{next_state | pending: MapSet.put(next_state.pending, run_id)}}

      {:waiting, _reasons} ->
        {:noreply, next_state}

      {:error, _error} ->
        {:noreply, next_state}
    end
  end
end
