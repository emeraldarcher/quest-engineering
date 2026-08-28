defmodule QuestEngineering.ServerWeb.WorkerSocket do
  use Phoenix.Socket

  channel "worker:control", QuestEngineering.ServerWeb.WorkerChannel

  @impl true
  def connect(%{"worker_token" => supplied}, socket, _connect_info) when is_binary(supplied) do
    expected = Application.fetch_env!(:quest_engineering_server, :worker_token)

    if byte_size(supplied) == byte_size(expected) and
         Plug.Crypto.secure_compare(supplied, expected) do
      {:ok, socket}
    else
      :error
    end
  end

  def connect(_params, _socket, _connect_info), do: :error

  @impl true
  def id(_socket), do: nil
end
