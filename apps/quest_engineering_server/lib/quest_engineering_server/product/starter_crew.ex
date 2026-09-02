defmodule QuestEngineering.Server.Product.StarterCrew do
  @moduledoc "Atomic classification and reconciliation of the ordinary Product starter crew."

  import Ecto.Query
  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Server.ExecutionOptions
  alias QuestEngineering.Server.Persistence.ProductClass
  alias QuestEngineering.Server.Persistence.ProductLoadout
  alias QuestEngineering.Server.Persistence.ProductSquad
  alias QuestEngineering.Server.Persistence.ProductSquadMember
  alias QuestEngineering.Server.Persistence.ProductTactic
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Product.Repository
  alias QuestEngineering.Server.Product.TacticLibrary
  alias QuestEngineering.Server.ProductChangeNotifier
  alias QuestEngineering.Server.Repo

  @class_keys ~w(builder reviewer)
  @loadout_keys ~w(coding review)
  @squad_key "engineering-pair"
  @tactic_key "implement-and-review"
  @coding_tools ~w(workspace.filesystem workspace.search terminal.shell)
  @review_tools ~w(workspace.filesystem workspace.search)

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code]
    defstruct [:code, :entity_type, :key, details: %{}]
  end

  @type state :: :empty | :recoverable_partial | :complete | :conflict | :manual_configuration

  @spec status() :: %{state: state(), conflict: map() | nil}
  def status do
    snapshot = snapshot(false)

    snapshot
    |> classify(:intrinsic)
    |> onboarding_classification(snapshot)
    |> status_view()
  end

  @spec create_or_reconcile(String.t()) :: {:ok, map()} | {:error, term()}
  def create_or_reconcile(workspace_id), do: create_or_reconcile(workspace_id, [])

  @doc false
  def create_or_reconcile(workspace_id, options) when is_binary(workspace_id) do
    result =
      Repo.transaction(fn ->
        snapshot = snapshot(true)
        classification = classify(snapshot, :intrinsic)

        case classification.state do
          :conflict -> Repo.rollback(conflict_error(classification.conflict))
          :manual_configuration -> Repo.rollback(%Error{code: :manual_configuration})
          :complete -> result(snapshot)
          _ -> reconcile(snapshot, workspace_id, options)
        end
      end)

    case result do
      {:ok, value} ->
        ProductChangeNotifier.notify(["classes", "loadouts", "squads", "tactics"])
        {:ok, value}

      {:error, error} ->
        {:error, error}
    end
  end

  def create_or_reconcile(_workspace_id, _options),
    do: {:error, %Error{code: :invalid_request, details: %{path: ["workspace_id"]}}}

  defp reconcile(snapshot, workspace_id, options) do
    with {:ok, _workspace} <- Repository.get_workspace(workspace_id),
         {:ok, configuration} <- reconciliation_configuration(snapshot, workspace_id),
         requested = classify(snapshot, {:configuration, configuration}),
         :ok <- allow_reconciliation(requested),
         {:ok, builder} <- ensure_class(snapshot, "builder"),
         {:ok, reviewer} <- ensure_class(snapshot, "reviewer"),
         {:ok, coding} <- ensure_loadout(snapshot, "coding", configuration),
         {:ok, review} <- ensure_loadout(snapshot, "review", configuration),
         {:ok, squad} <- ensure_squad(snapshot, builder.id, reviewer.id, coding.id, review.id),
         :ok <- before_tactic(options),
         {:ok, tactic} <- ensure_tactic(snapshot) do
      %{
        status: :ready,
        classes: [builder, reviewer],
        loadouts: [coding, review],
        squad: squad,
        tactic: tactic
      }
    else
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp before_tactic(options) do
    case Keyword.get(options, :before_tactic) do
      nil -> :ok
      callback when is_function(callback, 0) -> callback.()
    end
  end

  defp allow_reconciliation(%{state: :conflict, conflict: conflict}),
    do: {:error, conflict_error(conflict)}

  defp allow_reconciliation(%{state: :manual_configuration}),
    do: {:error, %Error{code: :manual_configuration}}

  defp allow_reconciliation(_classification), do: :ok

  defp reconciliation_configuration(snapshot, workspace_id) do
    if Enum.all?(@loadout_keys, &Map.has_key?(snapshot.loadouts, &1)) do
      {:ok, persisted_configuration(snapshot)}
    else
      compatible_configuration(snapshot, workspace_id)
    end
  end

  defp persisted_configuration(snapshot) do
    coding = Map.fetch!(snapshot.loadouts, "coding")
    review = Map.fetch!(snapshot.loadouts, "review")

    %{
      model: %ModelRef{provider: coding.model_provider, model: coding.model_name},
      reasoning: reasoning_atom(coding.reasoning),
      coding_tools: coding.tools,
      review_tools: review.tools
    }
  end

  defp compatible_configuration(snapshot, workspace_id) do
    configurations =
      ExecutionOptions.list()
      |> Enum.filter(&compatible_option?(&1, workspace_id))
      |> Enum.sort_by(&option_order_key/1)
      |> Enum.map(&configuration/1)

    case Enum.find(configurations, &configuration_matches_existing?(&1, snapshot)) do
      nil when configurations == [] ->
        {:error, %Error{code: :no_compatible_execution_option}}

      nil ->
        key = if Map.has_key?(snapshot.loadouts, "coding"), do: "coding", else: "review"
        {:error, %Error{code: :conflict, entity_type: :loadout, key: key}}

      value ->
        {:ok, value}
    end
  end

  defp option_order_key(option) do
    {
      option.model.provider,
      option.model.model,
      Enum.sort(option.reasoning),
      Enum.sort(option.tools),
      option.workspaces
      |> Enum.map(&{&1.workspace_id, Enum.sort(&1.workspace_access)})
      |> Enum.sort()
    }
  end

  defp compatible_option?(option, workspace_id) do
    workspace = Enum.find(option.workspaces, &(&1.workspace_id == workspace_id))

    option.available && Enum.any?(option.reasoning, &(&1 in ~w(low medium high))) && workspace &&
      "read_write" in workspace.workspace_access && "read_only" in workspace.workspace_access
  end

  defp configuration(option) do
    known_reasoning = Enum.filter(option.reasoning, &(&1 in ~w(low medium high)))

    reasoning =
      if "medium" in known_reasoning, do: :medium, else: reasoning_atom(hd(known_reasoning))

    %{
      model: %ModelRef{provider: option.model.provider, model: option.model.model},
      reasoning: reasoning,
      coding_tools: Enum.filter(option.tools, &(&1 in @coding_tools)),
      review_tools: Enum.filter(option.tools, &(&1 in @review_tools))
    }
  end

  defp reasoning_atom("low"), do: :low
  defp reasoning_atom("medium"), do: :medium
  defp reasoning_atom("high"), do: :high

  defp configuration_matches_existing?(configuration, snapshot) do
    Enum.all?(@loadout_keys, fn key ->
      case Map.get(snapshot.loadouts, key) do
        nil ->
          true

        row ->
          row.archived_at == nil && loadout_matches?(row, loadout_attributes(key, configuration))
      end
    end)
  end

  defp ensure_class(snapshot, key) do
    case Map.get(snapshot.classes, key) do
      nil -> Repository.create_class(class_attributes(key))
      row -> Repository.get_class(row.id)
    end
  end

  defp ensure_loadout(snapshot, key, configuration) do
    case Map.get(snapshot.loadouts, key) do
      nil -> Repository.create_loadout(loadout_attributes(key, configuration))
      row -> Repository.get_loadout(row.id)
    end
  end

  defp ensure_squad(snapshot, builder_id, reviewer_id, coding_id, review_id) do
    case Map.get(snapshot.squads, @squad_key) do
      nil ->
        Repository.create_squad(squad_attributes(builder_id, reviewer_id, coding_id, review_id))

      row ->
        Repository.get_squad(row.id)
    end
  end

  defp ensure_tactic(snapshot) do
    case Map.get(snapshot.tactics, @tactic_key) do
      nil -> TacticLibrary.create(tactic_attributes())
      row -> TacticLibrary.get(row.id)
    end
  end

  defp result(snapshot) do
    {:ok, builder} = Repository.get_class(Map.fetch!(snapshot.classes, "builder").id)
    {:ok, reviewer} = Repository.get_class(Map.fetch!(snapshot.classes, "reviewer").id)
    {:ok, coding} = Repository.get_loadout(Map.fetch!(snapshot.loadouts, "coding").id)
    {:ok, review} = Repository.get_loadout(Map.fetch!(snapshot.loadouts, "review").id)
    {:ok, squad} = Repository.get_squad(Map.fetch!(snapshot.squads, @squad_key).id)
    {:ok, tactic} = TacticLibrary.get(Map.fetch!(snapshot.tactics, @tactic_key).id)

    %{
      status: :ready,
      classes: [builder, reviewer],
      loadouts: [coding, review],
      squad: squad,
      tactic: tactic
    }
  end

  defp snapshot(lock?) do
    %{
      classes: rows(ProductClass, @class_keys, lock?),
      loadouts: rows(ProductLoadout, @loadout_keys, lock?),
      squads: rows(ProductSquad, [@squad_key], lock?),
      tactics: rows(ProductTactic, [@tactic_key], lock?),
      members: squad_members(lock?),
      unrelated_active?: unrelated_active?()
    }
  end

  defp rows(schema, keys, lock?) do
    query = from row in schema, where: row.key in ^keys
    query = if lock?, do: from(row in query, lock: "FOR UPDATE"), else: query
    query |> Repo.all() |> Map.new(&{&1.key, &1})
  end

  defp squad_members(lock?) do
    query =
      from member in ProductSquadMember,
        join: squad in ProductSquad,
        on: squad.id == member.squad_id,
        where: squad.key == @squad_key,
        order_by: [asc: member.position]

    query = if lock?, do: from(member in query, lock: "FOR UPDATE"), else: query
    Repo.all(query)
  end

  defp unrelated_active? do
    Enum.any?(
      [
        {ProductClass, @class_keys},
        {ProductLoadout, @loadout_keys},
        {ProductSquad, [@squad_key]},
        {ProductTactic, [@tactic_key]}
      ],
      fn {schema, keys} ->
        Repo.exists?(from row in schema, where: is_nil(row.archived_at) and row.key not in ^keys)
      end
    )
  end

  defp classify(snapshot, mode) do
    assessments = [
      assess_row(
        :class,
        "builder",
        snapshot.classes,
        &class_matches?(&1, class_attributes("builder"))
      ),
      assess_row(
        :class,
        "reviewer",
        snapshot.classes,
        &class_matches?(&1, class_attributes("reviewer"))
      ),
      assess_loadout("coding", snapshot, mode),
      assess_loadout("review", snapshot, mode),
      assess_squad(snapshot),
      assess_tactic(snapshot)
    ]

    conflict =
      Enum.find_value(assessments, fn {_identity, state} ->
        if match?({:conflict, _}, state), do: elem(state, 1)
      end)

    exact_count = Enum.count(assessments, fn {_identity, state} -> state == :exact_match end)
    missing_count = Enum.count(assessments, fn {_identity, state} -> state == :missing end)

    state =
      cond do
        conflict -> :conflict
        missing_count == 0 -> :complete
        snapshot.unrelated_active? -> :manual_configuration
        exact_count > 0 -> :recoverable_partial
        true -> :empty
      end

    %{state: state, conflict: conflict, assessments: Map.new(assessments)}
  end

  defp assess_row(type, key, rows, matches?) do
    identity = {type, key}

    case Map.get(rows, key) do
      nil ->
        {identity, :missing}

      %{archived_at: archived_at} when not is_nil(archived_at) ->
        {identity, {:conflict, identity}}

      row ->
        {identity, if(matches?.(row), do: :exact_match, else: {:conflict, identity})}
    end
  end

  defp assess_loadout(key, snapshot, {:configuration, configuration}) do
    assess_row(
      :loadout,
      key,
      snapshot.loadouts,
      &loadout_matches?(&1, loadout_attributes(key, configuration))
    )
  end

  defp assess_loadout(key, snapshot, :intrinsic) do
    assess_row(:loadout, key, snapshot.loadouts, fn row ->
      intrinsic_loadout_matches?(key, row, snapshot)
    end)
  end

  defp assess_squad(snapshot) do
    assess_row(:squad, @squad_key, snapshot.squads, fn row ->
      with builder when not is_nil(builder) <- Map.get(snapshot.classes, "builder"),
           reviewer when not is_nil(reviewer) <- Map.get(snapshot.classes, "reviewer"),
           coding when not is_nil(coding) <- Map.get(snapshot.loadouts, "coding"),
           review when not is_nil(review) <- Map.get(snapshot.loadouts, "review") do
        squad_matches?(row, snapshot.members, builder.id, reviewer.id, coding.id, review.id)
      else
        _ -> false
      end
    end)
  end

  defp assess_tactic(snapshot) do
    assess_row(:tactic, @tactic_key, snapshot.tactics, fn row ->
      body_matches =
        case TacticCodec.decode(row.body) do
          {:ok, body} -> body == canonical_tactic()
          {:error, _error} -> false
        end

      row.name == "Implement & Review" &&
        row.description == "A small sequential implementation and independent review tactic." &&
        body_matches
    end)
  end

  defp intrinsic_loadout_matches?(key, row, snapshot) do
    if static_loadout_matches?(key, row) do
      intrinsic_pair_matches?(key, row, snapshot)
    else
      false
    end
  end

  defp static_loadout_matches?(key, row) do
    identity_matches =
      row.name == loadout_name(key) && row.description == loadout_description(key) &&
        row.workspace_access == loadout_access(key)

    execution_matches =
      row.reasoning in ~w(low medium high) && is_binary(row.model_provider) &&
        is_binary(row.model_name)

    tools_match = Enum.all?(row.tools, &(&1 in loadout_tool_allowlist(key)))
    identity_matches && execution_matches && tools_match
  end

  defp intrinsic_pair_matches?(key, row, snapshot) do
    other_key = if key == "coding", do: "review", else: "coding"

    case Map.get(snapshot.loadouts, other_key) do
      nil -> advertised_loadout?(key, row)
      %{archived_at: archived_at} when not is_nil(archived_at) -> false
      other -> loadout_pair_matches?(key, row, other)
    end
  end

  defp advertised_loadout?(key, row) do
    ExecutionOptions.list()
    |> Enum.filter(
      &(Enum.any?(&1.reasoning, fn value -> value in ~w(low medium high) end) &&
          &1.workspaces != [])
    )
    |> Enum.map(&configuration/1)
    |> Enum.any?(&loadout_matches?(row, loadout_attributes(key, &1)))
  end

  defp loadout_pair_matches?("coding", coding, review),
    do:
      same_execution_configuration?(coding, review) &&
        review.tools == Enum.filter(coding.tools, &(&1 in @review_tools))

  defp loadout_pair_matches?("review", review, coding),
    do: loadout_pair_matches?("coding", coding, review)

  defp same_execution_configuration?(left, right),
    do:
      left.model_provider == right.model_provider && left.model_name == right.model_name &&
        left.reasoning == right.reasoning

  defp class_matches?(row, attributes),
    do:
      row.name == attributes.name && row.description == attributes.description &&
        row.instructions == attributes.instructions

  defp loadout_matches?(row, attributes),
    do:
      row.name == attributes.name && row.description == attributes.description &&
        row.model_provider == attributes.model.provider &&
        row.model_name == attributes.model.model &&
        row.reasoning == Atom.to_string(attributes.reasoning) && row.tools == attributes.tools &&
        row.workspace_access == Atom.to_string(attributes.workspace_access)

  defp squad_matches?(row, members, builder_id, reviewer_id, coding_id, review_id),
    do:
      row.name == "Engineering Pair" && row.description == "A builder and independent reviewer." &&
        Enum.map(members, &Map.take(&1, [:member_key, :name, :class_id, :loadout_id, :position])) ==
          [
            %{
              member_key: "builder",
              name: "Builder",
              class_id: builder_id,
              loadout_id: coding_id,
              position: 0
            },
            %{
              member_key: "reviewer",
              name: "Reviewer",
              class_id: reviewer_id,
              loadout_id: review_id,
              position: 1
            }
          ]

  defp class_attributes("builder"),
    do: %{
      key: "builder",
      name: "Builder",
      description: "Builds the requested change.",
      instructions: "Implement the requested change carefully and report the declared result."
    }

  defp class_attributes("reviewer"),
    do: %{
      key: "reviewer",
      name: "Reviewer",
      description: "Independently reviews completed work.",
      instructions: "Review the supplied work independently and report the declared result."
    }

  defp loadout_attributes(key, configuration),
    do: %{
      key: key,
      name: loadout_name(key),
      description: loadout_description(key),
      model: configuration.model,
      reasoning: configuration.reasoning,
      tools: configuration_tools(configuration, key),
      workspace_access: if(key == "coding", do: :read_write, else: :read_only)
    }

  defp configuration_tools(configuration, "coding"), do: configuration.coding_tools
  defp configuration_tools(configuration, "review"), do: configuration.review_tools
  defp loadout_name("coding"), do: "Coding"
  defp loadout_name("review"), do: "Review"
  defp loadout_description("coding"), do: "Writable engineering capabilities."
  defp loadout_description("review"), do: "Read-only review capabilities."
  defp loadout_access("coding"), do: "read_write"
  defp loadout_access("review"), do: "read_only"
  defp loadout_tool_allowlist("coding"), do: @coding_tools
  defp loadout_tool_allowlist("review"), do: @review_tools

  defp squad_attributes(builder_id, reviewer_id, coding_id, review_id),
    do: %{
      key: @squad_key,
      name: "Engineering Pair",
      description: "A builder and independent reviewer.",
      members: [
        %{key: "builder", name: "Builder", class_id: builder_id, loadout_id: coding_id},
        %{key: "reviewer", name: "Reviewer", class_id: reviewer_id, loadout_id: review_id}
      ]
    }

  defp tactic_attributes,
    do: %{
      key: @tactic_key,
      name: "Implement & Review",
      description: "A small sequential implementation and independent review tactic.",
      body: canonical_tactic()
    }

  defp canonical_tactic do
    sequence([
      step("implement",
        name: "Implement",
        instruction: "Implement the Quest objective.",
        performer: class("builder"),
        context: fresh(),
        consumes: [],
        produces: [artifact("change_set")]
      ),
      step("review",
        name: "Review",
        instruction: "Review the implementation against the Quest objective.",
        performer: class("reviewer"),
        context: fresh(),
        consumes: [artifact("change_set", from: "implement")],
        produces: [artifact("verdict")]
      )
    ])
  end

  defp onboarding_classification(classification, snapshot) do
    if classification.state == :conflict && established_configuration?(snapshot) do
      %{classification | state: :manual_configuration, conflict: nil}
    else
      classification
    end
  end

  defp established_configuration?(snapshot) do
    snapshot.unrelated_active? ||
      (Enum.all?(@class_keys, &Map.has_key?(snapshot.classes, &1)) &&
         Enum.all?(@loadout_keys, &Map.has_key?(snapshot.loadouts, &1)) &&
         Map.has_key?(snapshot.squads, @squad_key) &&
         Map.has_key?(snapshot.tactics, @tactic_key))
  end

  defp status_view(%{state: :conflict, conflict: {type, key}}),
    do: %{state: :conflict, conflict: %{entity_type: type, key: key}}

  defp status_view(%{state: state}), do: %{state: state, conflict: nil}
  defp conflict_error({type, key}), do: %Error{code: :conflict, entity_type: type, key: key}
end
