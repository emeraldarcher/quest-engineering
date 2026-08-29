defmodule QuestEngineering.ServerWeb.RunController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.Product.Repository
  alias QuestEngineering.Server.RunProjection
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

  def artifact(conn, %{"run_id" => run_id, "artifact_id" => artifact_id}) do
    case RunProjection.artifact(run_id, artifact_id) do
      {:ok, artifact} -> json(conn, %{artifact: artifact})
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
