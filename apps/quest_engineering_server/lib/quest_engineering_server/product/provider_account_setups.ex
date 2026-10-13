# credo:disable-for-this-file Credo.Check.Refactor.Nesting

defmodule QuestEngineering.Server.Product.ProviderAccountSetups do
  @moduledoc "Durable ProviderAccount-scoped setup authority, certainty, and reconciliation."

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.Product.ProviderAccount, as: DomainAccount
  alias QuestEngineering.Server.Persistence.ProviderAccount
  alias QuestEngineering.Server.Persistence.ProviderAccountEnvironment
  alias QuestEngineering.Server.Persistence.ProviderAccountHumanAttentionRequest, as: Attention
  alias QuestEngineering.Server.Persistence.ProviderAccountSetupAttempt, as: Attempt
  alias QuestEngineering.Server.Persistence.ProviderAccountSetupAuthorization, as: Authorization
  alias QuestEngineering.Server.Persistence.ProviderAccountSetupEvent, as: Event
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.Product.ProviderAccounts
  alias QuestEngineering.Server.ProviderAccountSetupInteractions
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkerConnections
  alias QuestEngineering.Server.WorkerProtocol

  @active_states ~w(authorized preparing invocation_requested invocation_acknowledged human_interaction_required validating cancellation_requested)
  @terminal_states ~w(succeeded failed uncertain cancelled invalidated)
  @states @active_states ++ @terminal_states
  @invocation_states ~w(not_requested requested acknowledged settled uncertain)
  @setup_executables ["/usr/bin/python3", "/usr/bin/qe-fake-provider-login"]
  @failure_messages %{
    "setup_process_lost" => "The setup process could not be recovered safely.",
    "setup_spawn_failed" => "The setup process could not be started safely.",
    "setup_invocation_uncertain" => "Setup invocation certainty could not be established.",
    "setup_process_failed" => "The setup process did not complete successfully.",
    "setup_validation_failed" => "Post-setup authentication validation failed.",
    "setup_cancelled" => "ProviderAccount setup was cancelled by the operator.",
    "environment_identity_mismatch" => "The ProviderAccount environment identity changed.",
    "stale_setup_command" => "The setup command is stale.",
    "input_delivery_uncertain" => "Sensitive setup input delivery is uncertain."
  }

  def list(provider_account_id) when is_binary(provider_account_id) do
    Attempt
    |> where([attempt], attempt.provider_account_id == ^provider_account_id)
    |> order_by([attempt], asc: attempt.setup_generation)
    |> Repo.all()
  end

  def fetch(id) when is_binary(id), do: Repo.get(Attempt, id)

  def active_for_account?(provider_account_id) when is_binary(provider_account_id) do
    Repo.exists?(
      from attempt in Attempt,
        where:
          attempt.provider_account_id == ^provider_account_id and
            attempt.state in ^@active_states
    )
  end

  def attention_for_attempt(id) when is_binary(id),
    do: Repo.get_by(Attention, setup_attempt_id: id)

  def authorize(provider_account_id, request_id)
      when is_binary(provider_account_id) and is_binary(request_id) and request_id != "" do
    Repo.transaction(fn -> authorize_locked(provider_account_id, request_id) end)
    |> unwrap()
  end

  def authorize(provider_account_id, _request_id),
    do:
      {:error,
       error(:invalid_provider_account_setup, %{provider_account_id: provider_account_id})}

  def deliver(%Attempt{} = attempt) do
    with %Authorization{} = authorization <-
           Repo.get_by(Authorization,
             setup_attempt_id: attempt.id,
             setup_generation: attempt.setup_generation
           ),
         %Worker{} = worker <- Repo.get(Worker, attempt.worker_id),
         true <- worker.status == "connected",
         true <- worker.ready_generation == worker.connection_generation,
         true <- worker.connection_generation == attempt.worker_generation,
         {:ok, public_key} <-
           ProviderAccountSetupInteractions.open(attempt.id, attempt.setup_generation) do
      WorkerConnections.send_protocol(
        worker.id,
        worker.connection_generation,
        WorkerProtocol.prepare_provider_account_setup(
          worker,
          attempt,
          authorization,
          public_key
        )
      )
    else
      nil -> {:error, error(:setup_authorization_missing, %{setup_attempt_id: attempt.id})}
      false -> {:error, error(:setup_worker_unavailable, %{setup_attempt_id: attempt.id})}
    end
  end

  def prepare_worker_reconciliation(worker_id, generation)
      when is_binary(worker_id) and is_integer(generation) and generation > 0 do
    with {:ok, setups} <-
           Repo.transaction(fn -> refence_active_attempts(worker_id, generation) end) |> unwrap() do
      Enum.reduce_while(setups, {:ok, []}, fn setup, {:ok, enriched} ->
        case ProviderAccountSetupInteractions.open(
               setup.setup_attempt_id,
               setup.setup_generation
             ) do
          {:ok, public_key} ->
            {:cont, {:ok, [Map.put(setup, :interaction_public_key, public_key) | enriched]}}

          {:error, reason} ->
            {:halt, {:error, reason}}
        end
      end)
      |> case do
        {:ok, enriched} -> {:ok, Enum.reverse(enriched)}
        error -> error
      end
    end
  end

  def record(worker_id, generation, report) when is_map(report) do
    Repo.transaction(fn -> record_locked(worker_id, generation, report) end)
    |> unwrap()
  end

  def record_input_delivery(worker_id, generation, delivery) when is_map(delivery) do
    Repo.transaction(fn -> record_input_delivery_locked(worker_id, generation, delivery) end)
    |> unwrap()
  end

  # State-machine branching keeps durable response commitment ahead of ephemeral delivery.
  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  def respond(provider_account_id, attempt_id, setup_generation, attention_id, request_id, value)
      when is_binary(provider_account_id) and is_binary(attempt_id) and
             is_integer(setup_generation) and setup_generation > 0 and is_binary(attention_id) and
             attention_id != "" and is_binary(request_id) and request_id != "" and
             is_binary(value) and byte_size(value) <= 8_192 do
    result =
      Repo.transaction(fn ->
        attempt = locked_attempt(attempt_id)
        validate_attempt_owner!(attempt, provider_account_id, setup_generation)

        attention =
          Repo.one(
            from request in Attention,
              where: request.setup_attempt_id == ^attempt.id and request.id == ^attention_id,
              lock: "FOR UPDATE"
          ) ||
            Repo.rollback(
              error(:stale_provider_account_setup_response, %{setup_attempt_id: attempt.id})
            )

        cond do
          attention.response_request_id == request_id and
              attention.delivery_state in ["delivery_requested", "delivery_acknowledged"] ->
            {attempt, attention, false}

          attention.response_state != "pending" or
              attempt.state != "human_interaction_required" ->
            Repo.rollback(
              error(:stale_provider_account_setup_response, %{setup_attempt_id: attempt.id})
            )

          true ->
            now = now()
            delivery_attempt_id = Ecto.UUID.generate()

            updated =
              attention
              |> Attention.changeset(%{
                response_state: "responded",
                response_request_id: request_id,
                response_committed_at: now,
                delivery_state: "delivery_requested",
                delivery_attempt_id: delivery_attempt_id,
                delivery_requested_at: now
              })
              |> Repo.update!()

            insert_event!(attempt, "sensitive_input_delivery_requested", %{
              attention_id: attention.id,
              delivery_attempt_id: delivery_attempt_id,
              byte_length: byte_size(value)
            })

            {attempt, updated, true}
        end
      end)

    case result do
      {:ok, {attempt, attention, true}} ->
        message =
          WorkerProtocol.respond_provider_account_setup(
            attempt.worker_id,
            attempt.worker_generation,
            attempt,
            attention,
            value
          )

        case WorkerConnections.send_protocol(
               attempt.worker_id,
               attempt.worker_generation,
               message
             ) do
          :ok ->
            {:ok, attempt, attention}

          {:error, reason} ->
            mark_input_delivery_uncertain(attention.id)
            {:error, reason}
        end

      {:ok, {attempt, attention, false}} ->
        {:ok, attempt, attention}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def respond(provider_account_id, attempt_id, _generation, _attention_id, _request_id, _value),
    do:
      {:error,
       error(:invalid_provider_account_setup_response, %{
         provider_account_id: provider_account_id,
         setup_attempt_id: attempt_id
       })}

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  def cancel(provider_account_id, attempt_id, request_id)
      when is_binary(provider_account_id) and is_binary(attempt_id) and is_binary(request_id) and
             request_id != "" do
    result =
      Repo.transaction(fn ->
        attempt = locked_attempt(attempt_id)

        if attempt.provider_account_id != provider_account_id,
          do:
            Repo.rollback(
              error(:provider_account_setup_not_found, %{setup_attempt_id: attempt_id})
            )

        cond do
          attempt.state in ["cancellation_requested", "cancelled"] and
              attempt.cancellation_request_id == request_id ->
            {attempt, false}

          attempt.state in ["cancellation_requested", "cancelled"] ->
            Repo.rollback(error(:setup_cancellation_conflict, %{setup_attempt_id: attempt.id}))

          attempt.state in @terminal_states ->
            Repo.rollback(error(:provider_account_setup_not_cancellable, %{state: attempt.state}))

          true ->
            now = now()

            updated =
              attempt
              |> Attempt.changeset(%{
                state: "cancellation_requested",
                cancellation_request_id: request_id,
                failure_code: "setup_cancelled",
                failure_message: @failure_messages["setup_cancelled"]
              })
              |> Repo.update!()

            cancel_attention!(updated, now)
            update_account_authentication!(updated.provider_account_id, "authentication_required")
            insert_event!(updated, "cancellation_requested", %{})
            {updated, true}
        end
      end)

    case result do
      {:ok, {attempt, true}} ->
        ProviderAccountSetupInteractions.clear(attempt.id)

        _ =
          WorkerConnections.send_protocol(
            attempt.worker_id,
            attempt.worker_generation,
            WorkerProtocol.cancel_provider_account_setup(
              attempt.worker_id,
              attempt.worker_generation,
              attempt,
              request_id
            )
          )

        {:ok, attempt}

      {:ok, {attempt, false}} ->
        {:ok, attempt}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def cancel(provider_account_id, attempt_id, _request_id),
    do:
      {:error,
       error(:invalid_provider_account_setup_cancellation, %{
         provider_account_id: provider_account_id,
         setup_attempt_id: attempt_id
       })}

  def interaction(provider_account_id, attempt_id, setup_generation, attention_id) do
    with %Attempt{} = attempt <- Repo.get(Attempt, attempt_id),
         true <- attempt.provider_account_id == provider_account_id,
         true <- attempt.setup_generation == setup_generation,
         true <- attempt.state == "human_interaction_required",
         true <- attempt.attention_id == attention_id,
         process_generation when is_binary(process_generation) <- attempt.process_generation do
      ProviderAccountSetupInteractions.fetch(
        attempt.id,
        setup_generation,
        attention_id,
        process_generation
      )
    else
      _ -> {:error, :setup_interaction_unavailable}
    end
  end

  defp authorize_locked(provider_account_id, request_id) do
    case Repo.get_by(Authorization, request_id: request_id) do
      %Authorization{} = authorization ->
        idempotent_authorization(provider_account_id, request_id, authorization)

      nil ->
        account = locked_account(provider_account_id)

        case Repo.get_by(Authorization, request_id: request_id) do
          %Authorization{} = authorization ->
            idempotent_authorization(provider_account_id, request_id, authorization)

          nil ->
            authorize_new_locked(account, request_id)
        end
    end
  end

  defp idempotent_authorization(provider_account_id, request_id, authorization) do
    attempt = Repo.get!(Attempt, authorization.setup_attempt_id)

    if attempt.provider_account_id == provider_account_id,
      do: {attempt, authorization, true},
      else: Repo.rollback(error(:setup_request_conflict, %{request_id: request_id}))
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp authorize_new_locked(account, request_id) do
    environment = locked_environment(account.id)
    validate_eligibility!(account, environment)

    existing =
      Repo.one(
        from attempt in Attempt,
          where:
            attempt.provider_account_id == ^account.id and
              attempt.state in ^@active_states,
          lock: "FOR UPDATE"
      )

    if existing,
      do: Repo.rollback(error(:setup_already_authorized, %{setup_attempt_id: existing.id}))

    worker =
      Repo.one(from worker in Worker, where: worker.id == ^account.worker_id, lock: "FOR UPDATE") ||
        Repo.rollback(error(:setup_worker_unavailable, %{worker_id: account.worker_id}))

    valid_worker =
      worker.status == "connected" and worker.ready_generation == worker.connection_generation and
        worker.connection_generation == environment.worker_generation and
        "provider_account_setup_v1" in Map.get(worker.capabilities, "features", [])

    if not valid_worker,
      do: Repo.rollback(error(:setup_worker_unavailable, %{worker_id: worker.id}))

    setup_generation =
      (Repo.one(
         from attempt in Attempt,
           where: attempt.provider_account_id == ^account.id,
           select: max(attempt.setup_generation)
       ) || 0) + 1

    now = now()

    attempt =
      Attempt.changeset(%{
        id: Ecto.UUID.generate(),
        provider_account_id: account.id,
        setup_generation: setup_generation,
        credential_generation_before: account.credential_generation,
        environment_generation: environment.credential_generation,
        provider_key: account.provider_key,
        worker_id: account.worker_id,
        worker_generation: environment.worker_generation,
        environment_operation_id: environment.operation_id,
        backend_kind: environment.backend_kind,
        environment_id: environment.environment_id,
        environment_incarnation: environment.incarnation,
        state: "authorized",
        invocation_state: "not_requested",
        validation_state: "not_checked"
      })
      |> Repo.insert!()

    authorization =
      Authorization.changeset(%{
        id: Ecto.UUID.generate(),
        setup_attempt_id: attempt.id,
        setup_generation: setup_generation,
        request_id: request_id,
        kind: "provider_account_setup",
        authorized_at: now
      })
      |> Repo.insert!()

    update_account_authentication!(account.id, "setup_authorized")
    insert_event!(attempt, "setup_authorized", %{authorization_id: authorization.id})
    {attempt, authorization, false}
  end

  defp validate_eligibility!(account, environment) do
    eligible =
      account.lifecycle_state == "connected" and account.environment_state == "available" and
        environment.physical_state == "available" and
        environment.desired_environment_state == "available" and
        environment.canary_persisted == true and
        Enum.all?(
          [environment.backend_kind, environment.environment_id, environment.incarnation],
          &(is_binary(&1) and &1 != "")
        )

    if not eligible,
      do:
        Repo.rollback(
          error(:provider_account_setup_ineligible, %{
            provider_account_id: account.id,
            lifecycle_state: account.lifecycle_state,
            environment_state: account.environment_state
          })
        )
  end

  defp refence_active_attempts(worker_id, generation) do
    environments =
      Repo.all(
        from environment in ProviderAccountEnvironment,
          where: environment.worker_id == ^worker_id
      )
      |> Map.new(&{&1.provider_account_id, &1})

    Repo.all(
      from attempt in Attempt,
        where: attempt.worker_id == ^worker_id and attempt.state in ^@active_states,
        order_by: [asc: attempt.inserted_at],
        lock: "FOR UPDATE"
    )
    |> Enum.map(fn attempt ->
      case Map.get(environments, attempt.provider_account_id) do
        %ProviderAccountEnvironment{} = environment
        when environment.environment_id == attempt.environment_id and
               environment.incarnation == attempt.environment_incarnation and
               environment.backend_kind == attempt.backend_kind and
               environment.credential_generation == attempt.environment_generation ->
          updated =
            attempt
            |> Changeset.change(
              worker_generation: generation,
              environment_operation_id: environment.operation_id
            )
            |> Repo.update!()

          insert_event!(updated, "worker_generation_reconciled", %{})
          setup_payload(updated)

        _ ->
          invalidated =
            attempt
            |> Attempt.changeset(%{
              state: "invalidated",
              failure_code: "environment_identity_mismatch",
              failure_message: @failure_messages["environment_identity_mismatch"]
            })
            |> Repo.update!()

          update_account_authentication!(
            invalidated.provider_account_id,
            "authentication_required"
          )

          insert_event!(invalidated, "setup_invalidated", %{})
          nil
      end
    end)
    |> Enum.reject(&is_nil/1)
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp record_locked(worker_id, generation, report) do
    attempt = locked_attempt(fetch(report, :setup_attempt_id))
    validate_report!(attempt, worker_id, generation, report)

    incoming_state = fetch(report, :state)
    incoming_invocation = fetch(report, :invocation_state)
    validate_transition!(attempt, incoming_state, incoming_invocation)
    now = parse_timestamp(fetch(report, :observed_at))
    process = fetch(report, :process)
    validation = fetch(report, :validation)
    failure_code = fetch(report, :failure_code)

    attributes = %{
      state: incoming_state,
      invocation_state: incoming_invocation,
      process_backend_id: process && fetch(process, :backend_process_id),
      process_start_identity: process && fetch(process, :process_start_identity),
      process_generation: process && fetch(process, :process_generation),
      process_executable: process && fetch(process, :executable),
      attention_id: attention_id(report),
      validation_state: (validation && fetch(validation, :state)) || attempt.validation_state,
      validation_identity:
        (validation && fetch(validation, :identity)) || attempt.validation_identity,
      failure_code: failure_code,
      failure_message: safe_failure_message(failure_code),
      invocation_requested_at:
        if(incoming_invocation in ["requested", "acknowledged", "settled"],
          do: attempt.invocation_requested_at || now,
          else: attempt.invocation_requested_at
        ),
      invocation_acknowledged_at:
        if(incoming_invocation in ["acknowledged", "settled"],
          do: attempt.invocation_acknowledged_at || now,
          else: attempt.invocation_acknowledged_at
        ),
      interaction_required_at:
        if(incoming_state == "human_interaction_required",
          do: attempt.interaction_required_at || now,
          else: attempt.interaction_required_at
        ),
      validated_at:
        if(incoming_state in ["succeeded", "failed"] and validation,
          do: attempt.validated_at || now,
          else: attempt.validated_at
        ),
      succeeded_at: if(incoming_state == "succeeded", do: attempt.succeeded_at || now, else: nil),
      cancelled_at: if(incoming_state == "cancelled", do: attempt.cancelled_at || now, else: nil)
    }

    updated =
      attempt
      |> Attempt.changeset(attributes)
      |> Repo.update!()

    updated = apply_account_projection!(updated, validation, now)
    apply_attention_projection!(updated, report, now)
    insert_event!(updated, "setup_state_observed", %{observed_state: incoming_state})
    updated
  end

  # Exact multi-axis fencing is intentionally one fail-closed predicate.
  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp validate_report!(attempt, worker_id, generation, report) do
    current_environment = Repo.get!(ProviderAccountEnvironment, attempt.provider_account_id)

    valid =
      attempt.worker_id == worker_id and attempt.worker_generation == generation and
        attempt.setup_generation == fetch(report, :setup_generation) and
        attempt.provider_account_id == fetch(report, :provider_account_id) and
        attempt.credential_generation_before == fetch(report, :credential_generation) and
        attempt.environment_generation == fetch(report, :environment_generation) and
        attempt.environment_operation_id == fetch(report, :environment_operation_id) and
        attempt.backend_kind == fetch(report, :backend_kind) and
        attempt.environment_id == fetch(report, :environment_id) and
        attempt.environment_incarnation == fetch(report, :environment_incarnation) and
        current_environment.credential_generation == attempt.environment_generation and
        current_environment.backend_kind == attempt.backend_kind and
        current_environment.environment_id == attempt.environment_id and
        current_environment.incarnation == attempt.environment_incarnation

    process = fetch(report, :process)
    attention = fetch(report, :attention)
    validation = fetch(report, :validation)
    incoming_state = fetch(report, :state)
    incoming_invocation = fetch(report, :invocation_state)

    process_required =
      incoming_state in ~w(invocation_acknowledged human_interaction_required validating succeeded) or
        incoming_invocation in ~w(acknowledged settled)

    process_stable =
      is_nil(attempt.process_generation) or
        (is_map(process) and attempt.process_backend_id == fetch(process, :backend_process_id) and
           attempt.process_start_identity == fetch(process, :process_start_identity) and
           attempt.process_generation == fetch(process, :process_generation) and
           attempt.process_executable == fetch(process, :executable))

    process_allowed =
      is_nil(process) or fetch(process, :executable) in @setup_executables

    valid_shape =
      (not process_required or is_map(process)) and process_allowed and process_stable and
        (incoming_state != "human_interaction_required" or is_map(attention)) and
        (incoming_state != "succeeded" or
           (incoming_invocation == "settled" and is_map(validation) and
              fetch(validation, :state) == "authenticated" and
              is_binary(fetch(validation, :identity))))

    if not valid or not valid_shape,
      do:
        Repo.rollback(
          error(:stale_provider_account_setup_report, %{setup_attempt_id: attempt.id})
        )
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp validate_transition!(attempt, incoming_state, incoming_invocation) do
    if incoming_state not in @states or incoming_invocation not in @invocation_states,
      do:
        Repo.rollback(
          error(:invalid_provider_account_setup_report, %{setup_attempt_id: attempt.id})
        )

    if attempt.state in @terminal_states and
         (incoming_state != attempt.state or incoming_invocation != attempt.invocation_state),
       do:
         Repo.rollback(
           error(:stale_provider_account_setup_report, %{setup_attempt_id: attempt.id})
         )

    rank = %{
      "authorized" => 0,
      "preparing" => 1,
      "invocation_requested" => 2,
      "invocation_acknowledged" => 3,
      "human_interaction_required" => 4,
      "validating" => 5,
      "cancellation_requested" => 5,
      "succeeded" => 6,
      "failed" => 6,
      "uncertain" => 6,
      "cancelled" => 6,
      "invalidated" => 6
    }

    invalid_state =
      Map.fetch!(rank, incoming_state) < Map.fetch!(rank, attempt.state) or
        (attempt.state == "cancellation_requested" and
           incoming_state not in ["cancellation_requested", "cancelled", "uncertain"])

    invocation_rank = %{
      "not_requested" => 0,
      "requested" => 1,
      "acknowledged" => 2,
      "settled" => 3,
      "uncertain" => 3
    }

    invalid_invocation =
      Map.fetch!(invocation_rank, incoming_invocation) <
        Map.fetch!(invocation_rank, attempt.invocation_state) or
        (attempt.invocation_state == "uncertain" and incoming_invocation != "uncertain") or
        (attempt.invocation_state == "settled" and incoming_invocation != "settled")

    if invalid_state or invalid_invocation,
      do:
        Repo.rollback(
          error(:stale_provider_account_setup_report, %{setup_attempt_id: attempt.id})
        )
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp apply_account_projection!(attempt, validation, now) do
    case attempt.state do
      "authorized" ->
        update_account_authentication!(attempt.provider_account_id, "setup_authorized")
        attempt

      state when state in ~w(preparing invocation_requested invocation_acknowledged) ->
        update_account_authentication!(attempt.provider_account_id, "setup_in_progress")
        attempt

      "human_interaction_required" ->
        update_account_authentication!(attempt.provider_account_id, "interaction_required")
        attempt

      "validating" ->
        update_account_authentication!(attempt.provider_account_id, "validating")
        attempt

      "succeeded" ->
        if not is_map(validation) or fetch(validation, :state) != "authenticated" or
             not is_binary(fetch(validation, :identity)) or attempt.invocation_state != "settled" do
          Repo.rollback(
            error(:invalid_provider_account_setup_readiness, %{setup_attempt_id: attempt.id})
          )
        end

        account = locked_account(attempt.provider_account_id)

        cond do
          account.credential_generation == attempt.credential_generation_before ->
            next = DomainAccount.authenticated(ProviderAccounts.to_domain_record(account), now)

            updated_account =
              account
              |> ProviderAccount.changeset(%{
                credential_generation: next.credential_generation,
                lifecycle_state: Atom.to_string(next.lifecycle_state),
                authentication_state: Atom.to_string(next.authentication_state),
                authenticated_at: next.authenticated_at,
                last_validated_at: next.last_validated_at
              })
              |> Repo.update!()

            attempt
            |> Attempt.changeset(%{
              credential_generation_after: updated_account.credential_generation
            })
            |> Repo.update!()

          account.credential_generation == attempt.credential_generation_before + 1 and
              account.authentication_state == "authenticated" ->
            attempt

          true ->
            Repo.rollback(
              error(:stale_provider_account_setup_report, %{setup_attempt_id: attempt.id})
            )
        end

      "failed" ->
        state =
          case validation_state(validation) do
            "authentication_required" -> "authentication_required"
            "inspection_unavailable" -> "inspection_unavailable"
            _ -> "authentication_required"
          end

        update_account_authentication!(attempt.provider_account_id, state)
        attempt

      state when state in ~w(uncertain cancelled invalidated cancellation_requested) ->
        update_account_authentication!(attempt.provider_account_id, "authentication_required")
        attempt
    end
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp apply_attention_projection!(attempt, report, now) do
    attention = fetch(report, :attention)

    cond do
      attempt.state == "human_interaction_required" and is_map(attention) ->
        attention_id = fetch(attention, :attention_id)

        existing = Repo.get_by(Attention, setup_attempt_id: attempt.id)

        attrs = %{
          id: attention_id,
          setup_attempt_id: attempt.id,
          provider_account_id: attempt.provider_account_id,
          worker_id: attempt.worker_id,
          setup_generation: attempt.setup_generation,
          request_generation: 1,
          request: %{
            "kind" => "provider_authentication",
            "message" =>
              "Complete the deterministic provider sign-in flow. This does not authorize model inference."
          },
          response_state: "pending",
          delivery_state: "response_not_delivered",
          surfaced_at: now
        }

        case existing do
          nil ->
            Attention.changeset(attrs) |> Repo.insert!()

          %{id: ^attention_id} ->
            existing

          _ ->
            Repo.rollback(
              error(:setup_attention_identity_mismatch, %{setup_attempt_id: attempt.id})
            )
        end

      attempt.state != "human_interaction_required" ->
        if request = Repo.get_by(Attention, setup_attempt_id: attempt.id) do
          terminal_state = if attempt.state == "cancelled", do: "cancelled", else: "obsolete"

          if request.response_state == "pending" do
            request
            |> Attention.changeset(%{
              response_state: terminal_state,
              cancelled_at: if(terminal_state == "cancelled", do: now),
              cancellation_reason: if(terminal_state == "cancelled", do: "setup_cancelled")
            })
            |> Repo.update!()
          end
        end

        :ok

      true ->
        :ok
    end
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp record_input_delivery_locked(worker_id, generation, delivery) do
    attempt = locked_attempt(fetch(delivery, :setup_attempt_id))

    valid =
      attempt.worker_id == worker_id and attempt.worker_generation == generation and
        attempt.setup_generation == fetch(delivery, :setup_generation) and
        attempt.process_generation == fetch(delivery, :process_generation)

    if not valid,
      do:
        Repo.rollback(
          error(:stale_provider_account_setup_delivery, %{setup_attempt_id: attempt.id})
        )

    request =
      Repo.one(
        from request in Attention,
          where:
            request.setup_attempt_id == ^attempt.id and
              request.id == ^fetch(delivery, :attention_id),
          lock: "FOR UPDATE"
      ) || Repo.rollback(error(:setup_attention_not_found, %{setup_attempt_id: attempt.id}))

    if request.delivery_attempt_id != fetch(delivery, :delivery_attempt_id),
      do:
        Repo.rollback(
          error(:stale_provider_account_setup_delivery, %{setup_attempt_id: attempt.id})
        )

    state = fetch(delivery, :state)
    now = parse_timestamp(fetch(delivery, :observed_at))

    attributes =
      case state do
        "delivery_acknowledged" ->
          %{delivery_state: state, delivery_acknowledged_at: now}

        "delivery_uncertain" ->
          %{delivery_state: state, delivery_uncertain_at: now}

        _ ->
          Repo.rollback(error(:invalid_provider_account_setup_delivery, %{state: state}))
      end

    updated = request |> Attention.changeset(attributes) |> Repo.update!()
    insert_event!(attempt, state, %{delivery_attempt_id: updated.delivery_attempt_id})
    updated
  end

  defp mark_input_delivery_uncertain(attention_id) do
    Repo.transaction(fn ->
      case Repo.one(
             from request in Attention, where: request.id == ^attention_id, lock: "FOR UPDATE"
           ) do
        %Attention{delivery_state: "delivery_requested"} = request ->
          request
          |> Attention.changeset(%{
            delivery_state: "delivery_uncertain",
            delivery_uncertain_at: now()
          })
          |> Repo.update!()

        request ->
          request
      end
    end)
  end

  defp cancel_attention!(attempt, now) do
    if request = Repo.get_by(Attention, setup_attempt_id: attempt.id) do
      request
      |> Attention.changeset(%{
        response_state: "cancelled",
        cancelled_at: now,
        cancellation_reason: "setup_cancelled"
      })
      |> Repo.update!()
    end
  end

  defp update_account_authentication!(id, state) do
    account = locked_account(id)

    attributes =
      %{authentication_state: state}
      |> then(fn attrs ->
        if state == "authenticated", do: attrs, else: Map.put(attrs, :last_validated_at, nil)
      end)

    account |> ProviderAccount.changeset(attributes) |> Repo.update!()
  end

  defp insert_event!(attempt, event_type, details) do
    Event.changeset(%{
      id: Ecto.UUID.generate(),
      setup_attempt_id: attempt.id,
      provider_account_id: attempt.provider_account_id,
      setup_generation: attempt.setup_generation,
      event_type: event_type,
      state: attempt.state,
      invocation_state: attempt.invocation_state,
      details: details,
      occurred_at: now()
    })
    |> Repo.insert!()
  end

  defp setup_payload(attempt) do
    authorization = Repo.get_by!(Authorization, setup_attempt_id: attempt.id)

    %{
      setup_attempt_id: attempt.id,
      provider_account_id: attempt.provider_account_id,
      setup_generation: attempt.setup_generation,
      authorization_id: authorization.id,
      authorized_at: authorization.authorized_at,
      credential_generation: attempt.credential_generation_before,
      environment_generation: attempt.environment_generation,
      worker_generation: attempt.worker_generation,
      environment_operation_id: attempt.environment_operation_id,
      provider_key: attempt.provider_key,
      backend_kind: attempt.backend_kind,
      environment_id: attempt.environment_id,
      environment_incarnation: attempt.environment_incarnation,
      state: attempt.state,
      invocation_state: attempt.invocation_state,
      cancellation_request_id: attempt.cancellation_request_id
    }
  end

  defp validate_attempt_owner!(attempt, account_id, setup_generation) do
    if attempt.provider_account_id != account_id or attempt.setup_generation != setup_generation,
      do: Repo.rollback(error(:provider_account_setup_not_found, %{setup_attempt_id: attempt.id}))
  end

  defp locked_account(id) do
    Repo.one(from account in ProviderAccount, where: account.id == ^id, lock: "FOR UPDATE") ||
      Repo.rollback(error(:not_found, %{provider_account_id: id}))
  end

  defp locked_environment(id) do
    Repo.one(
      from environment in ProviderAccountEnvironment,
        where: environment.provider_account_id == ^id,
        lock: "FOR UPDATE"
    ) || Repo.rollback(error(:provider_account_environment_missing, %{provider_account_id: id}))
  end

  defp locked_attempt(id) do
    Repo.one(from attempt in Attempt, where: attempt.id == ^id, lock: "FOR UPDATE") ||
      Repo.rollback(error(:provider_account_setup_not_found, %{setup_attempt_id: id}))
  end

  defp validation_state(value) when is_map(value), do: fetch(value, :state)
  defp validation_state(_value), do: nil

  defp attention_id(report) do
    case fetch(report, :attention) do
      value when is_map(value) -> fetch(value, :attention_id)
      _ -> nil
    end
  end

  defp safe_failure_message(nil), do: nil

  defp safe_failure_message(code),
    do: Map.get(@failure_messages, code, "ProviderAccount setup failed safely.")

  defp parse_timestamp(%DateTime{} = value), do: value

  defp parse_timestamp(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, timestamp, _offset} -> timestamp
      _ -> now()
    end
  end

  defp parse_timestamp(_value), do: now()
  defp fetch(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
  defp unwrap({:ok, value}), do: {:ok, value}
  defp unwrap({:error, reason}), do: {:error, reason}
  defp error(code, details), do: %{code: code, details: details}
end
