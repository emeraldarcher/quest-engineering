defmodule QuestEngineering.Core.ExecutionPlan do
  @moduledoc """
  Deterministic static output of semantic tactic compilation.

  Ordinary dependencies remain static and acyclic. Dynamic check/remediate
  repetition is retained in `control_regions`; it is never lowered to graph
  cycles. Dependencies may address a control-region reference, whose completion
  (rather than any one repeated step execution) gates following static work.
  """

  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.Step
  alias QuestEngineering.Core.ExecutionPlan.UntilRegion

  @enforce_keys [:steps, :control_dependencies, :artifact_bindings, :control_regions]
  defstruct [:steps, :control_dependencies, :artifact_bindings, :control_regions]

  @type t :: %__MODULE__{
          steps: [Step.t()],
          control_dependencies: [ControlDependency.t()],
          artifact_bindings: [ArtifactBinding.t()],
          control_regions: [UntilRegion.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.Step do
  @moduledoc "Static executable step metadata retained in a compiled plan."

  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  @enforce_keys [:key, :name, :instruction, :performer, :context, :produces]
  defstruct [:key, :name, :instruction, :performer, :context, :produces]

  @type t :: %__MODULE__{
          key: String.t(),
          name: String.t(),
          instruction: String.t(),
          performer: PerformerRequirement.t(),
          context: ContextRequirement.t(),
          produces: [String.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlRegionReference do
  @moduledoc "A deterministic static dependency endpoint for a dynamic control region."

  @enforce_keys [:id]
  defstruct [:id]

  @type t :: %__MODULE__{id: String.t()}
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlDependency do
  @moduledoc "A static ordering requirement between steps or a control-region boundary."

  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference

  @enforce_keys [:prerequisite, :dependent]
  defstruct [:prerequisite, :dependent]

  @type endpoint :: String.t() | ControlRegionReference.t()
  @type t :: %__MODULE__{prerequisite: endpoint(), dependent: endpoint()}
end

defmodule QuestEngineering.Core.ExecutionPlan.UntilOutput do
  @moduledoc "A dynamic artifact value exposed when an Until region completes."

  @enforce_keys [:region, :type, :kind, :producer]
  defstruct [:region, :type, :kind, :producer]

  @type t :: %__MODULE__{
          region: String.t(),
          type: String.t(),
          kind: :check | :carried,
          producer: String.t() | t() | nil
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ArtifactBinding do
  @moduledoc "A resolved fixed input source outside loop-carried region inputs."

  alias QuestEngineering.Core.ExecutionPlan.UntilOutput

  @enforce_keys [:consumer, :type, :producer]
  defstruct [:consumer, :type, :producer]

  @type t :: %__MODULE__{
          consumer: String.t(),
          type: String.t(),
          producer: String.t() | UntilOutput.t()
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlSubtree do
  @moduledoc "Static shape of one phase nested in a dynamic control region."

  alias QuestEngineering.Core.ExecutionPlan.ControlDependency

  @enforce_keys [:entries, :exits, :step_keys, :control_dependencies, :control_regions]
  defstruct [:entries, :exits, :step_keys, :control_dependencies, :control_regions]

  @type t :: %__MODULE__{
          entries: [ControlDependency.endpoint()],
          exits: [ControlDependency.endpoint()],
          step_keys: [String.t()],
          control_dependencies: [ControlDependency.t()],
          control_regions: [String.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ConditionBinding do
  @moduledoc "The check-local producer bound to an Until condition."

  @enforce_keys [:artifact_type, :producer, :field, :operator, :value]
  defstruct [:artifact_type, :producer, :field, :operator, :value]

  @type literal :: String.t() | integer() | float() | boolean() | nil
  @type t :: %__MODULE__{
          artifact_type: String.t(),
          producer: String.t(),
          field: String.t(),
          operator: :equals,
          value: literal()
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding do
  @moduledoc "A phase input read from an Until region's current carried value."

  @enforce_keys [:consumer, :type, :phase, :source]
  defstruct [:consumer, :type, :phase, :source]

  @type t :: %__MODULE__{
          consumer: String.t(),
          type: String.t(),
          phase: :check | :otherwise,
          source: :current
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ArtifactCarry do
  @moduledoc "A semantic artifact value evolved by an Until remediation."

  alias QuestEngineering.Core.ExecutionPlan.UntilOutput

  @enforce_keys [
    :type,
    :initial_producer,
    :remediation_producer,
    :check_consumers,
    :otherwise_consumers
  ]
  defstruct [
    :type,
    :initial_producer,
    :remediation_producer,
    :check_consumers,
    :otherwise_consumers
  ]

  @type producer :: String.t() | UntilOutput.t()
  @type t :: %__MODULE__{
          type: String.t(),
          initial_producer: producer(),
          remediation_producer: producer(),
          check_consumers: [String.t()],
          otherwise_consumers: [String.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.UntilRegion do
  @moduledoc """
  Compiled check-first bounded repetition.

  A future runtime enters `check`, evaluates `condition_binding`, completes on
  equality, or runs `otherwise` while remediation budget remains. The model
  records exhaustion at the boundary (the budget can be depleted while the
  condition is unsatisfied) but deliberately assigns no runtime failure policy.
  """

  alias QuestEngineering.Core.ExecutionPlan.ArtifactCarry
  alias QuestEngineering.Core.ExecutionPlan.ConditionBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlSubtree
  alias QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.Tactics.Condition

  @enforce_keys [
    :id,
    :parent_region,
    :check,
    :condition,
    :condition_binding,
    :otherwise,
    :max_remediations,
    :artifact_bindings,
    :artifact_carries,
    :outputs
  ]
  defstruct [
    :id,
    :parent_region,
    :check,
    :condition,
    :condition_binding,
    :otherwise,
    :max_remediations,
    :artifact_bindings,
    :artifact_carries,
    :outputs
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          parent_region: String.t() | nil,
          check: ControlSubtree.t(),
          condition: Condition.t(),
          condition_binding: ConditionBinding.t(),
          otherwise: ControlSubtree.t(),
          max_remediations: pos_integer(),
          artifact_bindings: [RegionArtifactBinding.t()],
          artifact_carries: [ArtifactCarry.t()],
          outputs: [UntilOutput.t()]
        }
end
