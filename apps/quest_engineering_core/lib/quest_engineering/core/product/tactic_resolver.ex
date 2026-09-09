defmodule QuestEngineering.Core.Product.TacticResolver.Limits do
  @moduledoc "Conservative deterministic expansion resource limits."

  defstruct max_use_depth: 32,
            max_expanded_nodes: 10_000,
            max_resolved_key_bytes: 1_024

  @type t :: %__MODULE__{
          max_use_depth: pos_integer(),
          max_expanded_nodes: pos_integer(),
          max_resolved_key_bytes: pos_integer()
        }

  @spec defaults() :: t()
  def defaults, do: %__MODULE__{}
end

defmodule QuestEngineering.Core.Product.TacticResolver.Catalog do
  @moduledoc "Plain immutable definitions and archive state supplied to the pure resolver."

  alias QuestEngineering.Core.Product.TacticDefinition

  defstruct definitions: %{}, archived_ids: MapSet.new()

  @type t :: %__MODULE__{
          definitions: %{optional(String.t()) => TacticDefinition.t()},
          archived_ids: MapSet.t(String.t())
        }

  @spec empty() :: t()
  def empty, do: %__MODULE__{}
end

defmodule QuestEngineering.Core.Product.TacticResolver.Error do
  @moduledoc "A structured authoring-resolution failure with scope provenance."

  @enforce_keys [:code, :path, :instance_path, :definition_path, :details]
  defstruct [:code, :path, :instance_path, :definition_path, :details]

  @type t :: %__MODULE__{
          code: atom(),
          path: [String.t() | non_neg_integer()],
          instance_path: [String.t()],
          definition_path: [String.t()],
          details: map()
        }
end

defmodule QuestEngineering.Core.Product.TacticResolver.StepOrigin do
  @moduledoc false

  @enforce_keys [:instance_path, :local_step_key, :body_path]
  defstruct [
    :instance_path,
    :local_step_key,
    :body_path,
    :definition_id,
    :definition_key
  ]

  @type t :: %__MODULE__{
          instance_path: [String.t()],
          local_step_key: String.t(),
          body_path: [String.t() | non_neg_integer()],
          definition_id: String.t() | nil,
          definition_key: String.t() | nil
        }
end

defmodule QuestEngineering.Core.Product.ResolvedTacticUse do
  @moduledoc "A resolved lexical child boundary; the compiler exposes only declared exports."

  @enforce_keys [
    :instance_key,
    :tactic_definition_id,
    :body,
    :input_ports,
    :input_bindings,
    :output_ports
  ]
  defstruct [
    :instance_key,
    :tactic_definition_id,
    :body,
    :input_ports,
    :input_bindings,
    :output_ports
  ]
end

defmodule QuestEngineering.Core.Product.TacticResolver.Resolution do
  @moduledoc "A fully expanded semantic Tactic plus non-execution provenance."

  alias QuestEngineering.Core.Product.TacticProvenance
  alias QuestEngineering.Core.Product.TacticResolver.StepOrigin

  @enforce_keys [:tactic, :interface, :provenance, :step_origins]
  defstruct [:tactic, :interface, :provenance, :step_origins]

  @type t :: %__MODULE__{
          tactic: term(),
          interface: QuestEngineering.Core.Product.TacticInterface.t(),
          provenance: TacticProvenance.t(),
          step_origins: %{optional(String.t()) => StepOrigin.t()}
        }
end

