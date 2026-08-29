defmodule QuestEngineering.Server.Persistence.OutboxWriter do
  @moduledoc false

  alias QuestEngineering.Core.Runtime.Action
  alias QuestEngineering.Server.Persistence.Error
  alias QuestEngineering.Server.Persistence.RuntimeCodec
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Repo

  @spec insert_actions(String.t(), non_neg_integer(), [Action.t()]) ::
          {:ok, [RuntimeOutbox.t()]} | {:error, Error.t() | Ecto.Changeset.t()}
  def insert_actions(run_id, revision, actions) do
    actions
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {action, emission_index}, {:ok, rows} ->
      case insert_action(run_id, revision, action, emission_index) do
        {:ok, row} -> {:cont, {:ok, rows ++ [row]}}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  @spec insert_action(String.t(), non_neg_integer(), Action.t(), non_neg_integer()) ::
          {:ok, RuntimeOutbox.t()} | {:error, Error.t() | Ecto.Changeset.t()}
  def insert_action(run_id, revision, %Action{} = action, emission_index \\ 0) do
    payload = RuntimeCodec.encode(action)

    attributes = %{
      action_id: action.id,
      run_id: run_id,
      run_revision: revision,
      emission_index: emission_index,
      action_type: Atom.to_string(action.type),
      payload: payload
    }

    changeset = RuntimeOutbox.changeset(attributes)

    case Repo.insert(changeset,
           on_conflict: :nothing,
           conflict_target: :action_id,
           returning: true
         ) do
      {:ok, %RuntimeOutbox{id: nil}} -> verify_existing(attributes)
      {:ok, row} -> {:ok, row}
      {:error, changeset} -> {:error, changeset}
    end
  end

  defp verify_existing(attributes) do
    existing = Repo.get_by!(RuntimeOutbox, action_id: attributes.action_id)

    if same_action?(existing, attributes) do
      {:ok, existing}
    else
      {:error,
       %Error{
         type: :action_id_conflict,
         action_id: attributes.action_id,
         run_id: attributes.run_id,
         details: %{
           existing_run_id: existing.run_id,
           existing_run_revision: existing.run_revision,
           submitted_run_revision: attributes.run_revision,
           existing_emission_index: existing.emission_index,
           submitted_emission_index: attributes.emission_index
         }
       }}
    end
  end

  defp same_action?(existing, attributes) do
    existing.run_id == attributes.run_id and
      existing.run_revision == attributes.run_revision and
      existing.emission_index == attributes.emission_index and
      existing.action_type == attributes.action_type and
      existing.payload == attributes.payload
  end
end
