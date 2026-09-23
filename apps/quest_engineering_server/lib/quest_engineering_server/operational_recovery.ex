defmodule QuestEngineering.Server.OperationalRecovery do
  @moduledoc """
  PostgreSQL authority for immutable operational recovery epochs and Attempt attribution.

  Recovery appends a new epoch and Runtime Attempt. It never rewrites a prior
  dispatch, Attempt, StepOccurrence, or semantic remediation region.
  """

  import Ecto.Query

  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.OperationalAttemptAttribution
  alias QuestEngineering.Server.Persistence.OperationalRecoveryEpoch
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.ProductChangeNotifier
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.RuntimeStore
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  defmodule Error do
    @moduledoc "Machine-readable operational recovery rejection."
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  @type continuation_mode :: :retained | :fresh

  def configured_allowance do
    Application.fetch_env!(:quest_engineering_server, :max_operational_attempts_per_epoch)
  end

  @doc "Attributes an Attempt when scheduling actually reserves its execution resources."
  def attribute_scheduled_attempt!(action) do
    case Repo.get(OperationalAttemptAttribution, action.id) do
      %OperationalAttemptAttribution{} = attribution -> attribution
      nil -> insert_attribution!(action)
    end
  end

  defp insert_attribution!(action) do
    epoch = current_or_initial_epoch!(action)

    attempt_in_epoch =
      Repo.aggregate(
        from(attribution in OperationalAttemptAttribution,
          where: attribution.epoch_id == ^epoch.id
        ),
        :count
      ) + 1

    if epoch.attempt_allowance && attempt_in_epoch > epoch.attempt_allowance do
      Repo.rollback(
        error(:operational_attempt_allowance_exhausted, action, %{epoch: epoch.epoch_number})
      )
    end

    now = now()

    %OperationalAttemptAttribution{}
    |> OperationalAttemptAttribution.changeset(%{
      action_id: action.id,
      epoch_id: epoch.id,
      run_id: action.run_id,
      occurrence_id: action.occurrence_id,
      attempt_id: action.attempt_id,
      global_attempt_number: attempt_number!(action.attempt_id),
      attempt_in_epoch: attempt_in_epoch,
      scheduled_at: now
    })
    |> Repo.insert!()
  end

  defp current_or_initial_epoch!(action) do
    query =
      from epoch in OperationalRecoveryEpoch,
        where: epoch.run_id == ^action.run_id and epoch.occurrence_id == ^action.occurrence_id,
        order_by: [desc: epoch.epoch_number],
        limit: 1,
        lock: "FOR UPDATE"

    Repo.one(query) ||
      %OperationalRecoveryEpoch{}
      |> OperationalRecoveryEpoch.changeset(%{
        run_id: action.run_id,
        occurrence_id: action.occurrence_id,
        epoch_number: 0,
        authorization_kind: "initial",
        attempt_allowance: configured_allowance(),
        policy_source: "configured",
        continuation_mode: "fresh",
        authorized_at: now()
      })
      |> Repo.insert!()
  end

  def execution_metadata(action_id) do
    with %OperationalAttemptAttribution{} = attribution <-
           Repo.get(OperationalAttemptAttribution, action_id),
         %OperationalRecoveryEpoch{} = epoch <-
           Repo.get(OperationalRecoveryEpoch, attribution.epoch_id) do
      %{
        epoch_number: epoch.epoch_number,
        attempt_in_epoch: attribution.attempt_in_epoch,
        attempt_allowance: epoch.attempt_allowance,
        authorization_kind: epoch.authorization_kind,
        continuation_mode: epoch.continuation_mode,
        retained_lineage_id: epoch.retained_lineage_id,
        source_attempt_id: epoch.source_attempt_id,
        request_id: epoch.request_id
      }
    else
      _ -> nil
    end
  end

  def same_epoch_retry_available?(action_id) do
    with %OperationalAttemptAttribution{} = attribution <-
           Repo.get(OperationalAttemptAttribution, action_id),
         %OperationalRecoveryEpoch{} = epoch <-
           Repo.get(OperationalRecoveryEpoch, attribution.epoch_id) do
      is_nil(epoch.attempt_allowance) or attribution.attempt_in_epoch < epoch.attempt_allowance
    else
      _ -> true
    end
  end

  def ensure_same_epoch_retry_available(action_id) do
    if same_epoch_retry_available?(action_id),
      do: :ok,
      else:
        {:error,
         %Error{
           code: :operational_attempt_allowance_exhausted,
           details: %{action_id: action_id}
         }}
  end

  def failure_policy(action_id, %{"classification" => "auto_retryable"}) do
    with %OperationalAttemptAttribution{} = attribution <-
           Repo.get(OperationalAttemptAttribution, action_id),
         %OperationalRecoveryEpoch{attempt_allowance: allowance} = epoch
         when is_integer(allowance) <- Repo.get(OperationalRecoveryEpoch, attribution.epoch_id) do
      if attribution.attempt_in_epoch < allowance,
        do: {:automatic_retry, epoch},
        else: {:exhausted, epoch}
    else
      _ -> {:operator_recovery_required, nil}
    end
  end

  def failure_policy(action_id, %{"classification" => classification})
      when classification in ["operator_recovery_required", "terminal_not_recoverable"] do
    attribution = Repo.get(OperationalAttemptAttribution, action_id)
    epoch = attribution && Repo.get(OperationalRecoveryEpoch, attribution.epoch_id)

    policy =
      case classification do
        "operator_recovery_required" -> :operator_recovery_required
        "terminal_not_recoverable" -> :terminal_not_recoverable
      end

    {policy, epoch}
  end

  def failure_policy(action_id, _failure),
    do: failure_policy(action_id, %{"classification" => "operator_recovery_required"})

  @doc "Applies one safe automatic retry inside the current epoch."
  def automatic_retry(action_id) do
    outbox = Repo.get_by!(RuntimeOutbox, action_id: action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)

    RuntimeStore.apply_transition(
      action.run_id,
      "automatic-operational-retry/v1/#{encode(action.id)}",
      Runtime.retry_requested(action)
    )
  end

  @doc "Appends a retained-process recovery for a terminal pre-prompt control failure."
  def request_pre_prompt_process(run_id, occurrence_id, source_attempt_id, request_id)
      when is_binary(source_attempt_id) and is_binary(request_id) do
    Repo.transaction(fn ->
      pre_prompt_process_decision(run_id, occurrence_id, source_attempt_id, request_id)
    end)
    |> deliver_pre_prompt_process()
  end

  defp pre_prompt_process_decision(run_id, occurrence_id, source_attempt_id, request_id) do
    lock_run!(run_id)

    case existing_source_recovery(run_id, occurrence_id, source_attempt_id, "retained") do
      %OperationalRecoveryEpoch{} = existing ->
        existing_pre_prompt_process_decision(existing, source_attempt_id)

      nil ->
        new_pre_prompt_process_decision(
          run_id,
          occurrence_id,
          source_attempt_id,
          request_id
        )
    end
  end

  defp new_pre_prompt_process_decision(
         run_id,
         occurrence_id,
         source_attempt_id,
         request_id
       ) do
    scheduled = latest_scheduled!(run_id, occurrence_id)
    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)
    ensure_requested_attempt!(action, source_attempt_id)
    dispatch = lock_source_dispatch!(%{action_id: action.id})
    session = lock_execution_session(action.id)
    worker = Repo.get(Worker, dispatch.worker_id)

    request = %{
      request_id: request_id,
      run_id: run_id,
      occurrence_id: occurrence_id,
      attempt_id: action.attempt_id,
      action_id: action.id,
      member_key: scheduled.member_key,
      worker_id: dispatch.worker_id,
      session_id: session && session.id,
      lineage_id: session && session.id,
      native_session_id: session && session.native_session_id
    }

    case pre_prompt_process_error(dispatch, scheduled, session, worker, request) do
      nil -> {:authorize, request}
      recovery_error -> Repo.rollback(recovery_error)
    end
  end

  defp existing_pre_prompt_process_decision(existing, source_attempt_id) do
    scheduled = latest_scheduled!(existing.run_id, existing.occurrence_id)
    attribution = Repo.get(OperationalAttemptAttribution, scheduled.action_id)
    dispatch = lock_source_dispatch!(%{action_id: scheduled.action_id})
    session = lock_execution_session(scheduled.action_id)
    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)

    if same_epoch_pre_prompt_retry?(
         existing,
         attribution,
         dispatch,
         scheduled,
         session,
         source_attempt_id,
         action.attempt_id
       ) do
      {:retry, retry_existing_epoch!(existing, scheduled)}
    else
      {:replay, replay_value(existing)}
    end
  end

  defp same_epoch_pre_prompt_retry?(
         epoch,
         attribution,
         dispatch,
         scheduled,
         session,
         source_attempt_id,
         current_attempt_id
       ) do
    same_epoch_capacity?(epoch, attribution) and
      retry_matches_source?(epoch, source_attempt_id, current_attempt_id) and
      false_ownership_failure?(dispatch, scheduled) and
      retained_empty_session?(session)
  end

  defp same_epoch_capacity?(epoch, %OperationalAttemptAttribution{} = attribution) do
    attribution.epoch_id == epoch.id and
      (is_nil(epoch.attempt_allowance) or
         attribution.attempt_in_epoch < epoch.attempt_allowance)
  end

  defp same_epoch_capacity?(_epoch, _attribution), do: false

  defp retry_matches_source?(epoch, source_attempt_id, current_attempt_id),
    do: epoch.source_attempt_id == source_attempt_id and current_attempt_id != source_attempt_id

  defp false_ownership_failure?(dispatch, scheduled),
    do:
      dispatch.state == "failed" and scheduled.state == "failed" and
        false_ownership_conflict?(dispatch.failure || %{})

  defp retained_empty_session?(%ExecutionSession{} = session),
    do:
      retained_antigravity?(session) and is_nil(session.native_session_id) and
        pre_prompt_turn?(session.turn)

  defp retained_empty_session?(_session), do: false

  defp false_ownership_conflict?(failure) do
    failure["reason"] == "harness_execution_failed" and
      failure["classification"] == "operator_recovery_required" and
      String.starts_with?(
        failure["message"] || "",
        "Prepared process or worktree is already owned by "
      )
  end

  defp retry_existing_epoch!(epoch, scheduled) do
    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)
    validate_current_attempt!(epoch.run_id, action)

    transition =
      case RuntimeStore.apply_transition(
             epoch.run_id,
             "same-epoch-pre-prompt-retry/v1/#{epoch.id}/#{encode(action.id)}",
             Runtime.retry_requested(action)
           ) do
        {:ok, transition} -> transition
        {:error, runtime_error} -> Repo.rollback(runtime_error)
      end

    ready_workspace!(epoch.run_id)

    replay_value(epoch)
    |> Map.merge(%{
      next_action_id: transition.actions |> List.first() |> then(&(&1 && &1.id)),
      idempotent_replay?: false
    })
  end

  defp deliver_pre_prompt_process({:ok, {:replay, value}}), do: {:ok, value}

  defp deliver_pre_prompt_process({:ok, {:retry, value}}) do
    Scheduler.wake(value.run_id)
    RunChangeNotifier.notify(value.run_id)
    ProductChangeNotifier.notify(["quests", "runs"])
    {:ok, value}
  end

  defp deliver_pre_prompt_process({:ok, {:authorize, request}}),
    do: authorize(request, mode: :retained, pre_prompt_process: true)

  defp deliver_pre_prompt_process({:error, error}), do: {:error, error}

  @doc "Requests a fresh recovery, retiring a known live source Attempt before appending history."
  def request_fresh(run_id, occurrence_id, source_attempt_id, request_id)
      when is_binary(source_attempt_id) and is_binary(request_id) do
    Repo.transaction(fn ->
      fresh_recovery_decision(run_id, occurrence_id, source_attempt_id, request_id)
    end)
    |> deliver_fresh_recovery(
      run_id,
      occurrence_id,
      source_attempt_id,
      request_id
    )
  end

  defp fresh_recovery_decision(run_id, occurrence_id, source_attempt_id, request_id) do
    lock_run!(run_id)

    case existing_source_recovery(run_id, occurrence_id, source_attempt_id, "fresh") do
      %OperationalRecoveryEpoch{} = existing ->
        {:replay, replay_value(existing)}

      nil ->
        new_fresh_recovery_decision(
          run_id,
          occurrence_id,
          source_attempt_id,
          request_id
        )
    end
  end

  defp new_fresh_recovery_decision(run_id, occurrence_id, source_attempt_id, request_id) do
    scheduled = latest_scheduled!(run_id, occurrence_id)
    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)

    if action.attempt_id != source_attempt_id do
      Repo.rollback(
        error(:replacement_attempt_already_exists, action, %{
          requested_source_attempt_id: source_attempt_id
        })
      )
    end

    dispatch = lock_source_dispatch!(%{action_id: action.id})
    fresh_dispatch_decision(dispatch, action, request_id)
  end

  defp fresh_dispatch_decision(dispatch, action, request_id) do
    if dispatch.state in ["claimed", "dispatched", "acknowledged", "running"] do
      already_requested? = not is_nil(dispatch.operational_recovery_request_id)
      request = dispatch.operational_recovery_request_id || request_id

      updated =
        dispatch
        |> Ecto.Changeset.change(
          operational_recovery_request_id: request,
          operational_recovery_requested_at: dispatch.operational_recovery_requested_at || now()
        )
        |> Repo.update!()

      {:retire, updated, action, request, already_requested?}
    else
      {:authorize, action, dispatch.operational_recovery_request_id || request_id}
    end
  end

  defp deliver_fresh_recovery(
         {:ok, {:replay, value}},
         _run_id,
         _occurrence_id,
         _source_attempt_id,
         _request_id
       ),
       do: {:ok, value}

  defp deliver_fresh_recovery(
         {:ok, {:authorize, _action, persisted_request_id}},
         run_id,
         occurrence_id,
         _source_attempt_id,
         _request_id
       ),
       do: authorize_fresh(run_id, occurrence_id, persisted_request_id)

  defp deliver_fresh_recovery(
         {:ok, {:retire, dispatch, action, persisted_request_id, already_requested?}},
         run_id,
         occurrence_id,
         source_attempt_id,
         request_id
       ) do
    worker = Repo.get!(Worker, dispatch.worker_id)

    failure = %{
      "code" => "execution_environment_recovery_required",
      "reason" => "sandbox_git_metadata_unavailable",
      "classification" => "operator_recovery_required",
      "message" =>
        "The native execution environment cannot access the verified Git metadata required by this retained worktree.",
      "recovery_request_id" => persisted_request_id
    }

    WorkerConnections.send_protocol(
      worker.id,
      worker.connection_generation,
      WorkerProtocol.retire_dispatch_for_recovery(worker.id, action.id, failure)
    )
    |> retirement_delivery_result(
      run_id,
      occurrence_id,
      source_attempt_id,
      request_id,
      persisted_request_id,
      already_requested?
    )
  end

  defp deliver_fresh_recovery(
         {:error, error},
         _run_id,
         _occurrence_id,
         _source_attempt_id,
         _request_id
       ),
       do: {:error, error}

  defp retirement_delivery_result(
         :ok,
         run_id,
         occurrence_id,
         source_attempt_id,
         request_id,
         persisted_request_id,
         already_requested?
       ) do
    {:ok,
     %{
       run_id: run_id,
       occurrence_id: occurrence_id,
       source_attempt_id: source_attempt_id,
       request_id: persisted_request_id,
       state: :retirement_requested,
       idempotent_replay?: already_requested? or persisted_request_id != request_id
     }}
  end

  defp retirement_delivery_result(
         {:error, reason},
         run_id,
         occurrence_id,
         _source_attempt_id,
         _request_id,
         _persisted_request_id,
         _already_requested?
       ) do
    {:error,
     %Error{
       code: :recovery_worker_unavailable,
       details: %{run_id: run_id, occurrence_id: occurrence_id, reason: inspect(reason)}
     }}
  end

  @doc "Finalizes a durable recovery intent after its source dispatch reports terminal failure."
  def finalize_requested(action_id) do
    dispatch = Repo.get_by(WorkerDispatch, action_id: action_id)

    if dispatch && dispatch.state == "failed" && dispatch.operational_recovery_request_id do
      outbox = Repo.get_by!(RuntimeOutbox, action_id: action_id)
      {:ok, action} = RuntimeCodec.decode(outbox.payload)

      authorize_fresh(
        action.run_id,
        action.occurrence_id,
        dispatch.operational_recovery_request_id
      )
    else
      :noop
    end
  end

  @doc "Opens the paid-inference gate for one fully prepared initial or human recovery Attempt."
  def authorize_prompt(run_id, occurrence_id, attempt_id, request_id) do
    Repo.transaction(fn ->
      persist_prompt_authorization(run_id, occurrence_id, attempt_id, request_id)
    end)
    |> deliver_prompt_authorization(
      run_id,
      occurrence_id,
      attempt_id,
      request_id
    )
  end

  defp persist_prompt_authorization(run_id, occurrence_id, attempt_id, request_id) do
    lock_run!(run_id)
    scheduled = latest_scheduled!(run_id, occurrence_id)
    outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)
    ensure_requested_attempt!(action, attempt_id)

    attribution = Repo.get(OperationalAttemptAttribution, action.id)
    epoch = attribution && Repo.get(OperationalRecoveryEpoch, attribution.epoch_id)
    dispatch = lock_source_dispatch!(%{action_id: action.id})
    session = lock_execution_session(action.id)
    already_authorized? = not is_nil(dispatch.prompt_authorized_at)

    unless already_authorized? or prompt_authorization_ready?(epoch, dispatch, session) do
      Repo.rollback(
        error(:prompt_authorization_not_ready, action, %{
          dispatch_state: dispatch.state,
          session_state: session && session.state
        })
      )
    end

    persisted_request_id = dispatch.prompt_authorization_request_id || request_id

    updated =
      dispatch
      |> Ecto.Changeset.change(
        prompt_authorization_request_id: persisted_request_id,
        prompt_authorized_at: dispatch.prompt_authorized_at || now()
      )
      |> Repo.update!()

    {updated, persisted_request_id, already_authorized?}
  end

  defp ensure_requested_attempt!(action, attempt_id) do
    if action.attempt_id != attempt_id do
      Repo.rollback(
        error(:replacement_attempt_already_exists, action, %{
          requested_attempt_id: attempt_id
        })
      )
    end
  end

  defp lock_execution_session(action_id) do
    Repo.one(
      from session in ExecutionSession,
        where: session.current_action_id == ^action_id,
        lock: "FOR UPDATE"
    )
  end

  defp prompt_authorization_ready?(epoch, dispatch, session) do
    prompt_authorization_epoch?(epoch) and promptable_dispatch?(dispatch) and
      promptable_session?(session)
  end

  defp prompt_authorization_epoch?(epoch) do
    epoch && epoch.authorization_kind in ["initial", "human"] &&
      epoch.continuation_mode in ["fresh", "retained"]
  end

  defp promptable_dispatch?(dispatch),
    do: dispatch.state in ["acknowledged", "running"]

  defp promptable_session?(session) do
    session && session.state == "waiting_for_human" &&
      get_in(session.attention || %{}, ["category"]) == "needs_confirmation" &&
      is_nil(session.native_session_id) &&
      is_nil(get_in(session.turn || %{}, ["prompt_intent_at"]))
  end

  defp deliver_prompt_authorization(
         {:ok, {dispatch, persisted_request_id, already_authorized?}},
         run_id,
         occurrence_id,
         attempt_id,
         request_id
       ) do
    worker = Repo.get!(Worker, dispatch.worker_id)

    _ =
      WorkerConnections.send_protocol(
        worker.id,
        worker.connection_generation,
        WorkerProtocol.authorize_dispatch_prompt(worker.id, dispatch.action_id)
      )

    {:ok,
     %{
       run_id: run_id,
       occurrence_id: occurrence_id,
       attempt_id: attempt_id,
       request_id: persisted_request_id,
       prompt_authorized_at: dispatch.prompt_authorized_at,
       idempotent_replay?: already_authorized? or persisted_request_id != request_id
     }}
  end

  defp deliver_prompt_authorization(
         {:error, error},
         _run_id,
         _occurrence_id,
         _attempt_id,
         _request_id
       ),
       do: {:error, error}

  def authorize_fresh(run_id, occurrence_id, request_id) do
    scheduled =
      Repo.one(
        from scheduled in ScheduledActionExecution,
          where: scheduled.run_id == ^run_id and scheduled.occurrence_id == ^occurrence_id,
          order_by: [desc: scheduled.bound_at],
          limit: 1
      )

    if scheduled do
      case in_flight_fresh_recovery(scheduled) do
        %OperationalRecoveryEpoch{} = existing ->
          {:ok, replay_value(existing)}

        nil ->
          outbox = Repo.get_by!(RuntimeOutbox, action_id: scheduled.action_id)
          {:ok, action} = RuntimeCodec.decode(outbox.payload)

          authorize(
            %{
              request_id: request_id,
              run_id: run_id,
              occurrence_id: occurrence_id,
              attempt_id: action.attempt_id,
              action_id: action.id,
              member_key: scheduled.member_key,
              worker_id: scheduled.worker_id,
              session_id: nil,
              lineage_id: nil,
              native_session_id: nil
            },
            mode: :fresh
          )
      end
    else
      {:error,
       %Error{
         code: :execution_not_recoverable,
         details: %{run_id: run_id, occurrence_id: occurrence_id}
       }}
    end
  end

  defp in_flight_fresh_recovery(%ScheduledActionExecution{state: "active"} = scheduled) do
    attribution = Repo.get(OperationalAttemptAttribution, scheduled.action_id)
    dispatch = Repo.get_by(WorkerDispatch, action_id: scheduled.action_id)

    with %OperationalAttemptAttribution{} <- attribution,
         %OperationalRecoveryEpoch{authorization_kind: "human", continuation_mode: "fresh"} =
           epoch <- Repo.get(OperationalRecoveryEpoch, attribution.epoch_id),
         true <-
           is_nil(dispatch) or
             dispatch.state in ["claimed", "dispatched", "acknowledged", "running"] do
      epoch
    else
      _ -> nil
    end
  end

  defp in_flight_fresh_recovery(_scheduled), do: nil

  defp existing_source_recovery(run_id, occurrence_id, source_attempt_id, continuation_mode) do
    Repo.one(
      from epoch in OperationalRecoveryEpoch,
        where:
          epoch.run_id == ^run_id and epoch.occurrence_id == ^occurrence_id and
            epoch.authorization_kind == "human" and
            epoch.continuation_mode == ^continuation_mode and
            epoch.source_attempt_id == ^source_attempt_id,
        order_by: [desc: epoch.epoch_number],
        limit: 1,
        lock: "FOR UPDATE"
    )
  end

  defp latest_scheduled!(run_id, occurrence_id) do
    Repo.one!(
      from scheduled in ScheduledActionExecution,
        where: scheduled.run_id == ^run_id and scheduled.occurrence_id == ^occurrence_id,
        order_by: [desc: scheduled.bound_at],
        limit: 1,
        lock: "FOR UPDATE"
    )
  end

  @doc "Authorizes a new human recovery epoch and appends a same-occurrence Attempt."
  def authorize(request, options \\ []) do
    mode = Keyword.get(options, :mode, :retained)
    pre_prompt_process? = Keyword.get(options, :pre_prompt_process, false)

    result =
      Repo.transaction(fn ->
        case Repo.get_by(OperationalRecoveryEpoch, request_id: request.request_id) do
          %OperationalRecoveryEpoch{} = existing -> replay!(existing, request)
          nil -> authorize_new!(request, mode, pre_prompt_process?)
        end
      end)

    case result do
      {:ok, value} ->
        Scheduler.wake(value.run_id)
        RunChangeNotifier.notify(value.run_id)
        ProductChangeNotifier.notify(["quests", "runs"])
        {:ok, value}

      {:error, error} ->
        {:error, error}
    end
  end

  defp authorize_new!(request, mode, pre_prompt_process?) do
    lock_run!(request.run_id)

    case existing_recovery_intent(request, mode) do
      %OperationalRecoveryEpoch{} = existing ->
        replay!(existing, request)

      nil ->
        case Repo.get_by(OperationalRecoveryEpoch, request_id: request.request_id) do
          %OperationalRecoveryEpoch{} = existing -> replay!(existing, request)
          nil -> authorize_locked!(request, mode, pre_prompt_process?)
        end
    end
  end

  defp existing_recovery_intent(request, mode) do
    Repo.get_by(OperationalRecoveryEpoch,
      run_id: request.run_id,
      occurrence_id: request.occurrence_id,
      authorization_kind: "human",
      source_attempt_id: request.attempt_id,
      continuation_mode: Atom.to_string(mode)
    )
  end

  defp authorize_locked!(request, mode, pre_prompt_process?) do
    dispatch = lock_source_dispatch!(request)
    scheduled = Repo.get!(ScheduledActionExecution, request.action_id)
    validate_source!(dispatch, scheduled, request, mode)
    validate_workspace!(request.run_id, scheduled.worker_id)
    session = validate_session!(request, mode)

    if pre_prompt_process? do
      worker = Repo.get(Worker, request.worker_id)

      case pre_prompt_process_error(dispatch, scheduled, session, worker, request) do
        nil -> :ok
        recovery_error -> Repo.rollback(recovery_error)
      end
    end

    outbox = Repo.get_by!(RuntimeOutbox, action_id: request.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)
    validate_current_attempt!(request.run_id, action)

    retire_uncertain_schedule!(dispatch, scheduled, mode)
    latest = latest_epoch!(request.run_id, request.occurrence_id)
    epoch_number = latest.epoch_number + 1
    now = now()

    epoch =
      %OperationalRecoveryEpoch{}
      |> OperationalRecoveryEpoch.changeset(%{
        run_id: request.run_id,
        occurrence_id: request.occurrence_id,
        epoch_number: epoch_number,
        authorization_kind: "human",
        source_attempt_id: request.attempt_id,
        request_id: request.request_id,
        attempt_allowance: configured_allowance(),
        policy_source: "configured",
        retained_session_id: session && session.id,
        retained_lineage_id: session && session.id,
        continuation_mode: Atom.to_string(mode),
        authorized_at: now
      })
      |> Repo.insert!()

    transition =
      case RuntimeStore.apply_transition(
             request.run_id,
             "human-operational-recovery/v1/#{request.request_id}",
             Runtime.recovery_requested(action)
           ) do
        {:ok, transition} -> transition
        {:error, runtime_error} -> Repo.rollback(runtime_error)
      end

    ready_workspace!(request.run_id)

    %{
      id: epoch.id,
      run_id: request.run_id,
      occurrence_id: request.occurrence_id,
      epoch_number: epoch_number,
      attempt_allowance: epoch.attempt_allowance,
      continuation_mode: epoch.continuation_mode,
      request_id: epoch.request_id,
      next_action_id: transition.actions |> List.first() |> then(&(&1 && &1.id)),
      idempotent_replay?: false
    }
  end

  defp replay!(epoch, request) do
    if epoch.run_id != request.run_id or epoch.occurrence_id != request.occurrence_id or
         epoch.source_attempt_id != request.attempt_id do
      Repo.rollback(%Error{
        code: :recovery_request_conflict,
        details: %{request_id: request.request_id}
      })
    end

    replay_value(epoch)
  end

  defp replay_value(epoch) do
    %{
      id: epoch.id,
      run_id: epoch.run_id,
      occurrence_id: epoch.occurrence_id,
      epoch_number: epoch.epoch_number,
      attempt_allowance: epoch.attempt_allowance,
      continuation_mode: epoch.continuation_mode,
      request_id: epoch.request_id,
      next_action_id: nil,
      idempotent_replay?: true
    }
  end

  defp validate_source!(dispatch, scheduled, request, mode) do
    retained_work_recovery = retained_work_recovery?(dispatch, scheduled, mode)
    validate_source_state!(dispatch, scheduled, request, retained_work_recovery)
    validate_source_identity!(scheduled, request)
    validate_source_failure!(dispatch, request, retained_work_recovery)
  end

  defp retained_work_recovery?(dispatch, scheduled, mode) do
    mode == :fresh and dispatch.state == "uncertain" and
      get_in(dispatch.failure || %{}, ["code"]) == "harness_contract_violation" and
      scheduled.state in ["active", "failed"]
  end

  defp validate_source_state!(%{state: "uncertain"}, _scheduled, request, false),
    do: Repo.rollback(error(:execution_still_uncertain, request))

  defp validate_source_state!(dispatch, scheduled, request, false) do
    if dispatch.state != "failed" or scheduled.state != "failed" do
      Repo.rollback(error(:execution_not_recoverable, request, %{dispatch_state: dispatch.state}))
    end
  end

  defp validate_source_state!(_dispatch, _scheduled, _request, true), do: :ok

  defp validate_source_identity!(scheduled, request) do
    unless scheduled.run_id == request.run_id and
             scheduled.occurrence_id == request.occurrence_id and
             scheduled.member_key == request.member_key do
      Repo.rollback(error(:recovery_identity_mismatch, request))
    end
  end

  defp validate_source_failure!(dispatch, request, false) do
    if failure_classification(dispatch.failure) == "terminal_not_recoverable" do
      Repo.rollback(
        error(:execution_not_recoverable, request, %{classification: "terminal_not_recoverable"})
      )
    end
  end

  defp validate_source_failure!(_dispatch, _request, true), do: :ok

  defp retire_uncertain_schedule!(
         %{state: "uncertain", failure: failure} = dispatch,
         scheduled,
         :fresh
       ) do
    if scheduled.state == "active" do
      released_at = now()
      Repo.update!(Ecto.Changeset.change(dispatch, slot_released_at: released_at))

      Repo.update!(
        Ecto.Changeset.change(scheduled,
          state: "failed",
          terminal_at: scheduled.terminal_at || released_at,
          failure: failure
        )
      )

      DispatchStore.refresh_worker_occupancy(scheduled.worker_id)
    end

    :ok
  end

  defp retire_uncertain_schedule!(_dispatch, _scheduled, _mode), do: :ok

  defp validate_workspace!(run_id, worker_id) do
    assignment =
      Repo.one(
        from assignment in RunWorkspaceAssignment,
          where: assignment.run_id == ^run_id,
          lock: "FOR UPDATE"
      )

    if is_nil(assignment) or assignment.worker_id != worker_id or
         assignment.state not in ["ready", "retained"] do
      Repo.rollback(%Error{
        code: :recovery_workspace_unavailable,
        details: %{run_id: run_id, state: assignment && assignment.state}
      })
    end
  end

  defp pre_prompt_process_error(dispatch, scheduled, session, worker, request) do
    case session_error(session, worker, request) do
      nil -> pre_prompt_source_error(dispatch, scheduled, session, request)
      recovery_error -> recovery_error
    end
  end

  defp pre_prompt_source_error(dispatch, scheduled, session, request) do
    cond do
      not terminal_source?(dispatch, scheduled) ->
        error(:execution_not_recoverable, request, %{dispatch_state: dispatch.state})

      not pre_prompt_control_failure?(dispatch.failure || %{}) ->
        adoption_error(request, "source_failure_is_not_control_readiness")

      not retained_antigravity?(session) ->
        adoption_error(request, "source_session_is_not_retained_antigravity")

      not is_nil(session.native_session_id) ->
        adoption_error(request, "native_conversation_exists")

      not pre_prompt_turn?(session.turn) ->
        adoption_error(request, "source_prompt_lifecycle_is_not_empty")

      true ->
        nil
    end
  end

  defp terminal_source?(dispatch, scheduled),
    do: dispatch.state == "failed" and scheduled.state == "failed"

  defp retained_antigravity?(session),
    do: session.harness_kind == "antigravity" and session.state == "retained"

  defp adoption_error(request, reason),
    do: error(:pre_prompt_process_adoption_unavailable, request, %{reason: reason})

  defp pre_prompt_control_failure?(failure) do
    failure["code"] == "execution_control_readiness_failed" or
      failure["reason"] == "execution_control_readiness_failed" or
      legacy_pre_prompt_control_failure?(failure)
  end

  defp legacy_pre_prompt_control_failure?(failure),
    do:
      failure["message"] ==
        "Antigravity did not launch the QE MCP child with the active bridge context."

  defp pre_prompt_turn?(turn) when is_map(turn) do
    Enum.all?(
      ~w(prompt_intent_at prompt_accepted_at native_activity_at provider_turn_settled_at native_idle_at structured_result_received_at stalled_at settled_at),
      &is_nil(turn[&1])
    )
  end

  defp pre_prompt_turn?(_turn), do: false

  defp validate_session!(_request, :fresh), do: nil

  defp validate_session!(request, :retained) do
    session =
      Repo.one(
        from session in ExecutionSession,
          where: session.id == ^request.session_id,
          lock: "FOR UPDATE"
      )

    worker = Repo.get(Worker, request.worker_id)

    case session_error(session, worker, request) do
      nil -> session
      recovery_error -> Repo.rollback(recovery_error)
    end
  end

  defp session_error(nil, _worker, request),
    do: error(:retained_session_unavailable, request)

  defp session_error(session, worker, request) do
    cond do
      stale_worker?(session, worker) ->
        error(:stale_recovery_worker_generation, request)

      session.worker_id != request.worker_id ->
        error(:recovery_worker_mismatch, request)

      session.current_action_id != request.action_id ->
        error(:recovery_session_mismatch, request)

      session.state not in ["retained", "running"] ->
        error(:retained_session_unavailable, request, %{state: session.state})

      request.lineage_id != session.id ->
        error(:recovery_session_mismatch, request)

      session.native_session_id != request.native_session_id ->
        error(:recovery_native_session_mismatch, request)

      true ->
        nil
    end
  end

  defp stale_worker?(_session, nil), do: true

  defp stale_worker?(session, worker),
    do:
      worker.status != "connected" or
        session.last_connection_generation != worker.connection_generation

  defp validate_current_attempt!(run_id, action) do
    {:ok, %{run: run}} = RuntimeStore.fetch_run(run_id)
    occurrence = Map.get(run.occurrences, action.occurrence_id)

    conflicting_schedule =
      Repo.exists?(
        from scheduled in ScheduledActionExecution,
          where:
            scheduled.run_id == ^run_id and scheduled.occurrence_id == ^action.occurrence_id and
              scheduled.state == "active" and scheduled.action_id != ^action.id
      )

    if is_nil(occurrence) or occurrence.current_attempt_id != action.attempt_id or
         conflicting_schedule do
      Repo.rollback(error(:replacement_attempt_already_exists, action))
    end
  end

  defp ready_workspace!(run_id) do
    now = now()

    from(assignment in RunWorkspaceAssignment,
      where: assignment.run_id == ^run_id and assignment.state == "retained"
    )
    |> Repo.update_all(set: [state: "ready", retained_at: nil, updated_at: now])
  end

  defp lock_run!(run_id) do
    Repo.one!(from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE")
  end

  defp lock_source_dispatch!(request) do
    case Repo.one(
           from dispatch in WorkerDispatch,
             where: dispatch.action_id == ^request.action_id,
             lock: "FOR UPDATE"
         ) do
      nil -> Repo.rollback(error(:dispatch_not_found, request))
      dispatch -> dispatch
    end
  end

  defp latest_epoch!(run_id, occurrence_id) do
    Repo.one!(
      from epoch in OperationalRecoveryEpoch,
        where: epoch.run_id == ^run_id and epoch.occurrence_id == ^occurrence_id,
        order_by: [desc: epoch.epoch_number],
        limit: 1,
        lock: "FOR UPDATE"
    )
  end

  defp failure_classification(%{"classification" => value}), do: value
  defp failure_classification(_), do: "operator_recovery_required"

  defp attempt_number!(attempt_id) do
    case Regex.run(~r{/attempt/(\d+)$}, attempt_id, capture: :all_but_first) do
      [number] ->
        String.to_integer(number)

      _ ->
        Repo.rollback(%Error{code: :invalid_attempt_identity, details: %{attempt_id: attempt_id}})
    end
  end

  defp error(code, source, extra \\ %{}) do
    details =
      source
      |> Map.take([:run_id, :occurrence_id, :attempt_id, :action_id, :request_id])
      |> Map.merge(extra)

    %Error{code: code, details: details}
  end

  defp encode(value), do: Base.url_encode64(value, padding: false)
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