defmodule QuestEngineering.Core.Product.TacticResolver do
  @moduledoc "Pure deterministic expansion of authoring Uses into a plain semantic Tactic."

  alias QuestEngineering.Core.Product.AcceptedArtifactSource
  alias QuestEngineering.Core.Product.ResolvedTacticUse
  alias QuestEngineering.Core.Product.TacticAuthoring
  alias QuestEngineering.Core.Product.TacticDefinition
  alias QuestEngineering.Core.Product.TacticInputBinding
  alias QuestEngineering.Core.Product.TacticInterface
  alias QuestEngineering.Core.Product.TacticOutputPort
  alias QuestEngineering.Core.Product.TacticProvenance
  alias QuestEngineering.Core.Product.TacticProvenance.Occurrence
  alias QuestEngineering.Core.Product.TacticProvenance.Root
  alias QuestEngineering.Core.Product.TacticResolver.Catalog
  alias QuestEngineering.Core.Product.TacticResolver.Error
  alias QuestEngineering.Core.Product.TacticResolver.Limits
  alias QuestEngineering.Core.Product.TacticResolver.Resolution
  alias QuestEngineering.Core.Product.TacticResolver.StepOrigin
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Core.Product.TacticUse
  alias QuestEngineering.Core.Tactics.ArtifactInput
  alias QuestEngineering.Core.Tactics.ArtifactRef
  alias QuestEngineering.Core.Tactics.Condition
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.Parallel
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Core.Tactics.Sequence
  alias QuestEngineering.Core.Tactics.Step
  alias QuestEngineering.Core.Tactics.Until

  @type result :: {:ok, Resolution.t()} | {:error, [Error.t()]}

  @spec resolve(Inline.t() | Definition.t(), Catalog.t(), Limits.t()) :: result()
  def resolve(source, catalog, limits \\ Limits.defaults())

  def resolve(%Inline{body: body}, %Catalog{} = catalog, %Limits{} = limits) do
    root = %Root{kind: :inline}
    state = state(catalog, limits)

    case expand_scope(body, [], ["inline"], nil, [], 0, state) do
      {:ok, tactic, resolved} -> success(tactic, %TacticInterface{}, root, resolved)
      {:error, error} -> {:error, [error]}
    end
  end

  def resolve(
        %Definition{tactic_definition_id: definition_id},
        %Catalog{} = catalog,
        %Limits{} = limits
      ) do
    case fetch_definition(definition_id, [], ["tactic_definition_id"], [], catalog) do
      {:ok, definition} ->
        identity = identity(definition)

        root = %Root{
          kind: :definition,
          definition_id: definition.id,
          definition_key: definition.key,
          definition_name: definition.name
        }

        state =
          catalog
          |> state(limits)
          |> add_occurrence([], definition)

        case expand_scope(definition.body, [], ["body"], identity, [identity], 0, state) do
          {:ok, tactic, resolved} -> success(tactic, definition.interface, root, resolved)
          {:error, error} -> {:error, [error]}
        end

      {:error, error} ->
        {:error, [error]}
    end
  end

  def resolve(source, %Catalog{}, %Limits{}) do
    {:error,
     [
       error(:invalid_tactic_source, [], [], [], %{
         value: source
       })
     ]}
  end

  defp expand_scope(body, prefix, path, definition, active, depth, state) do
    case TacticAuthoring.validate(body, path) do
      [] ->
        expand_node(body, prefix, path, definition, active, depth, state)

      errors ->
        {:error,
         error(
           :invalid_tactic_definition,
           path,
           prefix,
           definition_keys(active),
           %{validation_errors: errors, definition_id: definition && definition.id}
         )}
    end
  end

  defp expand_node(%Step{} = step, prefix, path, definition, _active, _depth, state) do
    with {:ok, state} <- increment_nodes(state, path, prefix, definition),
         resolved_key = scoped_key(prefix, step.key),
         :ok <- key_length(resolved_key, path ++ ["key"], prefix, definition, state) do
      resolved = %Step{
        step
        | key: resolved_key,
          performer: rewrite_performer(step.performer, prefix),
          context: rewrite_context(step.context, prefix),
          consumes: rewrite_inputs(step.consumes, prefix)
      }

      origin = %StepOrigin{
        instance_path: prefix,
        local_step_key: step.key,
        body_path: path,
        definition_id: definition && definition.id,
        definition_key: definition && definition.key
      }

      {:ok, resolved, put_origin(state, resolved_key, origin)}
    else
      {:error, error} -> {:error, error}
    end
  end

  defp expand_node(%Sequence{children: children}, prefix, path, definition, active, depth, state) do
    with {:ok, state} <- increment_nodes(state, path, prefix, definition),
         {:ok, resolved, state} <-
           expand_children(children, prefix, path, definition, active, depth, state) do
      {:ok, %Sequence{children: resolved}, state}
    end
  end

  defp expand_node(%Parallel{children: children}, prefix, path, definition, active, depth, state) do
    with {:ok, state} <- increment_nodes(state, path, prefix, definition),
         {:ok, resolved, state} <-
           expand_children(children, prefix, path, definition, active, depth, state) do
      {:ok, %Parallel{children: resolved}, state}
    end
  end

  defp expand_node(%Until{} = until, prefix, path, definition, active, depth, state) do
    with {:ok, state} <- increment_nodes(state, path, prefix, definition),
         {:ok, check, state} <-
           expand_node(until.check, prefix, path ++ ["check"], definition, active, depth, state),
         {:ok, otherwise, state} <-
           expand_node(
             until.otherwise,
             prefix,
             path ++ ["otherwise"],
             definition,
             active,
             depth,
             state
           ) do
      {:ok,
       %Until{
         until
         | check: check,
           condition: rewrite_condition(until.condition, prefix),
           otherwise: otherwise
       }, state}
    end
  end

  defp expand_node(%TacticUse{} = use, prefix, path, _definition, active, depth, state) do
    instance_path = prefix ++ [use.instance_key]
    child_path = path ++ ["$use", use.instance_key]
    next_depth = depth + 1

    with :ok <- use_depth(next_depth, child_path, instance_path, active, state),
         {:ok, definition} <-
           fetch_definition(
             use.tactic_definition_id,
             instance_path,
             path ++ ["tactic_definition_id"],
             active,
             state.catalog
           ),
         :ok <- no_cycle(definition, child_path, instance_path, active) do
      identity = identity(definition)
      next_state = add_occurrence(state, instance_path, definition)

      case expand_scope(
             definition.body,
             instance_path,
             child_path,
             definition,
             active ++ [identity],
             next_depth,
             next_state
           ) do
        {:ok, body, resolved} ->
          resolved_use = %ResolvedTacticUse{
            instance_key: Enum.join(instance_path, "/"),
            tactic_definition_id: definition.id,
            body: body,
            input_ports: definition.interface.inputs,
            input_bindings: Enum.map(use.input_bindings, &rewrite_binding(&1, prefix)),
            output_ports:
              Enum.map(definition.interface.outputs, &rewrite_output_port(&1, instance_path))
          }

          {:ok, resolved_use, resolved}

        {:error, error} ->
          {:error, error}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  defp expand_children(children, prefix, path, definition, active, depth, state) do
    children
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, [], state}, fn {child, index}, {:ok, resolved, current} ->
      case expand_node(
             child,
             prefix,
             path ++ ["children", index],
             definition,
             active,
             depth,
             current
           ) do
        {:ok, node, next} -> {:cont, {:ok, [node | resolved], next}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
    |> case do
      {:ok, resolved, current} -> {:ok, Enum.reverse(resolved), current}
      {:error, error} -> {:error, error}
    end
  end

  defp fetch_definition(id, instance_path, path, active, catalog) do
    cond do
      MapSet.member?(catalog.archived_ids, id) ->
        definition = Map.get(catalog.definitions, id)

        {:error,
         error(
           :archived_tactic_definition,
           path,
           instance_path,
           definition_keys(active),
           %{definition_id: id, definition_key: definition && definition.key}
         )}

      not Map.has_key?(catalog.definitions, id) ->
        {:error,
         error(:missing_tactic_definition, path, instance_path, definition_keys(active), %{
           definition_id: id
         })}

      true ->
        {:ok, Map.fetch!(catalog.definitions, id)}
    end
  end

  defp no_cycle(definition, path, instance_path, active) do
    case Enum.find_index(active, &(&1.id == definition.id)) do
      nil ->
        :ok

      index ->
        cycle = Enum.drop(active, index) ++ [identity(definition)]

        {:error,
         error(
           :cyclic_tactic_reference,
           path,
           instance_path,
           Enum.map(cycle, & &1.key),
           %{definition_ids: Enum.map(cycle, & &1.id)}
         )}
    end
  end

  defp increment_nodes(state, path, instance_path, definition) do
    count = state.node_count + 1

    if count > state.limits.max_expanded_nodes do
      {:error,
       limit_error(
         :max_expanded_nodes,
         state.limits.max_expanded_nodes,
         count,
         path,
         instance_path,
         definition
       )}
    else
      {:ok, %{state | node_count: count}}
    end
  end

  defp use_depth(depth, path, instance_path, active, state) do
    if depth > state.limits.max_use_depth do
      {:error,
       error(
         :resolution_limit_exceeded,
         path,
         instance_path,
         definition_keys(active),
         %{limit: :max_use_depth, maximum: state.limits.max_use_depth, actual: depth}
       )}
    else
      :ok
    end
  end

  defp key_length(key, path, instance_path, definition, state) do
    actual = byte_size(key)

    if actual > state.limits.max_resolved_key_bytes do
      {:error,
       limit_error(
         :max_resolved_key_bytes,
         state.limits.max_resolved_key_bytes,
         actual,
         path,
         instance_path,
         definition
       )}
    else
      :ok
    end
  end

  defp limit_error(limit, maximum, actual, path, instance_path, definition) do
    error(
      :resolution_limit_exceeded,
      path,
      instance_path,
      if(definition, do: [definition.key], else: []),
      %{limit: limit, maximum: maximum, actual: actual}
    )
  end

  defp rewrite_performer(
         %PerformerRequirement{selector: :same_as, value: value} = requirement,
         prefix
       ) do
    %{requirement | value: scoped_key(prefix, value)}
  end

  defp rewrite_performer(requirement, _prefix), do: requirement

  defp rewrite_context(
         %ContextRequirement{selector: :continue_from, value: value} = requirement,
         prefix
       ) do
    %{requirement | value: scoped_key(prefix, value)}
  end

  defp rewrite_context(requirement, _prefix), do: requirement

  defp rewrite_inputs(inputs, prefix) when is_list(inputs),
    do: Enum.map(inputs, &rewrite_input(&1, prefix))

  defp rewrite_inputs(inputs, _prefix), do: inputs

  defp rewrite_input(%ArtifactInput{source: %ArtifactRef{} = source} = input, prefix),
    do: %{input | source: rewrite_ref(source, prefix)}

  defp rewrite_input(input, _prefix), do: input

  defp rewrite_condition(%Condition{source: %ArtifactRef{} = source} = condition, prefix),
    do: %{condition | source: rewrite_ref(source, prefix)}

  defp rewrite_condition(condition, _prefix), do: condition

  defp rewrite_ref(%ArtifactRef{producer: "$inputs"} = source, prefix),
    do: %{source | producer: scoped_key(prefix, "$inputs")}

  defp rewrite_ref(%ArtifactRef{producer: producer} = source, prefix),
    do: %{source | producer: scoped_key(prefix, producer)}

  defp rewrite_binding(%TacticInputBinding{source: source} = binding, prefix),
    do: %{binding | source: rewrite_ref(source, prefix)}

  defp rewrite_output_port(%TacticOutputPort{source: %ArtifactRef{} = source} = port, prefix),
    do: %{port | source: rewrite_ref(source, prefix)}

  defp rewrite_output_port(%TacticOutputPort{source: %AcceptedArtifactSource{}} = port, _prefix),
    do: port

  defp scoped_key([], local_key), do: local_key
  defp scoped_key(prefix, local_key), do: Enum.join(prefix ++ [local_key], "/")

  defp state(catalog, limits) do
    %{
      catalog: catalog,
      limits: limits,
      node_count: 0,
      occurrences: [],
      origins: %{}
    }
  end

  defp add_occurrence(state, instance_path, definition) do
    occurrence = %Occurrence{
      instance_path: instance_path,
      definition_id: definition.id,
      definition_key: definition.key,
      definition_name: definition.name
    }

    %{state | occurrences: [occurrence | state.occurrences]}
  end

  defp put_origin(state, key, origin), do: %{state | origins: Map.put(state.origins, key, origin)}

  defp success(tactic, interface, root, state) do
    provenance = %TacticProvenance{
      root: root,
      definitions: Enum.reverse(state.occurrences)
    }

    interface = %{interface | outputs: Enum.map(interface.outputs, &rewrite_output_port(&1, []))}

    {:ok,
     %Resolution{
       tactic: tactic,
       interface: interface,
       provenance: provenance,
       step_origins: state.origins
     }}
  end

  defp identity(%TacticDefinition{} = definition),
    do: %{id: definition.id, key: definition.key}

  defp definition_keys(active), do: Enum.map(active, & &1.key)

  defp error(code, path, instance_path, definition_path, details) do
    %Error{
      code: code,
      path: path,
      instance_path: instance_path,
      definition_path: definition_path,
      details: details
    }
  end
end
