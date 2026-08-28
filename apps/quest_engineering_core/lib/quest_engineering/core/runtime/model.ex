defmodule QuestEngineering.Core.Runtime.Run do
  @moduledoc "Immutable state for one deterministic execution-plan run."

  alias QuestEngineering.Core.ExecutionPlan
  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Runtime.Failure
  alias QuestEngineering.Core.Runtime.RegionOccurrence
  alias QuestEngineering.Core.Runtime.Scope
  alias QuestEngineering.Core.Runtime.StepOccurrence

  @enforce_keys [
    :id,
    :plan,
    :status,
    :occurrences,
    :occurrence_order,
    :regions,
    :region_order,
    :scopes,
    :scope_order,
    :artifacts,
    :artifact_order,
    :counters
  ]
  defstruct [
    :id,
    :plan,
    :status,
    :failure,
    :root_scope_id,
    :occurrences,
    :occurrence_order,
    :regions,
    :region_order,
    :scopes,
    :scope_order,
    :artifacts,
    :artifact_order,
    :counters
  ]

  @type status :: :running | :completed | :failed
  @type counters :: %{
          occurrence: non_neg_integer(),
          region: non_neg_integer(),
          scope: non_neg_integer(),
          artifact: non_neg_integer()
        }
  @type t :: %__MODULE__{
          id: String.t(),
          plan: ExecutionPlan.t(),
          status: status(),
          failure: Failure.t() | nil,
          root_scope_id: String.t() | nil,
          occurrences: %{optional(String.t()) => StepOccurrence.t()},
          occurrence_order: [String.t()],
          regions: %{optional(String.t()) => RegionOccurrence.t()},
          region_order: [String.t()],
          scopes: %{optional(String.t()) => Scope.t()},
          scope_order: [String.t()],
          artifacts: %{optional(String.t()) => ArtifactInstance.t()},
          artifact_order: [String.t()],
          counters: counters()
        }
end

defmodule QuestEngineering.Core.Runtime.Scope do
  @moduledoc false

  alias QuestEngineering.Core.ExecutionPlan.ControlDependency
  alias QuestEngineering.Core.Runtime.ResolvedUntilOutput

  @enforce_keys [
    :id,
    :kind,
    :status,
    :control_path,
    :step_keys,
    :region_ids,
    :dependencies,
    :step_occurrences,
    :region_occurrences,
    :step_artifacts,
    :region_outputs,
    :lineage
  ]
  defstruct [
    :id,
    :kind,
    :status,
    :region_occurrence_id,
    :remediation_cycle,
    :control_path,
    :step_keys,
    :region_ids,
    :dependencies,
    :step_occurrences,
    :region_occurrences,
    :step_artifacts,
    :region_outputs,
    :lineage
  ]

  @type kind :: :root | :check | :otherwise
  @type t :: %__MODULE__{
          id: String.t(),
          kind: kind(),
          status: :active | :completed,
          region_occurrence_id: String.t() | nil,
          remediation_cycle: non_neg_integer() | nil,
          control_path: [String.t()],
          step_keys: [String.t()],
          region_ids: [String.t()],
          dependencies: [ControlDependency.t()],
          step_occurrences: %{optional(String.t()) => String.t()},
          region_occurrences: %{optional(String.t()) => String.t()},
          step_artifacts: %{optional(String.t()) => %{optional(String.t()) => String.t()}},
          region_outputs: [ResolvedUntilOutput.t()],
          lineage: %{optional(String.t()) => String.t()}
        }
end

defmodule QuestEngineering.Core.Runtime.StepOccurrence do
  @moduledoc "One runtime occurrence of a semantic step in a control-flow scope."

  alias QuestEngineering.Core.Runtime.ExecutionAttempt
  alias QuestEngineering.Core.Runtime.Scope

  @enforce_keys [
    :id,
    :semantic_step_key,
    :scope_id,
    :control_path,
    :status,
    :attempts,
    :input_artifact_ids,
    :output_artifact_ids
  ]
  defstruct [
    :id,
    :semantic_step_key,
    :scope_id,
    :region_occurrence_id,
    :phase,
    :remediation_cycle,
    :control_path,
    :status,
    :current_attempt_id,
    :attempts,
    :input_artifact_ids,
    :output_artifact_ids
  ]

  @type status :: :pending | :dispatched | :completed | :failed
  @type t :: %__MODULE__{
          id: String.t(),
          semantic_step_key: String.t(),
          scope_id: String.t(),
          region_occurrence_id: String.t() | nil,
          phase: Scope.kind(),
          remediation_cycle: non_neg_integer() | nil,
          control_path: [String.t()],
          status: status(),
          current_attempt_id: String.t() | nil,
          attempts: [ExecutionAttempt.t()],
          input_artifact_ids: %{optional(String.t()) => String.t()},
          output_artifact_ids: %{optional(String.t()) => String.t()}
        }
end

defmodule QuestEngineering.Core.Runtime.ExecutionAttempt do
  @moduledoc "A concrete try to execute one step occurrence; the runtime currently creates exactly one."

  @enforce_keys [:id, :number, :status]
  defstruct [:id, :number, :status]

  @type t :: %__MODULE__{
          id: String.t(),
          number: pos_integer(),
          status: :dispatched | :completed | :failed
        }
end

