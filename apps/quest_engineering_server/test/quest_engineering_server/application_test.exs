defmodule QuestEngineering.Server.ApplicationTest do
  use ExUnit.Case, async: true

  test "supervises the control-plane infrastructure" do
    assert Process.whereis(QuestEngineering.Server.Repo)
    assert Process.whereis(QuestEngineering.ServerWeb.Endpoint)
  end
end
