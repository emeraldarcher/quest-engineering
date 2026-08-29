import Config

config :quest_engineering_server, QuestEngineering.Server.Repo,
  username: System.get_env("POSTGRES_USER", "postgres"),
  password: System.get_env("POSTGRES_PASSWORD", "postgres"),
  hostname: System.get_env("POSTGRES_HOST", "localhost"),
  port: String.to_integer(System.get_env("POSTGRES_PORT", "5432")),
  database:
    System.get_env(
      "POSTGRES_TEST_DB",
      "quest_engineering_server_test#{System.get_env("MIX_TEST_PARTITION")}"
    ),
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "58mG/EfjSfAE7VAKwA9oa5SPyTtDTFzFdf+BumXt3c2VERzEWQC3HwrqJL2DfWsr",
  server: true

config :quest_engineering_server, :legacy_test_auto_worktrees, true

config :logger, level: :warning
config :phoenix, :plug_init_mode, :runtime
config :phoenix, sort_verified_routes_query_params: true
