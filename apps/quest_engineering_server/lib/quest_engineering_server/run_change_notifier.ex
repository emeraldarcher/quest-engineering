defmodule QuestEngineering.Server.RunChangeNotifier do
  @moduledoc "Ephemeral, post-commit invalidation notifications for Product Run projections."

  alias QuestEngineering.ServerWeb.Endpoint

  def notify(run_id) when is_binary(run_id) do
    Endpoint.broadcast("run:" <> run_id, "run_changed", %{run_id: run_id})
    :ok
  end
end
