defmodule QuestEngineering.Server.WorkspaceResolver do
  @moduledoc "Deprecated v3 compatibility boundary. Phoenix no longer resolves or inspects repository paths."

  defmodule Error do
    @moduledoc false
    @enforce_keys [:code, :details]
    defstruct [:code, :details]
  end

  def resolve(reference),
    do:
      {:error,
       %Error{
         code: :server_workspace_resolution_removed,
         details: %{workspace_reference: reference, protocol: 4}
       }}

  def list, do: []
end
