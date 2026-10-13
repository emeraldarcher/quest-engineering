defmodule QuestEngineering.ServerWeb.ProviderAccountSetupInputFilter do
  @moduledoc "Removes ephemeral ProviderAccount setup input from the telemetry-visible connection."

  alias QuestEngineering.Server.ProviderAccountSetupInteractions

  @private_key :provider_account_setup_input_reference
  @filtered "[FILTERED]"

  def init(options), do: options

  def call(
        %Plug.Conn{
          method: "POST",
          path_info: [
            "api",
            "v1",
            "provider-accounts",
            _account_id,
            "setup-attempts",
            _attempt_id,
            "respond"
          ],
          body_params: body_params
        } = conn,
        _options
      )
      when is_map(body_params) do
    case Map.fetch(body_params, "value") do
      {:ok, value} ->
        conn =
          conn
          |> Map.update!(:body_params, &Map.put(&1, "value", @filtered))
          |> Map.update!(:params, &Map.put(&1, "value", @filtered))
          |> redact_adapter_params()

        if is_binary(value) and byte_size(value) <= 8_192 do
          Plug.Conn.put_private(
            conn,
            @private_key,
            ProviderAccountSetupInteractions.hold_input(value)
          )
        else
          conn
        end

      _missing_or_invalid ->
        conn
    end
  end

  def call(conn, _options), do: conn

  def take(%Plug.Conn{} = conn) do
    conn.private
    |> Map.get(@private_key)
    |> ProviderAccountSetupInteractions.take_input()
  end

  defp redact_adapter_params(
         %Plug.Conn{adapter: {adapter, %{params: params} = adapter_state}} = conn
       )
       when is_atom(adapter) and is_map(params) do
    redacted_state = %{adapter_state | params: Map.put(params, "value", @filtered)}
    %{conn | adapter: {adapter, redacted_state}}
  end

  defp redact_adapter_params(conn), do: conn
end
