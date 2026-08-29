defmodule QuestEngineering.ServerWeb.ProductApiTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.ServerWeb.Endpoint

  @endpoint Endpoint

  test "Class API uses explicit DTOs, immutable keys, and archival" do
    create =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/api/v1/classes", %{key: "builder-api", name: "Builder", instructions: "Build."})

    assert %{"class" => %{"id" => id, "key" => "builder-api", "archived_at" => nil}} =
             json_response(create, 201)

    update =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> patch("/api/v1/classes/#{id}", %{key: "renamed"})

    assert %{"error" => %{"code" => "conflict"}} = json_response(update, 409)

    archived = post(build_conn(), "/api/v1/classes/#{id}/archive")
    assert %{"class" => %{"archived_at" => archived_at}} = json_response(archived, 200)
    assert is_binary(archived_at)

    listed = get(build_conn(), "/api/v1/classes?include_archived=true")

    assert %{"classes" => [%{"id" => ^id, "archived_at" => ^archived_at}]} =
             json_response(listed, 200)
  end

  test "Loadout, Squad, Tactic, and Quest endpoints use Product DTOs and previews are side-effect free" do
    root = Path.expand(".pi/tmp/api-product-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)

    previous_scheduler = Application.get_env(:quest_engineering_server, :scheduler_enabled)

    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:product-api" => root})

    Application.put_env(:quest_engineering_server, :scheduler_enabled, false)

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})

      Application.put_env(
        :quest_engineering_server,
        :scheduler_enabled,
        if(is_nil(previous_scheduler), do: true, else: previous_scheduler)
      )
    end)

    class =
      post_json("/api/v1/classes", %{key: "builder-http", name: "Builder", instructions: "Build."})

    assert %{"class" => %{"id" => class_id}} = json_response(class, 201)

    loadout =
      post_json("/api/v1/loadouts", %{
        key: "coding-http",
        name: "Coding",
        model: %{provider: "fake", model: "test"},
        reasoning: "medium",
        tools: ["workspace.filesystem"],
        workspace_access: "read_write"
      })

    assert %{"loadout" => %{"id" => loadout_id, "model" => %{"provider" => "fake"}}} =
             json_response(loadout, 201)

    squad =
      post_json("/api/v1/squads", %{
        key: "squad-http",
        name: "HTTP Squad",
        members: [
          %{member_key: "alice", name: "Alice", class_id: class_id, loadout_id: loadout_id}
        ]
      })

    assert %{"squad" => %{"id" => squad_id, "members" => [%{"member_key" => "alice"}]}} =
             json_response(squad, 201)

    body = %{
      type: "step",
      key: "implement",
      name: "Implement",
      instruction: "Implement.",
      performer: %{selector: "class", value: "builder-http"},
      context: %{selector: "fresh", value: nil},
      consumes: [],
      produces: []
    }

    tactic =
      post_json("/api/v1/tactics", %{
        key: "implementation-http",
        name: "Implementation",
        body: body
      })

    assert %{"tactic" => %{"id" => tactic_id, "body" => %{"type" => "step"}}} =
             json_response(tactic, 201)

    quest =
      post_json("/api/v1/quests", %{
        title: "HTTP Quest",
        objective: "Verify the Product API.",
        workspace_ref: "workspace:product-api",
        squad_id: squad_id,
        tactic_source: %{type: "definition", tactic_definition_id: tactic_id}
      })

    assert %{"quest" => %{"id" => quest_id, "tactic_source" => %{"type" => "definition"}}} =
             json_response(quest, 201)

    runs_before = Repo.aggregate(RuntimeRun, :count)
    outbox_before = Repo.aggregate(RuntimeOutbox, :count)

    assert %{"preview" => %{"resolved_tactic" => %{"type" => "step"}}} =
             json_response(post_json("/api/v1/tactics/#{tactic_id}/preview", %{}), 200)

    assert %{"preview" => %{"quest" => %{"id" => ^quest_id}}} =
             json_response(post_json("/api/v1/quests/#{quest_id}/preview", %{}), 200)

    assert Repo.aggregate(RuntimeRun, :count) == runs_before
    assert Repo.aggregate(RuntimeOutbox, :count) == outbox_before

    launch = post_json("/api/v1/quests/#{quest_id}/launch", %{})

    assert %{"launch" => %{"run_id" => run_id}, "run" => %{"status" => "waiting"}} =
             json_response(launch, 201)

    updated_class = patch(build_conn(), "/api/v1/classes/#{class_id}", %{name: "Changed Builder"})
    assert %{"class" => %{"name" => "Changed Builder"}} = json_response(updated_class, 200)
    projection = get(build_conn(), "/api/v1/runs/#{run_id}")

    assert %{"run" => %{"squad" => %{"members" => [%{"class" => %{"name" => "Builder"}}]}}} =
             json_response(projection, 200)

    assert %{"loadout" => %{"id" => ^loadout_id}} =
             json_response(post(build_conn(), "/api/v1/loadouts/#{loadout_id}/archive"), 200)

    assert %{"squad" => %{"id" => ^squad_id}} =
             json_response(post(build_conn(), "/api/v1/squads/#{squad_id}/archive"), 200)

    assert %{"tactic" => %{"id" => ^tactic_id}} =
             json_response(post(build_conn(), "/api/v1/tactics/#{tactic_id}/archive"), 200)

    assert %{"quest" => %{"id" => ^quest_id}} =
             json_response(post(build_conn(), "/api/v1/quests/#{quest_id}/archive"), 200)
  end

  test "workspace discovery exposes no filesystem roots" do
    root = Path.expand(".pi/tmp/api-workspace-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)

    Application.put_env(:quest_engineering_server, :workspaces, %{
      "workspace:api" => %{root: root, label: "API Workspace"}
    })

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})
    end)

    response = get(build_conn(), "/api/v1/workspaces")

    assert %{"workspaces" => [%{"ref" => "workspace:api", "name" => "API Workspace"}]} =
             json_response(response, 200)

    refute Jason.encode!(json_response(response, 200)) =~ root
  end

  defp post_json(path, body) do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> post(path, body)
  end
end
