defmodule QuestEngineering.Server.ExecutionStatus do
  @moduledoc """
  Authoritative projection of runtime, dispatch, session, and native-turn state.

  Runtime state owns orchestration completion. Worker dispatch state owns
  terminal execution certainty. The durable session turn owns the finer
  waiting/working/blocked/stalled distinction while a dispatch is active.
  """

  import Ecto.Query

  alias QuestEngineering.Server.Persistence.ExecutionSession
  alias QuestEngineering.Server.Persistence.RuntimeOutbox
  alias QuestEngineering.Server.Persistence.WorkerDispatch
  alias QuestEngineering.Server.Repo

  @active_priority ~w(uncertain failed blocked stalled running waiting_for_activity scheduled waiting pending)

  def step_state(:pending, _scheduled, _dispatch, _session), do: "pending"
  def step_state(:completed, _scheduled, _dispatch, _session), do: "completed"

  def step_state(:failed, _scheduled, dispatch, _session),
    do: if(cancelled?(dispatch), do: "cancelled", else: "failed")

  def step_state(:dispatched, scheduled, dispatch, session) do
    active_step_state(record_state(dispatch), record_state(scheduled), turn_phase(session))
  end

  defp active_step_state("uncertain", _scheduled, _phase), do: "uncertain"
  defp active_step_state("cancelled", _scheduled, _phase), do: "cancelled"
  defp active_step_state(_dispatch, "failed", _phase), do: "failed"
  defp active_step_state("failed", _scheduled, _phase), do: "failed"
  defp active_step_state(_dispatch, _scheduled, "uncertain"), do: "uncertain"
  defp active_step_state(_dispatch, _scheduled, "blocked"), do: "blocked"
  defp active_step_state(_dispatch, _scheduled, "stalled"), do: "stalled"
  defp active_step_state(_dispatch, _scheduled, "working"), do: "running"
  defp active_step_state(_dispatch, _scheduled, "awaiting_result"), do: "running"

  defp active_step_state(_dispatch, _scheduled, phase)
       when phase in ["prompt_intent", "waiting_for_activity"],
       do: "waiting_for_activity"

  defp active_step_state("running", _scheduled, _phase), do: "running"

  defp active_step_state(dispatch, _scheduled, _phase)
       when dispatch in ["claimed", "dispatched", "acknowledged"],
       do: "scheduled"

  defp active_step_state(_dispatch, scheduled, _phase) when not is_nil(scheduled),
    do: "scheduled"

  defp active_step_state(_dispatch, _scheduled, _phase), do: "waiting"

  def run_state(:failed, states),
    do: if("cancelled" in states and "failed" not in states, do: "cancelled", else: "failed")

  def run_state(:completed, _states), do: "completed"

  def run_state(:running, states) do
    Enum.find(@active_priority, "pending", &(&1 in states))
  end

  def active_run_state(run_id) do
    states =
      Repo.all(
        from action in RuntimeOutbox,
          left_join: dispatch in WorkerDispatch,
          on: dispatch.action_id == action.action_id,
          left_join: session in ExecutionSession,
          on: session.current_action_id == action.action_id,
          where:
            action.run_id == ^run_id and
              dispatch.state in ["claimed", "dispatched", "acknowledged", "running", "uncertain"],
          select: {dispatch, session}
      )
      |> Enum.map(fn {dispatch, session} ->
        step_state(:dispatched, dispatch, dispatch, session)
      end)

    run_state(:running, states)
  end

  def active_lifecycle(run_id) do
    case active_run_state(run_id) do
      "uncertain" -> lifecycle(run_id, "uncertain", "Execution Uncertain")
      "failed" -> lifecycle(run_id, "failed", "Needs Attention")
      "blocked" -> lifecycle(run_id, "blocked", "Waiting for You")
      "stalled" -> lifecycle(run_id, "stalled", "Execution Stalled")
      "waiting_for_activity" -> lifecycle(run_id, "waiting_for_activity", "Starting Work")
      _ -> lifecycle(run_id, "working", "Working")
    end
  end

  defp lifecycle(run_id, state, label) do
    %{
      state: state,
      label: label,
      current_run_id: run_id,
      primary_action: nil
    }
  end

  defp record_state(nil), do: nil

  defp record_state(record),
    do: if(cancelled?(record), do: "cancelled", else: Map.get(record, :state))

  defp cancelled?(%{state: "failed", failure: %{"code" => "execution_cancelled"}}), do: true
  defp cancelled?(_record), do: false

  defp turn_phase(nil), do: nil
  defp turn_phase(%{turn: %{"phase" => phase}}), do: phase
  defp turn_phase(_), do: nil
end
