defmodule QuestEngineering.ServerWeb.RunChannel do
  @moduledoc false
  use Phoenix.Channel

  alias QuestEngineering.Server.RunProjection

  @impl true
  def join("run:" <> run_id, _payload, socket) do
    case RunProjection.get(run_id) do
      {:ok, projection} -> {:ok, %{run: projection}, socket}
      {:error, _} -> {:error, %{reason: "not_found"}}
    end
  end
end
