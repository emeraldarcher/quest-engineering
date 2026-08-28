import Config

config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint,
  force_ssl: [rewrite_on: [:x_forwarded_proto], host: nil]

config :logger, level: :info
