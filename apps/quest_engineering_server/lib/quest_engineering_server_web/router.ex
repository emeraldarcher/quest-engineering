defmodule QuestEngineering.ServerWeb.Router do
  use QuestEngineering.ServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api/v1", QuestEngineering.ServerWeb do
    pipe_through :api

    get "/health", HealthController, :show
    get "/workspaces", ProductController, :index
    get "/workspaces/:id", ProductController, :show
    post "/workspaces", ProductController, :create
    patch "/workspaces/:id", ProductController, :update
    post "/workspaces/:id/archive", ProductController, :archive
    get "/workspace-sources", WorkspaceSourceController, :index
    post "/workspaces/:id/bindings", WorkspaceSourceController, :bind
    get "/execution-options", ExecutionOptionsController, :index
    get "/starter-crew", StarterCrewController, :show
    post "/starter-crew", StarterCrewController, :create

    get "/classes", ProductController, :index
    get "/classes/:id", ProductController, :show
    post "/classes", ProductController, :create
    patch "/classes/:id", ProductController, :update
    post "/classes/:id/archive", ProductController, :archive

    get "/loadouts", ProductController, :index
    get "/loadouts/:id", ProductController, :show
    post "/loadouts", ProductController, :create
    patch "/loadouts/:id", ProductController, :update
    post "/loadouts/:id/archive", ProductController, :archive

    post "/tactics/preview", TacticController, :preview
    post "/tactics/:id/preview", TacticController, :preview_definition
    get "/tactics", ProductController, :index
    get "/tactics/:id", ProductController, :show
    post "/tactics", ProductController, :create
    patch "/tactics/:id", ProductController, :update
    post "/tactics/:id/archive", ProductController, :archive

    get "/squads", ProductController, :index
    get "/squads/:id", ProductController, :show
    post "/squads", ProductController, :create
    patch "/squads/:id", ProductController, :update
    post "/squads/:id/archive", ProductController, :archive

    post "/quests/:id/preview", QuestController, :preview
    post "/quests/:id/launch", QuestController, :launch
    get "/quests/:id/runs", RunController, :quest_index
    get "/quests", ProductController, :index
    get "/quests/:id", ProductController, :show
    post "/quests", ProductController, :create
    patch "/quests/:id", ProductController, :update
    post "/quests/:id/archive", ProductController, :archive

    get "/runs", RunController, :index
    get "/runs/:id/changes", RunController, :changes
    post "/runs/:id/execution/retry", RunController, :retry_execution
    post "/runs/:id/execution/mark-failed", RunController, :mark_execution_failed
    post "/runs/:id/delivery/retry", RunController, :retry_delivery
    post "/runs/:id/worktree/cleanup", RunController, :cleanup
    get "/runs/:run_id/artifacts/:artifact_id", RunController, :artifact
    get "/runs/:id", RunController, :show
  end
end
