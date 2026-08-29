defmodule QuestEngineering.ServerWeb.ExecutionOptionsController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ExecutionOptions

  def index(conn, _params), do: json(conn, %{execution_options: ExecutionOptions.list()})
end
