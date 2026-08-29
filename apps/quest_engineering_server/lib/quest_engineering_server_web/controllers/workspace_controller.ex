defmodule QuestEngineering.ServerWeb.WorkspaceController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProductApi.Service

  def index(conn, _params), do: json(conn, %{workspaces: Service.workspaces()})
end
