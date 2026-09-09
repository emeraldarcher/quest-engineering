defmodule QuestEngineering.Core.Product.TacticInputPort do
  @moduledoc "A friendly, typed artifact port entering a reusable Tactic."

  @enforce_keys [:key, :label, :kind, :required]
  defstruct [:key, :label, :kind, :required]

  @type t :: %__MODULE__{
          key: String.t(),
          label: String.t(),
          kind: String.t(),
          required: boolean()
        }
end

defmodule QuestEngineering.Core.Product.AcceptedArtifactSource do
  @moduledoc "Exports the exact subject whose verdict satisfied one semantic acceptance gate."

  @enforce_keys [:gate_key]
  defstruct [:gate_key]

  @type t :: %__MODULE__{gate_key: String.t()}
end

defmodule QuestEngineering.Core.Product.TacticOutputPort do
  @moduledoc "A friendly, typed semantic result exported by a reusable Tactic."

  alias QuestEngineering.Core.Product.AcceptedArtifactSource
  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [:key, :label, :kind, :source]
  defstruct [:key, :label, :kind, :source]

  @type t :: %__MODULE__{
          key: String.t(),
          label: String.t(),
          kind: String.t(),
          source: ArtifactRef.t() | AcceptedArtifactSource.t()
        }
end

defmodule QuestEngineering.Core.Product.TacticInterface do
  @moduledoc "The intentionally small artifact contract of one reusable Tactic."

  alias QuestEngineering.Core.Product.TacticInputPort
  alias QuestEngineering.Core.Product.TacticOutputPort

  defstruct inputs: [], outputs: []

  @type t :: %__MODULE__{inputs: [TacticInputPort.t()], outputs: [TacticOutputPort.t()]}
end

defmodule QuestEngineering.Core.Product.TacticInputBinding do
  @moduledoc "An explicit parent binding for one child Tactic input port."

  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [:input, :source]
  defstruct [:input, :source]

  @type t :: %__MODULE__{input: String.t(), source: ArtifactRef.t()}
end
