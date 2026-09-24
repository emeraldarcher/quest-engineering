defmodule QuestEngineering.Server.Repo.Migrations.ExpandExecutionSessionLifecycleStates do
  use Ecto.Migration

  def up do
    drop constraint(:execution_sessions, :execution_sessions_state_valid)

    create constraint(:execution_sessions, :execution_sessions_state_valid,
             check:
               "state IN ('starting','waiting_for_activity','running','waiting_for_human','stalled','recovering','retained','closed','unavailable')"
           )
  end

  def down do
    drop constraint(:execution_sessions, :execution_sessions_state_valid)

    create constraint(:execution_sessions, :execution_sessions_state_valid,
             check:
               "state IN ('starting','running','waiting_for_human','recovering','retained','closed','unavailable')"
           )
  end
end
