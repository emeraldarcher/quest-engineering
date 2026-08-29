defmodule QuestEngineering.Core.Product.TacticDefinition do
  @moduledoc "A mutable named Product definition containing reusable Tactic authoring data."

  alias QuestEngineering.Core.Product.TacticAuthoring

  @enforce_keys [:id, :key, :name, :description, :body]
  defstruct [:id, :key, :name, :description, :body]

  @type t :: %__MODULE__{
          id: String.t(),
          key: String.t(),
          name: String.t(),
          description: String.t(),
          body: TacticAuthoring.t()
        }
end

defmodule QuestEngineering.Core.Product.TacticSource.Inline do
  @moduledoc "A Quest-local authoring Tactic."

  alias QuestEngineering.Core.Product.TacticAuthoring

  @enforce_keys [:body]
  defstruct [:body]

  @type t :: %__MODULE__{body: TacticAuthoring.t()}
end

defmodule QuestEngineering.Core.Product.TacticSource.Definition do
  @moduledoc "A Quest selection of one current reusable Tactic Definition."

  @enforce_keys [:tactic_definition_id]
  defstruct [:tactic_definition_id]

  @type t :: %__MODULE__{tactic_definition_id: String.t()}
end

defmodule QuestEngineering.Core.Product.TacticSource do
  @moduledoc "The explicit inline-or-definition source selected by a Quest."

  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline

  @type t :: Inline.t() | Definition.t()

  @spec inline(QuestEngineering.Core.Product.TacticAuthoring.t()) :: Inline.t()
  def inline(body), do: %Inline{body: body}

  @spec definition(String.t()) :: Definition.t()
  def definition(id), do: %Definition{tactic_definition_id: id}
end
