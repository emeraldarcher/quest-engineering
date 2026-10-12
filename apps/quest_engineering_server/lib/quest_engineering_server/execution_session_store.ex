defmodule QuestEngineering.Server.ExecutionSessionStore do
  @moduledoc "Generation-fenced durable operational state for coding-agent harness sessions."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Server.DispatchStore
  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.ExecutionSessionAuditEvent
  alias QuestEngineering.Server.Persistence.HumanAttentionRequest
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerError
  alias QuestEngineering.Server.WorkerProtocol
  alias QuestEngineering.ServerWeb.Endpoint

  @attachment_salt "local-live-session-attachment-v1"
  @attachment_ttl_seconds 60

  def record(worker_id, generation, session) do
    with {:ok, %{worker_id: ^worker_id, action: action}} <-
           DispatchStore.fetch(session.action_id),
         :ok <- validate_action(worker_id, action, session) do
      result =
        Repo.transaction(fn -> persist_session!(worker_id, generation, session, action) end)

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

  defp persist_session!(worker_id, generation, session, action) do
    _worker = lock_worker!(worker_id, generation)
    dispatch = lock_dispatch!(session.action_id, worker_id)
    existing = Repo.get(ExecutionSession, session.session_id)
    validate_existing!(existing, worker_id)

    stale = stale_update?(existing, generation, session.last_activity_at)

    persisted =
      if stale do
        existing
      else
        attention =
          merged_attention(existing, session.attention, action.id, session.session_id)

        persist_changeset!(
          existing,
          session_attributes(
            worker_id,
            generation,
            session,
            attention,
            merged_native_session_id(existing, session.native_session_id),
            normalized_session_state(existing, session.state, attention)
          )
        )
      end

    Repo.update!(Changeset.change(dispatch, execution_session_id: persisted.id))

    unless stale do
      retire_replaced_attention!(existing, persisted)
      persist_attention_request!(persisted, action)
      audit_attention_transition(existing, persisted, session)
    end

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

  defp session_attributes(
         worker_id,
         generation,
         session,
         attention,
         native_session_id,
         session_state
       ) do
    %{
      id: session.session_id,
      worker_id: worker_id,
      current_action_id: session.action_id,
      harness_kind: session.harness_kind,
      harness_display_name: session.harness_display_name,
      state: session_state,
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
    with {:ok, %{session: session, worker: worker, action: action, dispatch: dispatch}} <-
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
         takeover_allowed: takeover_available?(session, action, dispatch),
         recovery_allowed:
           not cancellation_fenced?(dispatch) and session.current_action_id == action.id and
             session.state == "retained" and
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
         {:ok, %{session: session, worker: worker, action: action, dispatch: dispatch}} <-
           lookup_usage(claims["run_id"], claims["attempt_id"], claims["session_id"]),
         true <- worker.id == claims["worker_id"],
         true <- worker.connection_generation == claims["worker_generation"],
         :ok <- available_for_attachment(session, worker),
         :ok <- takeover_allowed(session, action, dispatch, mode),
         {:ok, persisted} <- record_native_open(session, action, mode) do
      RunChangeNotifier.notify(claims["run_id"])
      {:ok, persisted}
    else
      false -> {:error, :stale_attachment_descriptor}
      {:error, _} = error -> error
    end
  end

  def record_opened(_token, _mode), do: {:error, :invalid_attachment_descriptor}

  def respond_to_attention(run_id, attempt_id, session_id, response) do
    with {:ok, %{session: session, worker: worker, action: action, dispatch: dispatch}} <-
           lookup_usage(run_id, attempt_id, session_id),
         {:ok, committed, idempotent?} <-
           commit_attention_response(session, action, dispatch, response),
         {:ok, delivery_state} <-
           request_attention_delivery(committed, session, worker, action) do
      RunChangeNotifier.notify(run_id)

      {:ok,
       %{
         request_id: committed.response_request_id,
         attention_id: committed.id,
         session_id: session.id,
         response_state: committed.response_state,
         delivery_state: delivery_state,
         delivered: delivery_state == "delivery_acknowledged",
         idempotent_replay: idempotent?
       }}
    end
  end

  def cancel_attention_for_action!(action_id, reason) do
    request =
      Repo.one(
        from request in HumanAttentionRequest,
          where:
            request.action_id == ^action_id and
              (request.response_state == "pending" or
                 (request.response_state == "responded" and
                    request.delivery_state != "delivery_acknowledged")),
          lock: "FOR UPDATE"
      )

    if request do
      cancelled_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)

      cancelled =
        request
        |> HumanAttentionRequest.changeset(%{
          response_state: "cancelled",
          cancelled_at: cancelled_at,
          cancellation_reason: reason
        })
        |> Repo.update!()

      session = Repo.get!(ExecutionSession, cancelled.session_id)

      if get_in(session.attention || %{}, ["attention_id"]) == cancelled.id,
        do: Repo.update!(Changeset.change(session, attention: nil))

      audit_request!(cancelled, "attention_cancelled", cancelled_at, %{"reason" => reason})
    end

    :ok
  end

  def record_attention_delivery(worker_id, generation, delivery) do
    result =
      Repo.transaction(fn ->
        worker = lock_worker!(worker_id, generation)
        request = lock_attention_request!(delivery.attention_id)
        validate_delivery_identity!(request, worker, delivery)
        apply_delivery_report!(request, delivery)
      end)

    case result do
      {:ok, request} ->
        RunChangeNotifier.notify(request.run_id)
        {:ok, request}

      {:error, error} ->
        {:error, error}
    end
  end

  def reconcile_attention_deliveries(worker_id, generation, deliveries) do
    Enum.reduce_while(deliveries, {:ok, []}, fn delivery, {:ok, values} ->
      case record_attention_delivery(
             worker_id,
             generation,
             Map.put(delivery, :connection_generation, generation)
           ) do
        {:ok, request} -> {:cont, {:ok, [request | values]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      error -> error
    end
  end

  def pending_attention_responses(worker_id, generation) do
    Repo.transaction(fn ->
      _worker = lock_worker!(worker_id, generation)

      Repo.all(
        from request in HumanAttentionRequest,
          where:
            request.worker_id == ^worker_id and request.response_state == "responded" and
              request.delivery_state == "delivery_requested" and
              request.delivery_requested_generation != ^generation,
          lock: "FOR UPDATE"
      )
      |> Enum.each(fn request ->
        uncertain_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)

        uncertain =
          request
          |> HumanAttentionRequest.changeset(%{
            delivery_state: "delivery_uncertain",
            delivery_uncertain_at: uncertain_at,
            cancellation_reason:
              "Worker generation changed after native response delivery was requested."
          })
          |> Repo.update!()

        update_session_attention!(Repo.get!(ExecutionSession, request.session_id), uncertain)

        audit_request!(uncertain, "attention_delivery_uncertain", uncertain_at, %{
          "delivery_attempt_id" => uncertain.delivery_attempt_id,
          "reason" => uncertain.cancellation_reason
        })
      end)

      Repo.all(
        from request in HumanAttentionRequest,
          where:
            request.worker_id == ^worker_id and request.response_state == "responded" and
              request.delivery_state == "response_not_delivered",
          lock: "FOR UPDATE"
      )
      |> Enum.map(&prepare_delivery_command!(&1, generation))
    end)
    |> case do
      {:ok, commands} -> {:ok, commands}
      {:error, error} -> {:error, error}
    end
  end

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
      {:ok, %{session: session, worker: worker, action: action, dispatch: dispatch}}
    else
      _ -> nil
    end
  end

  defp commit_attention_response(session, action, dispatch, response) do
    result =
      Repo.transaction(fn ->
        request = lock_attention_request!(response.attention_id)
        response_available!(request, session, action, dispatch, response)
        submitted_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)
        payload = %{"approved" => response.approved, "value" => response.value}

        if byte_size(Jason.encode!(payload)) > 131_072,
          do: Repo.rollback(:invalid_attention_response)

        cond do
          request.response_state == "responded" and request.response == payload and
              request.response_request_id == response.request_id ->
            {request, true}

          request.response_state != "pending" ->
            Repo.rollback(:stale_attention)

          true ->
            committed =
              request
              |> HumanAttentionRequest.changeset(%{
                response_state: "responded",
                response: payload,
                response_request_id: response.request_id,
                response_submitted_at: submitted_at,
                response_committed_at: submitted_at,
                delivery_state: "response_not_delivered"
              })
              |> Repo.update!()

            update_session_attention!(session, committed)

            audit_request!(
              committed,
              "attention_response_committed",
              submitted_at,
              %{"request_id" => response.request_id}
            )

            {committed, false}
        end
      end)

    case result do
      {:ok, {request, idempotent?}} -> {:ok, request, idempotent?}
      {:error, error} -> {:error, error}
    end
  end

  defp response_available!(request, session, action, dispatch, response) do
    interaction = get_in(session.attention || %{}, ["interaction", "kind"])

    capability =
      case interaction do
        "confirmation" -> "structured_confirmation"
        "text" -> "structured_text_response"
        "choice" -> "structured_choice_response"
        "multiline_response" -> "structured_multiline_response"
        _ -> nil
      end

    valid_identity =
      request.session_id == session.id and request.worker_id == session.worker_id and
        request.run_id == action.run_id and request.action_id == action.id and
        request.occurrence_id == action.occurrence_id and
        request.attempt_id == action.attempt_id

    duplicate =
      request.response_state == "responded" and
        request.response == %{"approved" => response.approved, "value" => response.value} and
        request.response_request_id == response.request_id

    cond do
      not valid_identity ->
        Repo.rollback(:stale_attention)

      duplicate ->
        :ok

      session.current_action_id != action.id or not is_nil(dispatch.cancellation_requested_at) ->
        Repo.rollback(:stale_attention)

      session.state != "waiting_for_human" or
          get_in(session.attention || %{}, ["attention_id"]) != response.attention_id ->
        Repo.rollback(:stale_attention)

      is_nil(capability) or get_in(session.capabilities, [capability]) != true ->
        Repo.rollback(:attention_response_unavailable)

      not valid_attention_value?(
        interaction,
        response.approved,
        response.value,
        session.attention
      ) ->
        Repo.rollback(:invalid_attention_response)

      request.response_state == "responded" ->
        Repo.rollback(:stale_attention)

      request.response_state in ["cancelled", "obsolete"] ->
        Repo.rollback(:stale_attention)

      true ->
        :ok
    end
  end

  defp request_attention_delivery(request, session, worker, _action) do
    cond do
      request.delivery_state != "response_not_delivered" ->
        {:ok, request.delivery_state}

      worker.status != "connected" or
          session.last_connection_generation != worker.connection_generation ->
        {:ok, "response_not_delivered"}

      true ->
        case prepare_one_delivery(request.id, worker.connection_generation) do
          {:ok, prepared, command} ->
            case WorkerConnections.send_protocol(worker.id, worker.connection_generation, command) do
              :ok ->
                {:ok, prepared.delivery_state}

              {:error, _reason} ->
                restore_undelivered!(prepared)
                {:ok, "response_not_delivered"}
            end

          {:error, error} ->
            {:error, error}
        end
    end
  end

  defp prepare_one_delivery(attention_id, generation) do
    Repo.transaction(fn ->
      request = lock_attention_request!(attention_id)

      if request.response_state != "responded" or
           request.delivery_state != "response_not_delivered" do
        Repo.rollback(:stale_attention)
      end

      prepared = prepare_delivery_request!(request, generation)
      {prepared, WorkerProtocol.respond_human_attention(prepared.worker_id, generation, prepared)}
    end)
    |> case do
      {:ok, {prepared, command}} -> {:ok, prepared, command}
      {:error, error} -> {:error, error}
    end
  end

  defp prepare_delivery_command!(request, generation) do
    prepared = prepare_delivery_request!(request, generation)
    WorkerProtocol.respond_human_attention(prepared.worker_id, generation, prepared)
  end

  defp prepare_delivery_request!(request, generation) do
    requested_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)
    # A Worker reconciliation can prove that this exact committed response never
    # crossed into native delivery. Reuse that durable attempt identity; a new
    # identity would conflict with the Worker's already-committed response.
    delivery_attempt_id = request.delivery_attempt_id || Ecto.UUID.generate()

    prepared =
      request
      |> HumanAttentionRequest.changeset(%{
        delivery_state: "delivery_requested",
        delivery_attempt_id: delivery_attempt_id,
        delivery_requested_generation: generation,
        delivery_requested_at: requested_at
      })
      |> Repo.update!()

    update_session_attention!(Repo.get!(ExecutionSession, prepared.session_id), prepared)

    audit_request!(prepared, "attention_delivery_requested", requested_at, %{
      "delivery_attempt_id" => delivery_attempt_id,
      "worker_generation" => generation
    })

    prepared
  end

  defp restore_undelivered!(request) do
    Repo.transaction(fn ->
      current = lock_attention_request!(request.id)

      if current.delivery_state == "delivery_requested" and
           current.delivery_attempt_id == request.delivery_attempt_id do
        restored =
          current
          |> HumanAttentionRequest.changeset(%{
            delivery_state: "response_not_delivered",
            delivery_attempt_id: nil,
            delivery_requested_generation: nil,
            delivery_requested_at: nil
          })
          |> Repo.update!()

        update_session_attention!(Repo.get!(ExecutionSession, restored.session_id), restored)
      end
    end)
  end

  defp lock_attention_request!(attention_id) do
    case Repo.one(
           from request in HumanAttentionRequest,
             where: request.id == ^attention_id,
             lock: "FOR UPDATE"
         ) do
      nil -> Repo.rollback(:stale_attention)
      request -> request
    end
  end

  defp validate_delivery_identity!(request, worker, delivery) do
    exact =
      delivery.connection_generation == worker.connection_generation and
        request.worker_id == worker.id and request.action_id == delivery.action_id and
        request.run_id == delivery.run_id and request.occurrence_id == delivery.occurrence_id and
        request.attempt_id == delivery.attempt_id and request.session_id == delivery.session_id and
        request.request_generation == delivery.request_generation and
        request.delivery_attempt_id == delivery.delivery_attempt_id

    unless exact, do: Repo.rollback(:stale_attention)
  end

  defp apply_delivery_report!(request, delivery) do
    observed_at = delivery.observed_at

    effective_state =
      if Map.get(delivery, :response_state) in ["cancelled", "obsolete"] or
           delivery.state in ["cancelled", "obsolete"],
         do: "cancelled",
         else: delivery.state

    attributes =
      case effective_state do
        "delivery_acknowledged" ->
          if request.delivery_state not in ["delivery_requested", "delivery_acknowledged"],
            do: Repo.rollback(:stale_attention)

          %{
            delivery_state: "delivery_acknowledged",
            delivery_acknowledged_at: request.delivery_acknowledged_at || observed_at
          }

        "delivery_uncertain" ->
          if request.delivery_state not in ["delivery_requested", "delivery_uncertain"],
            do: Repo.rollback(:stale_attention)

          %{
            delivery_state: "delivery_uncertain",
            delivery_uncertain_at: request.delivery_uncertain_at || observed_at,
            cancellation_reason: delivery.reason
          }

        "cancelled" ->
          if request.delivery_state == "delivery_acknowledged",
            do: Repo.rollback(:stale_attention)

          terminal_response_state =
            Map.get(delivery, :response_state) ||
              if(delivery.state == "obsolete", do: "obsolete", else: "cancelled")

          %{
            response_state: terminal_response_state,
            cancelled_at: request.cancelled_at || observed_at,
            cancellation_reason: delivery.reason
          }

        "response_not_delivered" ->
          if request.delivery_state == "delivery_requested" do
            %{
              delivery_state: "response_not_delivered",
              delivery_requested_at: nil,
              delivery_requested_generation: nil
            }
          else
            %{}
          end

        "delivery_requested" ->
          %{}
      end

    persisted =
      request
      |> HumanAttentionRequest.changeset(attributes)
      |> Repo.update!()

    session = Repo.get!(ExecutionSession, request.session_id)

    if effective_state in ["delivery_acknowledged", "cancelled"] and
         get_in(session.attention || %{}, ["attention_id"]) == request.id do
      Repo.update!(Changeset.change(session, attention: nil, state: "running"))
    else
      update_session_attention!(session, persisted)
    end

    event_type =
      case effective_state do
        "delivery_acknowledged" -> "attention_delivery_acknowledged"
        "delivery_uncertain" -> "attention_delivery_uncertain"
        "cancelled" -> "attention_cancelled"
        _ -> nil
      end

    if event_type,
      do:
        audit_request!(persisted, event_type, observed_at, %{
          "delivery_attempt_id" => delivery.delivery_attempt_id,
          "reason" => delivery.reason
        })

    persisted
  end

  defp update_session_attention!(session, request) do
    if get_in(session.attention || %{}, ["attention_id"]) == request.id do
      attention =
        session.attention
        |> Map.put("response_state", request.response_state)
        |> Map.put("delivery_state", request.delivery_state)
        |> maybe_map_put("delivery_attempt_id", request.delivery_attempt_id)

      Repo.update!(Changeset.change(session, attention: attention))
    end
  end

  defp maybe_map_put(map, _key, nil), do: map
  defp maybe_map_put(map, key, value), do: Map.put(map, key, value)

  defp valid_attention_value?(_interaction, false, value, _attention),
    do: is_nil(value)

  defp valid_attention_value?("confirmation", true, value, _attention),
    do: value in [true, nil]

  defp valid_attention_value?("text", true, value, _attention),
    do: is_binary(value) and byte_size(value) > 0 and byte_size(value) <= 16_384

  defp valid_attention_value?("multiline_response", true, value, _attention),
    do: is_binary(value) and byte_size(value) > 0 and byte_size(value) <= 65_536

  defp valid_attention_value?("choice", true, value, attention) do
    schema = attention["response_schema"]

    with %{"kind" => "choice_form_v1", "questions" => questions} when is_list(questions) <- schema,
         %{"answers" => answers} when is_map(answers) <- value,
         true <- map_size(value) == 1 and map_size(answers) == length(questions) do
      Enum.all?(questions, fn
        %{
          "header" => header,
          "multi_select" => multi_select,
          "options" => options
        }
        when is_binary(header) and is_boolean(multi_select) and is_list(options) ->
          labels =
            Enum.flat_map(options, fn
              %{"label" => label} when is_binary(label) -> [label]
              _ -> []
            end)

          answer = answers[header]

          if multi_select,
            do: is_list(answer) and answer != [] and Enum.all?(answer, &(&1 in labels)),
            else: is_binary(answer) and answer in labels

        _ ->
          false
      end)
    else
      _ -> false
    end
  end

  defp valid_attention_value?(_interaction, _approved, _value, _attention), do: false

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

  defp retire_replaced_attention!(nil, _persisted), do: :ok

  defp retire_replaced_attention!(existing, persisted) do
    previous_id = get_in(existing.attention || %{}, ["attention_id"])
    current_id = get_in(persisted.attention || %{}, ["attention_id"])

    if is_binary(previous_id) and previous_id != current_id do
      case Repo.get(HumanAttentionRequest, previous_id) do
        %{response_state: "responded", delivery_state: state}
        when state in ["delivery_requested", "delivery_uncertain"] ->
          Repo.rollback(:ambiguous_attention_replacement)

        %{response_state: state} = request when state in ["pending", "responded"] ->
          obsolete_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)

          obsolete =
            request
            |> HumanAttentionRequest.changeset(%{
              response_state: "obsolete",
              cancelled_at: obsolete_at,
              cancellation_reason:
                "Native session replaced or cleared the HumanAttention request."
            })
            |> Repo.update!()

          audit_request!(obsolete, "attention_cancelled", obsolete_at, %{
            "reason" => obsolete.cancellation_reason,
            "state" => "obsolete"
          })

        _ ->
          :ok
      end
    end
  end

  defp persist_attention_request!(%{attention: nil}, _action), do: :ok

  defp persist_attention_request!(session, action) do
    attention = session.attention
    attention_id = attention["attention_id"]
    # Existing non-blocking/prompt-authorization sessions predate durable request
    # generations. Treat only that persisted compatibility shape as generation 1;
    # protocol v14 still requires Workers to send the field explicitly.
    request_generation = attention["request_generation"] || 1

    unless is_binary(attention_id) and is_integer(request_generation) and request_generation > 0,
      do: Repo.rollback(:invalid_attention_request)

    request =
      attention
      |> Map.take([
        "category",
        "message",
        "interaction",
        "response_schema",
        "origin",
        "requested_at"
      ])
      |> canonical_attention_request()

    if byte_size(Jason.encode!(request)) > 65_536,
      do: Repo.rollback(:attention_request_too_large)

    case Repo.get(HumanAttentionRequest, attention_id) do
      nil ->
        if Repo.exists?(
             from active in HumanAttentionRequest,
               where:
                 active.action_id == ^action.id and
                   (active.response_state == "pending" or
                      (active.response_state == "responded" and
                         active.delivery_state != "delivery_acknowledged"))
           ),
           do: Repo.rollback(:active_attention_exists)

        surfaced_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)

        HumanAttentionRequest.changeset(%{
          id: attention_id,
          session_id: session.id,
          worker_id: session.worker_id,
          run_id: action.run_id,
          action_id: action.id,
          occurrence_id: action.occurrence_id,
          attempt_id: action.attempt_id,
          native_session_id: session.native_session_id,
          request_generation: request_generation,
          request: request,
          response_state: attention["response_state"] || "pending",
          delivery_state: attention["delivery_state"] || "response_not_delivered",
          delivery_attempt_id: attention["delivery_attempt_id"],
          surfaced_at: surfaced_at
        })
        |> Repo.insert!()

      existing ->
        exact =
          existing.session_id == session.id and existing.worker_id == session.worker_id and
            existing.run_id == action.run_id and existing.action_id == action.id and
            existing.occurrence_id == action.occurrence_id and
            existing.attempt_id == action.attempt_id and
            existing.native_session_id == session.native_session_id and
            existing.request_generation == request_generation and existing.request == request

        unless exact, do: Repo.rollback(:attention_identity_conflict)
    end
  end

  # Conversational takeover advances this runtime control marker in the session,
  # but it does not create a new durable question or change request identity.
  defp canonical_attention_request(%{"interaction" => interaction} = request)
       when is_map(interaction),
       do: %{request | "interaction" => Map.delete(interaction, "control_state")}

  defp canonical_attention_request(request), do: request

  defp normalized_session_state(_existing, :waiting_for_human, nil), do: "running"

  defp normalized_session_state(_existing, state, _attention), do: Atom.to_string(state)

  defp merged_attention(existing, incoming, action_id, session_id) do
    candidate = merge_native_attention(existing, incoming)

    attention_id =
      get_in(candidate || %{}, ["attention_id"]) ||
        get_in((existing && existing.attention) || %{}, ["attention_id"])

    request = is_binary(attention_id) && Repo.get(HumanAttentionRequest, attention_id)

    case request do
      %{action_id: request_action_id, session_id: request_session_id}
      when request_action_id != action_id or request_session_id != session_id ->
        candidate

      %{delivery_state: "delivery_acknowledged"} ->
        nil

      %{response_state: "responded"} = request ->
        projection = candidate || (existing && existing.attention)

        if is_map(projection) do
          projection
          |> Map.put("response_state", request.response_state)
          |> Map.put("delivery_state", request.delivery_state)
          |> maybe_map_put("delivery_attempt_id", request.delivery_attempt_id)
        else
          nil
        end

      %{response_state: state} when state in ["cancelled", "obsolete"] ->
        nil

      _ ->
        candidate
    end
  end

  defp merge_native_attention(
         %{attention: %{"attention_id" => id} = current},
         %{"attention_id" => id} = incoming
       ) do
    if get_in(current, ["interaction", "control_state"]) == "human_control" and
         get_in(incoming, ["interaction", "control_state"]) == "intervention_pending" do
      put_in(incoming, ["interaction", "control_state"], "human_control")
    else
      incoming
    end
  end

  defp merge_native_attention(_existing, incoming), do: incoming

  defp merged_native_session_id(nil, incoming), do: incoming
  defp merged_native_session_id(%{native_session_id: nil}, incoming), do: incoming
  defp merged_native_session_id(%{native_session_id: current}, nil), do: current
  defp merged_native_session_id(%{native_session_id: current}, current), do: current

  defp merged_native_session_id(%{native_session_id: _current}, _incoming),
    do: Repo.rollback(:session_native_identity_conflict)

  defp takeover_allowed(_session, _action, _dispatch, "observe"), do: :ok

  defp takeover_allowed(session, action, dispatch, "recovery") do
    if not cancellation_fenced?(dispatch) and session.current_action_id == action.id and
         session.state == "retained" and
         get_in(session.terminal, ["supports_takeover"]) == true,
       do: :ok,
       else: {:error, :attachment_unavailable}
  end

  defp takeover_allowed(session, action, dispatch, "takeover") do
    if takeover_available?(session, action, dispatch),
      do: :ok,
      else: {:error, :attachment_unavailable}
  end

  defp takeover_available?(session, action, dispatch) do
    not cancellation_fenced?(dispatch) and session.current_action_id == action.id and
      get_in(session.terminal, ["supports_takeover"]) == true and
      not pre_prompt_authorization_pending?(session)
  end

  defp cancellation_fenced?(dispatch), do: not is_nil(dispatch.cancellation_requested_at)

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

  defp audit_request!(request, event_type, occurred_at, metadata) do
    attributes = %{
      session_id: request.session_id,
      event_type: event_type,
      attention_id: request.id,
      run_id: request.run_id,
      action_id: request.action_id,
      occurrence_id: request.occurrence_id,
      attempt_id: request.attempt_id,
      metadata: metadata,
      occurred_at: occurred_at
    }

    case Repo.insert(ExecutionSessionAuditEvent.changeset(attributes),
           on_conflict: :nothing,
           conflict_target:
             {:unsafe_fragment,
              "(session_id, event_type, attention_id) WHERE attention_id IS NOT NULL"}
         ) do
      {:ok, _} -> :ok
      {:error, error} -> Repo.rollback(error)
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
