defmodule QuestEngineering.ServerWeb.ProductChannel do
  @moduledoc false
  use Phoenix.Channel
  def join("product:all", _payload, socket), do: {:ok, %{}, socket}
end
