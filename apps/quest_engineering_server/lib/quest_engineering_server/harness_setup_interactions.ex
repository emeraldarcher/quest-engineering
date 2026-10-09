defmodule QuestEngineering.Server.HarnessSetupInteractions do
  @moduledoc "Ephemeral, no-log relay for official provider setup interaction bytes."
  use GenServer

  @ttl_seconds 300
  @prune_interval_ms 1_000

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def put(setup_id, generation, attention_id, output) do
    GenServer.call(__MODULE__, {:put, setup_id, generation, attention_id, output})
  end

  def fetch(setup_id, generation, attention_id) do
    GenServer.call(__MODULE__, {:fetch, setup_id, generation, attention_id})
  end

  def clear(setup_id), do: GenServer.call(__MODULE__, {:clear, setup_id})

  @impl true
  def init(_options) do
    schedule_prune()
    {:ok, %{}}
  end

  @impl true
  def handle_call({:put, setup_id, generation, attention_id, output}, _from, state) do
    expires_at = DateTime.add(DateTime.utc_now(), @ttl_seconds, :second)

    entry = %{
      generation: generation,
      attention_id: attention_id,
      output: String.slice(output, -16_384, 16_384),
      expires_at: expires_at
    }

    {:reply, :ok, Map.put(prune(state), setup_id, entry)}
  end

  def handle_call({:fetch, setup_id, generation, attention_id}, _from, state) do
    state = prune(state)

    reply =
      case Map.get(state, setup_id) do
        %{generation: ^generation, attention_id: ^attention_id} = entry ->
          {:ok, Map.take(entry, [:output, :expires_at])}

        _ ->
          {:error, :setup_interaction_unavailable}
      end

    {:reply, reply, state}
  end

  def handle_call({:clear, setup_id}, _from, state),
    do: {:reply, :ok, Map.delete(state, setup_id)}

  @impl true
  def handle_info(:prune, state) do
    schedule_prune()
    {:noreply, prune(state)}
  end

  defp schedule_prune, do: Process.send_after(self(), :prune, @prune_interval_ms)

  defp prune(state) do
    now = DateTime.utc_now()
    Map.reject(state, fn {_key, entry} -> DateTime.compare(entry.expires_at, now) != :gt end)
  end
end
