defmodule QuestEngineering.ServerWeb.HealthController do
  use QuestEngineering.ServerWeb, :controller

  def show(conn, _params) do
    json(conn, %{status: "ok"})
  end
end
