defmodule QuestEngineering.Server.WorkerProtocol do
  @moduledoc """
  Versioned, JSON-compatible worker wire protocol.

  This module is the serialization and validation boundary. Phoenix channel
  callbacks only pass decoded messages to application services.
  """

  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Core.ResolvedExecution.Configuration
  alias QuestEngineering.Core.ResolvedExecution.Context
  alias QuestEngineering.Core.ResolvedExecution.Identity
  alias QuestEngineering.Core.ResolvedExecution.Performer
  alias QuestEngineering.Core.ResolvedExecution.Work
  alias QuestEngineering.Core.Runtime.ArtifactInstance

  @version 3
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
            dispatches: [map()] | nil
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
      :dispatches
    ]
  end

  defmodule Error do
    @moduledoc "Machine-readable worker protocol rejection."
    @enforce_keys [:code]

    @type t :: %__MODULE__{code: atom(), field: String.t() | nil, details: term()}

    defstruct [:code, :field, :details]
  end

  @spec version() :: 3
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
         "executors" => executors
       })
       when is_binary(os) and os != "" and is_binary(arch) and arch != "" and
              is_integer(max_concurrency) and max_concurrency > 0 and max_concurrency <= 1024 and
              is_list(executors) and executors != [] do
    with :ok <- string_list(tags, "capabilities.tags"),
         {:ok, executors} <- validate_executors(executors) do
      {:ok,
       %{
         "os" => os,
         "arch" => arch,
         "max_concurrency" => max_concurrency,
         "tags" => Enum.uniq(tags),
         "executors" => executors
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

  defp validate_executor(%{
         "adapter" => adapter,
         "models" => models,
         "reasoning" => reasoning,
         "tools" => tools,
         "workspaces" => workspaces
       })
       when is_binary(adapter) and adapter != "" and is_list(models) and models != [] and
              is_list(reasoning) and is_list(tools) and is_list(workspaces) do
    with :ok <- validate_models(models),
         :ok <- allowed_string_list(reasoning, @reasoning, "capabilities.executors.reasoning"),
         :ok <- string_list(tools, "capabilities.executors.tools"),
         :ok <- validate_workspaces(workspaces) do
      {:ok,
       %{
         "adapter" => adapter,
         "models" => Enum.uniq(models),
         "reasoning" => Enum.uniq(reasoning),
         "tools" => Enum.uniq(tools),
         "workspaces" => Enum.uniq(workspaces)
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

  defp validate_workspaces(workspaces) do
    if Enum.all?(workspaces, fn
         %{"ref" => ref, "root" => root, "max_access" => access} ->
           is_binary(ref) and ref != "" and is_binary(root) and root != "" and access in @access

         _other ->
           false
       end),
       do: :ok,
       else: error(:invalid_field, "capabilities.executors.workspaces")
  end

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
        "tools" => configuration.tools,
        "workspace" => %{
          "ref" => configuration.workspace_ref,
          "root" => configuration.workspace_root,
          "access" => Atom.to_string(configuration.workspace_access)
        }
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
