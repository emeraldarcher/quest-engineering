defmodule QuestEngineering.Server.ProductChangeNotifier do
  @moduledoc "Small Product-list invalidation signal."
  alias QuestEngineering.ServerWeb.Endpoint

  def notify(resources \\ ["quests", "runs", "workspaces"]) do
    Endpoint.broadcast("product:all", "product_changed", %{resources: resources})
    :ok
  end
end
