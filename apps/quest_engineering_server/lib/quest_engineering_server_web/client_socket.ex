defmodule QuestEngineering.ServerWeb.ClientSocket do
  @moduledoc false
  use Phoenix.Socket

  channel "run:*", QuestEngineering.ServerWeb.RunChannel
  channel "product:all", QuestEngineering.ServerWeb.ProductChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end
