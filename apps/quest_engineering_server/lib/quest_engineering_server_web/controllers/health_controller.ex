defmodule QuestEngineering.ServerWeb.HealthController do
  use QuestEngineering.ServerWeb, :controller

  def show(conn, _params) do
    json(conn, %{
      status: "ok",
      capabilities: %{
        local_session_attachment:
          Application.get_env(:quest_engineering_server, :local_session_attach_enabled, false)
      }
    })
  end
end
