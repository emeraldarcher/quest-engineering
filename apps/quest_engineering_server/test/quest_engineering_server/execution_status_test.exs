defmodule QuestEngineering.Server.ExecutionStatusTest do
  use ExUnit.Case, async: true

  alias QuestEngineering.Server.ExecutionStatus

  test "native turn evidence refines an active dispatch without inventing uncertainty" do
    dispatch = %{state: "running"}

    assert ExecutionStatus.step_state(
             :dispatched,
             %{},
             dispatch,
             session("waiting_for_activity")
           ) == "waiting_for_activity"

    assert ExecutionStatus.step_state(:dispatched, %{}, dispatch, session("working")) ==
             "running"

    assert ExecutionStatus.step_state(:dispatched, %{}, dispatch, session("blocked")) ==
             "blocked"

    assert ExecutionStatus.step_state(:dispatched, %{}, dispatch, session("stalled")) ==
             "stalled"
  end

  test "terminal dispatch truth outranks stale lifecycle observations" do
    assert ExecutionStatus.step_state(
             :dispatched,
             %{},
             %{state: "uncertain"},
             session("working")
           ) == "uncertain"

    assert ExecutionStatus.step_state(
             :dispatched,
             %{},
             %{state: "failed"},
             session("working")
           ) == "failed"
  end

  test "Run status uses one deterministic precedence across projected steps" do
    assert ExecutionStatus.run_state(:running, ["running", "blocked"]) == "blocked"
    assert ExecutionStatus.run_state(:running, ["stalled", "running"]) == "stalled"
    assert ExecutionStatus.run_state(:running, ["uncertain", "blocked"]) == "uncertain"
    assert ExecutionStatus.run_state(:completed, ["uncertain"]) == "completed"
  end

  defp session(phase), do: %{turn: %{"phase" => phase}}
end
