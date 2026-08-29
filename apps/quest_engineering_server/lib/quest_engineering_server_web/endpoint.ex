defmodule QuestEngineering.ServerWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :quest_engineering_server

  socket "/worker", QuestEngineering.ServerWeb.WorkerSocket,
    websocket: true,
    longpoll: false

  socket "/client", QuestEngineering.ServerWeb.ClientSocket,
    websocket: true,
    longpoll: false

  if code_reloading? do
    plug Phoenix.CodeReloader
    plug Phoenix.Ecto.CheckRepoStatus, otp_app: :quest_engineering_server
  end

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Phoenix.json_library()

  plug Plug.Head
  plug QuestEngineering.ServerWeb.Router
end
