defmodule QuestEngineering.ServerWeb.ProductController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProductApi.Service
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.ServerWeb.Api

  def index(conn, params), do: list(conn, params, kind(conn))
  def show(conn, params), do: show_resource(conn, params, kind(conn))
  def create(conn, params), do: create_resource(conn, params, kind(conn))
  def update(conn, params), do: update_resource(conn, params, kind(conn))
  def archive(conn, params), do: archive_resource(conn, params, kind(conn))

  defp list(conn, _params, kind) do
    with {:ok, include_archived} <- Api.include_archived?(conn),
         {:ok, values} <- Service.list(kind, include_archived: include_archived) do
      json(conn, %{
        plural(kind) => Enum.map(values, &view(kind, &1, Service.archived_at(kind, &1.id)))
      })
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp show_resource(conn, %{"id" => id}, kind) do
    with {:ok, include_archived} <- Api.include_archived?(conn),
         {:ok, value} <- Service.get(kind, id, include_archived: include_archived) do
      json(conn, %{kind => view(kind, value, Service.archived_at(kind, id))})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp create_resource(conn, params, kind) do
    case Service.create(kind, params) do
      {:ok, value} -> conn |> put_status(:created) |> json(%{kind => view(kind, value, nil)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp update_resource(conn, %{"id" => id} = params, kind) do
    case Service.update(kind, id, Map.delete(params, "id")) do
      {:ok, value} -> json(conn, %{kind => view(kind, value, nil)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp archive_resource(conn, %{"id" => id}, kind) do
    case Service.archive(kind, id) do
      {:ok, value} -> json(conn, %{kind => view(kind, value, Service.archived_at(kind, id))})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp kind(%{path_info: ["api", "v1", "workspaces" | _]}), do: :workspace
  defp kind(%{path_info: ["api", "v1", "classes" | _]}), do: :class
  defp kind(%{path_info: ["api", "v1", "loadouts" | _]}), do: :loadout
  defp kind(%{path_info: ["api", "v1", "squads" | _]}), do: :squad
  defp kind(%{path_info: ["api", "v1", "quests" | _]}), do: :quest
  defp kind(%{path_info: ["api", "v1", "tactics" | _]}), do: :tactic
  defp plural(:workspace), do: :workspaces
  defp plural(:class), do: :classes
  defp plural(:loadout), do: :loadouts
  defp plural(:squad), do: :squads
  defp plural(:quest), do: :quests
  defp plural(:tactic), do: :tactics
  defp view(:workspace, value, archived_at), do: View.workspace(value, archived_at)
  defp view(:class, value, archived_at), do: View.class(value, archived_at)
  defp view(:loadout, value, archived_at), do: View.loadout(value, archived_at)
  defp view(:squad, value, archived_at), do: View.squad(value, archived_at)
  defp view(:quest, value, archived_at), do: View.quest(value, archived_at)
  defp view(:tactic, value, archived_at), do: View.tactic(value, archived_at)
end
