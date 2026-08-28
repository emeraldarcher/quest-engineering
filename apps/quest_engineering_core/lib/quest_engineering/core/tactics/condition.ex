defmodule QuestEngineering.Core.Tactics.ArtifactField do
  @moduledoc "A serializable reference to one field of a typed artifact."

  alias QuestEngineering.Core.Tactics.Artifact

  @enforce_keys [:artifact, :field]
  defstruct [:artifact, :field]

  @type t :: %__MODULE__{artifact: Artifact.t(), field: String.t()}
end

defmodule QuestEngineering.Core.Tactics.Condition do
  @moduledoc "A deliberately small, data-only artifact-field comparison."

  alias QuestEngineering.Core.Tactics.Artifact

  @enforce_keys [:artifact, :field, :operator, :value]
  defstruct [:artifact, :field, :operator, :value]

  @type literal :: String.t() | integer() | float() | boolean() | nil
  @type t :: %__MODULE__{
          artifact: Artifact.t(),
          field: String.t(),
          operator: :equals,
          value: literal()
        }
end
