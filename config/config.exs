import Config

config :quest_engineering_server,
  ecto_repos: [QuestEngineering.Server.Repo],
  worker_token: System.get_env("QUEST_ENGINEERING_WORKER_TOKEN", "development-worker-token"),
  workspaces: %{}

config :quest_engineering_server, QuestEngineering.Server.Repo,
  migration_timestamps: [type: :utc_datetime_usec]

config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: QuestEngineering.ServerWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: QuestEngineering.Server.PubSub

config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"
