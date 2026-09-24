defmodule QuestEngineering.ServerWeb.RunController do
  use QuestEngineering.ServerWeb, :controller

  alias QuestEngineering.Server.DeliveryCoordinator
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.ExecutionCancellation
  alias QuestEngineering.Server.ExecutionRecovery
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.OperationalRecovery
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Product.Repository
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.RunWorkspaceStore
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.ServerWeb.Api

  def index(conn, _params) do
    case RunProjection.list() do
      {:ok, runs} -> json(conn, %{runs: runs})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def quest_index(conn, %{"id" => quest_id}) do
    with {:ok, _quest} <- Repository.get_quest(quest_id),
         {:ok, runs} <- RunProjection.list(quest_id) do
      json(conn, %{runs: runs})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def show(conn, %{"id" => id}) do
    case RunProjection.get(id) do
      {:ok, run} -> json(conn, %{run: run})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def changes(conn, %{"id" => run_id}) do
    case DeliveryStore.changes(run_id) do
      {:ok, changes} -> json(conn, %{changes: changes})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def retry_execution(conn, %{"id" => run_id, "occurrence_id" => occurrence_id})
      when is_binary(occurrence_id) do
    case ExecutionRecovery.retry(run_id, occurrence_id) do
      {:ok, _recovery} -> render_run(conn, run_id)
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def retry_execution(conn, _params),
    do:
      Api.render_error(conn, %ExecutionRecovery.Error{
        code: :invalid_execution_recovery,
        details: %{field: "occurrence_id"}
      })

  def recover_execution_fresh(
        conn,
        %{
          "id" => run_id,
          "occurrence_id" => occurrence_id,
          "source_attempt_id" => source_attempt_id,
          "request_id" => request_id
        }
      )
      when is_binary(occurrence_id) and is_binary(source_attempt_id) and
             is_binary(request_id) and request_id != "" do
    case OperationalRecovery.request_fresh(
           run_id,
           occurrence_id,
           source_attempt_id,
           request_id
         ) do
      {:ok, _recovery} -> render_run(conn, run_id)
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def recover_execution_fresh(conn, _params),
    do:
      Api.render_error(conn, %OperationalRecovery.Error{
        code: :invalid_execution_recovery,
        details: %{fields: ["occurrence_id", "source_attempt_id", "request_id"]}
      })

  def recover_pre_prompt_process(
        conn,
        %{
          "id" => run_id,
          "occurrence_id" => occurrence_id,
          "source_attempt_id" => source_attempt_id,
          "request_id" => request_id
        }
      )
      when is_binary(occurrence_id) and is_binary(source_attempt_id) and
             is_binary(request_id) and request_id != "" do
    case OperationalRecovery.request_pre_prompt_process(
           run_id,
           occurrence_id,
           source_attempt_id,
           request_id
         ) do
      {:ok, _recovery} -> render_run(conn, run_id)
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def recover_pre_prompt_process(conn, _params),
    do:
      Api.render_error(conn, %OperationalRecovery.Error{
        code: :invalid_execution_recovery,
        details: %{fields: ["occurrence_id", "source_attempt_id", "request_id"]}
      })

  def authorize_execution_prompt(
        conn,
        %{
          "id" => run_id,
          "occurrence_id" => occurrence_id,
          "attempt_id" => attempt_id,
          "request_id" => request_id
        }
      )
      when is_binary(occurrence_id) and is_binary(attempt_id) and
             is_binary(request_id) and request_id != "" do
    case OperationalRecovery.authorize_prompt(run_id, occurrence_id, attempt_id, request_id) do
      {:ok, _authorization} -> render_run(conn, run_id)
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def authorize_execution_prompt(conn, _params),
    do:
      Api.render_error(conn, %OperationalRecovery.Error{
        code: :invalid_prompt_authorization,
        details: %{fields: ["occurrence_id", "attempt_id", "request_id"]}
      })

  def cancel_execution_attempt(
        conn,
        %{
          "id" => run_id,
          "attempt_id" => attempt_id,
          "occurrence_id" => occurrence_id,
          "request_id" => request_id
        } = params
      ) do
    with :ok <- require_local_tauri(conn),
         {:ok, cancellation} <-
           ExecutionCancellation.request(
             run_id,
             occurrence_id,
             attempt_id,
             request_id,
             params["reason"]
           ),
         {:ok, run} <- RunProjection.get(run_id) do
      json(conn, %{cancellation: cancellation, run: run})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def cancel_execution_attempt(conn, _params) do
    Api.render_error(conn, %ExecutionCancellation.Error{
      code: :invalid_execution_cancellation,
      details: %{fields: ["occurrence_id", "attempt_id", "request_id"]}
    })
  end

  def mark_execution_failed(conn, %{"id" => run_id, "occurrence_id" => occurrence_id})
      when is_binary(occurrence_id) do
    case ExecutionRecovery.mark_failed(run_id, occurrence_id) do
      {:ok, _recovery} -> render_run(conn, run_id)
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def mark_execution_failed(conn, _params),
    do:
      Api.render_error(conn, %ExecutionRecovery.Error{
        code: :invalid_execution_recovery,
        details: %{field: "occurrence_id"}
      })

  def retry_delivery(conn, %{"id" => run_id}) do
    case DeliveryStore.retry(run_id) do
      {:ok, delivery} ->
        DeliveryCoordinator.wake(run_id)
        json(conn, %{delivery: DeliveryStore.projection(delivery)})

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def cleanup(conn, %{"id" => run_id} = params) do
    case RunWorkspaceStore.request_cleanup(run_id, params["acknowledge_unmerged"] == true) do
      {:ok, %{state: "removed"}} ->
        json(conn, %{execution_environment: %{state: "removed"}})

      {:ok, assignment} ->
        worker = Repo.get!(Worker, assignment.worker_id)

        case WorkerConnections.send_protocol(
               worker.id,
               worker.connection_generation,
               WorkerProtocol.cleanup_run_worktree(worker.id, assignment)
             ) do
          :ok -> json(conn, %{execution_environment: %{state: "cleanup_requested"}})
          {:error, error} -> Api.render_error(conn, error)
        end

      {:error, error} ->
        Api.render_error(conn, error)
    end
  end

  def session_attachment(
        conn,
        %{"id" => run_id, "attempt_id" => attempt_id, "session_id" => session_id}
      ) do
    with :ok <- require_local_tauri(conn),
         {:ok, descriptor} <-
           ExecutionSessionStore.attachment_descriptor(run_id, attempt_id, session_id) do
      json(conn, %{attachment: descriptor})
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def session_opened(conn, %{"descriptor_token" => token, "mode" => mode})
      when mode in ["observe", "takeover"] do
    with :ok <- require_local_tauri(conn),
         {:ok, session} <- ExecutionSessionStore.record_opened(token, mode) do
      json(conn, %{
        session_id: session.id,
        result: if(mode == "takeover", do: "human_control_started", else: "local_session_opened")
      })
    else
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  def session_opened(conn, _params), do: Api.render_error(conn, :invalid_attachment_descriptor)

  def artifact(conn, %{"run_id" => run_id, "artifact_id" => artifact_id}) do
    case RunProjection.artifact(run_id, artifact_id) do
      {:ok, artifact} -> json(conn, %{artifact: artifact})
      {:error, error} -> Api.render_error(conn, error)
    end
  end

  defp require_local_tauri(conn) do
    enabled = Application.get_env(:quest_engineering_server, :local_session_attach_enabled, false)
    local_request = conn.remote_ip in [{127, 0, 0, 1}, {0, 0, 0, 0, 0, 0, 0, 1}]
    local_host = conn.host in ["127.0.0.1", "localhost", "::1"]

    direct_request =
      get_req_header(conn, "forwarded") == [] and get_req_header(conn, "x-forwarded-for") == []

    tauri_client = get_req_header(conn, "x-quest-engineering-local-client") == ["tauri"]

    if enabled and local_request and local_host and direct_request and tauri_client,
      do: :ok,
      else: {:error, :local_session_attachment_disabled}
  end

  defp render_run(conn, run_id) do
    case RunProjection.get(run_id) do
      {:ok, run} -> json(conn, %{run: run})
      {:error, error} -> Api.render_error(conn, error)
    end
  end
end
