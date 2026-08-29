defmodule QuestEngineering.ServerWeb.WorkspaceController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProductApi.Service
  alias QuestEngineering.Server.ProductApi.View

  def index(conn, _params) do
    {:ok, workspaces} = Service.list(:workspace, [])

    json(conn, %{
      workspaces: Enum.map(workspaces, &View.workspace/1)
    })
  end
end
