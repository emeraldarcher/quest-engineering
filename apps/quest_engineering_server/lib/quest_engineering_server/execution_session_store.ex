defmodule QuestEngineering.Server.ExecutionSessionStore do
  @moduledoc "Generation-fenced durable operational state for coding-agent harness sessions."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.ExecutionSessionAuditEvent
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.ServerWeb.Endpoint

  @attachment_salt "local-live-session-attachment-v1"
  @attachment_ttl_seconds 60

  def record(worker_id, generation, session) do
    with {:ok, %{worker_id: ^worker_id, action: action}} <-
           DispatchStore.fetch(session.action_id),
         :ok <- validate_action(worker_id, action, session) do
      result = Repo.transaction(fn -> persist_session!(worker_id, generation, session) end)

      case result do
        {:ok, persisted} ->
          RunChangeNotifier.notify(session.run_id)
          {:ok, persisted}

        {:error, error} ->
          {:error, error}
      end
    else
      {:ok, _other_dispatch} ->
        {:error,
         %WorkerError{
           type: :dispatch_worker_mismatch,
           worker_id: worker_id,
           action_id: session.action_id
         }}

      {:error, _} = error ->
        error
    end
  end

  defp persist_session!(worker_id, generation, session) do
    _worker = lock_worker!(worker_id, generation)
    dispatch = lock_dispatch!(session.action_id, worker_id)
    existing = Repo.get(ExecutionSession, session.session_id)
    validate_existing!(existing, worker_id)

    stale = stale_update?(existing, generation, session.last_activity_at)

    persisted =
      if stale,
        do: existing,
        else:
          persist_changeset!(
            existing,
            session_attributes(
              worker_id,
              generation,
              session,
              merged_attention(existing, session.attention),
              merged_native_session_id(existing, session.native_session_id)
            )
          )

    Repo.update!(Changeset.change(dispatch, execution_session_id: persisted.id))
    unless stale, do: audit_attention_transition(existing, persisted, session)
    persisted
  end

  defp stale_update?(nil, _generation, _last_activity_at), do: false

  defp stale_update?(existing, generation, last_activity_at) do
    existing.last_connection_generation == generation and
      DateTime.compare(last_activity_at, existing.last_activity_at) == :lt
  end

  defp persist_changeset!(nil, attributes),
    do: Repo.insert!(ExecutionSession.changeset(attributes))

  defp persist_changeset!(existing, attributes),
    do: Repo.update!(ExecutionSession.changeset(existing, attributes))

  defp session_attributes(worker_id, generation, session, attention, native_session_id) do
    %{
      id: session.session_id,
      worker_id: worker_id,
      current_action_id: session.action_id,
      harness_kind: session.harness_kind,
      harness_display_name: session.harness_display_name,
      state: Atom.to_string(session.state),
      capabilities: session.capabilities,
      terminal: session.terminal,
      native_session_id: native_session_id,
      attention: attention,
      turn: Map.get(session, :turn),
      last_connection_generation: generation,
      started_at: session.started_at,
      last_activity_at: session.last_activity_at
    }
  end

  def reconcile(worker_id, generation, sessions) do
    Enum.reduce_while(sessions, {:ok, []}, fn session, {:ok, values} ->
      case record(worker_id, generation, session) do
        {:ok, persisted} ->
          {:cont, {:ok, [persisted | values]}}

        {:error, %WorkerError{type: :dispatch_not_found}} ->
          # A Worker can legitimately retain completed local history after the
          # control-plane database is reset. Dispatch reconciliation records
          # the unknown local Action as an anomaly; its orphaned session has no
          # safe server-side identity to persist and must not reject the rest.
          {:cont, {:ok, values}}

        {:error, error} ->
          {:halt, {:error, error}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      error -> error
    end
  end

  def list_for_actions([]), do: []

  def list_for_actions(action_ids) do
    Repo.all(
      from session in ExecutionSession,
        join: dispatch in WorkerDispatch,
        on: dispatch.execution_session_id == session.id,
        join: worker in Worker,
        on: worker.id == session.worker_id,
        where: dispatch.action_id in ^action_ids,
        select: {dispatch.action_id, session, worker}
    )
  end

  def attachment_descriptor(run_id, attempt_id, session_id) do
    with {:ok, %{session: session, worker: worker, action: action}} <-
           lookup_usage(run_id, attempt_id, session_id),
         :ok <- available_for_attachment(session, worker),
         token <-
           Phoenix.Token.sign(Endpoint, @attachment_salt, %{
             "run_id" => run_id,
             "attempt_id" => attempt_id,
             "session_id" => session.id,
             "worker_id" => worker.id,
             "worker_generation" => worker.connection_generation
           }),
         now <- DateTime.utc_now() |> DateTime.truncate(:second),
         :ok <- audit(session, action, "attachment_descriptor_issued", session.attention, %{}) do
      RunChangeNotifier.notify(run_id)

      {:ok,
       %{
         descriptor_token: token,
         expires_at: DateTime.add(now, @attachment_ttl_seconds, :second),
         mode: "local_native_terminal",
         worker_id: worker.id,
         worker_generation: worker.connection_generation,
         session_id: session.id,
         state: session.state,
         takeover_allowed: takeover_available?(session, action),
         recovery_allowed:
           session.current_action_id == action.id and session.state == "retained" and
             get_in(session.terminal, ["supports_takeover"]) == true,
         terminal: session.terminal
       }}
    end
  end

  def record_opened(token), do: record_opened(token, "observe")

  def record_opened(token, mode)
      when is_binary(token) and mode in ["observe", "takeover", "recovery"] do
    with {:ok, claims} <-
           Phoenix.Token.verify(Endpoint, @attachment_salt, token,
             max_age: @attachment_ttl_seconds
           ),
         {:ok, %{session: session, worker: worker, action: action}} <-
           lookup_usage(claims["run_id"], claims["attempt_id"], claims["session_id"]),
         true <- worker.id == claims["worker_id"],
         true <- worker.connection_generation == claims["worker_generation"],
         :ok <- available_for_attachment(session, worker),
         :ok <- takeover_allowed(session, action, mode),
         {:ok, persisted} <- record_native_open(session, action, mode) do
      RunChangeNotifier.notify(claims["run_id"])
      {:ok, persisted}
    else
      false -> {:error, :stale_attachment_descriptor}
      {:error, _} = error -> error
    end
  end

  def record_opened(_token, _mode), do: {:error, :invalid_attachment_descriptor}

  def notify_worker_runs(worker_id) do
    Repo.all(
      from session in ExecutionSession,
        where: session.worker_id == ^worker_id and not is_nil(session.current_action_id),
        select: session.current_action_id
    )
    |> Enum.each(fn action_id ->
      case DispatchStore.fetch(action_id) do
        {:ok, %{action: action}} -> RunChangeNotifier.notify(action.run_id)
        _ -> :ok
      end
    end)

    :ok
  end

  def audit_history(run_id) do
    Repo.all(
      from event in ExecutionSessionAuditEvent,
        where: event.run_id == ^run_id,
        order_by: [asc: event.occurred_at, asc: event.inserted_at]
    )
  end

  defp lookup_usage(run_id, attempt_id, session_id) do
    dispatches =
      Repo.all(
        from dispatch in WorkerDispatch,
          where: dispatch.execution_session_id == ^session_id
      )

    Enum.find_value(
      dispatches,
      {:error, :session_not_found},
      &matching_usage(&1, run_id, attempt_id, session_id)
    )
  end

  defp matching_usage(dispatch, run_id, attempt_id, session_id) do
    with {:ok, %{action: action}} <- DispatchStore.fetch(dispatch.action_id),
         true <- action.run_id == run_id and action.attempt_id == attempt_id,
         %ExecutionSession{} = session <- Repo.get(ExecutionSession, session_id),
         %Worker{} = worker <- Repo.get(Worker, session.worker_id) do
      {:ok, %{session: session, worker: worker, action: action}}
    else
      _ -> nil
    end
  end

  defp available_for_attachment(session, worker) do
    cond do
      worker.status != "connected" ->
        {:error, :worker_offline}

      session.last_connection_generation != worker.connection_generation ->
        {:error, :stale_attachment_descriptor}

      not get_in(session.capabilities, ["can_attach_terminal"]) ->
        {:error, :attachment_unavailable}

      not is_map(session.terminal) ->
        {:error, :attachment_unavailable}

      session.state in ["closed", "unavailable"] ->
        {:error, :attachment_unavailable}

      true ->
        :ok
    end
  end

  defp validate_action(worker_id, action, session) do
    if action.run_id == session.run_id and action.occurrence_id == session.occurrence_id and
         action.attempt_id == session.attempt_id do
      :ok
    else
      {:error,
       %WorkerError{
         type: :dispatch_identity_mismatch,
         worker_id: worker_id,
         action_id: session.action_id
       }}
    end
  end

  defp lock_worker!(worker_id, generation) do
    case Repo.one(from worker in Worker, where: worker.id == ^worker_id, lock: "FOR UPDATE") do
      %{connection_generation: ^generation} = worker -> worker
      nil -> Repo.rollback(:worker_not_found)
      worker -> Repo.rollback({:stale_connection_generation, worker.connection_generation})
    end
  end

  defp lock_dispatch!(action_id, worker_id) do
    case Repo.one(
           from dispatch in WorkerDispatch,
             where: dispatch.action_id == ^action_id,
             lock: "FOR UPDATE"
         ) do
      %{worker_id: ^worker_id} = dispatch -> dispatch
      nil -> Repo.rollback(:dispatch_not_found)
      _ -> Repo.rollback(:dispatch_worker_mismatch)
    end
  end

  defp validate_existing!(nil, _worker_id), do: :ok

  defp validate_existing!(existing, worker_id) do
    if existing.worker_id != worker_id,
      do: Repo.rollback(:session_identity_conflict),
      else: :ok
  end

  defp merged_attention(
         %{attention: %{"attention_id" => id} = current},
         %{"attention_id" => id, "interaction" => %{"control_state" => "intervention_pending"}} =
           incoming
       ) do
    case get_in(current, ["interaction", "control_state"]) do
      "human_control" -> put_in(incoming, ["interaction", "control_state"], "human_control")
      _ -> incoming
    end
  end

  defp merged_attention(_existing, incoming), do: incoming

  defp merged_native_session_id(nil, incoming), do: incoming
  defp merged_native_session_id(%{native_session_id: nil}, incoming), do: incoming
  defp merged_native_session_id(%{native_session_id: current}, nil), do: current
  defp merged_native_session_id(%{native_session_id: current}, current), do: current

  defp merged_native_session_id(%{native_session_id: _current}, _incoming),
    do: Repo.rollback(:session_native_identity_conflict)

  defp takeover_allowed(_session, _action, "observe"), do: :ok

  defp takeover_allowed(session, action, "recovery") do
    if session.current_action_id == action.id and session.state == "retained" and
         get_in(session.terminal, ["supports_takeover"]) == true,
       do: :ok,
       else: {:error, :attachment_unavailable}
  end

  defp takeover_allowed(session, action, "takeover") do
    if takeover_available?(session, action),
      do: :ok,
      else: {:error, :attachment_unavailable}
  end

  defp takeover_available?(session, action) do
    session.current_action_id == action.id and
      get_in(session.terminal, ["supports_takeover"]) == true and
      not pre_prompt_authorization_pending?(session)
  end

  defp pre_prompt_authorization_pending?(session) do
    attention_id = get_in(session.attention || %{}, ["attention_id"])

    session.state == "waiting_for_human" and
      get_in(session.attention || %{}, ["category"]) == "needs_confirmation" and
      is_binary(attention_id) and String.starts_with?(attention_id, "qe-prompt-authorization-") and
      is_nil(get_in(session.turn || %{}, ["prompt_intent_at"]))
  end

  defp record_native_open(session, action, mode) do
    result =
      Repo.transaction(fn ->
        persisted =
          if mode == "takeover" and
               get_in(session.attention || %{}, ["interaction", "kind"]) ==
                 "conversational_intervention" do
            attention =
              put_in(session.attention, ["interaction", "control_state"], "human_control")

            Repo.update!(Changeset.change(session, attention: attention))
          else
            session
          end

        metadata = %{
          "mode" => mode,
          "human_control_started" => mode == "takeover"
        }

        metadata =
          if mode == "recovery",
            do: Map.put(metadata, "human_recovery_session_opened", true),
            else: metadata

        case audit(persisted, action, "local_session_opened", persisted.attention, metadata) do
          :ok -> persisted
          {:error, error} -> Repo.rollback(error)
        end
      end)

    case result do
      {:ok, persisted} -> {:ok, persisted}
      {:error, error} -> {:error, error}
    end
  end

  defp audit_attention_transition(existing, persisted, session) do
    old_attention = existing && existing.attention
    new_attention = persisted.attention

    cond do
      is_map(new_attention) and attention_id(old_attention) != attention_id(new_attention) ->
        audit!(persisted, session, "attention_requested", new_attention)

      is_map(old_attention) and is_nil(new_attention) ->
        audit!(
          persisted,
          session,
          "attention_resolved",
          old_attention,
          intervention_resolution_metadata(Map.get(session, :intervention))
        )

      true ->
        :ok
    end
  end

  defp audit(session, action, type, attention, metadata) do
    identity = audit_identity(action)

    attributes = %{
      session_id: session.id,
      event_type: type,
      attention_id: attention_id(attention),
      run_id: identity.run_id,
      action_id: identity.action_id,
      occurrence_id: identity.occurrence_id,
      attempt_id: identity.attempt_id,
      metadata: metadata,
      occurred_at: DateTime.utc_now() |> DateTime.truncate(:microsecond)
    }

    on_conflict =
      if type == "local_session_opened" and metadata["human_control_started"] == true,
        do: {:replace, [:metadata, :occurred_at]},
        else: :nothing

    case Repo.insert(ExecutionSessionAuditEvent.changeset(attributes),
           on_conflict: on_conflict,
           conflict_target:
             {:unsafe_fragment,
              "(session_id, event_type, attention_id) WHERE attention_id IS NOT NULL"}
         ) do
      {:ok, _} -> :ok
      {:error, error} -> {:error, error}
    end
  end

  defp audit!(session, action, type, attention, metadata \\ %{}) do
    case audit(
           session,
           action,
           type,
           attention,
           Map.put(metadata, "category", attention["category"])
         ) do
      :ok -> :ok
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp audit_identity(%{action_id: action_id} = value) do
    %{
      action_id: action_id,
      run_id: value.run_id,
      occurrence_id: value.occurrence_id,
      attempt_id: value.attempt_id
    }
  end

  defp audit_identity(action) do
    %{
      action_id: action.id,
      run_id: action.run_id,
      occurrence_id: action.occurrence_id,
      attempt_id: action.attempt_id
    }
  end

  defp intervention_resolution_metadata(
         %{
           "kind" => "conversational_intervention",
           "state" => "resumed"
         } = intervention
       ) do
    %{
      "human_control_returned" => true,
      "handed_back_at" => intervention["handed_back_at"],
      "automation_resumed" => true,
      "automation_resumed_at" => intervention["automation_resumed_at"]
    }
  end

  defp intervention_resolution_metadata(_), do: %{}

  defp attention_id(%{"attention_id" => id}) when is_binary(id), do: id
  defp attention_id(_), do: nil
end
