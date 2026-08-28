defmodule QuestEngineering.Server.DataCase do
  @moduledoc false

  use ExUnit.CaseTemplate

  alias Ecto.Adapters.SQL.Sandbox
  alias QuestEngineering.Server.Repo

  using do
    quote do
      alias QuestEngineering.Server.Repo

      import Ecto
      import Ecto.Changeset
      import Ecto.Query
      import QuestEngineering.Server.DataCase
    end
  end

  setup tags do
    owner = Sandbox.start_owner!(Repo, shared: not tags[:async])

    on_exit(fn -> Sandbox.stop_owner(owner) end)
    :ok
  end
end
