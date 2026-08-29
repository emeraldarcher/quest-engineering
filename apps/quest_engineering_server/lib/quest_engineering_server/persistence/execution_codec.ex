defmodule QuestEngineering.Server.Persistence.LaunchSnapshotCodec do
  @moduledoc "Versioned codec for immutable Product launch snapshots."

  alias QuestEngineering.Core.Product.LaunchSnapshot
  alias QuestEngineering.Server.Persistence.Error
  alias QuestEngineering.Server.Persistence.RuntimeCodec

  @version 2
  @supported_versions [1, 2]
  def version, do: @version

  def encode(%LaunchSnapshot{} = snapshot), do: RuntimeCodec.encode(snapshot)

  def decode(payload, version) when version in @supported_versions do
    case RuntimeCodec.decode(payload) do
      {:ok, %LaunchSnapshot{} = snapshot} -> {:ok, snapshot}
      {:ok, value} -> {:error, %Error{type: :invalid_persisted_term, details: %{value: value}}}
      {:error, error} -> {:error, error}
    end
  end

  def decode(_payload, version),
    do: {:error, %Error{type: :unsupported_snapshot_version, details: %{version: version}}}
end

defmodule QuestEngineering.Server.Persistence.ResolvedExecutionCodec do
  @moduledoc "Versioned codec for provider-neutral scheduled execution values."

  alias QuestEngineering.Core.ResolvedExecution
  alias QuestEngineering.Server.Persistence.Error
  alias QuestEngineering.Server.Persistence.RuntimeCodec

  @version 1
  def version, do: @version

  def encode(%ResolvedExecution{} = execution), do: RuntimeCodec.encode(execution)

  def decode(payload, @version) do
    case RuntimeCodec.decode(payload) do
      {:ok, %ResolvedExecution{} = execution} -> {:ok, execution}
      {:ok, value} -> {:error, %Error{type: :invalid_persisted_term, details: %{value: value}}}
      {:error, error} -> {:error, error}
    end
  end

  def decode(_payload, version),
    do: {:error, %Error{type: :unsupported_snapshot_version, details: %{version: version}}}
end
