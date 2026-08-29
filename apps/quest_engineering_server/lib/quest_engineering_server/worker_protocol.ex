defmodule QuestEngineering.Server.WorkerProtocol do
  @moduledoc """
  Versioned, JSON-compatible worker wire protocol.

  This module is the serialization and validation boundary. Phoenix channel
  callbacks only pass decoded messages to application services.
  """

  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.ExecutionWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.LogicalWorkspace
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance

  @version 4
  @worker_id ~r/\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z/
  @states ~w(accepted running completed failed uncertain)
  @reasoning ~w(low medium high)
  @access ~w(none read_only read_write)

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
            binding: map() | nil
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
      :binding
    ]
  end

  defmodule Error do
    @moduledoc "Machine-readable worker protocol rejection."
    @enforce_keys [:code]

    @type t :: %__MODULE__{code: atom(), field: String.t() | nil, details: term()}

    defstruct [:code, :field, :details]
  end

  @spec version() :: 4
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

  def welcome(worker_id) do
    %{
      "type" => "worker_welcome",
      "protocol_version" => @version,
      "worker_id" => worker_id
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
            "identity_hash" => assignment.identity_hash
          }
        end)
    }
  end

  def execute_action(worker_id, %ResolvedExecution{} = execution) do
    %{
      "type" => "execute_action",
      "protocol_version" => @version,
      "worker_id" => worker_id,
      "execution" => execution(execution)
    }
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
         {:ok, failure} <- required_plain_map(payload, "failure") do
      {:ok,
       struct!(
         Message,
         Map.merge(fields, %{type: :step_failed, worker_id: worker_id, failure: failure})
       )}
    end
  end

  defp decode_message("reconcile_state", worker_id, %{"dispatches" => dispatches})
       when is_list(dispatches) do
    with {:ok, decoded} <- decode_reconcile_dispatches(dispatches) do
      {:ok, %Message{type: :reconcile_state, worker_id: worker_id, dispatches: decoded}}
    end
  end

  defp decode_message("reconcile_state", _worker_id, _payload),
    do: error(:invalid_field, "dispatches", %{expected: "array"})

  defp decode_message(type, _worker_id, _payload),
    do: error(:unknown_message_type, "type", %{received: type})

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
       max_access: access,
       allow_unconfined_shell: shell
     }}
  end

  defp decode_workspace_binding(_value), do: error(:invalid_field, "binding")

  defp decode_ready_worktree(%{
         "worktree_id" => worktree_id,
         "run_id" => run_id,
         "workspace_binding_id" => binding_id,
         "base_revision" => base_revision,
         "branch_name" => branch_name,
         "canonical_root" => canonical_root,
         "source_dirty_excluded" => dirty,
         "identity_hash" => identity_hash
       })
       when is_binary(worktree_id) and is_binary(run_id) and is_binary(binding_id) and
              is_binary(base_revision) and is_binary(branch_name) and is_binary(canonical_root) and
              is_boolean(dirty) and is_binary(identity_hash) do
    {:ok,
     %{
       worktree_id: worktree_id,
       run_id: run_id,
       workspace_binding_id: binding_id,
       base_revision: base_revision,
       branch_name: branch_name,
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

  defp optional_failure(payload, state) when state in [:failed, :uncertain],
    do: required_plain_map(payload, "failure")

  defp optional_failure(_payload, _state), do: {:ok, nil}

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

  defp validate_capabilities(%{
         "os" => os,
         "arch" => arch,
         "max_concurrency" => max_concurrency,
         "tags" => tags,
         "executors" => executors,
         "workspace_bindings" => workspace_bindings
       })
       when is_binary(os) and os != "" and is_binary(arch) and arch != "" and
              is_integer(max_concurrency) and max_concurrency > 0 and max_concurrency <= 1024 and
              is_list(executors) and executors != [] do
    with :ok <- string_list(tags, "capabilities.tags"),
         {:ok, executors} <- validate_executors(executors),
         :ok <- validate_workspace_bindings(workspace_bindings) do
      {:ok,
       %{
         "os" => os,
         "arch" => arch,
         "max_concurrency" => max_concurrency,
         "tags" => Enum.uniq(tags),
         "executors" => executors,
         "workspace_bindings" => Enum.uniq(workspace_bindings)
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
           "adapter" => adapter,
           "models" => models,
           "reasoning" => reasoning,
           "tools" => tools
         } = executor
       )
       when is_binary(adapter) and adapter != "" and is_list(models) and models != [] and
              is_list(reasoning) and is_list(tools) do
    with :ok <- validate_models(models),
         :ok <- allowed_string_list(reasoning, @reasoning, "capabilities.executors.reasoning"),
         :ok <- string_list(tools, "capabilities.executors.tools") do
      {:ok,
       %{
         "adapter" => adapter,
         "models" => Enum.uniq(models),
         "reasoning" => Enum.uniq(reasoning),
         "tools" => Enum.uniq(tools),
         "workspaces" => Map.get(executor, "workspaces", [])
       }}
    end
  end

  defp validate_executor(_executor),
    do: error(:invalid_capabilities, "capabilities.executors")

  defp validate_models(models) do
    if Enum.all?(models, fn
         %{"provider" => provider, "model" => model} ->
           is_binary(provider) and provider != "" and is_binary(model) and model != ""

         _other ->
           false
       end),
       do: :ok,
       else: error(:invalid_field, "capabilities.executors.models")
  end

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

  defp allowed_string_list(values, allowed, field) do
    if Enum.all?(values, &(&1 in allowed)),
      do: :ok,
      else: error(:invalid_field, field, %{allowed: allowed})
  end

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

  defp execution(%ResolvedExecution{
         identity: %Identity{} = identity,
         performer: %Performer{} = performer,
         work: %Work{} = work,
         configuration: %Configuration{} = configuration,
         logical_workspace: %LogicalWorkspace{} = logical_workspace,
         execution_workspace: %ExecutionWorkspace{} = execution_workspace,
         context: %Context{} = context
       }) do
    %{
      "identity" => stringify_struct(identity),
      "performer" => stringify_struct(performer),
      "work" => %{
        "quest_objective" => work.quest_objective,
        "class_instructions" => work.class_instructions,
        "step_instruction" => work.step_instruction,
        "inputs" => Map.new(work.inputs, fn {type, value} -> {type, artifact(value)} end),
        "declared_outputs" => work.declared_outputs
      },
      "configuration" => %{
        "model" => %{
          "provider" => configuration.model.provider,
          "model" => configuration.model.model
        },
        "reasoning" => Atom.to_string(configuration.reasoning),
        "tools" => configuration.tools
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

  defp stringify_struct(value) do
    Map.new(Map.from_struct(value), fn {key, nested} -> {Atom.to_string(key), nested} end)
  end

  defp artifact(%ArtifactInstance{} = value) do
    %{
      "id" => value.id,
      "type" => value.type,
      "producer_occurrence_id" => value.producer_occurrence_id,
      "value" => value.value
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
