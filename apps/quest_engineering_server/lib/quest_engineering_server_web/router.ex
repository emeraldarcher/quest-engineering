defmodule QuestEngineering.ServerWeb.Router do
  use QuestEngineering.ServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api/v1", QuestEngineering.ServerWeb do
    pipe_through :api

    get "/health", HealthController, :show
  end
end
