defmodule QuestEngineering.Core.ExecutionPlan do
  @moduledoc "Deterministic static execution specification with named, typed artifact bindings."

  alias QuestEngineering.Core.ExecutionPlan.ArtifactBinding
  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.ExecutionPlan.Step
  alias QuestEngineering.Core.ExecutionPlan.TacticOutput
  alias QuestEngineering.Core.ExecutionPlan.UntilRegion

  @enforce_keys [:steps, :control_dependencies, :artifact_bindings, :control_regions]
  defstruct [
    :steps,
    :control_dependencies,
    :artifact_bindings,
    :control_regions,
    tactic_outputs: []
  ]

  @type t :: %__MODULE__{
          steps: [Step.t()],
          control_dependencies: [ControlDependency.t()],
          artifact_bindings: [ArtifactBinding.t()],
          control_regions: [UntilRegion.t()],
          tactic_outputs: [TacticOutput.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.Step do
  @moduledoc "Static executable Step metadata."
  alias QuestEngineering.Core.Tactics.{
    ArtifactInput,
    ArtifactOutput,
    ContextRequirement,
    PerformerRequirement
  }

  @enforce_keys [:key, :name, :instruction, :performer, :context, :consumes, :produces]
  defstruct [:key, :name, :instruction, :performer, :context, :consumes, :produces]

  @type t :: %__MODULE__{
          key: String.t(),
          name: String.t(),
          instruction: String.t(),
          performer: PerformerRequirement.t(),
          context: ContextRequirement.t(),
          consumes: [ArtifactInput.t()],
          produces: [ArtifactOutput.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlRegionReference do
  @moduledoc false
  @enforce_keys [:id]
  defstruct [:id]
  @type t :: %__MODULE__{id: String.t()}
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlDependency do
  @moduledoc false
  alias QuestEngineering.Core.ExecutionPlan.ControlRegionReference
  @enforce_keys [:prerequisite, :dependent]
  defstruct [:prerequisite, :dependent]
  @type endpoint :: String.t() | ControlRegionReference.t()
  @type t :: %__MODULE__{prerequisite: endpoint(), dependent: endpoint()}
end

defmodule QuestEngineering.Core.ExecutionPlan.UntilOutput do
  @moduledoc "An existing artifact reference exposed when an Until completes."
  @enforce_keys [:region, :name, :kind, :source_kind, :producer]
  defstruct [:region, :name, :kind, :source_kind, :producer]

  @type t :: %__MODULE__{
          region: String.t(),
          name: String.t(),
          kind: String.t(),
          source_kind: :check | :carried,
          producer: QuestEngineering.Core.Tactics.ArtifactRef.t() | t() | nil
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ArtifactBinding do
  @moduledoc "A resolved exact source for one named Step input."
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.Tactics.ArtifactRef
  @enforce_keys [:consumer, :input, :kind, :producer]
  defstruct [:consumer, :input, :kind, :producer, :required]
  @type producer :: ArtifactRef.t() | UntilOutput.t()
  @type t :: %__MODULE__{
          consumer: String.t(),
          input: String.t(),
          kind: String.t(),
          producer: producer(),
          required: boolean()
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ControlSubtree do
  @moduledoc false
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
  @moduledoc "The exact check-local output evaluated by an Until."
  alias QuestEngineering.Core.Tactics.ArtifactRef
  @enforce_keys [:kind, :producer, :field, :operator, :value]
  defstruct [:kind, :producer, :field, :operator, :value]
  @type literal :: String.t() | integer() | float() | boolean() | nil
  @type t :: %__MODULE__{
          kind: String.t(),
          producer: ArtifactRef.t(),
          field: String.t(),
          operator: :equals,
          value: literal()
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.InputEndpoint do
  @moduledoc false
  @enforce_keys [:step, :input]
  defstruct [:step, :input]
  @type t :: %__MODULE__{step: String.t(), input: String.t()}
end

defmodule QuestEngineering.Core.ExecutionPlan.RegionArtifactBinding do
  @moduledoc "A named phase input read from the current loop-carried artifact."
  @enforce_keys [:consumer, :input, :kind, :phase, :source]
  defstruct [:consumer, :input, :kind, :phase, :source]

  @type t :: %__MODULE__{
          consumer: String.t(),
          input: String.t(),
          kind: String.t(),
          phase: :check | :otherwise,
          source: :current
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.ArtifactCarry do
  @moduledoc "One semantic artifact kind evolved by an Until remediation."
  alias QuestEngineering.Core.ExecutionPlan.{InputEndpoint, UntilOutput}
  alias QuestEngineering.Core.Tactics.ArtifactRef

  @enforce_keys [
    :kind,
    :initial_producer,
    :remediation_producer,
    :check_consumers,
    :otherwise_consumers
  ]
  defstruct [
    :kind,
    :initial_producer,
    :remediation_producer,
    :check_consumers,
    :otherwise_consumers
  ]

  @type producer :: ArtifactRef.t() | UntilOutput.t()
  @type t :: %__MODULE__{
          kind: String.t(),
          initial_producer: producer(),
          remediation_producer: producer(),
          check_consumers: [InputEndpoint.t()],
          otherwise_consumers: [InputEndpoint.t()]
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.UntilRegion do
  @moduledoc "Compiled check-first bounded semantic remediation."
  alias QuestEngineering.Core.ExecutionPlan.{
    ArtifactCarry,
    ConditionBinding,
    ControlSubtree,
    RegionArtifactBinding,
    UntilOutput
  }

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
    :outputs,
    :acceptance_gate_key,
    :acceptance_subject_kind
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
          outputs: [UntilOutput.t()],
          acceptance_gate_key: String.t() | nil,
          acceptance_subject_kind: String.t() | nil
        }
end

defmodule QuestEngineering.Core.ExecutionPlan.TacticOutput do
  @moduledoc "A declared root Tactic export mapped to an existing immutable artifact source."
  alias QuestEngineering.Core.ExecutionPlan.UntilOutput
  alias QuestEngineering.Core.Tactics.ArtifactRef
  @enforce_keys [:key, :label, :kind, :producer]
  defstruct [:key, :label, :kind, :producer]

  @type t :: %__MODULE__{
          key: String.t(),
          label: String.t(),
          kind: String.t(),
          producer: ArtifactRef.t() | UntilOutput.t()
        }
end
