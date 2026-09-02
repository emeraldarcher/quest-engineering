defmodule QuestEngineering.ServerWeb.StarterCrewApiTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.ServerWeb.Endpoint

  @endpoint Endpoint

  test "status and atomic command return Product-safe starter DTOs" do
    assert %{"starter_crew" => %{"state" => "empty", "conflict" => nil}} =
             get(build_conn(), "/api/v1/starter-crew") |> json_response(200)

    workspace = compatible_workspace!()

    response =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/starter-crew", %{workspace_id: workspace.id})
      |> json_response(200)

    assert %{
             "starter_crew" => %{
               "status" => "ready",
               "classes" => [
                 %{"id" => builder_id, "key" => "builder"},
                 %{"key" => "reviewer"}
               ],
               "loadouts" => loadouts = [%{"key" => "coding"}, %{"key" => "review"}],
               "squad" => %{
                 "key" => "engineering-pair",
                 "members" => [
                   %{"member_key" => "builder"},
                   %{"member_key" => "reviewer"}
                 ]
               },
               "tactic" => %{"key" => "implement-and-review"}
             }
           } = response

    refute Enum.any?(loadouts, &Map.has_key?(&1, "instructions"))

    assert %{"starter_crew" => %{"state" => "complete"}} =
             get(build_conn(), "/api/v1/starter-crew") |> json_response(200)

    assert {:ok, _customized} =
             Products.update_class(builder_id, %{
               instructions: "Use the established team practice."
             })

    assert %{"starter_crew" => %{"state" => "manual_configuration", "conflict" => nil}} =
             get(build_conn(), "/api/v1/starter-crew") |> json_response(200)

    refute Jason.encode!(response) =~ "starter=true"
    refute Jason.encode!(response) =~ "worker_id"
    refute Jason.encode!(response) =~ "workspace_id"
  end

  test "canonical conflicts use a typed safe response and commit no new starter entities" do
    {:ok, _class} =
      Products.create_class(%{key: "builder", name: "Custom", instructions: "Custom."})

    assert %{
             "starter_crew" => %{
               "state" => "conflict",
               "conflict" => %{"entity_type" => "class", "key" => "builder"}
             }
           } = get(build_conn(), "/api/v1/starter-crew") |> json_response(200)

    response =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/starter-crew", %{workspace_id: Ecto.UUID.generate()})
      |> json_response(409)

    assert %{
             "error" => %{
               "code" => "starter_conflict",
               "message" => "Starter setup conflicts with existing Product configuration.",
               "meta" => %{"entity_type" => "class", "key" => "builder"}
             }
           } = response
  end

  test "missing request configuration is malformed rather than exposing internals" do
    assert %{"error" => %{"code" => "malformed_request"}} =
             build_conn()
             |> put_req_header("content-type", "application/json")
             |> post("/api/v1/starter-crew", %{})
             |> json_response(400)
  end

  defp compatible_workspace! do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "starter-api-project",
        name: "workspace:starter-api",
        source_kind: :local_git
      })

    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "starter"}],
          "reasoning" => ["low", "medium"],
          "tools" => ["workspace.filesystem", "workspace.search"],
          "workspaces" => [
            %{
              "ref" => "workspace:starter-api",
              "root" => "/not-exposed",
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }

    {:ok, _worker} =
      WorkerStore.register("starter-api-worker", capabilities, Ecto.UUID.generate())

    workspace
  end
end
