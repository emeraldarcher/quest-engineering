defmodule QuestEngineering.Server.WorkerProtocol do
  @moduledoc """
  Versioned, JSON-compatible worker wire protocol.

  This module is the serialization and validation boundary. Phoenix channel
  callbacks only pass decoded messages to application services.
  """

  alias QuestEngineering.Core.Product.ToolPolicy.Exact
  alias QuestEngineering.Core.Product.ToolPolicy.NativePermissions
  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.ExecutionWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.LogicalWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.ReasoningCapability
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance

  @version 7
  @worker_id ~r/\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z/
  @states ~w(accepted running completed failed uncertain)
  @access ~w(none read_only read_write)
  @session_states ~w(starting running waiting_for_human recovering retained closed unavailable)
  @attention_categories ~w(needs_input needs_permission needs_authentication needs_confirmation blocked_external interactive_prompt unknown_interactive_block)
  @interaction_kinds ~w(confirmation text choice multiline_response conversational_intervention)
  @human_control_states ~w(intervention_pending human_control resuming_automation)
  @intervention_states ~w(intervention_pending resuming_automation resumed)
  @failure_classifications ~w(auto_retryable operator_recovery_required terminal_not_recoverable)

  defmodule Message do
    @moduledoc false
    @enforce_keys [:type, :worker_id]

    @type t :: %__MODULE__{
            type: atom(),
            worker_id: String.t(),
            action_id: String.t() | nil,
            occurrence_id: String.t() | nil,
            attempt_id: String.t() | nil,
            state: atom() | nil,
            outputs: map() | nil,
            failure: map() | nil,
            dispatches: [map()] | nil,
            worktree: map() | nil,
            candidates: [map()] | nil,
            binding: map() | nil,
            delivery: map() | nil,
            session: map() | nil,
            sessions: [map()] | nil,
            recovery: map() | nil
          }

    defstruct [
      :type,
      :worker_id,
      :action_id,
      :occurrence_id,
      :attempt_id,
      :state,
      :outputs,
      :failure,
      :dispatches,
      :worktree,
      :candidates,
      :binding,
      :delivery,
      :session,
      :sessions,
      :recovery
    ]
  end

  defmodule Error do
    @moduledoc "Machine-readable worker protocol rejection."
    @enforce_keys [:code]

    @type t :: %__MODULE__{code: atom(), field: String.t() | nil, details: term()}

    defstruct [:code, :field, :details]
  end

  @spec version() :: 7
  def version, do: @version

  @spec decode_hello(term()) :: {:ok, map()} | {:error, Error.t()}
  def decode_hello(%{"type" => "worker_hello"} = payload) do
    with :ok <- validate_version(payload),
         {:ok, worker_id} <- required_string(payload, "worker_id"),
         :ok <- validate_worker_id(worker_id),
         {:ok, capabilities} <- validate_capabilities(payload["capabilities"]) do
      {:ok, %{worker_id: worker_id, capabilities: capabilities}}
    end
  end

  def decode_hello(%{"type" => type}) when is_binary(type),
    do: error(:unexpected_message_type, "type", %{received: type, expected: "worker_hello"})

  def decode_hello(_payload), do: error(:malformed_message, nil, %{expected: "worker_hello"})

  @spec decode_worker_message(term(), String.t()) :: {:ok, Message.t()} | {:error, Error.t()}
  def decode_worker_message(%{"type" => type} = payload, expected_worker_id)
      when is_binary(type) do
    with :ok <- validate_version(payload),
         {:ok, worker_id} <- required_string(payload, "worker_id"),
         :ok <- match_worker(worker_id, expected_worker_id) do
      decode_message(type, worker_id, payload)
    end
  end

  def decode_worker_message(_payload, _worker_id), do: error(:malformed_message)

  def welcome(worker_id, binding_reconciliation \\ []) do
    %{
      "type" => "worker_welcome",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "workspace_binding_reconciliation" => binding_reconciliation
    }
  end

  def reconcile_request(worker_id) do
    %{
      "type" => "reconcile_request",
      "protocol_version" => @version,
      "worker_id" => worker_id
    }
  end

  def discover_workspace_sources(worker_id) do
    %{
      "type" => "discover_workspace_sources",
      "protocol_version" => @version,
      "worker_id" => worker_id
    }
  end

  def bind_workspace_source(worker_id, binding) do
    %{
      "type" => "bind_workspace_source",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "binding" => %{
        "binding_id" => binding.binding_id,
        "workspace_id" => binding.workspace_id,
        "workspace_key" => binding.workspace_key,
        "source_kind" => to_string(binding.source_kind),
        "source_fingerprint" => binding.source_fingerprint,
        "candidate_id" => binding.candidate_id
      }
    }
  end

  def provision_run_worktree(worker_id, assignment) do
    %{
      "type" => "provision_run_worktree",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "worktree" => %{
        "worktree_id" => assignment.worktree_id,
        "run_id" => assignment.run_id,
        "workspace_id" => assignment.workspace_id,
        "workspace_binding_id" => assignment.workspace_binding_id,
        "base" => %{"kind" => assignment.base_selector},
        "branch_name" => assignment.branch_name,
        "identity_hash" => assignment.identity_hash
      }
    }
  end

  def reconcile_run_worktrees_request(worker_id, assignments) do
    %{
      "type" => "reconcile_run_worktrees",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "worktrees" =>
        Enum.map(assignments, fn assignment ->
          %{
            "worktree_id" => assignment.worktree_id,
            "run_id" => assignment.run_id,
            "workspace_binding_id" => assignment.workspace_binding_id,
            "identity_hash" => assignment.identity_hash,
            "desired_state" => assignment.state
          }
        end)
    }
  end

  def retain_run_worktree(worker_id, assignment) do
    worktree_command("retain_run_worktree", worker_id, assignment)
  end

  def cleanup_run_worktree(worker_id, assignment) do
    worktree_command("cleanup_run_worktree", worker_id, assignment)
  end

  def inspect_run_delivery(worker_id, delivery, assignment) do
    delivery_command("inspect_run_delivery", worker_id, delivery, assignment)
  end

  def publish_run_delivery(worker_id, delivery, assignment) do
    delivery_command("publish_run_delivery", worker_id, delivery, assignment)
    |> put_in(["delivery", "expected_fingerprint"], delivery.change_fingerprint)
    |> put_in(["delivery", "base_revision"], delivery.base_revision)
    |> put_in(["delivery", "base_branch_name"], delivery.base_branch_name)
    |> put_in(["delivery", "repository_identity"], delivery.repository_identity)
    |> put_in(["delivery", "remote_name"], delivery.remote_name)
  end

  def resolve_uncertain_dispatch(worker_id, action_id, resolution)
      when resolution in [:retry, :mark_failed] do
    %{
      "type" => "resolve_uncertain_dispatch",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "action_id" => action_id,
      "resolution" => Atom.to_string(resolution)
    }
  end

  def execute_action(worker_id, %ResolvedExecution{} = execution, operational_recovery \\ nil) do
    %{
      "type" => "execute_action",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "execution" => execution(execution)
    }
    |> maybe_put("operational_recovery", encode_operational_recovery(operational_recovery))
  end

  def protocol_error(%Error{} = protocol_error) do
    error_message(protocol_error.code, protocol_error.field, protocol_error.details)
  end

  def application_error(%{type: type} = application_error) do
    details = Map.get(application_error, :details) || %{}
    error_message(type, nil, details)
  end

  defp error_message(code, field, details) do
    %{
      "type" => "protocol_error",
      "protocol_version" => @version,
      "error" => %{
        "code" => Atom.to_string(code),
        "field" => field,
        "details" => details || %{}
      }
    }
  end

  defp decode_message("worker_heartbeat", worker_id, _payload),
    do: {:ok, %Message{type: :heartbeat, worker_id: worker_id}}

  defp decode_message("workspace_sources", worker_id, %{"candidates" => candidates})
       when is_list(candidates) do
    with {:ok, decoded} <- decode_workspace_candidates(candidates) do
      {:ok, %Message{type: :workspace_sources, worker_id: worker_id, candidates: decoded}}
    end
  end

  defp decode_message("workspace_binding_ready", worker_id, %{"binding" => binding}) do
    with {:ok, decoded} <- decode_workspace_binding(binding) do
      {:ok, %Message{type: :workspace_binding_ready, worker_id: worker_id, binding: decoded}}
    end
  end

  defp decode_message("run_worktree_ready", worker_id, payload) do
    with {:ok, worktree} <- decode_ready_worktree(payload["worktree"]) do
      {:ok, %Message{type: :run_worktree_ready, worker_id: worker_id, worktree: worktree}}
    end
  end

  defp decode_message("run_worktree_failed", worker_id, payload) do
    with {:ok, worktree} <- decode_failed_worktree(payload) do
      {:ok, %Message{type: :run_worktree_failed, worker_id: worker_id, worktree: worktree}}
    end
  end

  defp decode_message("run_worktree_attention", worker_id, payload) do
    with {:ok, worktree} <- decode_failed_worktree(payload) do
      {:ok, %Message{type: :run_worktree_attention, worker_id: worker_id, worktree: worktree}}
    end
  end

  defp decode_message("run_worktree_retained", worker_id, %{"worktree" => worktree})
       when is_map(worktree) do
    with {:ok, decoded} <- decode_worktree_identity(worktree),
         do:
           {:ok, %Message{type: :run_worktree_retained, worker_id: worker_id, worktree: decoded}}
  end

  defp decode_message("run_worktree_removed", worker_id, %{"worktree" => worktree})
       when is_map(worktree) do
    with {:ok, decoded} <- decode_worktree_identity(worktree),
         do: {:ok, %Message{type: :run_worktree_removed, worker_id: worker_id, worktree: decoded}}
  end

  defp decode_message("run_delivery_inspected", worker_id, %{"delivery" => delivery})
       when is_map(delivery) do
    with {:ok, decoded} <- decode_delivery(delivery, :inspected),
         do:
           {:ok, %Message{type: :run_delivery_inspected, worker_id: worker_id, delivery: decoded}}
  end

  defp decode_message("run_delivery_published", worker_id, %{"delivery" => delivery})
       when is_map(delivery) do
    with {:ok, decoded} <- decode_delivery(delivery, :published),
         do:
           {:ok, %Message{type: :run_delivery_published, worker_id: worker_id, delivery: decoded}}
  end

  defp decode_message("run_delivery_failed", worker_id, %{"delivery" => delivery})
       when is_map(delivery) do
    with {:ok, decoded} <- decode_delivery(delivery, :failed),
         do: {:ok, %Message{type: :run_delivery_failed, worker_id: worker_id, delivery: decoded}}
  end

  defp decode_message("workspace_binding_failed", worker_id, %{"binding" => binding})
       when is_map(binding) do
    {:ok, %Message{type: :workspace_binding_failed, worker_id: worker_id, binding: binding}}
  end

  defp decode_message("run_worktree_integrity_failed", worker_id, payload) do
    with {:ok, action_id} <- required_string(payload, "action_id"),
         {:ok, failure} <- required_plain_map(payload, "failure") do
      {:ok,
       %Message{
         type: :run_worktree_integrity_failed,
         worker_id: worker_id,
         action_id: action_id,
         failure: failure
       }}
    end
  end

  defp decode_message("session_state", worker_id, %{"session" => session}) do
    with {:ok, decoded} <- decode_session(session) do
      {:ok, %Message{type: :session_state, worker_id: worker_id, session: decoded}}
    end
  end

  defp decode_message("human_recovery_requested", worker_id, %{"recovery" => recovery}) do
    with {:ok, decoded} <- decode_human_recovery(recovery) do
      {:ok,
       %Message{
         type: :human_recovery_requested,
         worker_id: worker_id,
         recovery: Map.put(decoded, :worker_id, worker_id)
       }}
    end
  end

  defp decode_message("dispatch_accepted", worker_id, payload) do
    with {:ok, fields} <- dispatch_identity(payload) do
      {:ok,
       struct!(Message, Map.merge(fields, %{type: :dispatch_accepted, worker_id: worker_id}))}
    end
  end

  defp decode_message("dispatch_state", worker_id, payload) do
    with {:ok, fields} <- dispatch_identity(payload),
         {:ok, state} <- state(payload),
         {:ok, outputs} <- optional_outputs(payload, state),
         {:ok, failure} <- optional_failure(payload, state) do
      {:ok,
       struct!(
         Message,
         Map.merge(fields, %{
           type: :dispatch_state,
           worker_id: worker_id,
           state: state,
           outputs: outputs,
           failure: failure
         })
       )}
    end
  end

  defp decode_message("step_completed", worker_id, payload) do
    with {:ok, fields} <- dispatch_identity(payload),
         {:ok, outputs} <- required_outputs(payload) do
      {:ok,
       struct!(
         Message,
         Map.merge(fields, %{type: :step_completed, worker_id: worker_id, outputs: outputs})
       )}
    end
  end

  defp decode_message("step_failed", worker_id, payload) do
    with {:ok, fields} <- dispatch_identity(payload),
         {:ok, failure} <- required_plain_map(payload, "failure"),
         {:ok, failure} <- classified_failure(failure) do
      {:ok,
       struct!(
         Message,
         Map.merge(fields, %{type: :step_failed, worker_id: worker_id, failure: failure})
       )}
    end
  end

  defp decode_message("reconcile_state", worker_id, %{"dispatches" => dispatches} = payload)
       when is_list(dispatches) do
    sessions = Map.get(payload, "sessions", [])

    with true <- is_list(sessions),
         {:ok, decoded} <- decode_reconcile_dispatches(dispatches),
         {:ok, decoded_sessions} <- decode_sessions(sessions) do
      {:ok,
       %Message{
         type: :reconcile_state,
         worker_id: worker_id,
         dispatches: decoded,
         sessions: decoded_sessions
       }}
    else
      false -> error(:invalid_field, "sessions", %{expected: "array"})
      {:error, _} = error -> error
    end
  end

  defp decode_message("reconcile_state", _worker_id, _payload),
    do: error(:invalid_field, "dispatches", %{expected: "array"})

  defp decode_message(type, _worker_id, _payload),
    do: error(:unknown_message_type, "type", %{received: type})

  defp decode_human_recovery(value) when is_map(value) do
    with {:ok, request_id} <- required_string(value, "request_id"),
         {:ok, run_id} <- required_string(value, "run_id"),
         {:ok, occurrence_id} <- required_string(value, "occurrence_id"),
         {:ok, attempt_id} <- required_string(value, "attempt_id"),
         {:ok, action_id} <- required_string(value, "action_id"),
         {:ok, member_key} <- required_string(value, "member_key"),
         {:ok, session_id} <- required_string(value, "session_id"),
         {:ok, lineage_id} <- required_string(value, "lineage_id"),
         {:ok, native_session_id} <- required_string(value, "native_session_id") do
      {:ok,
       %{
         request_id: request_id,
         run_id: run_id,
         occurrence_id: occurrence_id,
         attempt_id: attempt_id,
         action_id: action_id,
         member_key: member_key,
         session_id: session_id,
         lineage_id: lineage_id,
         native_session_id: native_session_id
       }}
    end
  end

  defp decode_human_recovery(_), do: error(:invalid_field, "recovery")

  defp decode_sessions(sessions) do
    Enum.reduce_while(sessions, {:ok, []}, fn value, {:ok, decoded} ->
      case decode_session(value) do
        {:ok, session} -> {:cont, {:ok, [session | decoded]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, decoded} -> {:ok, Enum.reverse(decoded)}
      error -> error
    end
  end

  defp decode_session(value) when is_map(value) do
    with {:ok, session_id} <- required_string(value, "session_id"),
         {:ok, action_id} <- required_string(value, "action_id"),
         {:ok, run_id} <- required_string(value, "run_id"),
         {:ok, occurrence_id} <- required_string(value, "occurrence_id"),
         {:ok, attempt_id} <- required_string(value, "attempt_id"),
         {:ok, member_key} <- required_string(value, "member_key"),
         {:ok, harness_kind} <- required_string(value, "harness_kind"),
         {:ok, harness_display_name} <- required_string(value, "harness_display_name"),
         {:ok, state} <- session_state(value["state"]),
         {:ok, capabilities} <- decode_session_capabilities(value["capabilities"]),
         {:ok, terminal} <- decode_terminal(value["terminal"]),
         {:ok, native_session_id} <- optional_string(value["native_session_id"]),
         {:ok, attention} <- decode_attention(value["attention"]),
         {:ok, intervention} <- decode_intervention(value["intervention"]),
         {:ok, started_at} <- timestamp(value["started_at"], "session.started_at"),
         {:ok, last_activity_at} <-
           timestamp(value["last_activity_at"], "session.last_activity_at") do
      {:ok,
       %{
         session_id: session_id,
         action_id: action_id,
         run_id: run_id,
         occurrence_id: occurrence_id,
         attempt_id: attempt_id,
         member_key: member_key,
         harness_kind: harness_kind,
         harness_display_name: harness_display_name,
         state: state,
         capabilities: capabilities,
         terminal: terminal,
         native_session_id: native_session_id,
         attention: attention,
         intervention: intervention,
         started_at: started_at,
         last_activity_at: last_activity_at
       }}
    end
  end

  defp decode_session(_), do: error(:invalid_field, "session")

  defp decode_session_capabilities(value) when is_map(value) do
    with {:ok, attach} <- required_boolean(value, "can_attach_terminal"),
         {:ok, input} <- required_boolean(value, "can_send_input"),
         {:ok, interrupt} <- required_boolean(value, "can_interrupt"),
         {:ok, attention} <- required_boolean(value, "can_detect_attention"),
         {:ok, resume} <- required_boolean(value, "can_resume"),
         {:ok, events} <- required_boolean(value, "can_observe_structured_events"),
         {:ok, confirmation} <- optional_capability(value, "structured_confirmation"),
         {:ok, text} <- optional_capability(value, "structured_text_response"),
         {:ok, choice} <- optional_capability(value, "structured_choice_response"),
         {:ok, multiline} <- optional_capability(value, "structured_multiline_response"),
         {:ok, native_prompt} <- optional_capability(value, "native_prompt_control"),
         {:ok, conversational} <- optional_capability(value, "conversational_takeover"),
         {:ok, automation_resume} <- optional_capability(value, "automation_resume") do
      {:ok,
       %{
         "can_attach_terminal" => attach,
         "can_send_input" => input,
         "can_interrupt" => interrupt,
         "can_detect_attention" => attention,
         "can_resume" => resume,
         "can_observe_structured_events" => events,
         "structured_confirmation" => confirmation,
         "structured_text_response" => text,
         "structured_choice_response" => choice,
         "structured_multiline_response" => multiline,
         "native_prompt_control" => native_prompt,
         "conversational_takeover" => conversational,
         "automation_resume" => automation_resume
       }}
    end
  end

  defp decode_session_capabilities(_), do: error(:invalid_field, "session.capabilities")

  defp decode_terminal(nil), do: {:ok, nil}

  defp decode_terminal(
         %{
           "attachment_mode" => "local_native_terminal",
           "backend_kind" => backend,
           "terminal_session_id" => session_id,
           "terminal_target_id" => target_id,
           "supports_observation" => observation,
           "supports_takeover" => takeover
         } = terminal
       )
       when is_binary(backend) and backend != "" and is_binary(session_id) and session_id != "" and
              is_binary(target_id) and target_id != "" and is_boolean(observation) and
              is_boolean(takeover) do
    {:ok,
     %{
       "attachment_mode" => "local_native_terminal",
       "backend_kind" => backend,
       "terminal_session_id" => session_id,
       "terminal_target_id" => target_id,
       "terminal_id" => terminal["terminal_id"],
       "supports_observation" => observation,
       "supports_takeover" => takeover
     }}
  end

  defp decode_terminal(_), do: error(:invalid_field, "session.terminal")

  defp decode_attention(nil), do: {:ok, nil}

  defp decode_attention(
         %{
           "attention_id" => id,
           "category" => category,
           "message" => message,
           "requested_at" => requested_at
         } = value
       )
       when is_binary(id) and id != "" and category in @attention_categories and
              is_binary(message) and byte_size(message) > 0 and byte_size(message) <= 240 do
    with {:ok, timestamp} <- timestamp(requested_at, "session.attention.requested_at"),
         {:ok, interaction} <- decode_interaction(value["interaction"]) do
      {:ok,
       %{
         "attention_id" => id,
         "category" => category,
         "message" => message,
         "requested_at" => DateTime.to_iso8601(timestamp)
       }
       |> maybe_put("interaction", interaction)}
    end
  end

  defp decode_attention(_), do: error(:invalid_field, "session.attention")

  defp decode_interaction(nil), do: {:ok, nil}

  defp decode_interaction(%{"kind" => kind, "control_state" => state} = value)
       when kind in @interaction_kinds and state in @human_control_states do
    with {:ok, command} <- optional_string(value["resume_command"]) do
      {:ok,
       %{"kind" => kind, "control_state" => state}
       |> maybe_put("resume_command", command)}
    end
  end

  defp decode_interaction(_), do: error(:invalid_field, "session.attention.interaction")

  defp decode_intervention(nil), do: {:ok, nil}

  defp decode_intervention(
         %{
           "attention_id" => id,
           "kind" => "conversational_intervention",
           "state" => state,
           "requested_at" => requested_at
         } = value
       )
       when is_binary(id) and id != "" and state in @intervention_states do
    with {:ok, requested} <- timestamp(requested_at, "session.intervention.requested_at"),
         {:ok, handed_back} <-
           optional_timestamp(value["handed_back_at"], "session.intervention.handed_back_at"),
         {:ok, resumed} <-
           optional_timestamp(
             value["automation_resumed_at"],
             "session.intervention.automation_resumed_at"
           ),
         :ok <- valid_intervention_timestamps(state, handed_back, resumed) do
      {:ok,
       %{
         "attention_id" => id,
         "kind" => "conversational_intervention",
         "state" => state,
         "requested_at" => DateTime.to_iso8601(requested)
       }
       |> maybe_put("handed_back_at", handed_back && DateTime.to_iso8601(handed_back))
       |> maybe_put("automation_resumed_at", resumed && DateTime.to_iso8601(resumed))}
    end
  end

  defp decode_intervention(_), do: error(:invalid_field, "session.intervention")

  defp valid_intervention_timestamps("intervention_pending", nil, nil), do: :ok
  defp valid_intervention_timestamps("resuming_automation", %DateTime{}, nil), do: :ok
  defp valid_intervention_timestamps("resumed", %DateTime{}, %DateTime{}), do: :ok

  defp valid_intervention_timestamps(_state, _handed_back, _resumed),
    do: error(:invalid_field, "session.intervention.lifecycle_timestamps")

  defp session_state(value) when value in @session_states do
    {:ok,
     case value do
       "starting" -> :starting
       "running" -> :running
       "waiting_for_human" -> :waiting_for_human
       "recovering" -> :recovering
       "retained" -> :retained
       "closed" -> :closed
       "unavailable" -> :unavailable
     end}
  end

  defp session_state(value), do: error(:invalid_field, "session.state", %{received: value})

  defp optional_string(nil), do: {:ok, nil}
  defp optional_string(value) when is_binary(value) and value != "", do: {:ok, value}
  defp optional_string(_), do: error(:invalid_field, "session.native_session_id")

  defp required_boolean(value, key) do
    case Map.fetch(value, key) do
      {:ok, boolean} when is_boolean(boolean) -> {:ok, boolean}
      _ -> error(:invalid_field, "session.capabilities.#{key}")
    end
  end

  defp optional_capability(value, key) do
    case Map.get(value, key, false) do
      boolean when is_boolean(boolean) -> {:ok, boolean}
      _ -> error(:invalid_field, "session.capabilities.#{key}")
    end
  end

  defp optional_timestamp(nil, _field), do: {:ok, nil}
  defp optional_timestamp(value, field), do: timestamp(value, field)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp timestamp(value, field) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> {:ok, datetime}
      _ -> error(:invalid_field, field)
    end
  end

  defp timestamp(_value, field), do: error(:invalid_field, field)

  defp decode_reconcile_dispatches(dispatches) do
    Enum.reduce_while(dispatches, {:ok, []}, fn payload, {:ok, decoded} ->
      with true <- is_map(payload),
           {:ok, fields} <- dispatch_identity(payload),
           {:ok, state} <- state(payload),
           {:ok, outputs} <- optional_outputs(payload, state),
           {:ok, failure} <- optional_failure(payload, state) do
        item = Map.merge(fields, %{state: state, outputs: outputs, failure: failure})
        {:cont, {:ok, [item | decoded]}}
      else
        false -> {:halt, error(:invalid_field, "dispatches", %{reason: "entry_must_be_object"})}
        {:error, _error} = invalid -> {:halt, invalid}
      end
    end)
    |> case do
      {:ok, decoded} -> {:ok, Enum.reverse(decoded)}
      invalid -> invalid
    end
  end

  defp decode_workspace_candidates(candidates) do
    Enum.reduce_while(candidates, {:ok, []}, fn
      %{
        "candidate_id" => id,
        "name" => name,
        "source_kind" => kind,
        "max_access" => access,
        "allow_unconfined_shell" => shell
      } = value,
      {:ok, decoded}
      when is_binary(id) and is_binary(name) and kind in ["git_remote", "local_git"] and
             access in @access and is_boolean(shell) ->
        candidate = %{
          candidate_id: id,
          name: name,
          source_kind: kind,
          source_fingerprint: value["source_fingerprint"],
          publication_remote_name: value["publication_remote_name"],
          publication_repository_identity: value["publication_repository_identity"],
          max_access: access,
          allow_unconfined_shell: shell
        }

        {:cont, {:ok, decoded ++ [candidate]}}

      _invalid, _acc ->
        {:halt, error(:invalid_field, "candidates")}
    end)
  end

  defp decode_workspace_binding(
         %{
           "binding_id" => binding_id,
           "workspace_id" => workspace_id,
           "authorized_root_key" => root_key,
           "source_repository_root" => source_root,
           "max_access" => access,
           "allow_unconfined_shell" => shell
         } = value
       )
       when is_binary(binding_id) and is_binary(workspace_id) and is_binary(root_key) and
              is_binary(source_root) and access in @access and is_boolean(shell) do
    {:ok,
     %{
       binding_id: binding_id,
       workspace_id: workspace_id,
       authorized_root_key: root_key,
       source_repository_root: source_root,
       source_fingerprint: value["source_fingerprint"],
       publication_remote_name: value["publication_remote_name"],
       publication_repository_identity: value["publication_repository_identity"],
       max_access: access,
       allow_unconfined_shell: shell
     }}
  end

  defp decode_workspace_binding(_value), do: error(:invalid_field, "binding")

  defp decode_ready_worktree(
         %{
           "worktree_id" => worktree_id,
           "run_id" => run_id,
           "workspace_binding_id" => binding_id,
           "base_revision" => base_revision,
           "branch_name" => branch_name,
           "canonical_root" => canonical_root,
           "source_dirty_excluded" => dirty,
           "identity_hash" => identity_hash
         } = value
       )
       when is_binary(worktree_id) and is_binary(run_id) and is_binary(binding_id) and
              is_binary(base_revision) and is_binary(branch_name) and is_binary(canonical_root) and
              is_boolean(dirty) and is_binary(identity_hash) do
    {:ok,
     %{
       worktree_id: worktree_id,
       run_id: run_id,
       workspace_binding_id: binding_id,
       base_revision: base_revision,
       base_branch_name: value["base_branch_name"],
       branch_name: branch_name,
       publication_remote_name: value["publication_remote_name"],
       publication_repository_identity: value["publication_repository_identity"],
       canonical_root: canonical_root,
       source_dirty_excluded: dirty,
       identity_hash: identity_hash
     }}
  end

  defp decode_ready_worktree(_payload), do: error(:invalid_field, "worktree")

  defp decode_failed_worktree(%{
         "worktree_id" => worktree_id,
         "run_id" => run_id,
         "workspace_binding_id" => binding_id,
         "identity_hash" => identity_hash,
         "failure" => failure
       })
       when is_binary(worktree_id) and is_binary(run_id) and is_binary(binding_id) and
              is_binary(identity_hash) and is_map(failure) do
    {:ok,
     %{
       worktree_id: worktree_id,
       run_id: run_id,
       workspace_binding_id: binding_id,
       identity_hash: identity_hash,
       failure_code: failure["code"] || "run_worktree_failed",
       failure_details: failure
     }}
  end

  defp decode_failed_worktree(_payload), do: error(:invalid_field, "worktree")

  defp decode_worktree_identity(value) do
    with {:ok, worktree_id} <- required_string(value, "worktree_id"),
         {:ok, run_id} <- required_string(value, "run_id"),
         {:ok, binding_id} <- required_string(value, "workspace_binding_id"),
         {:ok, identity_hash} <- required_string(value, "identity_hash") do
      {:ok,
       %{
         worktree_id: worktree_id,
         run_id: run_id,
         workspace_binding_id: binding_id,
         identity_hash: identity_hash
       }}
    end
  end

  defp decode_delivery(value, kind) do
    with {:ok, delivery_id} <- required_string(value, "delivery_id"),
         {:ok, run_id} <- required_string(value, "run_id"),
         {:ok, worktree_id} <- required_string(value, "worktree_id"),
         {:ok, identity_hash} <- required_string(value, "identity_hash") do
      base = %{
        delivery_id: delivery_id,
        run_id: run_id,
        worktree_id: worktree_id,
        identity_hash: identity_hash
      }

      decode_delivery_kind(value, kind, base)
    end
  end

  defp decode_delivery_kind(value, :inspected, base) do
    required =
      ~w(fingerprint base_revision base_branch_name branch_name head_before_finalize repository_host repository_identity remote_name)

    if Enum.all?(required, &(is_binary(value[&1]) and value[&1] != "")) and
         is_map(value["evidence"]) and is_boolean(value["no_changes"]) do
      {:ok,
       Map.merge(base, %{
         fingerprint: value["fingerprint"],
         base_revision: value["base_revision"],
         base_branch_name: value["base_branch_name"],
         branch_name: value["branch_name"],
         head_before_finalize: value["head_before_finalize"],
         repository_host: value["repository_host"],
         repository_identity: value["repository_identity"],
         remote_name: value["remote_name"],
         evidence: value["evidence"],
         no_changes: value["no_changes"]
       })}
    else
      error(:invalid_field, "delivery")
    end
  end

  defp decode_delivery_kind(value, :published, base) do
    if Enum.all?(
         ~w(fingerprint branch_name head_revision),
         &(is_binary(value[&1]) and value[&1] != "")
       ),
       do:
         {:ok,
          Map.merge(base, %{
            fingerprint: value["fingerprint"],
            branch_name: value["branch_name"],
            head_revision: value["head_revision"]
          })},
       else: error(:invalid_field, "delivery")
  end

  defp decode_delivery_kind(value, :failed, base) do
    if Enum.all?(~w(stage code), &(is_binary(value[&1]) and value[&1] != "")) and
         is_map(value["details"] || %{}),
       do:
         {:ok,
          Map.merge(base, %{
            stage: value["stage"],
            code: value["code"],
            details: value["details"] || %{}
          })},
       else: error(:invalid_field, "delivery")
  end

  defp dispatch_identity(payload) do
    with {:ok, action_id} <- required_string(payload, "action_id"),
         {:ok, occurrence_id} <- required_string(payload, "occurrence_id"),
         {:ok, attempt_id} <- required_string(payload, "attempt_id") do
      {:ok, %{action_id: action_id, occurrence_id: occurrence_id, attempt_id: attempt_id}}
    end
  end

  defp state(%{"state" => state}) when state in @states,
    do: {:ok, String.to_existing_atom(state)}

  defp state(payload),
    do: error(:invalid_field, "state", %{received: payload["state"], allowed: @states})

  defp optional_outputs(payload, :completed), do: required_outputs(payload)
  defp optional_outputs(_payload, _state), do: {:ok, nil}

  defp optional_failure(payload, :failed) do
    with {:ok, failure} <- required_plain_map(payload, "failure"),
         do: classified_failure(failure)
  end

  defp optional_failure(payload, :uncertain), do: required_plain_map(payload, "failure")

  defp optional_failure(_payload, _state), do: {:ok, nil}

  defp classified_failure(%{"classification" => classification} = failure)
       when classification in @failure_classifications,
       do: {:ok, failure}

  defp classified_failure(%{"classification" => classification}),
    do:
      error(:invalid_field, "failure.classification", %{
        received: classification,
        allowed: @failure_classifications
      })

  defp classified_failure(failure),
    do: {:ok, Map.put(failure, "classification", "operator_recovery_required")}

  defp required_outputs(payload) do
    case payload["outputs"] do
      outputs when is_map(outputs) and not is_struct(outputs) ->
        validate_output_values(outputs)

      _other ->
        error(:invalid_field, "outputs", %{expected: "object"})
    end
  end

  defp validate_output_values(outputs) do
    if Enum.all?(outputs, fn {key, value} -> is_binary(key) and artifact_value?(value) end) do
      {:ok, outputs}
    else
      error(:invalid_artifact_value, "outputs")
    end
  end

  defp required_plain_map(payload, field) do
    case payload[field] do
      value when is_map(value) and not is_struct(value) ->
        if artifact_value?(value), do: {:ok, value}, else: error(:invalid_field, field)

      _other ->
        error(:invalid_field, field, %{expected: "object"})
    end
  end

  defp validate_version(%{"protocol_version" => @version}), do: :ok

  defp validate_version(payload) do
    error(:unsupported_protocol_version, "protocol_version", %{
      received: payload["protocol_version"],
      supported: [@version]
    })
  end

  defp validate_worker_id(worker_id) do
    if Regex.match?(@worker_id, worker_id),
      do: :ok,
      else: error(:invalid_worker_id, "worker_id")
  end

  defp match_worker(worker_id, worker_id), do: :ok

  defp match_worker(received, expected),
    do: error(:worker_id_mismatch, "worker_id", %{received: received, expected: expected})

  defp validate_capabilities(
         %{
           "os" => os,
           "arch" => arch,
           "max_concurrency" => max_concurrency,
           "tags" => tags,
           "executors" => executors,
           "workspace_bindings" => workspace_bindings
         } = capabilities
       )
       when is_binary(os) and os != "" and is_binary(arch) and arch != "" and
              is_integer(max_concurrency) and max_concurrency > 0 and max_concurrency <= 1024 and
              is_list(executors) and executors != [] do
    with :ok <- string_list(tags, "capabilities.tags"),
         {:ok, executors} <- validate_executors(executors),
         :ok <- validate_workspace_bindings(workspace_bindings),
         features = Map.get(capabilities, "features", []),
         :ok <- string_list(features, "capabilities.features") do
      {:ok,
       %{
         "os" => os,
         "arch" => arch,
         "max_concurrency" => max_concurrency,
         "tags" => Enum.uniq(tags),
         "executors" => executors,
         "workspace_bindings" => Enum.uniq(workspace_bindings),
         "features" => Enum.uniq(features)
       }}
    end
  end

  defp validate_capabilities(_capabilities),
    do: error(:invalid_capabilities, "capabilities")

  defp validate_executors(executors) do
    Enum.reduce_while(executors, {:ok, []}, fn executor, {:ok, validated} ->
      case validate_executor(executor) do
        {:ok, value} -> {:cont, {:ok, validated ++ [value]}}
        {:error, _error} = error -> {:halt, error}
      end
    end)
  end

  defp validate_executor(
         %{
           "harness_kind" => harness_kind,
           "models" => models,
           "supported_tool_policies" => supported_tool_policies,
           "tool_enforcement" => tool_enforcement,
           "tool_profile" => %{"tools" => tools}
         } = executor
       )
       when is_binary(harness_kind) and harness_kind != "" and is_list(models) and models != [] and
              is_list(tools) and is_list(supported_tool_policies) and
              tool_enforcement in ["exact", "native_permissions"] do
    with :ok <- validate_models(models),
         :ok <- string_list(tools, "capabilities.executors.tool_profile.tools"),
         true <- Enum.uniq(supported_tool_policies) == supported_tool_policies,
         true <- Enum.all?(supported_tool_policies, &(&1 in ["exact", "native_permissions"])),
         true <- supported_tool_policies == [tool_enforcement] do
      {:ok,
       %{
         "harness_kind" => harness_kind,
         "models" => Enum.uniq(models),
         "supported_tool_policies" => supported_tool_policies,
         "tool_enforcement" => tool_enforcement,
         "tool_profile" => %{"tools" => Enum.uniq(tools)},
         "workspaces" => Map.get(executor, "workspaces", [])
       }}
    else
      _invalid -> error(:invalid_capabilities, "capabilities.executors.tool_policy")
    end
  end

  defp validate_executor(_executor),
    do: error(:invalid_capabilities, "capabilities.executors")

  defp validate_models(models) do
    if Enum.all?(models, &valid_model?/1),
      do: :ok,
      else: error(:invalid_field, "capabilities.executors.models")
  end

  defp valid_model?(%{
         "provider" => provider,
         "model" => model,
         "display_name" => display_name,
         "reasoning_capability" => reasoning_capability
       }) do
    non_blank?(provider) and non_blank?(model) and non_blank?(display_name) and
      valid_reasoning_capability?(reasoning_capability)
  end

  defp valid_model?(_other), do: false

  defp valid_reasoning_capability?(%{"kind" => "unsupported"} = capability),
    do: map_size(capability) == 1

  defp valid_reasoning_capability?(%{"kind" => "enumerated", "values" => values} = capability)
       when is_list(values) and values != [] and map_size(capability) == 2 do
    Enum.uniq(values) == values and Enum.all?(values, &non_blank?/1)
  end

  defp valid_reasoning_capability?(_other), do: false

  defp validate_workspace_bindings(bindings) when is_list(bindings) do
    if Enum.all?(bindings, fn
         %{
           "binding_id" => binding_id,
           "workspace_id" => workspace_id,
           "authorized_root_key" => root_key,
           "source_repository_root" => source_root,
           "max_access" => access,
           "allow_unconfined_shell" => shell
         } ->
           valid_uuid?(binding_id) and valid_uuid?(workspace_id) and non_blank?(root_key) and
             non_blank?(source_root) and access in @access and is_boolean(shell)

         _other ->
           false
       end),
       do: :ok,
       else: error(:invalid_field, "capabilities.workspace_bindings")
  end

  defp validate_workspace_bindings(_bindings),
    do: error(:invalid_field, "capabilities.workspace_bindings")

  defp valid_uuid?(value), do: is_binary(value) and match?({:ok, _}, Ecto.UUID.cast(value))
  defp non_blank?(value), do: is_binary(value) and String.trim(value) != ""

  defp string_list(values, field) when is_list(values) do
    if Enum.all?(values, &(is_binary(&1) and &1 != "")),
      do: :ok,
      else: error(:invalid_field, field, %{expected: "non-empty strings"})
  end

  defp string_list(_values, field), do: error(:invalid_field, field, %{expected: "array"})

  defp required_string(payload, field) do
    case payload[field] do
      value when is_binary(value) and value != "" -> {:ok, value}
      _other -> error(:missing_or_invalid_field, field)
    end
  end

  defp worktree_command(type, worker_id, assignment) do
    %{
      "type" => type,
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "worktree" => %{
        "worktree_id" => assignment.worktree_id,
        "run_id" => assignment.run_id,
        "workspace_binding_id" => assignment.workspace_binding_id,
        "identity_hash" => assignment.identity_hash
      }
    }
  end

  defp delivery_command(type, worker_id, delivery, assignment) do
    %{
      "type" => type,
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "delivery" => %{
        "delivery_id" => delivery.id,
        "command_revision" => delivery.command_revision,
        "run_id" => delivery.run_id,
        "worktree_id" => assignment.worktree_id,
        "workspace_binding_id" => assignment.workspace_binding_id,
        "identity_hash" => assignment.identity_hash,
        "branch_name" => assignment.branch_name
      }
    }
  end

  defp execution(%ResolvedExecution{
         identity: %Identity{} = identity,
         performer: %Performer{} = performer,
         work: %Work{} = work,
         configuration: %Configuration{} = configuration,
         logical_workspace: %LogicalWorkspace{} = logical_workspace,
         execution_workspace: %ExecutionWorkspace{} = execution_workspace,
         context: %Context{} = context
       }) do
    validate_resolved_configuration!(configuration)

    %{
      "identity" => stringify_struct(identity),
      "performer" => stringify_struct(performer),
      "work" => %{
        "quest_objective" => work.quest_objective,
        "class_instructions" => work.class_instructions,
        "step_instruction" => work.step_instruction,
        "inputs" => Map.new(work.inputs, fn {name, value} -> {name, artifact(value)} end),
        "declared_outputs" =>
          Enum.map(work.declared_outputs, &%{"name" => &1.name, "kind" => &1.kind}),
        "acceptance_contract" => work.acceptance_contract
      },
      "configuration" => %{
        "harness_kind" => configuration.harness_kind,
        "model" => %{
          "provider" => configuration.model.provider,
          "model" => configuration.model.model
        },
        "reasoning" => configuration.reasoning,
        "reasoning_capability" => reasoning_capability(configuration.reasoning_capability),
        "tool_policy" => tool_policy(configuration.tool_policy),
        "tool_enforcement" => Atom.to_string(configuration.tool_enforcement),
        "resolved_tool_profile" => %{"tools" => configuration.resolved_tool_profile.tools}
      },
      "logical_workspace" => %{
        "workspace_id" => logical_workspace.workspace_id,
        "workspace_key" => logical_workspace.workspace_key
      },
      "execution_workspace" => %{
        "worktree_id" => execution_workspace.worktree_id,
        "workspace_binding_id" => execution_workspace.workspace_binding_id,
        "canonical_root" => execution_workspace.canonical_root,
        "access" => Atom.to_string(execution_workspace.access)
      },
      "context" => %{
        "mode" => Atom.to_string(context.mode),
        "source_occurrence_id" => context.source_occurrence_id,
        "logical_lineage_id" => context.logical_lineage_id
      }
    }
  end

  defp validate_resolved_configuration!(
         %Configuration{
           reasoning: nil,
           reasoning_capability: %ReasoningCapability{kind: :unsupported, values: []}
         } = configuration
       ),
       do: validate_resolved_tools!(configuration)

  defp validate_resolved_configuration!(
         %Configuration{
           reasoning: reasoning,
           reasoning_capability: %ReasoningCapability{kind: :enumerated, values: values}
         } = configuration
       )
       when is_binary(reasoning) do
    if reasoning in values,
      do: validate_resolved_tools!(configuration),
      else: raise(ArgumentError, "resolved reasoning is not advertised")
  end

  defp validate_resolved_configuration!(_configuration),
    do: raise(ArgumentError, "resolved reasoning/capability combination is invalid")

  defp validate_resolved_tools!(%Configuration{
         tool_policy: %Exact{tools: expected},
         tool_enforcement: :exact,
         resolved_tool_profile: %{tools: actual}
       }) do
    if MapSet.new(expected) == MapSet.new(actual),
      do: :ok,
      else: raise(ArgumentError, "resolved exact tool profile is invalid")
  end

  defp validate_resolved_tools!(%Configuration{
         tool_policy: %NativePermissions{},
         tool_enforcement: :native_permissions,
         resolved_tool_profile: %{tools: actual}
       })
       when is_list(actual),
       do: :ok

  defp validate_resolved_tools!(_configuration),
    do: raise(ArgumentError, "resolved tool policy/enforcement combination is invalid")

  defp reasoning_capability(%ReasoningCapability{kind: :unsupported, values: []}),
    do: %{"kind" => "unsupported"}

  defp reasoning_capability(%ReasoningCapability{kind: :enumerated, values: values}),
    do: %{"kind" => "enumerated", "values" => values}

  defp tool_policy(%Exact{tools: tools}), do: %{"kind" => "exact", "tools" => tools}
  defp tool_policy(%NativePermissions{}), do: %{"kind" => "native_permissions"}

  defp encode_operational_recovery(nil), do: nil

  defp encode_operational_recovery(recovery) do
    %{
      "epoch_number" => recovery.epoch_number,
      "attempt_in_epoch" => recovery.attempt_in_epoch,
      "attempt_allowance" => recovery.attempt_allowance,
      "authorization_kind" => recovery.authorization_kind,
      "continuation_mode" => recovery.continuation_mode,
      "retained_lineage_id" => recovery.retained_lineage_id,
      "source_attempt_id" => recovery.source_attempt_id,
      "request_id" => recovery.request_id
    }
  end

  defp stringify_struct(value) do
    Map.new(Map.from_struct(value), fn {key, nested} -> {Atom.to_string(key), nested} end)
  end

  defp artifact(%ArtifactInstance{} = value) do
    %{
      "id" => value.id,
      "kind" => value.kind,
      "output_name" => value.output_name,
      "producer_occurrence_id" => value.producer_occurrence_id,
      "value" => value.value,
      "version" => value.version,
      "supersedes_artifact_id" => value.supersedes_artifact_id,
      "content_hash" => value.content_hash,
      "media_type" => value.media_type,
      "filename" => value.filename,
      "title" => value.title
    }
  end

  defp artifact_value?(value)
       when is_binary(value) or is_integer(value) or is_float(value) or is_boolean(value) or
              is_nil(value),
       do: true

  defp artifact_value?(value) when is_list(value), do: Enum.all?(value, &artifact_value?/1)

  defp artifact_value?(value) when is_map(value) and not is_struct(value) do
    Enum.all?(value, fn {key, nested} -> is_binary(key) and artifact_value?(nested) end)
  end

  defp artifact_value?(_value), do: false

  defp error(code, field \\ nil, details \\ nil),
    do: {:error, %Error{code: code, field: field, details: details}}
end
