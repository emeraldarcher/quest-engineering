defmodule QuestEngineering.ServerWeb.ProviderAccountApiTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.Product.ProviderAccountSetups
  alias QuestEngineering.Server.ProviderAccountSetupInteractions
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
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
               "capabilities" => %{"can_authorize_setup" => false},
               "authentication" => %{
                 "state" => "not_checked",
                 "method" => nil,
                 "configuration_identity" => nil,
                 "environment_policy" => nil,
                 "evidence_identity" => nil,
                 "inspected_at" => nil
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

  test "ProviderAccount setup API is local, account-scoped, and never persists interaction bytes" do
    worker_id = "provider-account-setup-api-#{System.unique_integer([:positive])}"
    connection_id = Ecto.UUID.generate()
    {:ok, worker} = WorkerStore.register(worker_id, capabilities(), connection_id)
    {:ok, worker} = WorkerStore.mark_ready(worker.id, worker.connection_generation)

    :ok =
      WorkerConnections.activate(
        worker.id,
        connection_id,
        worker.connection_generation,
        self()
      )

    {:ok, {account, pending}} =
      ProviderAccounts.create(
        %{provider_key: "fake", worker_id: worker.id},
        worker.connection_generation
      )

    {:ok, {:applied, account, environment}} =
      ProviderAccounts.apply_environment_report(%{
        provider_account_id: account.id,
        credential_generation: pending.credential_generation,
        worker_id: worker.id,
        worker_generation: pending.worker_generation,
        operation_id: pending.operation_id,
        physical_state: "available",
        event_type: "environment_ensured",
        backend_kind: "fake-account",
        environment_id: "setup-api-environment",
        incarnation: "setup-api-incarnation",
        error_code: nil,
        error_message: nil,
        canary_persisted: true,
        observed_at: DateTime.utc_now(),
        authentication: %{
          state: "authentication_required",
          method: "none",
          configuration_identity: "qe-fake-provider-account-auth-v1",
          environment_policy: "qe-fake-provider-account-explicit-environment-v1",
          evidence_identity: "provider-auth-evidence-v1:" <> String.duplicate("a", 64),
          inspected_at: DateTime.utc_now()
        }
      })

    assert %{
             "provider_account" => %{
               "capabilities" => %{"can_authorize_setup" => true},
               "authentication" => %{
                 "state" => "authentication_required",
                 "method" => "none",
                 "configuration_identity" => "qe-fake-provider-account-auth-v1"
               }
             }
           } =
             build_conn()
             |> get("/api/v1/provider-accounts/#{account.id}")
             |> json_response(200)

    request_id = Ecto.UUID.generate()

    assert %{"error" => %{"code" => "local_provider_account_setup_unavailable"}} =
             build_conn()
             |> post("/api/v1/provider-accounts/#{account.id}/setup-attempts", %{
               request_id: request_id,
               confirmed: true
             })
             |> json_response(409)

    assert %{"setup_attempt" => %{"id" => attempt_id, "state" => "authorized"}} =
             local_conn()
             |> post("/api/v1/provider-accounts/#{account.id}/setup-attempts", %{
               request_id: request_id,
               confirmed: true
             })
             |> json_response(202)

    assert_receive {:worker_protocol,
                    %{
                      "type" => "prepare_provider_account_setup",
                      "protocol_version" => 19,
                      "setup" => %{
                        "setup_attempt_id" => ^attempt_id,
                        "provider_account_id" => account_id,
                        "authorization_kind" => "provider_account_setup",
                        "environment" => %{
                          "environment_id" => "setup-api-environment",
                          "incarnation" => "setup-api-incarnation"
                        }
                      }
                    }}

    assert account_id == account.id

    assert %{"error" => %{"code" => "setup_already_authorized"}} =
             local_conn()
             |> post("/api/v1/provider-accounts/#{account.id}/setup-attempts", %{
               request_id: Ecto.UUID.generate(),
               confirmed: true
             })
             |> json_response(409)

    assert %{"error" => %{"code" => "provider_account_setup_active"}} =
             build_conn()
             |> post("/api/v1/provider-accounts/#{account.id}/actions/stop")
             |> json_response(409)

    attempt = ProviderAccountSetups.fetch(attempt_id)
    process_generation = Ecto.UUID.generate()
    attention_id = Ecto.UUID.generate()

    assert {:ok, waiting} =
             ProviderAccountSetups.record(
               worker.id,
               worker.connection_generation,
               %{
                 setup_attempt_id: attempt.id,
                 provider_account_id: account.id,
                 setup_generation: attempt.setup_generation,
                 credential_generation: attempt.credential_generation_before,
                 environment_generation: attempt.environment_generation,
                 worker_generation: attempt.worker_generation,
                 environment_operation_id: attempt.environment_operation_id,
                 invocation_worker_generation: attempt.worker_generation,
                 invocation_environment_operation_id: attempt.environment_operation_id,
                 backend_kind: environment.backend_kind,
                 environment_id: environment.environment_id,
                 environment_incarnation: environment.incarnation,
                 state: "human_interaction_required",
                 invocation_state: "acknowledged",
                 process: %{
                   backend_process_id: "setup-api-pid",
                   process_start_identity: "setup-api-start",
                   process_generation: process_generation,
                   executable: "/usr/bin/qe-fake-provider-login"
                 },
                 attention: %{
                   attention_id: attention_id,
                   kind: "provider_authentication",
                   message: "Complete deterministic sign-in."
                 },
                 preflight: %{
                   state: "authentication_required",
                   method: "none",
                   configuration_identity: attempt.auth_configuration_identity,
                   environment_policy: attempt.auth_environment_policy,
                   evidence_identity: attempt.authorization_inspection_identity,
                   inspected_at: DateTime.utc_now()
                 },
                 validation: nil,
                 failure_code: nil,
                 observed_at: DateTime.utc_now()
               }
             )

    ephemeral = "https://fake-provider.invalid/device?code=ephemeral-only"

    :ok =
      ProviderAccountSetupInteractions.put(
        waiting.id,
        waiting.setup_generation,
        attention_id,
        process_generation,
        ephemeral
      )

    {client_public_key, client_private_key} = interaction_encryption_key()
    telemetry_id = {__MODULE__, make_ref()}
    test_process = self()

    :ok =
      :telemetry.attach(
        telemetry_id,
        [:phoenix, :endpoint, :stop],
        fn _event, _measurements, metadata, destination ->
          send(destination, {:provider_account_endpoint_telemetry, metadata})
        end,
        test_process
      )

    on_exit(fn -> :telemetry.detach(telemetry_id) end)

    interaction_conn =
      local_conn()
      |> put_req_header("x-qe-interaction-public-key", client_public_key)
      |> get(
        "/api/v1/provider-accounts/#{account.id}/setup-attempts/#{attempt_id}/interactions/#{attention_id}?generation=#{waiting.setup_generation}"
      )

    assert ["no-store"] = get_resp_header(interaction_conn, "cache-control")
    refute interaction_conn.resp_body =~ ephemeral

    assert %{"interaction" => %{"output" => sealed_output}} =
             json_response(interaction_conn, 200)

    assert decrypt_interaction(sealed_output, client_private_key) == ephemeral
    assert_receive {:provider_account_endpoint_telemetry, interaction_telemetry}
    refute inspect(interaction_telemetry, limit: :infinity) =~ ephemeral

    sensitive_input = "fake-sensitive-input-never-durable"

    response_conn =
      local_conn()
      |> post(
        "/api/v1/provider-accounts/#{account.id}/setup-attempts/#{attempt_id}/respond",
        %{
          setup_generation: waiting.setup_generation,
          attention_id: attention_id,
          request_id: Ecto.UUID.generate(),
          value: sensitive_input
        }
      )

    refute inspect(response_conn.params) =~ sensitive_input
    refute inspect(response_conn.body_params) =~ sensitive_input
    assert_receive {:provider_account_endpoint_telemetry, response_telemetry}
    refute inspect(response_telemetry, limit: :infinity) =~ sensitive_input

    assert %{
             "setup_attempt" => %{
               "id" => ^attempt_id,
               "attention" => %{
                 "response_state" => "responded",
                 "delivery_state" => "delivery_requested"
               }
             }
           } = json_response(response_conn, 200)

    assert_receive {:worker_protocol,
                    %{
                      "type" => "respond_provider_account_setup",
                      "setup_attempt_id" => ^attempt_id,
                      "attention_id" => ^attention_id,
                      "process_generation" => ^process_generation,
                      "value" => ^sensitive_input
                    }}

    refute durable_setup_text_contains?(sensitive_input)
    refute durable_setup_text_contains?(ephemeral)

    assert %{"setup_attempts" => [%{"id" => ^attempt_id}]} =
             build_conn()
             |> get("/api/v1/provider-accounts/#{account.id}/setup-attempts")
             |> json_response(200)
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

  defp local_conn do
    build_conn()
    |> Map.put(:host, "localhost")
    |> Map.put(:remote_ip, {127, 0, 0, 1})
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-quest-engineering-local-client", "tauri")
  end

  defp interaction_encryption_key do
    private_key = :public_key.generate_key({:rsa, 2048, 65_537})
    public_key = {:RSAPublicKey, elem(private_key, 2), elem(private_key, 3)}

    {:SubjectPublicKeyInfo, der, :not_encrypted} =
      :public_key.pem_entry_encode(:SubjectPublicKeyInfo, public_key)

    {Base.encode64(der), private_key}
  end

  defp decrypt_interaction(sealed, private_key) do
    key =
      sealed["encrypted_key"]
      |> Base.decode64!()
      |> :public_key.decrypt_private(private_key,
        rsa_pad: :rsa_pkcs1_oaep_padding,
        rsa_oaep_md: :sha256
      )

    :crypto.crypto_one_time_aead(
      :aes_256_gcm,
      key,
      Base.decode64!(sealed["iv"]),
      Base.decode64!(sealed["ciphertext"]),
      "",
      Base.decode64!(sealed["tag"]),
      false
    )
  end

  defp durable_setup_text_contains?(value) do
    sql = """
    SELECT EXISTS (
      SELECT 1 FROM provider_account_setup_attempts WHERE row_to_json(provider_account_setup_attempts)::text LIKE $1
      UNION ALL
      SELECT 1 FROM provider_account_setup_authorizations WHERE row_to_json(provider_account_setup_authorizations)::text LIKE $1
      UNION ALL
      SELECT 1 FROM provider_account_setup_events WHERE row_to_json(provider_account_setup_events)::text LIKE $1
      UNION ALL
      SELECT 1 FROM provider_account_human_attention_requests WHERE row_to_json(provider_account_human_attention_requests)::text LIKE $1
    )
    """

    %{rows: [[result]]} = Repo.query!(sql, ["%#{value}%"])
    result
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
      "features" => [
        "provider_account_environments_v1",
        "provider_account_setup_v1",
        "provider_account_auth_preflight_v1"
      ],
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
