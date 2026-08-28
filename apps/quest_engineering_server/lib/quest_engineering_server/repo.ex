defmodule QuestEngineering.Server.Repo do
  use Ecto.Repo,
    otp_app: :quest_engineering_server,
    adapter: Ecto.Adapters.Postgres
end
