defmodule QuestEngineering.Server.RuntimeStore do
  @moduledoc """
  Transactional persistence boundary around the pure core runtime.

  The authoritative run snapshot, accepted transition record, and every action
  emitted by that transition are committed in one PostgreSQL transaction.
  """

  import Ecto.Query

  alias Ecto.Changeset
  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Runtime
  alias QuestEngineering.Core.Runtime.Event
  alias QuestEngineering.Server.Persistence.Error
  alias QuestEngineering.Server.Persistence.OutboxWriter
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RuntimeTransition
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo

  @type run_result :: %{
          run: Runtime.Run.t(),
          revision: non_neg_integer(),
          actions: [Runtime.Action.t()],
          idempotent_replay?: boolean()
        }

  @doc "Starts and persists a run and its initial actions atomically."
  @spec create_run(String.t(), ExecutionPlan.t()) :: {:ok, run_result()} | {:error, term()}
  def create_run(run_id, %ExecutionPlan{} = plan) when is_binary(run_id) and run_id != "" do
    transact(fn ->
      case Runtime.start(plan, run_id) do
        {:ok, run, actions} -> persist_new_run(run, actions)
        {:error, error} -> Repo.rollback(error)
      end
    end)
  end

  def create_run(_run_id, plan) do
    {:error,
     %Error{type: :constraint_failure, details: %{reason: :invalid_create_run, plan: plan}}}
  end

  @doc false
  @spec persist_started_run(Runtime.Run.t(), [Runtime.Action.t()]) :: run_result()
  def persist_started_run(%Runtime.Run{} = run, actions) when is_list(actions) do
    if Repo.in_transaction?() do
      persist_new_run(run, actions)
    else
      raise ArgumentError, "persist_started_run/2 requires an existing Repo transaction"
    end
  end

  @doc "Loads the authoritative snapshot without consulting in-memory state or replaying history."
  @spec fetch_run(String.t()) ::
          {:ok, %{run: Runtime.Run.t(), revision: non_neg_integer(), status: atom()}}
          | {:error, Error.t()}
  def fetch_run(run_id) do
    case Repo.get(RuntimeRun, run_id) do
      nil ->
        {:error, %Error{type: :run_not_found, run_id: run_id}}

      row ->
        with {:ok, run} <- RuntimeCodec.decode_snapshot(row.snapshot, row.snapshot_version) do
          {:ok, %{run: run, revision: row.revision, status: run.status}}
        end
    end
  end

  @doc "Applies an externally identified event exactly once for a run."
  @spec apply_transition(String.t(), String.t(), Event.t()) ::
          {:ok, run_result()} | {:error, term()}
  def apply_transition(run_id, transition_id, %Event{} = event)
      when is_binary(run_id) and is_binary(transition_id) and transition_id != "" do
    encoded_event = RuntimeCodec.encode(event)

    transact(fn ->
      row = lock_run!(run_id)

      case find_transition(run_id, transition_id) do
        nil -> apply_new_transition(row, transition_id, event, encoded_event)
        transition -> replay_transition(transition, event)
      end
    end)
  end

  def apply_transition(run_id, transition_id, event) do
    {:error,
     %Error{
       type: :constraint_failure,
       run_id: run_id,
       transition_id: transition_id,
       details: %{reason: :invalid_apply_transition, event: event}
     }}
  end

  @doc "Lists accepted transitions in authoritative revision order."
  @spec list_transitions(String.t()) :: {:ok, [map()]} | {:error, Error.t()}
  def list_transitions(run_id) do
    if Repo.exists?(from run in RuntimeRun, where: run.id == ^run_id) do
      RuntimeTransition
      |> where([transition], transition.run_id == ^run_id)
      |> order_by([transition], asc: transition.resulting_revision)
      |> Repo.all()
      |> decode_transitions()
    else
      {:error, %Error{type: :run_not_found, run_id: run_id}}
    end
  end

  @doc "Returns durable action intents that do not yet have a worker dispatch."
  @spec pending_actions(String.t() | nil) :: {:ok, [map()]} | {:error, Error.t()}
  def pending_actions(run_id \\ nil) do
    query =
      from outbox in RuntimeOutbox,
        left_join: dispatch in WorkerDispatch,
        on: dispatch.action_id == outbox.action_id,
        where: is_nil(dispatch.id),
        order_by: [asc: outbox.run_revision, asc: outbox.emission_index],
        select: outbox

    query = if run_id, do: where(query, [outbox], outbox.run_id == ^run_id), else: query
    query |> Repo.all() |> decode_outbox_rows()
  end

  defp persist_new_run(run, actions) do
    {:ok, snapshot} = RuntimeCodec.encode_snapshot(run)

    changeset =
      RuntimeRun.create_changeset(%{
        id: run.id,
        snapshot: snapshot,
        snapshot_version: RuntimeCodec.snapshot_version(),
        status: Atom.to_string(run.status),
        revision: 0
      })

    with {:ok, _row} <- insert_or_rollback(changeset),
         {:ok, _outbox} <- insert_actions_or_rollback(run.id, 0, actions) do
      %{run: run, revision: 0, actions: actions, idempotent_replay?: false}
    end
  end

  defp apply_new_transition(row, transition_id, event, encoded_event) do
    with {:ok, run} <- decode_or_rollback(row.snapshot, row.snapshot_version),
         {:ok, next_run, actions} <- transition_or_rollback(run, event),
         {:ok, result_snapshot} <- RuntimeCodec.encode_snapshot(next_run),
         {:ok, updated_row} <- update_run_or_rollback(row, next_run, result_snapshot),
         :ok <-
           insert_transition_or_rollback(
             updated_row,
             transition_id,
             encoded_event,
             result_snapshot,
             actions
           ),
         {:ok, _outbox} <- insert_actions_or_rollback(row.id, updated_row.revision, actions) do
      %{
        run: next_run,
        revision: updated_row.revision,
        actions: actions,
        idempotent_replay?: false
      }
    end
  end

  defp replay_transition(transition, submitted_event) do
    with {:ok, persisted_event} <- decode_or_rollback(transition.event_payload),
         :ok <- ensure_same_event(transition, persisted_event, submitted_event),
         {:ok, run} <-
           decode_or_rollback(transition.result_snapshot, transition.snapshot_version),
         {:ok, actions} <- load_actions_or_rollback(transition.action_ids) do
      %{
        run: run,
        revision: transition.resulting_revision,
        actions: actions,
        idempotent_replay?: true
      }
    end
  end

  defp ensure_same_event(_transition, event, event), do: :ok

  defp ensure_same_event(transition, _persisted, _submitted) do
    Repo.rollback(%Error{
      type: :transition_id_conflict,
      run_id: transition.run_id,
      transition_id: transition.transition_id,
      details: %{reason: :different_event_payload}
    })
  end

  defp lock_run!(run_id) do
    query = from run in RuntimeRun, where: run.id == ^run_id, lock: "FOR UPDATE"

    case Repo.one(query) do
      nil -> Repo.rollback(%Error{type: :run_not_found, run_id: run_id})
      row -> row
    end
  end

  defp find_transition(run_id, transition_id) do
    Repo.get_by(RuntimeTransition, run_id: run_id, transition_id: transition_id)
  end

  defp update_run_or_rollback(row, run, snapshot) do
    changeset =
      RuntimeRun.transition_changeset(row, %{
        snapshot: snapshot,
        snapshot_version: RuntimeCodec.snapshot_version(),
        status: Atom.to_string(run.status)
      })

    case Repo.update(changeset) do
      {:ok, updated} -> {:ok, updated}
      {:error, changeset} -> Repo.rollback(constraint_error(changeset))
    end
  rescue
    Ecto.StaleEntryError ->
      Repo.rollback(%Error{
        type: :stale_revision,
        run_id: row.id,
        details: %{revision: row.revision}
      })
  end

  defp insert_transition_or_rollback(row, transition_id, event, snapshot, actions) do
    changeset =
      RuntimeTransition.changeset(%{
        run_id: row.id,
        transition_id: transition_id,
        resulting_revision: row.revision,
        event_payload: event,
        result_snapshot: snapshot,
        snapshot_version: RuntimeCodec.snapshot_version(),
        resulting_status: row.status,
        action_ids: Enum.map(actions, & &1.id)
      })

    case Repo.insert(changeset) do
      {:ok, _transition} -> :ok
      {:error, changeset} -> Repo.rollback(constraint_error(changeset))
    end
  end

  defp insert_actions_or_rollback(run_id, revision, actions) do
    case OutboxWriter.insert_actions(run_id, revision, actions) do
      {:ok, outbox} -> {:ok, outbox}
      {:error, %Error{} = error} -> Repo.rollback(error)
      {:error, %Changeset{} = changeset} -> Repo.rollback(constraint_error(changeset))
    end
  end

  defp load_actions_or_rollback(action_ids) do
    rows = Repo.all(from outbox in RuntimeOutbox, where: outbox.action_id in ^action_ids)
    by_id = Map.new(rows, &{&1.action_id, &1})

    Enum.reduce_while(action_ids, {:ok, []}, fn action_id, {:ok, actions} ->
      case Map.fetch(by_id, action_id) do
        {:ok, row} -> append_decoded_action(row, actions)
        :error -> missing_transition_action!(action_id)
      end
    end)
  end

  defp append_decoded_action(row, actions) do
    case RuntimeCodec.decode(row.payload) do
      {:ok, action} -> {:cont, {:ok, actions ++ [action]}}
      {:error, error} -> {:halt, Repo.rollback(error)}
    end
  end

  defp missing_transition_action!(action_id) do
    Repo.rollback(%Error{
      type: :action_not_found,
      action_id: action_id,
      details: %{reason: :transition_action_missing}
    })
  end

  defp decode_transitions(rows) do
    Enum.reduce_while(rows, {:ok, []}, fn row, {:ok, decoded} ->
      case RuntimeCodec.decode(row.event_payload) do
        {:ok, event} ->
          transition = %{
            transition_id: row.transition_id,
            revision: row.resulting_revision,
            event: event,
            resulting_status: String.to_existing_atom(row.resulting_status),
            action_ids: row.action_ids,
            inserted_at: row.inserted_at
          }

          {:cont, {:ok, decoded ++ [transition]}}

        {:error, error} ->
          {:halt, {:error, error}}
      end
    end)
  end

  defp decode_outbox_rows(rows) do
    Enum.reduce_while(rows, {:ok, []}, fn row, {:ok, decoded} ->
      case RuntimeCodec.decode(row.payload) do
        {:ok, action} -> {:cont, {:ok, decoded ++ [outbox_record(row, action)]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  defp outbox_record(row, action) do
    %{
      action_id: row.action_id,
      run_id: row.run_id,
      run_revision: row.run_revision,
      emission_index: row.emission_index,
      action_type: String.to_existing_atom(row.action_type),
      action: action
    }
  end

  defp transition_or_rollback(run, event) do
    case Runtime.transition(run, event) do
      {:ok, next_run, actions} -> {:ok, next_run, actions}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp decode_or_rollback(snapshot, version) do
    case RuntimeCodec.decode_snapshot(snapshot, version) do
      {:ok, run} -> {:ok, run}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp decode_or_rollback(payload) do
    case RuntimeCodec.decode(payload) do
      {:ok, value} -> {:ok, value}
      {:error, error} -> Repo.rollback(error)
    end
  end

  defp insert_or_rollback(changeset) do
    case Repo.insert(changeset) do
      {:ok, row} -> {:ok, row}
      {:error, changeset} -> Repo.rollback(constraint_error(changeset))
    end
  end

  defp transact(fun) do
    case Repo.transaction(fun) do
      {:ok, result} -> {:ok, result}
      {:error, error} -> {:error, error}
    end
  end

  defp constraint_error(changeset) do
    %Error{
      type: :constraint_failure,
      details: %{errors: Changeset.traverse_errors(changeset, &elem(&1, 0))}
    }
  end
end
