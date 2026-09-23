defmodule QuestEngineering.ServerWeb.SessionAttachmentTest do
  use QuestEngineering.ServerWeb.ConnCase, async: false

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Server.Repo

  setup do
    :ok = Sandbox.checkout(Repo)
    :ok
  end

  test "local attachment fails closed unless enabled and marked as local Tauri", %{conn: conn} do
    previous =
      Application.get_env(:quest_engineering_server, :local_session_attach_enabled, false)

    on_exit(fn ->
      Application.put_env(:quest_engineering_server, :local_session_attach_enabled, previous)
    end)

    path = "/api/v1/runs/run/attempts/attempt/sessions/session/attachment"

    conn = post(conn, path, %{})
    assert json_response(conn, 409)["error"]["code"] == "local_session_attachment_disabled"

    Application.put_env(:quest_engineering_server, :local_session_attach_enabled, true)

    assert %{
             "status" => "ok",
             "capabilities" => %{"local_session_attachment" => true}
           } = json_response(get(build_conn(), "/api/v1/health"), 200)

    conn = %{build_conn() | host: "127.0.0.1"} |> post(path, %{})
    assert json_response(conn, 409)["error"]["code"] == "local_session_attachment_disabled"

    remote_conn =
      %{build_conn() | remote_ip: {10, 0, 0, 8}, host: "127.0.0.1"}
      |> put_req_header("x-quest-engineering-local-client", "tauri")
      |> post(path, %{})

    assert json_response(remote_conn, 409)["error"]["code"] ==
             "local_session_attachment_disabled"

    conn =
      %{build_conn() | host: "127.0.0.1"}
      |> put_req_header("x-quest-engineering-local-client", "tauri")
      |> post(path, %{})

    assert json_response(conn, 404)["error"]["code"] == "session_not_found"

    cancellation_path = "/api/v1/runs/run/attempts/attempt/cancel"
    cancellation_body = %{occurrence_id: "occurrence", request_id: "request"}

    unauthorized =
      %{build_conn() | host: "127.0.0.1"}
      |> post(cancellation_path, cancellation_body)

    assert json_response(unauthorized, 409)["error"]["code"] ==
             "local_session_attachment_disabled"

    authorized =
      %{build_conn() | host: "127.0.0.1"}
      |> put_req_header("x-quest-engineering-local-client", "tauri")
      |> post(cancellation_path, cancellation_body)

    assert json_response(authorized, 404)["error"]["code"] == "not_found"
  end
end
