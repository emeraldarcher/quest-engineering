defmodule QuestEngineering.Core.Product.Class do
  @moduledoc "A mutable product definition describing one behavioral role."

  @enforce_keys [:id, :key, :name, :description, :instructions]
  defstruct [:id, :key, :name, :description, :instructions]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          instructions: String.t()
        }
end

defmodule QuestEngineering.Core.Product.ModelRef do
  @moduledoc "A provider-qualified model identity independent of any execution adapter."

  @enforce_keys [:provider, :model]
  defstruct [:provider, :model]

  @type t :: %__MODULE__{provider: String.t(), model: String.t()}
end

defmodule QuestEngineering.Core.Product.Loadout do
  @moduledoc """
  Capability and resource configuration with no behavioral instructions.

  `tools` contains Quest Engineering capability identifiers. Provider adapters
  map those identifiers to native tools; Loadouts never contain Pi tool names.
  """

  alias QuestEngineering.Core.Product.ModelRef

  @enforce_keys [
    :id,
    :key,
    :name,
    :description,
    :model,
    :reasoning,
    :tools,
    :workspace_access
  ]
  defstruct [
    :id,
    :key,
    :name,
    :description,
    :model,
    :reasoning,
    :tools,
    :workspace_access
  ]

  @type reasoning :: :low | :medium | :high
  @type workspace_access :: :none | :read_only | :read_write
  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          model: ModelRef.t(),
          reasoning: reasoning(),
          tools: [String.t()],
          workspace_access: workspace_access()
        }
end

defmodule QuestEngineering.Core.Product.Member do
  @moduledoc "A Squad-scoped named roster slot referencing one Class and one Loadout."

  @enforce_keys [:key, :name, :class_id, :loadout_id]
  defstruct [:key, :name, :class_id, :loadout_id]

  @type t :: %__MODULE__{
          key: String.t(),
          name: String.t(),
          class_id: String.t(),
          loadout_id: String.t()
        }
end

defmodule QuestEngineering.Core.Product.Squad do
  @moduledoc "A reusable ordered roster which owns no orchestration."

  alias QuestEngineering.Core.Product.Member

  @enforce_keys [:id, :key, :name, :description, :members]
  defstruct [:id, :key, :name, :description, :members]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          members: [Member.t()]
        }
end

defmodule QuestEngineering.Core.Product.Workspace do
  @moduledoc "A path-free logical product workspace which may be bound on many Workers."

  @enforce_keys [:id, :key, :name, :source_kind]
  defstruct [:id, :key, :name, :source_kind, :source_fingerprint]

  @type source_kind :: :git_remote | :local_git
  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          source_kind: source_kind(),
          source_fingerprint: String.t() | nil
        }
end

defmodule QuestEngineering.Core.Product.Quest do
  @moduledoc "A user's objective and selected logical Workspace, Squad, and Tactic source."

  alias QuestEngineering.Core.Product.TacticSource

  @enforce_keys [:id, :title, :objective, :workspace_id, :squad_id, :tactic_source]
  defstruct [:id, :title, :objective, :workspace_id, :squad_id, :tactic_source]

  @type t :: %__MODULE__{
          id: String.t(),
          title: String.t(),
          objective: String.t(),
          workspace_id: String.t(),
          squad_id: String.t(),
          tactic_source: TacticSource.t()
        }
end
