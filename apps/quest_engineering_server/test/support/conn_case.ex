defmodule QuestEngineering.ServerWeb.ConnCase do
  @moduledoc """
  Test case for requests to the Quest Engineering HTTP endpoint.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      @endpoint QuestEngineering.ServerWeb.Endpoint

      use Phoenix.VerifiedRoutes,
        endpoint: QuestEngineering.ServerWeb.Endpoint,
        router: QuestEngineering.ServerWeb.Router

      import Plug.Conn
      import Phoenix.ConnTest
    end
  end

  setup do
    {:ok, conn: Phoenix.ConnTest.build_conn()}
  end
end
