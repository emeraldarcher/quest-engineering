defmodule QuestEngineering.Server.WorkspaceControl do
  @moduledoc "Control-plane mediation for Worker-local source discovery and logical binding."

  import Ecto.Query

  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  def request_discovery do
    Repo.all(from worker in Worker, where: worker.status == "connected")
    |> Enum.each(fn worker ->
      WorkerConnections.send_protocol(
        worker.id,
        worker.connection_generation,
        WorkerProtocol.discover_workspace_sources(worker.id)
      )
    end)

    :ok
  end

  def list_candidates do
    Repo.all(
      from candidate in WorkerWorkspaceCandidate,
        join: worker in Worker,
        on: worker.id == candidate.worker_id,
        where: candidate.status == "available" and worker.status == "connected",
        order_by: [asc: candidate.name, asc: candidate.candidate_id],
        select: candidate
    )
    |> Enum.map(fn candidate ->
      %{
        candidate_id: candidate.candidate_id,
        name: candidate.name,
        source_kind: candidate.source_kind,
        source_fingerprint: candidate.source_fingerprint,
        max_access: candidate.max_access,
        shell_available: candidate.allow_unconfined_shell
      }
    end)
  end

  def bind(workspace_id, candidate_id) do
    with %ProductWorkspace{} = workspace <- Repo.get(ProductWorkspace, workspace_id),
         %WorkerWorkspaceCandidate{} = candidate <-
           Repo.get(WorkerWorkspaceCandidate, candidate_id),
         %Worker{} = worker <- Repo.get(Worker, candidate.worker_id),
         true <- worker.status == "connected",
         binding_id = Ecto.UUID.generate(),
         :ok <-
           WorkerConnections.send_protocol(
             worker.id,
             worker.connection_generation,
             WorkerProtocol.bind_workspace_source(worker.id, %{
               binding_id: binding_id,
               workspace_id: workspace.id,
               workspace_key: workspace.key,
               source_kind: workspace.source_kind,
               source_fingerprint: workspace.source_fingerprint,
               candidate_id: candidate.candidate_id
             })
           ) do
      {:ok, %{binding_id: binding_id, status: "binding"}}
    else
      nil -> {:error, :not_found}
      false -> {:error, :worker_unavailable}
      {:error, _reason} = error -> error
    end
  end

  def record_candidates(worker_id, candidates) do
    now = now()

    Repo.transaction(fn ->
      ids = Enum.map(candidates, & &1.candidate_id)

      Repo.update_all(
        from(candidate in WorkerWorkspaceCandidate,
          where: candidate.worker_id == ^worker_id and candidate.candidate_id not in ^ids
        ),
        set: [status: "unavailable", updated_at: now]
      )

      Enum.each(candidates, fn candidate ->
        attributes = %{
          candidate_id: candidate.candidate_id,
          worker_id: worker_id,
          name: candidate.name,
          source_kind: candidate.source_kind,
          source_fingerprint: candidate.source_fingerprint,
          max_access: candidate.max_access,
          allow_unconfined_shell: candidate.allow_unconfined_shell,
          status: "available",
          last_seen_at: now,
          inserted_at: now,
          updated_at: now
        }

        Repo.insert_all(WorkerWorkspaceCandidate, [attributes],
          on_conflict:
            {:replace,
             [
               :name,
               :source_kind,
               :source_fingerprint,
               :max_access,
               :allow_unconfined_shell,
               :status,
               :last_seen_at,
               :updated_at
             ]},
          conflict_target: [:candidate_id]
        )
      end)
    end)
  end

  def record_binding(worker_id, generation, binding) do
    now = now()

    attributes =
      Map.merge(binding, %{
        worker_id: worker_id,
        status: "available",
        last_seen_generation: generation,
        last_seen_at: now
      })

    existing = Repo.get(WorkerWorkspaceBinding, binding.binding_id)

    changeset =
      WorkerWorkspaceBinding.changeset(existing || %WorkerWorkspaceBinding{}, attributes)

    if existing, do: Repo.update(changeset), else: Repo.insert(changeset)
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
