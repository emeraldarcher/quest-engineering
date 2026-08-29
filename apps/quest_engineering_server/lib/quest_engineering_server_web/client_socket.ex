defmodule QuestEngineering.ServerWeb.ClientSocket do
  @moduledoc false
  use Phoenix.Socket

  channel "run:*", QuestEngineering.ServerWeb.RunChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end
