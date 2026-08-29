defmodule QuestEngineering.ServerWeb.TacticController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProductApi.Service
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.ServerWeb.Api

  def preview(conn, params) do
    case Service.preview_tactic(params) do
      {:ok, preview} -> json(conn, %{preview: View.preview(preview)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def preview_definition(conn, %{"id" => id}) do
    case Service.preview_tactic_definition(id) do
      {:ok, preview} -> json(conn, %{preview: View.preview(preview)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
