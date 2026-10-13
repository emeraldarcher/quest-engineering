defmodule QuestEngineering.ServerWeb.ProviderAccountController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.ProviderAccountSetupInteractions

  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.ProviderAccountApi.Service
  alias QuestEngineering.Server.ProviderAccountApi.View
  alias QuestEngineering.ServerWeb.Api
  alias QuestEngineering.ServerWeb.ProviderAccountSetupInputFilter

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

  def setup_attempts(conn, %{"id" => id}) do
    with {:ok, _account, _environment} <- Service.get(id),
         {:ok, attempts} <- Service.setup_attempts(id) do
      json(conn, %{
        setup_attempts:
          Enum.map(attempts, fn attempt ->
            View.setup_attempt(
              attempt,
              ProviderAccountSetups.attention_for_attempt(attempt.id)
            )
          end)
      })
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def authorize_setup(conn, %{"id" => id} = params) do
    with :ok <- require_local_tauri_client(conn),
         {:ok, attempt, attention, idempotent?} <-
           Service.authorize_setup(id, Map.delete(params, "id")) do
      conn
      |> put_status(:accepted)
      |> json(%{
        setup_attempt: View.setup_attempt(attempt, attention),
        idempotent_replay: idempotent?
      })
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def setup_interaction(conn, %{
        "id" => id,
        "attempt_id" => attempt_id,
        "generation" => generation,
        "attention_id" => attention_id
      }) do
    with :ok <- require_local_tauri_client(conn),
         [client_public_key] <- get_req_header(conn, "x-qe-interaction-public-key"),
         {parsed_generation, ""} <- Integer.parse(generation),
         {:ok, interaction} <-
           Service.setup_interaction(id, attempt_id, parsed_generation, attention_id),
         {:ok, sealed_output} <-
           ProviderAccountSetupInteractions.seal_for_client(
             interaction.output,
             client_public_key
           ) do
      conn
      |> put_resp_header("cache-control", "no-store")
      |> put_resp_header("pragma", "no-cache")
      |> json(%{
        interaction: %{
          setup_attempt_id: attempt_id,
          setup_generation: parsed_generation,
          attention_id: attention_id,
          output: sealed_output,
          expires_at: DateTime.to_iso8601(interaction.expires_at)
        }
      })
    else
      {:error, error} -> Api.render_error(conn, error)
      _ -> Api.render_error(conn, :setup_interaction_unavailable)
    end
  end

  def respond_setup(conn, %{"id" => id, "attempt_id" => attempt_id} = params) do
    request = Map.drop(params, ["id", "attempt_id", "value"])

    request =
      case ProviderAccountSetupInputFilter.take(conn) do
        {:ok, value} -> Map.put(request, "value", value)
        :error -> request
      end

    with :ok <- require_local_tauri_client(conn),
         {:ok, attempt, attention} <- Service.respond_setup(id, attempt_id, request) do
      json(conn, %{setup_attempt: View.setup_attempt(attempt, attention)})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def cancel_setup(conn, %{"id" => id, "attempt_id" => attempt_id} = params) do
    with :ok <- require_local_tauri_client(conn),
         {:ok, attempt, attention} <-
           Service.cancel_setup(id, attempt_id, Map.drop(params, ["id", "attempt_id"])) do
      json(conn, %{setup_attempt: View.setup_attempt(attempt, attention)})
    else
      {:error, error} -> Api.render_error(conn, error)
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

  defp require_local_tauri_client(conn) do
    local_request = conn.remote_ip in [{127, 0, 0, 1}, {0, 0, 0, 0, 0, 0, 0, 1}]
    local_host = conn.host in ["127.0.0.1", "localhost", "::1"]

    direct_request =
      get_req_header(conn, "forwarded") == [] and get_req_header(conn, "x-forwarded-for") == []

    tauri_client = get_req_header(conn, "x-quest-engineering-local-client") == ["tauri"]

    if local_request and local_host and direct_request and tauri_client,
      do: :ok,
      else: {:error, :local_provider_account_setup_unavailable}
  end
end
