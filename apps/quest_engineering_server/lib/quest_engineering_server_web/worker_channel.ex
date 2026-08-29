defmodule QuestEngineering.ServerWeb.WorkerChannel do
  @moduledoc false

  use Phoenix.Channel

  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.RunWorkspaceProvisioner
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerMessageHandler
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.Server.WorkerStore

  @impl true
  def join("worker:control", payload, socket) do
    with {:ok, hello} <- WorkerProtocol.decode_hello(payload),
         connection_id = Ecto.UUID.generate(),
         {:ok, worker} <-
           WorkerStore.register(hello.worker_id, hello.capabilities, connection_id),
         :ok <-
           WorkerConnections.activate(
             hello.worker_id,
             connection_id,
             worker.connection_generation,
             self()
           ) do
      socket =
        socket
        |> assign(:worker_id, hello.worker_id)
        |> assign(:connection_id, connection_id)
        |> assign(:connection_generation, worker.connection_generation)

      send(self(), :after_worker_join)
      {:ok, WorkerProtocol.welcome(hello.worker_id), socket}
    else
      {:error, %WorkerProtocol.Error{} = error} -> {:error, WorkerProtocol.protocol_error(error)}
      {:error, error} -> {:error, WorkerProtocol.application_error(error)}
    end
  end

  @impl true
  def handle_in("protocol", payload, socket) do
    with {:ok, message} <- WorkerProtocol.decode_worker_message(payload, socket.assigns.worker_id),
         {:ok, response} <-
           WorkerMessageHandler.handle(
             socket.assigns.worker_id,
             socket.assigns.connection_generation,
             message
           ) do
      {:reply, {:ok, response}, socket}
    else
      {:error, %WorkerProtocol.Error{} = error} ->
        {:reply, {:error, WorkerProtocol.protocol_error(error)}, socket}

      {:error, error} ->
        {:reply, {:error, WorkerProtocol.application_error(error)}, socket}
    end
  end

  def handle_in(_event, _payload, socket) do
    error = %WorkerProtocol.Error{code: :unknown_channel_event}
    {:reply, {:error, WorkerProtocol.protocol_error(error)}, socket}
  end

  @impl true
  def handle_info(:after_worker_join, socket) do
    RunWorkspaceProvisioner.redeliver(socket.assigns.worker_id)
    _ = Dispatcher.redeliver(socket.assigns.worker_id, socket.assigns.connection_generation)
    Scheduler.wake_all()
    send(self(), :request_reconciliation)
    {:noreply, socket}
  end

  def handle_info(:request_reconciliation, socket) do
    worker_id = socket.assigns.worker_id
    push(socket, "protocol", WorkerProtocol.reconcile_request(worker_id))

    push(
      socket,
      "protocol",
      WorkerProtocol.reconcile_run_worktrees_request(
        worker_id,
        RunWorkspaceStore.assignments_for_worker(worker_id)
      )
    )

    {:noreply, socket}
  end

  def handle_info({:worker_protocol, message}, socket) do
    push(socket, "protocol", message)
    {:noreply, socket}
  end

  def handle_info({:worker_superseded, new_generation}, socket) do
    push(socket, "protocol", %{
      "type" => "connection_superseded",
      "protocol_version" => WorkerProtocol.version(),
      "worker_id" => socket.assigns.worker_id,
      "new_generation" => new_generation
    })

    {:stop, :normal, socket}
  end
end
