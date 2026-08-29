import Config

if System.get_env("PHX_SERVER") do
  config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint, server: true
end

if port = System.get_env("PORT") do
  config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint,
    http: [port: String.to_integer(port)]
end

if encoded_workspaces = System.get_env("QUEST_ENGINEERING_WORKSPACES_JSON") do
  workspaces = Jason.decode!(encoded_workspaces)

  unless is_map(workspaces) and
           Enum.all?(workspaces, fn {reference, root} ->
             is_binary(reference) and reference != "" and is_binary(root) and root != ""
           end) do
    raise "QUEST_ENGINEERING_WORKSPACES_JSON must be a JSON object of non-empty string paths"
  end

  config :quest_engineering_server, workspaces: workspaces
end

if config_env() == :prod do
  worker_token = System.fetch_env!("QUEST_ENGINEERING_WORKER_TOKEN")
  config :quest_engineering_server, worker_token: worker_token

  database_url =
    System.get_env("DATABASE_URL") ||
      raise "DATABASE_URL is required in production"

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is required in production"

  host = System.get_env("PHX_HOST", "example.com")
  socket_options = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :quest_engineering_server, QuestEngineering.Server.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE", "10")),
    socket_options: socket_options

  config :quest_engineering_server, QuestEngineering.ServerWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [ip: {0, 0, 0, 0, 0, 0, 0, 0}],
    secret_key_base: secret_key_base
end
