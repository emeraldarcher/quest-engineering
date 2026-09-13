defmodule QuestEngineering.Server.Repo.Migrations.RenameNativeSessionIdentity do
  use Ecto.Migration

  def change do
    rename table(:execution_sessions), :provider_session_id, to: :native_session_id
  end
end
