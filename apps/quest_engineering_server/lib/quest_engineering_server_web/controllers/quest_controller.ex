defmodule QuestEngineering.ServerWeb.QuestController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProductApi.Service
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.ServerWeb.Api

  def preview(conn, %{"id" => id}) do
    case Service.preview_quest(id) do
      {:ok, snapshot} -> json(conn, %{preview: View.quest_preview(snapshot)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def launch(conn, %{"id" => id}) do
    case Service.launch(id) do
      {:ok, launched} ->
        {:ok, projection} = RunProjection.get(launched.run_id)

        body = %{
          launch: %{id: launched.launch_id, quest_id: id, run_id: launched.run_id},
          run: RunProjection.summary(projection)
        }

        conn
        |> put_status(:created)
        |> put_resp_header("location", "/api/v1/runs/" <> launched.run_id)
        |> json(body)

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end
end