defmodule QuestEngineering.Core.Runtime.RegionOccurrence do
  @moduledoc "Runtime state for one entry into a compiled Until region."

  alias QuestEngineering.Core.Runtime.ResolvedUntilOutput

  @enforce_keys [
    :id,
    :semantic_region_id,
    :parent_scope_id,
    :control_path,
    :status,
    :remediations_completed,
    :check_scope_ids,
    :otherwise_scope_ids,
    :current_artifacts,
    :entering_step_artifacts,
    :entering_region_outputs,
    :entering_lineage,
    :output_artifacts,
    :exposed_lineage
  ]
  defstruct [
    :id,
    :semantic_region_id,
    :parent_scope_id,
    :parent_region_occurrence_id,
    :control_path,
    :status,
    :remediations_completed,
    :current_check_scope_id,
    :current_otherwise_scope_id,
    :check_scope_ids,
    :otherwise_scope_ids,
    :current_artifacts,
    :entering_step_artifacts,
    :entering_region_outputs,
    :entering_lineage,
    :output_artifacts,
    :exposed_lineage
  ]

  @type status :: :checking | :remediating | :completed | :exhausted
  @type t :: %__MODULE__{
          id: String.t(),
          semantic_region_id: String.t(),
          parent_scope_id: String.t(),
          parent_region_occurrence_id: String.t() | nil,
          control_path: [String.t()],
          status: status(),
          remediations_completed: non_neg_integer(),
          current_check_scope_id: String.t() | nil,
          current_otherwise_scope_id: String.t() | nil,
          check_scope_ids: [String.t()],
          otherwise_scope_ids: [String.t()],
          current_artifacts: %{optional(String.t()) => String.t()},
          entering_step_artifacts: map(),
          entering_region_outputs: [ResolvedUntilOutput.t()],
          entering_lineage: %{optional(String.t()) => String.t()},
          output_artifacts: [ResolvedUntilOutput.t()],
          exposed_lineage: %{optional(String.t()) => String.t()}
        }
end

defmodule QuestEngineering.Core.Runtime.ArtifactInstance do
  @moduledoc "A typed runtime artifact value produced by one completed occurrence."

  @enforce_keys [:id, :type, :producer_occurrence_id, :value]
  defstruct [:id, :type, :producer_occurrence_id, :value]

  @type value ::
          String.t()
          | integer()
          | float()
          | boolean()
          | nil
          | [value()]
          | %{optional(String.t()) => value()}
  @type t :: %__MODULE__{
          id: String.t(),
          type: String.t(),
          producer_occurrence_id: String.t(),
          value: value()
        }
end

defmodule QuestEngineering.Core.Runtime.ResolvedUntilOutput do
  @moduledoc false

  alias QuestEngineering.Core.ExecutionPlan.UntilOutput

  @enforce_keys [:output, :artifact_id]
  defstruct [:output, :artifact_id]

  @type t :: %__MODULE__{output: UntilOutput.t(), artifact_id: String.t()}
end

defmodule QuestEngineering.Core.Runtime.Action do
  @moduledoc "A side-effect request emitted by the pure runtime for an outside executor."

  alias QuestEngineering.Core.Runtime.ArtifactInstance
  alias QuestEngineering.Core.Tactics.ContextRequirement
  alias QuestEngineering.Core.Tactics.PerformerRequirement

  @enforce_keys [
    :id,
    :type,
    :run_id,
    :occurrence_id,
    :attempt_id,
    :semantic_step_key,
    :instruction,
    :performer_requirement,
    :context_requirement,
    :inputs,
    :declared_outputs
  ]
  defstruct [
    :id,
    :type,
    :run_id,
    :occurrence_id,
    :attempt_id,
    :semantic_step_key,
    :instruction,
    :performer_requirement,
    :performer_affinity_occurrence_id,
    :context_requirement,
    :context_lineage_occurrence_id,
    :inputs,
    :declared_outputs
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          type: :execute_step,
          run_id: String.t(),
          occurrence_id: String.t(),
          attempt_id: String.t(),
          semantic_step_key: String.t(),
          instruction: String.t(),
          performer_requirement: PerformerRequirement.t(),
          performer_affinity_occurrence_id: String.t() | nil,
          context_requirement: ContextRequirement.t(),
          context_lineage_occurrence_id: String.t() | nil,
          inputs: %{optional(String.t()) => ArtifactInstance.t()},
          declared_outputs: [String.t()]
        }
end

defmodule QuestEngineering.Core.Runtime.Event do
  @moduledoc "External fact submitted to the pure runtime."

  alias QuestEngineering.Core.Runtime.ArtifactInstance

  @enforce_keys [:type, :occurrence_id, :attempt_id, :outputs]
  defstruct [:type, :occurrence_id, :attempt_id, :outputs]

  @type t :: %__MODULE__{
          type: :step_completed,
          occurrence_id: String.t(),
          attempt_id: String.t(),
          outputs: %{optional(String.t()) => ArtifactInstance.value()}
        }
end

defmodule QuestEngineering.Core.Runtime.Error do
  @moduledoc "Machine-readable rejection of an invalid start or transition request."

  @enforce_keys [:type]
  defstruct [:type, :run_id, :occurrence_id, :attempt_id, :artifact_type, :details]

  @type error_type ::
          :invalid_execution_plan
          | :invalid_event
          | :run_already_terminal
          | :unknown_occurrence
          | :invalid_occurrence_state
          | :duplicate_completion
          | :invalid_attempt
          | :missing_output
          | :undeclared_output
          | :invalid_artifact_value
  @type t :: %__MODULE__{
          type: error_type(),
          run_id: String.t() | nil,
          occurrence_id: String.t() | nil,
          attempt_id: String.t() | nil,
          artifact_type: String.t() | nil,
          details: term()
        }
end

defmodule QuestEngineering.Core.Runtime.Failure do
  @moduledoc "A valid runtime event's structured terminal failure result."

  @enforce_keys [:type]
  defstruct [:type, :region_id, :region_occurrence_id, :remediations, :details]

  @type t :: %__MODULE__{
          type: :until_exhausted,
          region_id: String.t(),
          region_occurrence_id: String.t(),
          remediations: non_neg_integer(),
          details: term()
        }
end
