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
           authority(binding.provider_account_id, binding.action_id, true),
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

      Map.put(binding, :authorization_id, authorization_id(binding))
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
