defmodule QuestEngineering.Server.RunWorkspaceProvisioner do
  @moduledoc "Delivers durable Run-worktree desired state without consuming Action slots."

  use GenServer

  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.Server.WorkerStore

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  def ensure(run_id), do: GenServer.call(__MODULE__, {:ensure, run_id}, 10_000)

  def redeliver(worker_id), do: GenServer.cast(__MODULE__, {:redeliver, worker_id})
  def deliver_assignment(assignment), do: deliver(assignment)

  @impl true
  def init(_options), do: {:ok, %{}}

  @impl true
  def handle_call({:ensure, run_id}, _from, state) do
    result =
      case RunWorkspaceStore.ensure_assignment(run_id) do
        {:ready, assignment} ->
          {:ready, assignment}

        {:provision, assignment} ->
          _ = deliver(assignment)
          {:preparing, assignment}

        {:waiting_for_host, assignment} ->
          {:preparing, assignment}

        {:blocked, assignment} ->
          {:blocked, assignment}

        {:error, error} ->
          {:error, error}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_cast({:redeliver, worker_id}, state) do
    Enum.each(RunWorkspaceStore.assignments_for_worker(worker_id), fn assignment ->
      if assignment.state == "provisioning", do: deliver(assignment)
    end)

    {:noreply, state}
  end

  defp deliver(assignment) do
    with {:ok, worker} <- WorkerStore.fetch(assignment.worker_id) do
      WorkerConnections.send_protocol(
        assignment.worker_id,
        worker.connection_generation,
        WorkerProtocol.provision_run_worktree(assignment.worker_id, assignment)
      )
    end
  end
end
