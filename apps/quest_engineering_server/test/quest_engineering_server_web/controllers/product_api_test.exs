defmodule QuestEngineering.ServerWeb.ProductApiTest do
  use QuestEngineering.Server.DataCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerStore
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

  test "Tactic preview projects inferred, explicit, and nested semantic artifact sources" do
    tactics_before = Repo.aggregate(ProductTactic, :count)

    inferred =
      sequence_body([
        step_body("implement", produces: ["change_set"]),
        step_body("review", consumes: [%{type: "change_set", source: nil}])
      ])

    inferred_preview = preview_inline(inferred, 200)
    refute Map.has_key?(inferred_preview, "execution_plan")

    assert [binding] = inferred_preview["artifact_bindings"]
    assert binding["artifact_type"] == "change_set"
    assert binding["selection"] == "inferred"
    assert binding["consumer"]["local_key"] == "review"
    assert binding["source"]["kind"] == "step"
    assert binding["source"]["step"]["local_key"] == "implement"

    explicit =
      sequence_body([
        step_body("implement", produces: ["change_set"]),
        step_body("review", consumes: [%{type: "change_set", source: "implement"}])
      ])

    assert [%{"selection" => "explicit"}] =
             preview_inline(explicit, 200)["artifact_bindings"]

    child =
      post_json("/api/v1/tactics", %{
        key: "nested-child-http",
        name: "Nested Child",
        body: step_body("implement", produces: ["change_set"])
      })
      |> json_response(201)
      |> get_in(["tactic"])

    nested =
      sequence_body([
        %{type: "use", instance_key: "backend", tactic_definition_id: child["id"]},
        step_body("review", consumes: [%{type: "change_set", source: nil}])
      ])

    nested_preview = preview_inline(nested, 200)
    [nested_binding] = nested_preview["artifact_bindings"]
    producer = nested_binding["source"]["step"]
    assert producer["local_key"] == "implement"

    assert producer["instance_path"] == [
             %{
               "instance_key" => "backend",
               "definition_key" => "nested-child-http",
               "definition_name" => "Nested Child"
             }
           ]

    encoded = Jason.encode!(nested_preview)
    refute encoded =~ "execution_plan"
    refute encoded =~ "control_dependencies"
    refute encoded =~ "occurrence_id"
    refute encoded =~ "attempt_id"
    assert Repo.aggregate(ProductTactic, :count) == tactics_before + 1
  end

  test "Tactic preview errors retain safe artifact context and contextual saves remain valid" do
    missing = step_body("review", consumes: [%{type: "plan", source: nil}])
    missing_error = preview_inline(missing, 422)["error"]
    assert missing_error["code"] == "preview_failed"

    assert [%{"code" => "missing_artifact", "details" => missing_details}] =
             missing_error["details"]

    assert missing_details["artifact_type"] == "plan"
    assert missing_details["consumer_step"]["local_key"] == "review"

    contextual =
      post_json("/api/v1/tactics", %{
        key: "contextual-http",
        name: "Contextual",
        body: missing
      })

    assert %{"tactic" => %{"id" => contextual_id}} = json_response(contextual, 201)

    assert %{"error" => %{"details" => [%{"code" => "missing_artifact"}]}} =
             json_response(post_json("/api/v1/tactics/#{contextual_id}/preview", %{}), 422)

    ambiguous =
      sequence_body([
        %{
          type: "parallel",
          children: [
            step_body("backend", produces: ["change_set"]),
            step_body("frontend", produces: ["change_set"])
          ]
        },
        step_body("review", consumes: [%{type: "change_set", source: nil}])
      ])

    ambiguous_error = preview_inline(ambiguous, 422)["error"]

    assert [%{"code" => "ambiguous_artifact", "details" => ambiguous_details}] =
             ambiguous_error["details"]

    assert ambiguous_details["artifact_type"] == "change_set"

    assert Enum.map(ambiguous_details["candidate_steps"], & &1["local_key"]) == [
             "backend",
             "frontend"
           ]

    invalid_source =
      sequence_body([
        step_body("implement", produces: ["change_set"]),
        step_body("review",
          consumes: [%{type: "change_set", source: "future"}]
        ),
        step_body("future", produces: ["change_set"])
      ])

    invalid_error = preview_inline(invalid_source, 422)["error"]

    assert [%{"code" => "invalid_artifact_source", "details" => invalid_details}] =
             invalid_error["details"]

    assert invalid_details["artifact_type"] == "change_set"
    assert invalid_details["consumer_step"]["local_key"] == "review"
    assert invalid_details["requested_source"]["local_key"] == "future"
  end

  test "persisted-definition candidate preview detects cycles without mutation" do
    a =
      post_json("/api/v1/tactics", %{
        key: "candidate-a-http",
        name: "Candidate A",
        body: step_body("work")
      })
      |> json_response(201)
      |> get_in(["tactic"])

    c =
      post_json("/api/v1/tactics", %{
        key: "candidate-c-http",
        name: "Candidate C",
        body: %{type: "use", instance_key: "to-a", tactic_definition_id: a["id"]}
      })
      |> json_response(201)
      |> get_in(["tactic"])

    b =
      post_json("/api/v1/tactics", %{
        key: "candidate-b-http",
        name: "Candidate B",
        body: %{type: "use", instance_key: "to-c", tactic_definition_id: c["id"]}
      })
      |> json_response(201)
      |> get_in(["tactic"])

    direct = %{
      type: "use",
      instance_key: "self",
      tactic_definition_id: a["id"]
    }

    assert %{
             "error" => %{
               "details" => [
                 %{
                   "code" => "cyclic_tactic_reference",
                   "definition_path" => ["candidate-a-http", "candidate-a-http"]
                 }
               ]
             }
           } =
             post_json("/api/v1/tactics/#{a["id"]}/preview", %{body: direct})
             |> json_response(422)

    candidate = %{type: "use", instance_key: "to-b", tactic_definition_id: b["id"]}

    response = post_json("/api/v1/tactics/#{a["id"]}/preview", %{body: candidate})

    assert %{
             "error" => %{
               "code" => "preview_failed",
               "details" => [
                 %{
                   "code" => "cyclic_tactic_reference",
                   "definition_path" => [
                     "candidate-a-http",
                     "candidate-b-http",
                     "candidate-c-http",
                     "candidate-a-http"
                   ]
                 }
               ]
             }
           } = json_response(response, 422)

    persisted = get(build_conn(), "/api/v1/tactics/#{a["id"]}") |> json_response(200)
    assert persisted["tactic"]["body"] == a["body"]
  end

  test "Loadout, Squad, Tactic, and Quest endpoints use Product DTOs and previews are side-effect free" do
    root = Path.expand(".pi/tmp/api-product-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)

    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:product-api" => root})

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})
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

    %{"workspace" => %{"id" => workspace_id}} =
      post_json("/api/v1/workspaces", %{
        key: "product-api",
        name: "Product API",
        source_kind: "local_git"
      })
      |> json_response(201)

    quest =
      post_json("/api/v1/quests", %{
        title: "HTTP Quest",
        objective: "Verify the Product API.",
        workspace_id: workspace_id,
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

  test "client CORS allows only configured origins" do
    previous = Application.get_env(:quest_engineering_server, :client_origins)
    Application.put_env(:quest_engineering_server, :client_origins, ["tauri://localhost"])

    on_exit(fn ->
      Application.put_env(:quest_engineering_server, :client_origins, previous || [])
    end)

    response =
      build_conn()
      |> put_req_header("origin", "tauri://localhost")
      |> get("/api/v1/health")

    assert get_resp_header(response, "access-control-allow-origin") == ["tauri://localhost"]

    rejected =
      build_conn()
      |> put_req_header("origin", "https://not-allowed.example")
      |> get("/api/v1/health")

    assert get_resp_header(rejected, "access-control-allow-origin") == []
  end

  test "execution options expose deduplicated coherent profiles without Worker infrastructure" do
    {:ok, workspace} =
      Products.create_workspace(%{
        key: "api-options",
        name: "workspace:api",
        source_kind: :local_git
      })

    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 2,
      "tags" => ["internal"],
      "executors" => [
        %{
          "adapter" => "private-adapter",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "high"],
          "tools" => ["workspace.filesystem", "workspace.search"],
          "workspaces" => [
            %{
              "ref" => "workspace:api",
              "root" => "/not-for-clients",
              "max_access" => "read_write"
            }
          ]
        }
      ]
    }

    {:ok, _} = WorkerStore.register("options-one", capabilities, Ecto.UUID.generate())
    {:ok, _} = WorkerStore.register("options-two", capabilities, Ecto.UUID.generate())

    response = get(build_conn(), "/api/v1/execution-options")

    assert %{
             "execution_options" => [
               %{
                 "model" => %{"provider" => "fake", "model" => "test"},
                 "reasoning" => ["high", "low"],
                 "tools" => ["workspace.filesystem", "workspace.search"],
                 "workspaces" => [
                   %{
                     "workspace_id" => workspace_id,
                     "workspace_access" => ["none", "read_only", "read_write"]
                   }
                 ],
                 "available" => true
               }
             ]
           } = json_response(response, 200)

    assert workspace_id == workspace.id
    encoded = Jason.encode!(json_response(response, 200))
    refute encoded =~ "options-one"
    refute encoded =~ "private-adapter"
    refute encoded =~ "/not-for-clients"
    refute encoded =~ "max_concurrency"
  end

  test "logical Workspace APIs expose no Worker filesystem roots" do
    created =
      post_json("/api/v1/workspaces", %{
        key: "api-workspace",
        name: "API Workspace",
        source_kind: "local_git"
      })
      |> json_response(201)

    response = get(build_conn(), "/api/v1/workspaces")

    assert %{
             "workspaces" => [
               %{
                 "id" => workspace_id,
                 "key" => "api-workspace",
                 "name" => "API Workspace",
                 "source_kind" => "local_git"
               }
             ]
           } = json_response(response, 200)

    assert created["workspace"]["id"] == workspace_id
    refute Jason.encode!(json_response(response, 200)) =~ "/Users/"
  end

  defp preview_inline(body, status) do
    post_json("/api/v1/tactics/preview", %{
      tactic_source: %{type: "inline", body: body}
    })
    |> json_response(status)
    |> case do
      %{"preview" => preview} -> preview
      error -> error
    end
  end

  defp sequence_body(children), do: %{type: "sequence", children: children}

  defp step_body(key, options \\ []) do
    %{
      type: "step",
      key: key,
      name: key |> String.replace("-", " ") |> String.capitalize(),
      instruction: "Perform #{key}.",
      performer: %{selector: "class", value: "builder"},
      context: %{selector: "fresh", value: nil},
      consumes: Keyword.get(options, :consumes, []),
      produces: Enum.map(Keyword.get(options, :produces, []), &%{type: &1, source: nil})
    }
  end

  defp post_json(path, body) do
    build_conn()
    |> put_req_header("content-type", "application/json")
    |> post(path, body)
  end
end
