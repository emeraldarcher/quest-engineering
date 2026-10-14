defmodule QuestEngineering.Server.Product.WorkspaceToolBrokers do
  @moduledoc """
  Derives account→Run workspace broker authority from one current Product execution.

  Product owns semantic admission through the existing scheduled execution,
  operational attribution, prompt authorization, workspace assignment, and
  ProviderAccount readiness. Worker owns the physical broker session and fills
  the PhysicalLineage and Run-environment identity.
  """

  import Ecto.Query

  alias QuestEngineering.Server.Persistence.OperationalAttemptAttribution
  alias QuestEngineering.Server.Persistence.OperationalRecoveryEpoch
  alias QuestEngineering.Server.Persistence.ProviderAccount
  alias QuestEngineering.Server.Persistence.ProviderAccountEnvironment
  alias QuestEngineering.Server.Persistence.ResolvedExecutionCodec
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  @feature "workspace_tool_broker_v1"

  @doc """
  Prepares and admits the one exact Anthropic ProviderAccount authority for a
  Claude Code Action. Ambiguous account selection fails closed.
  """
  def prepare_and_admit_for_action(action_id) when is_binary(action_id) do
    case claude_account_for_action(action_id) do
      {:ok, :not_required} ->
        {:ok, :not_required}

      {:ok, provider_account_id} ->
        with {:ok, binding} <- prepare(provider_account_id, action_id),
             {:ok, admitted} <- admit(binding) do
          {:ok, admitted}
        end

      {:error, _reason} = error ->
        error
    end
  end

  def prepare(provider_account_id, action_id)
      when is_binary(provider_account_id) and is_binary(action_id) do
    with {:ok, binding} <- authority(provider_account_id, action_id, false),
         :ok <-
           WorkerConnections.send_protocol(
             binding.worker_id,
             binding.worker_generation,
             WorkerProtocol.prepare_workspace_tool_broker(
               binding.worker_id,
               binding.worker_generation,
               binding
             )
           ) do
      {:ok, binding}
    end
  end

  def admit(binding) when is_map(binding) do
    with {:ok, current} <-
           authority(binding.provider_account_id, binding.action_id, false),
         true <- current == binding,
         :ok <-
           WorkerConnections.send_protocol(
             current.worker_id,
             current.worker_generation,
             WorkerProtocol.admit_workspace_tool_broker(
               current.worker_id,
               current.worker_generation,
               current.authorization_id
             )
           ) do
      {:ok, current}
    else
      false -> {:error, error(:workspace_tool_broker_authority_stale)}
      {:error, _reason} = error -> error
    end
  end

  def record_activity(worker_id, worker_generation, activity)
      when is_binary(worker_id) and is_integer(worker_generation) and is_map(activity) do
    Repo.transaction(fn ->
      dispatch =
        Repo.one(
          from dispatch in WorkerDispatch,
            where: dispatch.action_id == ^activity.action_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_execution_missing))

      if dispatch.worker_id != worker_id or
           dispatch.last_connection_generation != worker_generation or
           dispatch.workspace_tool_broker_authorization_id != activity.authorization_id do
        Repo.rollback(error(:workspace_tool_broker_authority_stale))
      end

      case activity.state do
        "admitted" ->
          if dispatch.workspace_tool_broker_admitted_at &&
               (dispatch.workspace_tool_broker_session_id != activity.session_id or
                  dispatch.workspace_tool_broker_generation != activity.broker_generation) do
            Repo.rollback(error(:workspace_tool_broker_authority_stale))
          end

          dispatch
          |> Ecto.Changeset.change(
            workspace_tool_broker_session_id: activity.session_id,
            workspace_tool_broker_generation: activity.broker_generation,
            workspace_tool_broker_admitted_at:
              dispatch.workspace_tool_broker_admitted_at || DateTime.utc_now()
          )
          |> Repo.update!()

        "closed" ->
          if dispatch.workspace_tool_broker_admitted_at &&
               (dispatch.workspace_tool_broker_session_id != activity.session_id or
                  dispatch.workspace_tool_broker_generation != activity.broker_generation) do
            Repo.rollback(error(:workspace_tool_broker_authority_stale))
          end

          dispatch
          |> Ecto.Changeset.change(
            workspace_tool_broker_session_id: nil,
            workspace_tool_broker_generation: nil,
            workspace_tool_broker_admitted_at: nil
          )
          |> Repo.update!()

        _ ->
          dispatch
      end
    end)
    |> case do
      {:ok, dispatch} -> {:ok, dispatch}
      {:error, reason} -> {:error, reason}
    end
  end

  def retire(binding, reason) when is_map(binding) and is_binary(reason) and reason != "" do
    with {:ok, current} <-
           authority(binding.provider_account_id, binding.action_id, false),
         true <- current.authorization_id == binding.authorization_id,
         :ok <-
           WorkerConnections.send_protocol(
             current.worker_id,
             current.worker_generation,
             WorkerProtocol.retire_workspace_tool_broker(
               current.worker_id,
               current.worker_generation,
               current.authorization_id,
               String.slice(reason, 0, 128)
             )
           ) do
      :ok
    else
      false -> {:error, error(:workspace_tool_broker_authority_stale)}
      {:error, _reason} = error -> error
    end
  end

  defp claude_account_for_action(action_id) do
    Repo.transaction(fn ->
      scheduled =
        Repo.one(
          from execution in ScheduledActionExecution,
            where: execution.action_id == ^action_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_execution_missing))

      execution =
        case ResolvedExecutionCodec.decode(
               scheduled.resolved_execution,
               scheduled.resolved_execution_version
             ) do
          {:ok, decoded} -> decoded
          {:error, _reason} -> Repo.rollback(error(:workspace_tool_broker_execution_invalid))
        end

      if execution.configuration.harness_kind != "claude_code" do
        :not_required
      else
        if execution.configuration.model.provider != "anthropic" do
          Repo.rollback(error(:workspace_tool_broker_provider_mismatch))
        end

        accounts =
          Repo.all(
            from account in ProviderAccount,
              join: environment in ProviderAccountEnvironment,
              on: environment.provider_account_id == account.id,
              where:
                account.worker_id == ^scheduled.worker_id and
                  account.provider_key == "anthropic" and
                  account.lifecycle_state == "connected" and
                  account.authentication_state == "authenticated" and
                  environment.worker_id == ^scheduled.worker_id and
                  environment.credential_generation == account.credential_generation and
                  environment.physical_state == "available" and
                  environment.desired_environment_state == "available" and
                  environment.canary_persisted == true,
              order_by: [asc: account.id],
              select: account.id,
              lock: "FOR UPDATE"
          )

        case accounts do
          [provider_account_id] -> provider_account_id
          [] -> Repo.rollback(error(:claude_provider_account_unavailable))
          _ -> Repo.rollback(error(:claude_provider_account_ambiguous))
        end
      end
    end)
    |> case do
      {:ok, value} -> {:ok, value}
      {:error, reason} -> {:error, reason}
    end
  end

  defp authority(provider_account_id, action_id, require_prompt?) do
    Repo.transaction(fn ->
      account =
        Repo.one(
          from account in ProviderAccount,
            where: account.id == ^provider_account_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:provider_account_not_found))

      environment =
        Repo.one(
          from environment in ProviderAccountEnvironment,
            where: environment.provider_account_id == ^provider_account_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:provider_account_environment_unavailable))

      scheduled =
        Repo.one(
          from execution in ScheduledActionExecution,
            where: execution.action_id == ^action_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_execution_missing))

      attribution =
        Repo.one(
          from attribution in OperationalAttemptAttribution,
            where: attribution.action_id == ^action_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_execution_missing))

      epoch = Repo.get!(OperationalRecoveryEpoch, attribution.epoch_id)

      dispatch =
        Repo.one(
          from dispatch in WorkerDispatch,
            where: dispatch.action_id == ^action_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_execution_missing))

      assignment =
        Repo.one(
          from assignment in RunWorkspaceAssignment,
            where: assignment.run_id == ^scheduled.run_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:workspace_tool_broker_workspace_unavailable))

      worker = Repo.get!(Worker, scheduled.worker_id)

      validate_authority!(
        account,
        environment,
        scheduled,
        attribution,
        dispatch,
        assignment,
        worker,
        require_prompt?
      )

      execution =
        case ResolvedExecutionCodec.decode(
               scheduled.resolved_execution,
               scheduled.resolved_execution_version
             ) do
          {:ok, decoded} -> decoded
          {:error, _reason} -> Repo.rollback(error(:workspace_tool_broker_execution_invalid))
        end

      identity = execution.identity
      logical_workspace = execution.logical_workspace
      execution_workspace = execution.execution_workspace
      tools = execution.configuration.resolved_tool_profile.tools

      if not is_list(tools) or Enum.any?(tools, &(not is_binary(&1))) do
        Repo.rollback(error(:workspace_tool_broker_tool_profile_invalid))
      end

      binding = %{
        provider_account_id: account.id,
        credential_generation: account.credential_generation,
        account_environment_generation: environment.credential_generation,
        account_environment: %{
          backend_kind: environment.backend_kind,
          environment_id: environment.environment_id,
          incarnation: environment.incarnation
        },
        run_id: scheduled.run_id,
        action_id: scheduled.action_id,
        occurrence_id: scheduled.occurrence_id,
        attempt_id: attribution.attempt_id,
        operational_epoch: epoch.epoch_number,
        operational_attempt: attribution.attempt_in_epoch,
        workspace_id: logical_workspace.workspace_id,
        worktree_id: execution_workspace.worktree_id,
        workspace_binding_id: execution_workspace.workspace_binding_id,
        workspace_access: Atom.to_string(execution_workspace.access),
        resolved_tool_profile: %{"tools" => tools},
        worker_id: scheduled.worker_id,
        worker_generation: worker.connection_generation
      }

      if binding.attempt_id != identity.attempt_id or
           binding.run_id != identity.run_id or
           binding.action_id != identity.action_id or
           binding.occurrence_id != identity.occurrence_id or
           assignment.workspace_id != binding.workspace_id or
           assignment.worktree_id != binding.worktree_id or
           assignment.workspace_binding_id != binding.workspace_binding_id do
        Repo.rollback(error(:workspace_tool_broker_execution_stale))
      end

      authorized = Map.put(binding, :authorization_id, authorization_id(binding))

      if dispatch.workspace_tool_broker_authorization_id &&
           (dispatch.provider_account_id != authorized.provider_account_id or
              dispatch.provider_account_credential_generation !=
                authorized.credential_generation or
              dispatch.workspace_tool_broker_authorization_id != authorized.authorization_id) do
        Repo.rollback(error(:workspace_tool_broker_authority_stale))
      end

      unless dispatch.workspace_tool_broker_authorization_id do
        dispatch
        |> Ecto.Changeset.change(
          provider_account_id: authorized.provider_account_id,
          provider_account_credential_generation: authorized.credential_generation,
          workspace_tool_broker_authorization_id: authorized.authorization_id
        )
        |> Repo.update!()
      end

      authorized
    end)
    |> case do
      {:ok, binding} -> {:ok, binding}
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_authority!(
         account,
         environment,
         scheduled,
         attribution,
         dispatch,
         assignment,
         worker,
         require_prompt?
       ) do
    features = Map.get(worker.capabilities || %{}, "features", [])

    valid =
      account.lifecycle_state == "connected" and
        account.authentication_state == "authenticated" and
        environment.physical_state == "available" and
        environment.desired_environment_state == "available" and
        environment.canary_persisted == true and
        not is_nil(environment.backend_kind) and not is_nil(environment.environment_id) and
        not is_nil(environment.incarnation) and account.worker_id == scheduled.worker_id and
        environment.worker_id == scheduled.worker_id and scheduled.state == "active" and
        attribution.run_id == scheduled.run_id and
        attribution.occurrence_id == scheduled.occurrence_id and
        dispatch.worker_id == scheduled.worker_id and
        dispatch.state in ["acknowledged", "running"] and
        is_nil(dispatch.cancellation_requested_at) and assignment.state == "ready" and
        assignment.worker_id == scheduled.worker_id and worker.status == "connected" and
        worker.ready_generation == worker.connection_generation and
        environment.worker_generation == worker.connection_generation and @feature in features and
        (not require_prompt? or not is_nil(dispatch.prompt_authorized_at))

    unless valid, do: Repo.rollback(error(:workspace_tool_broker_not_admissible))
  end

  defp authorization_id(binding) do
    digest =
      :crypto.hash(
        :sha256,
        :erlang.term_to_binary({
          "workspace_tool_broker_v1",
          binding.provider_account_id,
          binding.credential_generation,
          binding.account_environment_generation,
          binding.account_environment,
          binding.run_id,
          binding.action_id,
          binding.occurrence_id,
          binding.attempt_id,
          binding.operational_epoch,
          binding.operational_attempt,
          binding.workspace_id,
          binding.worktree_id,
          binding.workspace_binding_id,
          binding.workspace_access,
          binding.resolved_tool_profile,
          binding.worker_id,
          binding.worker_generation
        })
      )
      |> Base.encode16(case: :lower)

    "workspace-tool-broker:#{digest}"
  end

  defp error(code), do: %{type: code, details: %{}}
end
