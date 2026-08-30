defmodule QuestEngineering.Server.BackgroundLifecycleTest do
  use QuestEngineering.Server.DataCase, async: false

  alias QuestEngineering.Server.Dispatcher
  alias QuestEngineering.Server.RunWorkspaceProvisioner
  alias QuestEngineering.Server.Scheduler
  alias QuestEngineering.Server.WorkerConnections

  test "DB-using coordinators are test-owned and stop before sandbox ownership" do
    refute Process.whereis(WorkerConnections)
    refute Process.whereis(Dispatcher)
    refute Process.whereis(RunWorkspaceProvisioner)
    refute Process.whereis(Scheduler)

    connections = start_supervised!(WorkerConnections)
    dispatcher = start_supervised!({Dispatcher, claim_owner: "lifecycle-test"})
    provisioner = start_supervised!(RunWorkspaceProvisioner)
    scheduler = start_supervised!({Scheduler, claim_owner: "lifecycle-test"})

    Scheduler.wake_all()
    assert Process.alive?(connections)
    assert Process.alive?(dispatcher)
    assert Process.alive?(provisioner)
    assert Process.alive?(scheduler)

    :ok = stop_supervised(Scheduler)
    :ok = stop_supervised(RunWorkspaceProvisioner)
    :ok = stop_supervised(Dispatcher)
    :ok = stop_supervised(WorkerConnections)

    refute Process.alive?(scheduler)
    refute Process.alive?(provisioner)
    refute Process.alive?(dispatcher)
    refute Process.alive?(connections)
  end
end
