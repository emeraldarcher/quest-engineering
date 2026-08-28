defmodule QuestEngineering.Server.WorkerConnections do
  @moduledoc "Ephemeral local routing for currently authoritative Worker channel processes."

  use GenServer

  alias QuestEngineering.Server.WorkerStore

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def activate(worker_id, connection_id, generation, pid) do
    GenServer.call(__MODULE__, {:activate, worker_id, connection_id, generation, pid})
  end

  def lookup(worker_id), do: GenServer.call(__MODULE__, {:lookup, worker_id})

  def send_protocol(worker_id, generation, message) do
    GenServer.call(__MODULE__, {:send_protocol, worker_id, generation, message})
  end

  @impl true
  def init(_options), do: {:ok, %{workers: %{}, refs: %{}}}

  @impl true
  def handle_call({:activate, worker_id, connection_id, generation, pid}, _from, state) do
    state = supersede_existing(state, worker_id, generation)
    ref = Process.monitor(pid)
    connection = %{pid: pid, connection_id: connection_id, generation: generation, ref: ref}

    next = %{
      workers: Map.put(state.workers, worker_id, connection),
      refs: Map.put(state.refs, ref, {worker_id, connection})
    }

    {:reply, :ok, next}
  end

  def handle_call({:lookup, worker_id}, _from, state) do
    reply =
      case Map.fetch(state.workers, worker_id) do
        {:ok, connection} -> {:ok, Map.take(connection, [:pid, :connection_id, :generation])}
        :error -> {:error, :not_connected}
      end

    {:reply, reply, state}
  end

  def handle_call({:send_protocol, worker_id, generation, message}, _from, state) do
    case Map.fetch(state.workers, worker_id) do
      {:ok, %{generation: ^generation, pid: pid}} ->
        send(pid, {:worker_protocol, message})
        {:reply, :ok, state}

      {:ok, connection} ->
        {:reply, {:error, {:stale_connection_generation, connection.generation}}, state}

      :error ->
        {:reply, {:error, :not_connected}, state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.refs, ref) do
      {nil, _refs} ->
        {:noreply, state}

      {{worker_id, connection}, refs} ->
        workers =
          case Map.get(state.workers, worker_id) do
            %{ref: ^ref} ->
              safe_disconnect(worker_id, connection)
              Map.delete(state.workers, worker_id)

            _newer_connection ->
              state.workers
          end

        {:noreply, %{workers: workers, refs: refs}}
    end
  end

  defp safe_disconnect(worker_id, connection) do
    WorkerStore.disconnect(worker_id, connection.connection_id, connection.generation)
  rescue
    DBConnection.OwnershipError -> {:error, :repo_unavailable}
  end

  defp supersede_existing(state, worker_id, generation) do
    case Map.get(state.workers, worker_id) do
      nil ->
        state

      connection ->
        send(connection.pid, {:worker_superseded, generation})
        %{state | workers: Map.delete(state.workers, worker_id)}
    end
  end
end
