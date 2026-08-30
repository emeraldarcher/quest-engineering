# credo:disable-for-this-file Credo.Check.Refactor.Nesting
defmodule QuestEngineering.Server.WorkspaceControl do
  @moduledoc "Control-plane mediation for Worker-local source discovery and logical binding."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.Persistence.ProductWorkspace
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceBinding
  alias QuestEngineering.Server.Persistence.WorkerWorkspaceCandidate
  alias QuestEngineering.Server.Persistence.WorkspaceBindingAttempt
  alias QuestEngineering.Server.ProductChangeNotifier
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
        publication_remote_name: candidate.publication_remote_name,
        publication_repository_identity: candidate.publication_repository_identity,
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
         true <- worker.status == "connected" do
      binding_id = Ecto.UUID.generate()

      with {:ok, attempt} <-
             Repo.insert(
               WorkspaceBindingAttempt.changeset(%{
                 binding_id: binding_id,
                 workspace_id: workspace.id,
                 worker_id: worker.id,
                 candidate_id: candidate.candidate_id,
                 state: "pending"
               })
             ) do
        result =
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
          )

        case result do
          :ok ->
            ProductChangeNotifier.notify(["workspaces", "execution_options"])
            {:ok, %{binding_id: binding_id, status: "preparing"}}

          {:error, reason} = error ->
            attempt
            |> Changeset.change(
              state: "offline",
              failure_code: "worker_unavailable",
              failure_details: safe_failure(%{reason: inspect(reason)})
            )
            |> Repo.update!()

            ProductChangeNotifier.notify(["workspaces", "execution_options"])
            error
        end
      end
    else
      nil -> {:error, :not_found}
      false -> {:error, :worker_unavailable}
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
          publication_remote_name: candidate.publication_remote_name,
          publication_repository_identity: candidate.publication_repository_identity,
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
               :publication_remote_name,
               :publication_repository_identity,
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

    result = if existing, do: Repo.update(changeset), else: Repo.insert(changeset)

    if match?({:ok, _}, result) do
      if attempt = Repo.get(WorkspaceBindingAttempt, binding.binding_id),
        do:
          attempt
          |> Changeset.change(state: "available", failure_code: nil, failure_details: nil)
          |> Repo.update!()

      ProductChangeNotifier.notify(["workspaces", "execution_options"])
    end

    result
  end

  def record_binding_failure(worker_id, binding) do
    case Repo.get(WorkspaceBindingAttempt, binding["binding_id"]) do
      %{worker_id: ^worker_id} = attempt ->
        result =
          attempt
          |> Changeset.change(
            state: "attention_required",
            failure_code: binding["failure_code"] || "workspace_binding_failed",
            failure_details: safe_failure(binding["failure_details"] || %{})
          )
          |> Repo.update()

        ProductChangeNotifier.notify(["workspaces", "execution_options"])
        result

      _ ->
        {:error, :binding_attempt_not_found}
    end
  end

  def binding_state(workspace_id) do
    Repo.one(
      from attempt in WorkspaceBindingAttempt,
        where: attempt.workspace_id == ^workspace_id,
        order_by: [desc: attempt.inserted_at],
        limit: 1
    ) ||
      case Repo.one(
             from binding in WorkerWorkspaceBinding,
               where: binding.workspace_id == ^workspace_id and binding.status == "available",
               limit: 1
           ) do
        nil -> nil
        _ -> %{state: "available"}
      end
  end

  defp safe_failure(value) when is_map(value),
    do:
      value
      |> Enum.take(10)
      |> Map.new(fn {key, nested} ->
        {to_string(key), if(is_binary(nested), do: String.slice(nested, 0, 300), else: nested)}
      end)

  defp safe_failure(_), do: %{}

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
