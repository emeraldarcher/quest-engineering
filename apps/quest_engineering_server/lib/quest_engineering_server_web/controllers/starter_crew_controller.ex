defmodule QuestEngineering.ServerWeb.StarterCrewController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.Product.StarterCrew
  alias QuestEngineering.Server.ProductApi.View
  alias QuestEngineering.ServerWeb.Api

  def show(conn, _params), do: json(conn, %{starter_crew: status_view(StarterCrew.status())})

  def create(conn, %{"workspace_id" => workspace_id}) do
    case StarterCrew.create_or_reconcile(workspace_id) do
      {:ok, result} -> json(conn, %{starter_crew: result_view(result)})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def create(conn, _params),
    do:
      Api.render_error(conn, %StarterCrew.Error{
        code: :invalid_request,
        details: %{path: ["workspace_id"]}
      })

  defp status_view(%{state: state, conflict: conflict}) do
    %{
      state: Atom.to_string(state),
      conflict:
        if(conflict,
          do: %{entity_type: Atom.to_string(conflict.entity_type), key: conflict.key},
          else: nil
        )
    }
  end

  defp result_view(result) do
    %{
      status: Atom.to_string(result.status),
      classes: Enum.map(result.classes, &View.class/1),
      loadouts: Enum.map(result.loadouts, &View.loadout/1),
      squad: View.squad(result.squad),
      tactic: View.tactic(result.tactic)
    }
  end
end
