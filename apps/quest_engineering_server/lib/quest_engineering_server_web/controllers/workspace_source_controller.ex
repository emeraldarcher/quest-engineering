defmodule QuestEngineering.ServerWeb.WorkspaceSourceController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.WorkspaceControl
  alias QuestEngineering.ServerWeb.Api

  def index(conn, _params) do
    :ok = WorkspaceControl.request_discovery()
    json(conn, %{workspace_sources: WorkspaceControl.list_candidates()})
  end

  def bind(conn, %{"id" => workspace_id, "candidate_id" => candidate_id}) do
    case WorkspaceControl.bind(workspace_id, candidate_id) do
      {:ok, result} -> conn |> put_status(:accepted) |> json(%{binding: result})
      {:error, :not_found} -> Api.render_error(conn, :not_found)
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
