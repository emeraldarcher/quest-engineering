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

defmodule QuestEngineering.Core.Product.ToolPolicy.Exact do
  @moduledoc "User-authored execution intent requesting an exactly enforced QE capability subset."
  @enforce_keys [:tools]
  defstruct [:tools]
  @type t :: %__MODULE__{tools: [String.t()]}
end

defmodule QuestEngineering.Core.Product.ToolPolicy.NativePermissions do
  @moduledoc "User-authored execution intent to use a harness's native tools and authorization system."
  defstruct []
  @type t :: %__MODULE__{}
end

defmodule QuestEngineering.Core.Product.Loadout do
  @moduledoc """
  Capability and resource configuration with no behavioral instructions.

  `tool_policy` is user-authored execution intent. Harness enforcement and the
  execution-time QE semantic capability profile are resolved later and are not
  Loadout knobs.
  """

  alias QuestEngineering.Core.Product.ModelRef

  @enforce_keys [
    :id,
    :key,
    :name,
    :description,
    :harness,
    :model,
    :reasoning,
    :tool_policy,
    :workspace_access
  ]
  defstruct [
    :id,
    :key,
    :name,
    :description,
    :harness,
    :model,
    :reasoning,
    :tool_policy,
    :workspace_access
  ]

  @type reasoning :: String.t() | nil
  @type tool_policy ::
          QuestEngineering.Core.Product.ToolPolicy.Exact.t()
          | QuestEngineering.Core.Product.ToolPolicy.NativePermissions.t()
  @type workspace_access :: :none | :read_only | :read_write
  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          harness: String.t(),
          model: ModelRef.t(),
          reasoning: reasoning(),
          tool_policy: tool_policy(),
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
