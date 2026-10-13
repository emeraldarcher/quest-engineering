defmodule QuestEngineering.ServerWeb.ProviderAccountController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProviderAccountApi.Service
  alias QuestEngineering.Server.ProviderAccountApi.View
  alias QuestEngineering.ServerWeb.Api

  def index(conn, _params) do
    {:ok, accounts} = Service.list()
    json(conn, %{provider_accounts: Enum.map(accounts, &View.account/1)})
  end

  def show(conn, %{"id" => id}) do
    case Service.get(id) do
      {:ok, account, environment} ->
        json(conn, %{provider_account: View.account(account, environment)})

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def create(conn, params) do
    case Service.create(params) do
      {:ok, account, environment} ->
        conn
        |> put_status(:accepted)
        |> json(%{provider_account: View.account(account, environment)})

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def lifecycle_action(conn, %{"id" => id, "action" => action}) do
    case Service.action(id, action) do
      {:ok, account, environment} ->
        conn
        |> put_status(:accepted)
        |> json(%{provider_account: View.account(account, environment)})

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def events(conn, %{"id" => id}) do
    with {:ok, _account, _environment} <- Service.get(id),
         {:ok, events} <- Service.events(id) do
      json(conn, %{events: Enum.map(events, &View.event/1)})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
