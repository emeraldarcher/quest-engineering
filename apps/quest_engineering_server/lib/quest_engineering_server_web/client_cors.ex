defmodule QuestEngineering.ServerWeb.ClientCors do
  @moduledoc false

  import Plug.Conn

  def init(options), do: options

  def call(conn, _options) do
    origin = List.first(get_req_header(conn, "origin"))

    if is_binary(origin) and origin in allowed_origins() do
      conn
      |> put_resp_header("access-control-allow-origin", origin)
      |> put_resp_header("vary", "origin")
      |> put_resp_header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS")
      |> put_resp_header("access-control-allow-headers", "content-type")
      |> maybe_preflight()
    else
      conn
    end
  end

  defp maybe_preflight(%{method: "OPTIONS"} = conn), do: conn |> send_resp(204, "") |> halt()
  defp maybe_preflight(conn), do: conn

  defp allowed_origins,
    do: Application.get_env(:quest_engineering_server, :client_origins, [])
end
