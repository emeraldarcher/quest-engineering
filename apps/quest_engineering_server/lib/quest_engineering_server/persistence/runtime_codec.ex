defmodule QuestEngineering.Server.Persistence.RuntimeCodec do
  @moduledoc """
  Versioned JSON-compatible codec for trusted internal runtime data.

  Structs, atoms, tuples, and maps are explicitly tagged. Struct decoding is
  restricted to the core data-model allowlist, and atom decoding only resolves
  atoms that already exist in the VM. No executable or opaque BEAM terms are
  accepted.
  """

  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ArtifactCarry
  alias QuestEngineering.Core.ExecutionPlan.ConditionBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference
  alias QuestEngineering.Core.ExecutionPlan.ControlSubtree
  alias QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.Step
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.ExecutionPlan.UntilRegion
  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Runtime.Event
  alias QuestEngineering.Core.Runtime.ExecutionAttempt
  alias QuestEngineering.Core.Runtime.Failure
  alias QuestEngineering.Core.Runtime.RegionOccurrence
  alias QuestEngineering.Core.Runtime.ResolvedUntilOutput
  alias QuestEngineering.Core.Runtime.Run
  alias QuestEngineering.Core.Runtime.Scope
  alias QuestEngineering.Core.Runtime.StepOccurrence
  alias QuestEngineering.Core.Tactics.Artifact
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Server.Persistence.Error

  @snapshot_version 2

  @struct_modules [
    ExecutionPlan,
    ArtifactBinding,
    ArtifactCarry,
    ConditionBinding,
    ControlDependency,
    ControlRegionReference,
    ControlSubtree,
    RegionArtifactBinding,
    Step,
    UntilOutput,
    UntilRegion,
    Action,
    ArtifactInstance,
    Event,
    ExecutionAttempt,
    Failure,
    RegionOccurrence,
    ResolvedUntilOutput,
    Run,
    Scope,
    StepOccurrence,
    Artifact,
    Condition,
    ContextRequirement,
    PerformerRequirement
  ]
  @modules_by_name Map.new(@struct_modules, &{Atom.to_string(&1), &1})
  @closed_atoms ~w(
    active carried check checking class completed continue_from current dispatched equals
    execute_step exhausted failed fresh otherwise pending remediating root running same_as
    step_completed until_exhausted
  )a
  @closed_atoms_by_name Map.new(@closed_atoms, &{Atom.to_string(&1), &1})

  @spec snapshot_version() :: pos_integer()
  def snapshot_version, do: @snapshot_version

  @spec encode_snapshot(Run.t()) :: {:ok, map()}
  def encode_snapshot(%Run{} = run), do: {:ok, encode_term(run)}

  @spec decode_snapshot(map(), integer()) :: {:ok, Run.t()} | {:error, Error.t()}
  def decode_snapshot(payload, @snapshot_version) do
    case decode_term(payload) do
      {:ok, %Run{} = run} -> {:ok, run}
      {:ok, other} -> invalid_term(%{reason: :snapshot_is_not_a_run, value: other})
      {:error, _error} = error -> error
    end
  end

  def decode_snapshot(_payload, version) do
    {:error, %Error{type: :unsupported_snapshot_version, details: %{version: version}}}
  end

  @spec encode(term()) :: map() | list() | String.t() | number() | boolean() | nil
  def encode(term), do: encode_term(term)

  @spec decode(term()) :: {:ok, term()} | {:error, Error.t()}
  def decode(term), do: decode_term(term)

  defp encode_term(nil), do: nil
  defp encode_term(true), do: true
  defp encode_term(false), do: false
  defp encode_term(value) when is_binary(value) or is_integer(value) or is_float(value), do: value

  defp encode_term(%module{} = value) when module in @struct_modules do
    %{
      "$struct" => Atom.to_string(module),
      "fields" => value |> Map.from_struct() |> encode_term()
    }
  end

  defp encode_term(value) when is_atom(value), do: %{"$atom" => Atom.to_string(value)}

  defp encode_term(value) when is_tuple(value) do
    %{"$tuple" => value |> Tuple.to_list() |> Enum.map(&encode_term/1)}
  end

  defp encode_term(value) when is_list(value), do: Enum.map(value, &encode_term/1)

  defp encode_term(value) when is_map(value) do
    entries =
      value
      |> Enum.map(fn {key, nested} -> [encode_term(key), encode_term(nested)] end)
      |> Enum.sort_by(fn [key, _nested] -> inspect(key) end)

    %{"$map" => entries}
  end

  defp decode_term(nil), do: {:ok, nil}
  defp decode_term(true), do: {:ok, true}
  defp decode_term(false), do: {:ok, false}

  defp decode_term(value) when is_binary(value) or is_integer(value) or is_float(value),
    do: {:ok, value}

  defp decode_term(%{"$atom" => name}) when is_binary(name) do
    case Map.fetch(@closed_atoms_by_name, name) do
      {:ok, atom} ->
        {:ok, atom}

      :error ->
        {:ok, String.to_existing_atom(name)}
    end
  rescue
    ArgumentError -> invalid_term(%{reason: :unknown_atom, atom: name})
  end

  defp decode_term(%{"$tuple" => values}) when is_list(values) do
    with {:ok, decoded} <- decode_list(values), do: {:ok, List.to_tuple(decoded)}
  end

  defp decode_term(%{"$map" => entries}) when is_list(entries) do
    Enum.reduce_while(entries, {:ok, %{}}, fn
      [encoded_key, encoded_value], {:ok, decoded} ->
        with {:ok, key} <- decode_term(encoded_key),
             {:ok, value} <- decode_term(encoded_value) do
          {:cont, {:ok, Map.put(decoded, key, value)}}
        else
          {:error, _error} = error -> {:halt, error}
        end

      malformed, _accumulator ->
        {:halt, invalid_term(%{reason: :malformed_map_entry, entry: malformed})}
    end)
  end

  defp decode_term(%{"$struct" => name, "fields" => encoded_fields}) when is_binary(name) do
    with {:ok, module} <- fetch_struct_module(name),
         {:ok, fields} <- decode_term(encoded_fields),
         true <- is_map(fields) do
      {:ok, struct!(module, fields)}
    else
      false -> invalid_term(%{reason: :struct_fields_are_not_a_map, module: name})
      {:error, _error} = error -> error
    end
  rescue
    error in [KeyError, ArgumentError] ->
      invalid_term(%{
        reason: :invalid_struct_fields,
        module: name,
        error: Exception.message(error)
      })
  end

  defp decode_term(value) when is_list(value), do: decode_list(value)
  defp decode_term(value), do: invalid_term(%{reason: :unsupported_encoding, value: value})

  defp decode_list(values) do
    Enum.reduce_while(values, {:ok, []}, fn encoded, {:ok, decoded} ->
      case decode_term(encoded) do
        {:ok, value} -> {:cont, {:ok, [value | decoded]}}
        {:error, _error} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, decoded} -> {:ok, Enum.reverse(decoded)}
      {:error, _error} = error -> error
    end
  end

  defp fetch_struct_module(name) do
    case Map.fetch(@modules_by_name, name) do
      {:ok, module} ->
        # Loading the allowlisted struct module first interns its closed field and
        # discriminator atoms before nested fields are decoded. This keeps cold
        # restart decoding safe without creating atoms from open wire data.
        case Code.ensure_loaded(module) do
          {:module, ^module} -> {:ok, module}
          {:error, reason} -> invalid_term(%{reason: :struct_module_unavailable, module: name, error: reason})
        end
      :error -> invalid_term(%{reason: :unknown_struct, module: name})
    end
  end

  defp invalid_term(details),
    do: {:error, %Error{type: :invalid_persisted_term, details: details}}
end
