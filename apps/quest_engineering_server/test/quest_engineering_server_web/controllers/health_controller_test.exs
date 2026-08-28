defmodule QuestEngineering.ServerWeb.HealthControllerTest do
  use QuestEngineering.ServerWeb.ConnCase, async: true

  test "GET /api/v1/health reports that the control plane is running", %{conn: conn} do
    conn = get(conn, ~p"/api/v1/health")

    assert json_response(conn, 200) == %{"status" => "ok"}
  end
end
