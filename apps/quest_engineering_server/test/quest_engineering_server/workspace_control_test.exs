defmodule QuestEngineering.Server.WorkspaceControlTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Persistence.WorkspaceBindingAttempt
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerStore
  alias QuestEngineering.Server.WorkspaceControl
  alias QuestEngineering.ServerWeb.Endpoint

  test "readiness derives from durable bindings and current Worker availability" do
    {:ok, workspace} = workspace()
    connection_id = Ecto.UUID.generate()
    {:ok, worker} = WorkerStore.register("workspace-worker", capabilities(), connection_id)

    Repo.insert!(
      WorkerWorkspaceBinding.changeset(%{
        binding_id: Ecto.UUID.generate(),
        worker_id: worker.id,
        workspace_id: workspace.id,
        authorized_root_key: "projects",
        source_repository_root: ".pi/tmp/project",
        source_fingerprint: workspace.source_fingerprint,
        max_access: "read_write",
        allow_unconfined_shell: false,
        status: "available",
        last_seen_generation: worker.connection_generation,
        last_seen_at: DateTime.utc_now()
      })
    )

    assert %{state: "available"} = WorkspaceControl.binding_state(workspace.id)

    assert {:ok, _worker} =
             WorkerStore.disconnect(worker.id, connection_id, worker.connection_generation)

    assert %{state: "offline"} = WorkspaceControl.binding_state(workspace.id)
  end

  test "pending and actionable failures project separately from unbound" do
    {:ok, unbound} = workspace("unbound-project")
    assert WorkspaceControl.binding_state(unbound.id) == nil

    pending =
      Repo.insert!(
        WorkspaceBindingAttempt.changeset(%{
          binding_id: Ecto.UUID.generate(),
          workspace_id: unbound.id,
          worker_id: register_worker("pending-worker").id,
          candidate_id: candidate(unbound.id, "pending-worker"),
          state: "pending"
        })
      )

    assert %{state: "pending", binding_id: binding_id} =
             WorkspaceControl.binding_state(unbound.id)

    assert binding_id == pending.binding_id

    {:ok, failed} = workspace("failed-project")
    failed_worker = register_worker("failed-worker")
    failed_candidate = candidate(failed.id, failed_worker.id)

    Repo.insert!(
      WorkspaceBindingAttempt.changeset(%{
        binding_id: Ecto.UUID.generate(),
        workspace_id: failed.id,
        worker_id: failed_worker.id,
        candidate_id: failed_candidate,
        state: "offline",
        failure_code: "worker_unavailable"
      })
    )

    assert %{state: "attention_required", failure_code: "worker_unavailable"} =
             WorkspaceControl.binding_state(failed.id)
  end

  test "Worker availability transitions invalidate Product without heartbeat noise" do
    Endpoint.subscribe("product:all")
    connection_id = Ecto.UUID.generate()

    assert {:ok, worker} =
             WorkerStore.register("availability-worker", capabilities(), connection_id)

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_changed",
      payload: %{
        resources: ["workspaces", "workspace_sources", "execution_options"]
      }
    }

    assert {:ok, _worker} = WorkerStore.heartbeat(worker.id, worker.connection_generation)
    refute_receive %Phoenix.Socket.Broadcast{event: "product_changed"}, 50

    assert {:ok, _worker} =
             WorkerStore.disconnect(worker.id, connection_id, worker.connection_generation)

    assert_receive %Phoenix.Socket.Broadcast{event: "product_changed"}
  end

  test "repository discovery invalidates Product only when visible results change" do
    worker = register_worker("discovery-worker")
    Endpoint.subscribe("product:all")

    candidates = [
      %{
        candidate_id: "candidate-discovery",
        name: "quest-engineering",
        source_kind: "git_remote",
        source_fingerprint: "https://github.com/emeraldarcher/quest-engineering",
        publication_remote_name: "origin",
        publication_repository_identity: "emeraldarcher/quest-engineering",
        max_access: "read_write",
        allow_unconfined_shell: false
      }
    ]

    assert {:ok, true} = WorkspaceControl.record_candidates(worker.id, candidates)

    assert_receive %Phoenix.Socket.Broadcast{
      event: "product_changed",
      payload: %{resources: ["workspace_sources"]}
    }

    assert {:ok, false} = WorkspaceControl.record_candidates(worker.id, candidates)
    refute_receive %Phoenix.Socket.Broadcast{event: "product_changed"}, 50

    assert {:ok, true} = WorkspaceControl.record_candidates(worker.id, [])
    assert_receive %Phoenix.Socket.Broadcast{event: "product_changed"}
  end

  defp workspace(key \\ "readiness-project") do
    Products.create_workspace(%{
      key: key,
      name: "Readiness Project",
      source_kind: :git_remote,
      source_fingerprint: "https://github.com/emeraldarcher/#{key}"
    })
  end

  defp register_worker(id) do
    {:ok, worker} = WorkerStore.register(id, capabilities(), Ecto.UUID.generate())
    worker
  end

  defp candidate(_workspace_id, worker_id) do
    candidate_id = "candidate-#{worker_id}"

    Repo.insert!(%QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate{
      candidate_id: candidate_id,
      worker_id: worker_id,
      name: "project",
      source_kind: "git_remote",
      source_fingerprint: "https://github.com/emeraldarcher/project",
      max_access: "read_write",
      allow_unconfined_shell: false,
      status: "available",
      last_seen_at: DateTime.utc_now()
    })

    candidate_id
  end

  defp capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "executors" => [],
      "workspace_bindings" => []
    }
  end
end
