defmodule QuestEngineering.Server.Application do
  @moduledoc false

  use Application

  alias QuestEngineering.ServerWeb.Endpoint

  @impl true
  def start(_type, _args) do
    claim_owner =
      Application.get_env(
        :quest_engineering_server,
        :dispatcher_claim_owner,
        "control-plane/" <> Atom.to_string(node())
      )

    children = [
      QuestEngineering.Server.Repo,
      {Phoenix.PubSub, name: QuestEngineering.Server.PubSub},
      QuestEngineering.Server.WorkerConnections,
      {QuestEngineering.Server.Dispatcher, claim_owner: claim_owner},
      Endpoint
    ]

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: QuestEngineering.Server.Supervisor
    )
  end

  @impl true
  def config_change(changed, _new, removed) do
    Endpoint.config_change(changed, removed)
    :ok
  end
end
