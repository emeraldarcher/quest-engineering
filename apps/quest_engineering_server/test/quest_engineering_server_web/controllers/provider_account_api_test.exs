defmodule QuestEngineering.ServerWeb.ProviderAccountApiTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.ServerWeb.Endpoint

  @endpoint Endpoint

  setup do
    start_supervised!(QuestEngineering.Server.WorkerConnections)
    :ok
  end

  test "ProviderAccount API exposes credential-free lifecycle, readiness, and history" do
    worker_id = "provider-account-api-#{System.unique_integer([:positive])}"
    {:ok, _worker} = WorkerStore.register(worker_id, capabilities(), Ecto.UUID.generate())

    created =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/provider-accounts", %{
        provider_key: "provider-neutral",
        display_name: "Primary account",
        worker_id: worker_id
      })
      |> json_response(202)

    assert %{
             "provider_account" => %{
               "id" => id,
               "provider_key" => "provider-neutral",
               "display_name" => "Primary account",
               "worker_id" => ^worker_id,
               "credential_generation" => 1,
               "lifecycle_state" => "connected",
               "readiness" => %{
                 "semantic" => "semantically_connected",
                 "environment" => "pending",
                 "authentication" => "not_checked",
                 "inference" => "not_evaluated"
               },
               "environment" => %{
                 "desired_state" => "available",
                 "physical_state" => "pending",
                 "environment_id" => nil,
                 "incarnation" => nil
               }
             }
           } = created

    assert %{"provider_accounts" => [%{"id" => ^id}]} =
             build_conn()
             |> get("/api/v1/provider-accounts")
             |> json_response(200)

    assert %{"provider_account" => %{"id" => ^id}} =
             build_conn()
             |> get("/api/v1/provider-accounts/#{id}")
             |> json_response(200)

    assert %{"provider_account" => invalid} =
             build_conn()
             |> post("/api/v1/provider-accounts/#{id}/actions/invalidate")
             |> json_response(202)

    assert invalid["id"] == id
    assert invalid["lifecycle_state"] == "invalid"
    assert invalid["readiness"]["authentication"] == "not_checked"
    assert invalid["readiness"]["inference"] == "not_evaluated"

    assert %{"provider_account" => reconnected} =
             build_conn()
             |> post("/api/v1/provider-accounts/#{id}/actions/reconnect")
             |> json_response(202)

    assert reconnected["id"] == id
    assert reconnected["credential_generation"] == 2
    assert reconnected["lifecycle_state"] == "connected"

    assert %{"events" => events} =
             build_conn()
             |> get("/api/v1/provider-accounts/#{id}/events")
             |> json_response(200)

    assert Enum.map(events, & &1["event_type"]) == [
             "account_created",
             "account_invalid",
             "credential_generation_advanced"
           ]

    refute response_contains_secret_field?(created)
    refute response_contains_secret_field?(%{"events" => events})
  end

  test "ProviderAccount API projects durable stop and remove targets separately from convergence" do
    worker_id = "provider-account-api-intent-#{System.unique_integer([:positive])}"
    {:ok, _worker} = WorkerStore.register(worker_id, capabilities(), Ecto.UUID.generate())

    assert %{"provider_account" => %{"id" => id}} =
             build_conn()
             |> put_req_header("content-type", "application/json")
             |> post("/api/v1/provider-accounts", %{
               provider_key: "provider-neutral",
               worker_id: worker_id
             })
             |> json_response(202)

    assert %{
             "provider_account" => %{
               "environment" => %{
                 "desired_state" => "stopped",
                 "physical_state" => "pending"
               }
             }
           } =
             build_conn()
             |> post("/api/v1/provider-accounts/#{id}/actions/stop")
             |> json_response(202)

    assert %{
             "provider_account" => %{
               "environment" => %{
                 "desired_state" => "removed",
                 "physical_state" => "removing"
               }
             }
           } =
             build_conn()
             |> post("/api/v1/provider-accounts/#{id}/actions/remove")
             |> json_response(202)
  end

  test "ProviderAccount API rejects credentials, unknown fields, actions, and identities" do
    worker_id = "provider-account-api-validation-#{System.unique_integer([:positive])}"
    {:ok, _worker} = WorkerStore.register(worker_id, capabilities(), Ecto.UUID.generate())

    for payload <- [
          %{provider_key: "fake", worker_id: worker_id, credential: "secret"},
          %{provider_key: "fake", worker_id: worker_id, unknown: true}
        ] do
      assert %{"error" => %{"code" => "malformed_request"}} =
               build_conn()
               |> put_req_header("content-type", "application/json")
               |> post("/api/v1/provider-accounts", payload)
               |> json_response(400)
    end

    assert %{"error" => %{"code" => "not_found"}} =
             build_conn()
             |> get("/api/v1/provider-accounts/missing")
             |> json_response(404)

    assert %{"error" => %{"code" => "malformed_request"}} =
             build_conn()
             |> post("/api/v1/provider-accounts/missing/actions/login")
             |> json_response(400)
  end

  defp response_contains_secret_field?(value) when is_map(value) do
    Enum.any?(value, fn {key, nested} ->
      key in ["credential", "credentials", "secret", "token"] or
        response_contains_secret_field?(nested)
    end)
  end

  defp response_contains_secret_field?(value) when is_list(value),
    do: Enum.any?(value, &response_contains_secret_field?/1)

  defp response_contains_secret_field?(_value), do: false

  defp capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "features" => ["provider_account_environments_v1"],
      "workspace_bindings" => [],
      "executors" => [
        %{
          "harness_kind" => "fake",
          "models" => [
            %{
              "provider" => "fake",
              "model" => "test",
              "display_name" => "Test",
              "account_availability" => "verified_available",
              "reasoning_capability" => %{"kind" => "unsupported"}
            }
          ],
          "supported_tool_policies" => ["exact"],
          "tool_enforcement" => "exact",
          "tool_profile" => %{"tools" => []}
        }
      ]
    }
  end
end
