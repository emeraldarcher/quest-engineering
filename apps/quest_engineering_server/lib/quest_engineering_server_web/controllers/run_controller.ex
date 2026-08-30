defmodule QuestEngineering.ServerWeb.RunController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.DeliveryCoordinator
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Product.Repository
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.ServerWeb.Api

  def index(conn, _params) do
    case RunProjection.list() do
      {:ok, runs} -> json(conn, %{runs: runs})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def quest_index(conn, %{"id" => quest_id}) do
    with {:ok, _quest} <- Repository.get_quest(quest_id),
         {:ok, runs} <- RunProjection.list(quest_id) do
      json(conn, %{runs: runs})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def show(conn, %{"id" => id}) do
    case RunProjection.get(id) do
      {:ok, run} -> json(conn, %{run: run})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def changes(conn, %{"id" => run_id}) do
    case DeliveryStore.changes(run_id) do
      {:ok, changes} -> json(conn, %{changes: changes})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def retry_delivery(conn, %{"id" => run_id}) do
    case DeliveryStore.retry(run_id) do
      {:ok, delivery} ->
        DeliveryCoordinator.wake(run_id)
        json(conn, %{delivery: DeliveryStore.projection(delivery)})

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def cleanup(conn, %{"id" => run_id} = params) do
    case RunWorkspaceStore.request_cleanup(run_id, params["acknowledge_unmerged"] == true) do
      {:ok, %{state: "removed"}} ->
        json(conn, %{execution_environment: %{state: "removed"}})

      {:ok, assignment} ->
        worker = Repo.get!(Worker, assignment.worker_id)

        case WorkerConnections.send_protocol(
               worker.id,
               worker.connection_generation,
               WorkerProtocol.cleanup_run_worktree(worker.id, assignment)
             ) do
          :ok -> json(conn, %{execution_environment: %{state: "cleanup_requested"}})
          {:error, error} -> Api.render_error(conn, error)
        end

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def artifact(conn, %{"run_id" => run_id, "artifact_id" => artifact_id}) do
    case RunProjection.artifact(run_id, artifact_id) do
      {:ok, artifact} -> json(conn, %{artifact: artifact})
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
