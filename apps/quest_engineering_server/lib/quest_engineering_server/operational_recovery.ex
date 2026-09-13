defmodule QuestEngineering.Server.OperationalRecovery do
  @moduledoc """
  PostgreSQL authority for immutable operational recovery epochs and Attempt attribution.

  Recovery appends a new epoch and Runtime Attempt. It never rewrites a prior
  dispatch, Attempt, StepOccurrence, or semantic remediation region.
  """

  import Ecto.Query

  alias QuestEngineering.Core.Runtime
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
    {String.to_existing_atom(classification), epoch}
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

  def authorize_fresh(run_id, occurrence_id, request_id) do
    scheduled =
      Repo.one(
        from scheduled in ScheduledActionExecution,
          where: scheduled.run_id == ^run_id and scheduled.occurrence_id == ^occurrence_id,
          order_by: [desc: scheduled.bound_at],
          limit: 1
      )

    if scheduled do
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
    else
      {:error,
       %Error{
         code: :execution_not_recoverable,
         details: %{run_id: run_id, occurrence_id: occurrence_id}
       }}
    end
  end

  @doc "Authorizes a new human recovery epoch and appends a same-occurrence Attempt."
  def authorize(request, options \\ []) do
    mode = Keyword.get(options, :mode, :retained)

    result =
      Repo.transaction(fn ->
        case Repo.get_by(OperationalRecoveryEpoch, request_id: request.request_id) do
          %OperationalRecoveryEpoch{} = existing -> replay!(existing, request)
          nil -> authorize_new!(request, mode)
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

  defp authorize_new!(request, mode) do
    lock_run!(request.run_id)

    case Repo.get_by(OperationalRecoveryEpoch, request_id: request.request_id) do
      %OperationalRecoveryEpoch{} = existing -> replay!(existing, request)
      nil -> authorize_locked!(request, mode)
    end
  end

  defp authorize_locked!(request, mode) do
    dispatch = lock_source_dispatch!(request)
    scheduled = Repo.get!(ScheduledActionExecution, request.action_id)
    validate_source!(dispatch, scheduled, request)
    validate_workspace!(request.run_id, scheduled.worker_id)
    session = validate_session!(request, mode)
    outbox = Repo.get_by!(RuntimeOutbox, action_id: request.action_id)
    {:ok, action} = RuntimeCodec.decode(outbox.payload)
    validate_current_attempt!(request.run_id, action)

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
             Runtime.retry_requested(action)
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

  defp validate_source!(dispatch, scheduled, request) do
    cond do
      dispatch.state == "uncertain" ->
        Repo.rollback(error(:execution_still_uncertain, request))

      dispatch.state != "failed" or scheduled.state != "failed" ->
        Repo.rollback(
          error(:execution_not_recoverable, request, %{dispatch_state: dispatch.state})
        )

      scheduled.run_id != request.run_id or scheduled.occurrence_id != request.occurrence_id or
          scheduled.member_key != request.member_key ->
        Repo.rollback(error(:recovery_identity_mismatch, request))

      failure_classification(dispatch.failure) == "terminal_not_recoverable" ->
        Repo.rollback(
          error(:execution_not_recoverable, request, %{classification: "terminal_not_recoverable"})
        )

      true ->
        :ok
    end
  end

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
         conflicting_schedule or
         Enum.any?(
           occurrence.attempts,
           &(&1.id != action.attempt_id and &1.status == :dispatched)
         ) do
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
