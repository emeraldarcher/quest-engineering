defmodule QuestEngineering.Server.HarnessSetupStore do
  @moduledoc "Durable Run-bound harness setup authority and contextual readiness."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Core.Tactics.PerformerRequirement
  alias QuestEngineering.Server.CapabilityMatcher
  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.Persistence.HarnessSetupAuthorization
  alias QuestEngineering.Server.Persistence.HarnessSetupContext
  alias QuestEngineering.Server.Persistence.LaunchSnapshotCodec
  alias QuestEngineering.Server.Persistence.OccurrenceContextBinding
  alias QuestEngineering.Server.Persistence.OccurrenceMemberBinding
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.ScheduledActionExecution
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  @active_states ~w(authorized preparing invocation_requested invocation_acknowledged human_interaction_required ready uncertain cancellation_requested)
  @redeliver_states ~w(authorized preparing invocation_requested invocation_acknowledged human_interaction_required ready cancellation_requested)

  def authorize(run_id, occurrence_id, request_id)
      when is_binary(run_id) and is_binary(occurrence_id) and is_binary(request_id) and
             request_id != "" do
    case Repo.transaction(fn -> authorize_locked(run_id, occurrence_id, request_id) end) do
      {:ok, {context, authorization, idempotent?}} ->
        RunChangeNotifier.notify(run_id)
        {:ok, %{context: context, authorization: authorization, idempotent?: idempotent?}}

      {:error, error} ->
        {:error, error}
    end
  end

  def authorize(_run_id, _occurrence_id, _request_id),
    do: {:error, error(:invalid_harness_setup, %{fields: ~w(run_id occurrence_id request_id)})}

  def deliver(%HarnessSetupContext{} = context) do
    with %Worker{} = worker <- Repo.get(Worker, context.worker_id),
         true <-
           worker.status == "connected" and
             worker.ready_generation == worker.connection_generation,
         true <- worker.connection_generation == context.worker_generation do
      message = setup_command(context, worker)

      if message,
        do:
          WorkerConnections.send_protocol(
            worker.id,
            worker.connection_generation,
            message
          ),
        else: {:error, error(:setup_authorization_missing, %{setup_id: context.id})}
    else
      nil -> {:error, error(:setup_worker_unavailable, %{setup_id: context.id})}
      false -> {:error, error(:setup_worker_unavailable, %{setup_id: context.id})}
    end
  end

  def redeliver(worker_id, generation) do
    contexts =
      Repo.all(
        from context in HarnessSetupContext,
          where: context.worker_id == ^worker_id and context.state in ^@redeliver_states,
          order_by: [asc: context.inserted_at]
      )
      |> Enum.map(fn context ->
        changes =
          cond do
            context.state == "cancellation_requested" ->
              [worker_generation: generation]

            context.state == "ready" ->
              [worker_generation: generation, state: "preparing"]

            context.worker_generation != generation ->
              [worker_generation: generation, state: "preparing"]

            true ->
              []
          end

        if changes == [] do
          context
        else
          context
          |> Changeset.change(changes)
          |> Repo.update!()
        end
      end)

    Enum.each(contexts, &deliver/1)
    :ok
  end

  def record(worker_id, generation, setup) do
    result =
      Repo.transaction(fn ->
        context =
          Repo.one(
            from context in HarnessSetupContext,
              where: context.id == ^setup.setup_id,
              lock: "FOR UPDATE"
          ) || Repo.rollback(error(:harness_setup_not_found, %{setup_id: setup.setup_id}))

        validate_report!(context, worker_id, generation, setup)
        validate_state_transition!(context, setup)
        validate_invocation_transition!(context, setup)
        now = now()
        attributes = state_attributes(context, setup, now)

        context
        |> HarnessSetupContext.changeset(attributes)
        |> Repo.update!()
      end)

    case result do
      {:ok, context} ->
        if context.state == "ready" do
          Scheduler.wake(context.run_id)
          _ = Dispatcher.redeliver(context.worker_id, context.worker_generation)
        end

        RunChangeNotifier.notify(context.run_id)
        {:ok, context}

      {:error, error} ->
        {:error, error}
    end
  end

  def cancel(run_id, occurrence_id, setup_id, request_id)
      when is_binary(run_id) and is_binary(occurrence_id) and is_binary(setup_id) and
             is_binary(request_id) and request_id != "" do
    case Repo.transaction(fn ->
           context =
             Repo.one(
               from context in HarnessSetupContext,
                 where:
                   context.id == ^setup_id and context.run_id == ^run_id and
                     context.occurrence_id == ^occurrence_id,
                 lock: "FOR UPDATE"
             ) || Repo.rollback(error(:harness_setup_not_found, %{setup_id: setup_id}))

           cond do
             context.state in ["cancellation_requested", "cancelled"] and
                 context.cancellation_request_id == request_id ->
               {context, request_id, false}

             context.state in ["cancellation_requested", "cancelled"] ->
               Repo.rollback(error(:setup_cancellation_conflict, %{setup_id: context.id}))

             context.state in ["ready", "failed", "cancelled", "invalidated"] ->
               Repo.rollback(error(:harness_setup_not_cancellable, %{state: context.state}))

             true ->
               cancelled =
                 context
                 |> HarnessSetupContext.changeset(%{
                   state: "cancellation_requested",
                   attention: nil,
                   cancellation_request_id: request_id,
                   failure: %{
                     "code" => "setup_cancelled",
                     "message" => "Harness setup was cancelled by the operator."
                   }
                 })
                 |> Repo.update!()

               {cancelled, request_id, true}
           end
         end) do
      {:ok, {context, _request_id, false}} ->
        {:ok, context}

      {:ok, {context, request_id, true}} ->
        case {Repo.get(Worker, context.worker_id), Process.whereis(WorkerConnections)} do
          {%Worker{} = worker, pid} when is_pid(pid) ->
            WorkerConnections.send_protocol(
              worker.id,
              worker.connection_generation,
              WorkerProtocol.cancel_harness_setup(
                worker.id,
                worker.connection_generation,
                context,
                request_id
              )
            )

          _ ->
            :pending
        end

        QuestEngineering.Server.HarnessSetupInteractions.clear(context.id)
        RunChangeNotifier.notify(run_id)
        {:ok, context}

      {:error, error} ->
        {:error, error}
    end
  end

  def cancel(_run_id, _occurrence_id, setup_id, _request_id),
    do: {:error, error(:invalid_harness_setup_cancellation, %{setup_id: setup_id})}

  def respond(run_id, occurrence_id, setup_id, generation, attention_id, request_id, value)
      when is_binary(run_id) and is_binary(occurrence_id) and is_binary(setup_id) and
             is_integer(generation) and generation > 0 and is_binary(attention_id) and
             attention_id != "" and is_binary(request_id) and request_id != "" and
             is_binary(value) and byte_size(value) <= 8_192 do
    context = Repo.get(HarnessSetupContext, setup_id)

    valid =
      context && context.run_id == run_id && context.occurrence_id == occurrence_id &&
        context.setup_generation == generation && context.state == "human_interaction_required" &&
        get_in(context.attention || %{}, ["attention_id"]) == attention_id

    if valid do
      worker = Repo.get!(Worker, context.worker_id)

      case WorkerConnections.send_protocol(
             worker.id,
             worker.connection_generation,
             WorkerProtocol.respond_harness_setup(
               worker.id,
               worker.connection_generation,
               context,
               attention_id,
               request_id,
               value
             )
           ) do
        :ok -> {:ok, context}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, error(:stale_harness_setup_response, %{setup_id: setup_id})}
    end
  end

  def respond(_run_id, _occurrence_id, setup_id, _generation, _attention_id, _request_id, _value),
    do: {:error, error(:invalid_harness_setup_response, %{setup_id: setup_id})}

  def fetch(setup_id), do: Repo.get(HarnessSetupContext, setup_id)

  def retryable?(%HarnessSetupContext{} = context),
    do:
      context.state in ["failed", "cancelled"] and
        context.invocation_state == "not_requested"

  def retryable?(_context), do: false

  def fetch_for_action(action_id) do
    Repo.one(
      from context in HarnessSetupContext,
        where: context.action_id == ^action_id,
        order_by: [desc: context.setup_generation],
        limit: 1
    )
  end

  def binding_for_execution(action_id, execution) do
    context =
      fetch_for_action(action_id) ||
        context_for_execution_continuation(execution)

    case context do
      %HarnessSetupContext{state: "ready"} -> execution_binding(context)
      _ -> nil
    end
  end

  def list_for_run(run_id) do
    Repo.all(
      from context in HarnessSetupContext,
        where: context.run_id == ^run_id,
        order_by: [asc: context.inserted_at]
    )
  end

  def available_for_action?(%Action{} = action, member) when not is_nil(member) do
    assignment = Repo.get_by(RunWorkspaceAssignment, run_id: action.run_id)

    worker =
      if assignment && is_binary(assignment.worker_id),
        do: Repo.get(Worker, assignment.worker_id),
        else: nil

    requested = %{
      harness_kind: member.loadout.harness,
      model: member.loadout.model,
      reasoning: member.loadout.reasoning,
      tool_policy: member.loadout.tool_policy,
      workspace_access: member.loadout.workspace_access
    }

    assignment && assignment.state == "ready" && worker && worker.status == "connected" &&
      match?({:ok, _}, CapabilityMatcher.resolve_setup(worker.capabilities, requested))
  end

  def available_for_action?(_action, _member), do: false

  def ready_resolution(action, requested, assignment, worker, scheduled_context) do
    context = fetch_for_action(action.id) || continuation_context(action)

    case context do
      %HarnessSetupContext{} ->
        with :ok <-
               validate_ready_context(
                 context,
                 action,
                 assignment,
                 worker,
                 scheduled_context
               ),
             {:ok, resolution} <- CapabilityMatcher.resolve_setup(worker.capabilities, requested),
             true <- context.resolved_configuration == encode_resolution(requested, resolution) do
          {:ok, resolution, execution_binding(context)}
        else
          _ -> :error
        end

      nil ->
        :error
    end
  end

  def projection(nil), do: nil

  def projection(%HarnessSetupContext{} = context) do
    %{
      id: context.id,
      generation: context.setup_generation,
      harness_kind: context.harness_kind,
      state: context.state,
      invocation_state: context.invocation_state,
      setup_required: context.state != "ready",
      authenticated: context.state == "ready",
      attention: context.attention,
      failure: context.failure,
      physical_lineage_id: context.physical_lineage_id,
      environment:
        if(context.environment_id,
          do: %{
            environment_id: context.environment_id,
            incarnation: context.environment_incarnation,
            profile: %{id: context.profile_id, digest: context.profile_digest}
          },
          else: nil
        ),
      authorized_at:
        Repo.one(
          from authorization in HarnessSetupAuthorization,
            where:
              authorization.setup_context_id == ^context.id and
                authorization.setup_generation == ^context.setup_generation,
            select: authorization.authorized_at
        )
        |> iso()
    }
  end

  def invalidate_run(run_id, reason) do
    now = now()

    ids =
      Repo.all(
        from context in HarnessSetupContext,
          where: context.run_id == ^run_id and context.state in ^@active_states,
          select: context.id
      )

    {count, _} =
      from(context in HarnessSetupContext,
        where: context.run_id == ^run_id and context.state in ^@active_states
      )
      |> Repo.update_all(
        set: [
          state: "invalidated",
          attention: nil,
          failure: %{"code" => reason, "message" => "Harness setup context was invalidated."},
          updated_at: now
        ]
      )

    Enum.each(ids, &QuestEngineering.Server.HarnessSetupInteractions.clear/1)
    count
  end

  defp setup_command(%HarnessSetupContext{state: "cancellation_requested"} = context, worker)
       when is_binary(context.cancellation_request_id) do
    WorkerProtocol.cancel_harness_setup(
      worker.id,
      worker.connection_generation,
      context,
      context.cancellation_request_id
    )
  end

  defp setup_command(context, worker) do
    case Repo.get_by(HarnessSetupAuthorization,
           setup_context_id: context.id,
           setup_generation: context.setup_generation
         ) do
      %HarnessSetupAuthorization{} = authorization ->
        WorkerProtocol.prepare_harness_setup(worker, context, authorization)

      nil ->
        nil
    end
  end

  defp authorize_locked(run_id, occurrence_id, request_id) do
    existing_authorization = Repo.get_by(HarnessSetupAuthorization, request_id: request_id)

    if existing_authorization do
      context = Repo.get!(HarnessSetupContext, existing_authorization.setup_context_id)

      if context.run_id == run_id and context.occurrence_id == occurrence_id,
        do: {context, existing_authorization, true},
        else: Repo.rollback(error(:setup_request_conflict, %{request_id: request_id}))
    else
      Repo.one(from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE") ||
        Repo.rollback(error(:run_not_found, %{run_id: run_id}))

      assignment =
        Repo.one(
          from assignment in RunWorkspaceAssignment,
            where: assignment.run_id == ^run_id,
            lock: "FOR UPDATE"
        ) || Repo.rollback(error(:run_workspace_missing, %{run_id: run_id}))

      if assignment.state != "ready" or is_nil(assignment.canonical_worktree_root),
        do: Repo.rollback(error(:run_workspace_not_ready, %{state: assignment.state}))

      action = pending_action!(run_id, occurrence_id)
      existing = fetch_for_action(action.id)

      cond do
        existing && existing.state == "uncertain" ->
          Repo.rollback(error(:setup_outcome_uncertain, %{setup_id: existing.id}))

        existing && existing.state in ["failed", "cancelled"] && not retryable?(existing) ->
          Repo.rollback(error(:setup_invocation_already_used, %{setup_id: existing.id}))

        existing && existing.state in @active_states ->
          Repo.rollback(error(:setup_already_authorized, %{setup_id: existing.id}))

        true ->
          :ok
      end

      worker =
        Repo.one(
          from worker in Worker, where: worker.id == ^assignment.worker_id, lock: "FOR UPDATE"
        ) ||
          Repo.rollback(error(:setup_worker_unavailable, %{run_id: run_id}))

      if worker.status != "connected" or worker.ready_generation != worker.connection_generation,
        do: Repo.rollback(error(:setup_worker_unavailable, %{worker_id: worker.id}))

      {member, requested, resolution} = setup_selection!(run_id, action, worker)
      {member_binding, context_binding} = bind_pre_dispatch!(action, member)
      environment = resolution.execution_environment
      profile = environment && environment["profile"]

      if is_nil(profile),
        do: Repo.rollback(error(:setup_profile_missing, %{worker_id: worker.id}))

      context =
        HarnessSetupContext.changeset(%{
          id: Ecto.UUID.generate(),
          run_id: run_id,
          action_id: action.id,
          occurrence_id: occurrence_id,
          member_key: member_binding.member_key,
          harness_kind: requested.harness_kind,
          worker_id: worker.id,
          worker_generation: worker.connection_generation,
          workspace_id: assignment.workspace_id,
          worktree_id: assignment.worktree_id,
          workspace_binding_id: assignment.workspace_binding_id,
          canonical_root: assignment.canonical_worktree_root,
          workspace_access: Atom.to_string(requested.workspace_access),
          logical_lineage_id: context_binding.logical_lineage_id,
          physical_lineage_id: (existing && existing.physical_lineage_id) || Ecto.UUID.generate(),
          profile_id: profile["id"],
          profile_digest: profile["digest"],
          setup_generation: (existing && existing.setup_generation + 1) || 1,
          state: "authorized",
          invocation_state: "not_requested",
          resolved_configuration: encode_resolution(requested, resolution)
        })
        |> Repo.insert!()

      authorization =
        HarnessSetupAuthorization.changeset(%{
          id: Ecto.UUID.generate(),
          setup_context_id: context.id,
          setup_generation: context.setup_generation,
          request_id: request_id,
          kind: "human_harness_setup",
          authorized_at: now()
        })
        |> Repo.insert!()

      {context, authorization, false}
    end
  end

  defp pending_action!(run_id, occurrence_id) do
    Repo.all(
      from outbox in RuntimeOutbox,
        where: outbox.run_id == ^run_id,
        order_by: [asc: outbox.inserted_at, asc: outbox.action_id],
        lock: "FOR UPDATE"
    )
    |> Enum.find_value(fn outbox ->
      case {Repo.get(ScheduledActionExecution, outbox.action_id),
            RuntimeCodec.decode(outbox.payload)} do
        {nil, {:ok, %Action{occurrence_id: ^occurrence_id} = action}} -> action
        _ -> nil
      end
    end) ||
      Repo.rollback(
        error(:pending_action_not_found, %{run_id: run_id, occurrence_id: occurrence_id})
      )
  end

  defp setup_selection!(run_id, action, worker) do
    launch = Repo.get_by!(QuestLaunch, run_id: run_id)

    snapshot =
      case LaunchSnapshotCodec.decode(launch.snapshot, launch.snapshot_version) do
        {:ok, %LaunchSnapshot{} = value} ->
          value

        {:error, reason} ->
          Repo.rollback(error(:invalid_launch_snapshot, %{reason: inspect(reason)}))
      end

    class_key =
      case action.performer_requirement do
        %PerformerRequirement{selector: :class, value: key} -> key
        _ -> Repo.rollback(error(:unsupported_setup_performer, %{action_id: action.id}))
      end

    member =
      case Repo.get_by(OccurrenceMemberBinding,
             run_id: action.run_id,
             occurrence_id: action.occurrence_id
           ) do
        nil -> Enum.find(snapshot.squad.members, &(&1.class.key == class_key))
        binding -> Enum.find(snapshot.squad.members, &(&1.key == binding.member_key))
      end || Repo.rollback(error(:setup_member_unavailable, %{class_key: class_key}))

    requested = %{
      harness_kind: member.loadout.harness,
      model: member.loadout.model,
      reasoning: member.loadout.reasoning,
      tool_policy: member.loadout.tool_policy,
      workspace_access: member.loadout.workspace_access
    }

    case CapabilityMatcher.resolve_setup(worker.capabilities, requested) do
      {:ok, resolution} ->
        {member, requested, resolution}

      :error ->
        Repo.rollback(error(:harness_setup_unavailable, %{harness: requested.harness_kind}))
    end
  end

  defp bind_pre_dispatch!(action, member) do
    now = now()

    member_binding =
      Repo.get_by(OccurrenceMemberBinding,
        run_id: action.run_id,
        occurrence_id: action.occurrence_id
      ) ||
        Repo.insert!(
          OccurrenceMemberBinding.changeset(%{
            run_id: action.run_id,
            occurrence_id: action.occurrence_id,
            member_key: member.key,
            bound_at: now
          })
        )

    context_binding =
      Repo.get_by(OccurrenceContextBinding,
        run_id: action.run_id,
        occurrence_id: action.occurrence_id
      ) ||
        Repo.insert!(
          OccurrenceContextBinding.changeset(%{
            run_id: action.run_id,
            occurrence_id: action.occurrence_id,
            logical_lineage_id: Ecto.UUID.generate(),
            source_occurrence_id: action.context_lineage_occurrence_id,
            bound_at: now
          })
        )

    {member_binding, context_binding}
  end

  defp validate_report!(context, worker_id, generation, setup) do
    mismatch =
      context.worker_id != worker_id or context.worker_generation != generation or
        context.setup_generation != setup.setup_generation or
        context.action_id != setup.action_id or context.run_id != setup.run_id or
        context.occurrence_id != setup.occurrence_id or
        context.physical_lineage_id != setup.physical_lineage_id

    if mismatch, do: Repo.rollback(error(:stale_harness_setup_report, %{setup_id: context.id}))
    :ok
  end

  defp validate_state_transition!(context, setup) do
    terminal = ~w(ready failed uncertain cancelled invalidated)
    incoming = Atom.to_string(setup.state)

    if context.state in terminal and incoming != context.state,
      do:
        Repo.rollback(
          error(:stale_harness_setup_report, %{setup_id: context.id, state: context.state})
        )

    if context.state in terminal and incoming == context.state and
         Atom.to_string(setup.invocation_state) != context.invocation_state,
       do:
         Repo.rollback(
           error(:stale_harness_setup_report, %{setup_id: context.id, state: context.state})
         )

    rank = %{
      "authorized" => 0,
      "preparing" => 1,
      "invocation_requested" => 2,
      "invocation_acknowledged" => 3,
      "human_interaction_required" => 4,
      "cancellation_requested" => 4,
      "ready" => 5,
      "failed" => 5,
      "uncertain" => 5,
      "cancelled" => 5,
      "invalidated" => 5
    }

    if Map.fetch!(rank, incoming) < Map.fetch!(rank, context.state),
      do: Repo.rollback(error(:stale_harness_setup_report, %{setup_id: context.id}))

    if context.state == "cancellation_requested" and
         incoming not in ["cancellation_requested", "cancelled", "uncertain"],
       do:
         Repo.rollback(
           error(:stale_harness_setup_report, %{setup_id: context.id, state: context.state})
         )

    if setup.state == :ready do
      inspection = setup.inspection || %{}
      environment = inspection["environment"] || %{}

      stable =
        context.state != "ready" or
          (context.environment_id == environment["environment_id"] and
             context.environment_incarnation == environment["incarnation"] and
             context.config_identity == inspection["config_identity"])

      valid =
        stable and
          setup.invocation_state == :settled and inspection["state"] == "ready" and
          inspection["authenticated"] == true and is_binary(inspection["config_identity"]) and
          is_binary(environment["environment_id"]) and
          is_binary(environment["incarnation"]) and
          environment["profile"] == %{
            "id" => context.profile_id,
            "digest" => context.profile_digest
          }

      if not valid,
        do: Repo.rollback(error(:invalid_harness_setup_readiness, %{setup_id: context.id}))
    end
  end

  defp validate_invocation_transition!(context, setup) do
    incoming = Atom.to_string(setup.invocation_state)

    valid =
      case context.invocation_state do
        "acknowledged" -> incoming in ~w(acknowledged settled uncertain)
        "settled" -> incoming == "settled"
        "uncertain" -> incoming == "uncertain"
        _ -> true
      end

    if not valid,
      do:
        Repo.rollback(
          error(:stale_harness_setup_report, %{
            setup_id: context.id,
            invocation_state: context.invocation_state
          })
        )
  end

  defp state_attributes(context, setup, now) do
    inspection = setup.inspection || %{}
    environment = inspection["environment"] || %{}
    profile = environment["profile"] || %{}

    if profile != %{} and
         (profile["id"] != context.profile_id or profile["digest"] != context.profile_digest),
       do: Repo.rollback(error(:setup_profile_mismatch, %{setup_id: context.id}))

    %{
      state: Atom.to_string(setup.state),
      invocation_state: Atom.to_string(setup.invocation_state),
      environment_id: environment["environment_id"] || context.environment_id,
      environment_incarnation: environment["incarnation"] || context.environment_incarnation,
      config_identity: inspection["config_identity"] || context.config_identity,
      attention: setup.attention,
      failure: setup.failure || context.failure,
      invocation_requested_at:
        if(setup.invocation_state in [:requested, :acknowledged, :settled],
          do: context.invocation_requested_at || now,
          else: context.invocation_requested_at
        ),
      invocation_acknowledged_at:
        if(setup.invocation_state in [:acknowledged, :settled],
          do: context.invocation_acknowledged_at || now,
          else: context.invocation_acknowledged_at
        ),
      ready_at: if(setup.state == :ready, do: context.ready_at || now, else: context.ready_at),
      cancelled_at:
        if(setup.state == :cancelled, do: context.cancelled_at || now, else: context.cancelled_at)
    }
  end

  defp context_for_execution_continuation(%{
         identity: %{run_id: run_id},
         context: %{
           mode: :continue_from,
           source_occurrence_id: source_occurrence_id,
           logical_lineage_id: logical_lineage_id
         }
       }) do
    Repo.one(
      from context in HarnessSetupContext,
        where:
          context.run_id == ^run_id and context.occurrence_id == ^source_occurrence_id and
            context.logical_lineage_id == ^logical_lineage_id and context.state == "ready",
        order_by: [desc: context.setup_generation],
        limit: 1
    )
  end

  defp context_for_execution_continuation(_execution), do: nil

  defp continuation_context(%Action{context_lineage_occurrence_id: nil}), do: nil

  defp continuation_context(%Action{} = action) do
    Repo.one(
      from context in HarnessSetupContext,
        where:
          context.run_id == ^action.run_id and
            context.occurrence_id == ^action.context_lineage_occurrence_id and
            context.state == "ready",
        order_by: [desc: context.setup_generation],
        limit: 1
    )
  end

  defp validate_ready_context(context, action, assignment, worker, scheduled_context) do
    action_identity_matches =
      (context.action_id == action.id and context.occurrence_id == action.occurrence_id) or
        compatible_continuation?(context, action, scheduled_context)

    valid =
      context.state == "ready" and context.invocation_state == "settled" and
        context.run_id == action.run_id and action_identity_matches and
        context.worker_id == worker.id and
        context.worker_generation == worker.connection_generation and
        assignment.worker_id == worker.id and context.workspace_id == assignment.workspace_id and
        context.worktree_id == assignment.worktree_id and
        context.workspace_binding_id == assignment.workspace_binding_id and
        context.canonical_root == assignment.canonical_worktree_root and
        is_binary(context.environment_id) and is_binary(context.environment_incarnation) and
        is_binary(context.config_identity)

    if valid, do: :ok, else: :error
  end

  defp compatible_continuation?(context, %Action{} = action, scheduled_context) do
    action.context_lineage_occurrence_id == context.occurrence_id and
      scheduled_context.source_occurrence_id == context.occurrence_id and
      scheduled_context.logical_lineage_id == context.logical_lineage_id
  end

  defp execution_binding(context) do
    %{
      setup_id: context.id,
      setup_generation: context.setup_generation,
      physical_lineage_id: context.physical_lineage_id,
      environment: %{
        environment_id: context.environment_id,
        incarnation: context.environment_incarnation,
        profile: %{id: context.profile_id, digest: context.profile_digest}
      },
      config_identity: context.config_identity
    }
  end

  defp encode_resolution(requested, resolution) do
    %{
      "model" => %{
        "provider" => requested.model.provider,
        "model" => requested.model.model
      },
      "reasoning" => requested.reasoning,
      "reasoning_capability" => encode_struct(resolution.reasoning_capability),
      "tool_policy" => encode_struct(requested.tool_policy),
      "tool_enforcement" => Atom.to_string(resolution.tool_enforcement),
      "resolved_tool_profile" => encode_struct(resolution.resolved_tool_profile)
    }
  end

  defp encode_struct(struct) when is_struct(struct) do
    struct |> Map.from_struct() |> stringify()
  end

  defp encode_struct(map) when is_map(map), do: stringify(map)
  defp stringify(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify(value) when is_list(value), do: Enum.map(value, &stringify/1)

  defp stringify(value) when is_map(value),
    do: Map.new(value, fn {key, nested} -> {to_string(key), stringify(nested)} end)

  defp stringify(value), do: value
  defp error(code, details), do: %Error{code: code, details: details}
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
  defp iso(nil), do: nil
  defp iso(value), do: DateTime.to_iso8601(value)
end
