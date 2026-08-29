defmodule QuestEngineering.Core.Product.TacticProvenance.Root do
  @moduledoc false

  @enforce_keys [:kind]
  defstruct [:kind, :definition_id, :definition_key, :definition_name]

  @type t :: %__MODULE__{
          kind: :inline | :definition,
          definition_id: String.t() | nil,
          definition_key: String.t() | nil,
          definition_name: String.t() | nil
        }
end

defmodule QuestEngineering.Core.Product.TacticProvenance.Occurrence do
  @moduledoc false

  @enforce_keys [
    :instance_path,
    :definition_id,
    :definition_key,
    :definition_name
  ]
  defstruct [:instance_path, :definition_id, :definition_key, :definition_name]

  @type t :: %__MODULE__{
          instance_path: [String.t()],
          definition_id: String.t(),
          definition_key: String.t(),
          definition_name: String.t()
        }
end

defmodule QuestEngineering.Core.Product.TacticProvenance do
  @moduledoc "Lightweight definition-occurrence provenance frozen into a launch snapshot."

  alias QuestEngineering.Core.Product.TacticProvenance.Occurrence
  alias QuestEngineering.Core.Product.TacticProvenance.Root

  @enforce_keys [:root, :definitions]
  defstruct [:root, :definitions]

  @type t :: %__MODULE__{root: Root.t(), definitions: [Occurrence.t()]}
end
