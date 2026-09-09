defmodule QuestEngineering.Core.Tactics.ArtifactField do
  @moduledoc "A serializable field reference on one exact named artifact output."

  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [:source, :field]
  defstruct [:source, :field]

  @type t :: %__MODULE__{source: ArtifactRef.t(), field: String.t()}
end

defmodule QuestEngineering.Core.Tactics.Condition do
  @moduledoc "A deliberately small, data-only comparison against an exact output binding."

  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [:source, :field, :operator, :value]
  defstruct [:source, :field, :operator, :value]

  @type literal :: String.t() | integer() | float() | boolean() | nil
  @type t :: %__MODULE__{
          source: ArtifactRef.t(),
          field: String.t(),
          operator: :equals,
          value: literal()
        }
end
