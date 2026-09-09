defmodule QuestEngineering.Core.Tactics.ArtifactRef do
  @moduledoc "An exact reference to one named output in the current authoring scope."

  @enforce_keys [:producer, :output]
  defstruct [:producer, :output]

  @type t :: %__MODULE__{producer: String.t(), output: String.t()}
end

defmodule QuestEngineering.Core.Tactics.ArtifactInput do
  @moduledoc "A named, typed Step input slot bound to an exact artifact or inferred by kind."

  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [:name, :kind]
  defstruct [:name, :kind, :source, required: true]

  @type t :: %__MODULE__{
          name: String.t(),
          kind: String.t(),
          source: ArtifactRef.t() | nil,
          required: boolean()
        }
end

defmodule QuestEngineering.Core.Tactics.ReviewContract do
  @moduledoc "The semantic gate and exact local input reviewed by a Review Verdict output."

  @enforce_keys [:gate_key, :subject_input]
  defstruct [:gate_key, :subject_input]

  @type t :: %__MODULE__{gate_key: String.t(), subject_input: String.t()}
end

defmodule QuestEngineering.Core.Tactics.ArtifactOutput do
  @moduledoc "A named Step output slot and its open semantic artifact kind."

  alias QuestEngineering.Core.Tactics.ReviewContract

  @enforce_keys [:name, :kind]
  defstruct [:name, :kind, :review]

  @type t :: %__MODULE__{
          name: String.t(),
          kind: String.t(),
          review: ReviewContract.t() | nil
        }
end
