defmodule QuestEngineering.Server.WorkerBindingReconciliationTest do
  use QuestEngineering.Server.DataCase, async: true

  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.Server.WorkerStore

  test "Worker with no bindings registers and reconciles normally" do
    worker = register("worker-empty")

    assert {:ok, []} =
             WorkerStore.reconcile_workspace_bindings(worker.id, worker.connection_generation, [])

    assert {:ok, %{status: "connected", capabilities: %{"workspace_bindings" => []}}} =
             WorkerStore.fetch(worker.id)
  end

  test "one valid binding reconciles as available" do
    workspace = workspace("valid")
    worker = register("worker-valid")
    binding = binding_fixture(workspace.id)

    assert {:ok, [%{status: "accepted"}]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               [binding]
             )

    assert %{status: "available", workspace_id: workspace_id} =
             Repo.get!(WorkerWorkspaceBinding, binding["binding_id"])

    assert workspace_id == workspace.id
  end

  test "duplicate available repository root is a conflict instead of crashing reconciliation" do
    first = workspace("duplicate-root-first")
    second = workspace("duplicate-root-second")
    worker = register("worker-duplicate-root")
    first_binding = binding_fixture(first.id, "duplicate-root")
    second_binding = binding_fixture(second.id, "duplicate-root")

    assert {:ok,
            [
              %{status: "accepted"},
              %{status: "conflict", code: "constraint_failure"}
            ]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               [first_binding, second_binding]
             )

    assert %{status: "available"} =
             Repo.get!(WorkerWorkspaceBinding, first_binding["binding_id"])

    refute Repo.get(WorkerWorkspaceBinding, second_binding["binding_id"])
    assert {:ok, %{status: "connected"}} = WorkerStore.fetch(worker.id)
  end

  test "archived Workspace binding becomes stale and its repository root can be rebound" do
    archived_workspace = workspace("archived-root")
    replacement_workspace = workspace("replacement-root")
    worker = register("worker-rebound-root")
    archived_binding = binding_fixture(archived_workspace.id, "rebound-root")
    replacement_binding = binding_fixture(replacement_workspace.id, "rebound-root")

    assert {:ok, [%{status: "accepted"}]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               [archived_binding]
             )

    assert :ok = Products.archive_workspace(archived_workspace.id)

    assert %{status: "unavailable"} =
             Repo.get!(WorkerWorkspaceBinding, archived_binding["binding_id"])

    assert {:ok,
            [
              %{status: "stale_workspace", code: "workspace_not_found"},
              %{status: "accepted"}
            ]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               [archived_binding, replacement_binding]
             )

    assert %{status: "unavailable"} =
             Repo.get!(WorkerWorkspaceBinding, archived_binding["binding_id"])

    assert %{status: "available"} =
             Repo.get!(WorkerWorkspaceBinding, replacement_binding["binding_id"])
  end

  test "missing Workspace retires only that reconciliation and leaves Worker connected" do
    worker = register("worker-stale")
    stale = binding_fixture(Ecto.UUID.generate())

    assert {:ok,
            [
              %{
                status: "stale_workspace",
                code: "workspace_not_found",
                binding_id: binding_id
              }
            ]} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               [stale]
             )

    assert binding_id == stale["binding_id"]
    assert {:ok, %{status: "connected"}} = WorkerStore.fetch(worker.id)
    refute Repo.get(WorkerWorkspaceBinding, stale["binding_id"])
  end

  test "valid and stale bindings reconcile independently" do
    first = workspace("mixed-first")
    second = workspace("mixed-second")
    worker = register("worker-mixed")
    stale = binding_fixture(Ecto.UUID.generate(), "stale")
    bindings = [binding_fixture(first.id, "first"), stale, binding_fixture(second.id, "second")]

    assert {:ok, outcomes} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               bindings
             )

    assert Enum.map(outcomes, & &1.status) == ["accepted", "stale_workspace", "accepted"]
    assert Repo.aggregate(WorkerWorkspaceBinding, :count) == 2
    assert {:ok, %{status: "connected"}} = WorkerStore.fetch(worker.id)
  end

  test "multiple stale bindings do not prevent registration" do
    worker = register("worker-multiple-stale")

    bindings = [
      binding_fixture(Ecto.UUID.generate(), "one"),
      binding_fixture(Ecto.UUID.generate(), "two")
    ]

    assert {:ok, outcomes} =
             WorkerStore.reconcile_workspace_bindings(
               worker.id,
               worker.connection_generation,
               bindings
             )

    assert Enum.all?(outcomes, &(&1.status == "stale_workspace"))
    assert Repo.aggregate(WorkerWorkspaceBinding, :count) == 0
    assert {:ok, %{status: "connected"}} = WorkerStore.fetch(worker.id)
  end

  test "older connection generation cannot reconcile after a newer registration" do
    first = register("worker-generation")
    second = register("worker-generation")
    workspace = workspace("generation")

    assert {:error, %WorkerError{type: :stale_connection_generation}} =
             WorkerStore.reconcile_workspace_bindings(
               first.id,
               first.connection_generation,
               [binding_fixture(workspace.id)]
             )

    assert second.connection_generation == first.connection_generation + 1
    assert Repo.aggregate(WorkerWorkspaceBinding, :count) == 0
  end

  defp register(id) do
    assert {:ok, worker} = WorkerStore.register(id, capabilities(), Ecto.UUID.generate())
    worker
  end

  defp workspace(key) do
    assert {:ok, workspace} =
             Products.create_workspace(%{
               key: "binding-reconciliation-#{key}",
               name: "Binding reconciliation #{key}",
               source_kind: :local_git,
               source_fingerprint: nil
             })

    workspace
  end

  defp binding_fixture(workspace_id, suffix \\ "binding") do
    %{
      "binding_id" => Ecto.UUID.generate(),
      "workspace_id" => workspace_id,
      "authorized_root_key" => "projects",
      "source_repository_root" => ".pi/tmp/#{suffix}",
      "source_fingerprint" => nil,
      "publication_remote_name" => nil,
      "publication_repository_identity" => nil,
      "max_access" => "read_write",
      "allow_unconfined_shell" => false
    }
  end

  defp capabilities do
    %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [],
      "workspace_bindings" => []
    }
  end
end
