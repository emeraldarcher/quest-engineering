defmodule QuestEngineering.Server.Persistence.HumanAttentionRequest do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}
  schema "human_attention_requests" do
    field :session_id, :string
    field :worker_id, :string
    field :run_id, :string
    field :action_id, :string
    field :occurrence_id, :string
    field :attempt_id, :string
    field :native_session_id, :string
    field :request_generation, :integer
    field :request, :map
    field :response_state, :string
    field :response, :map
    field :response_request_id, :string
    field :response_submitted_at, :utc_datetime_usec
    field :response_committed_at, :utc_datetime_usec
    field :delivery_state, :string
    field :delivery_attempt_id, :string
    field :delivery_requested_generation, :integer
    field :delivery_requested_at, :utc_datetime_usec
    field :delivery_acknowledged_at, :utc_datetime_usec
    field :delivery_uncertain_at, :utc_datetime_usec
    field :cancelled_at, :utc_datetime_usec
    field :cancellation_reason, :string
    field :surfaced_at, :utc_datetime_usec
    timestamps(type: :utc_datetime_usec)
  end

  def changeset(request \\ %__MODULE__{}, attributes) do
    request
    |> cast(attributes, [
      :id,
      :session_id,
      :worker_id,
      :run_id,
      :action_id,
      :occurrence_id,
      :attempt_id,
      :native_session_id,
      :request_generation,
      :request,
      :response_state,
      :response,
      :response_request_id,
      :response_submitted_at,
      :response_committed_at,
      :delivery_state,
      :delivery_attempt_id,
      :delivery_requested_generation,
      :delivery_requested_at,
      :delivery_acknowledged_at,
      :delivery_uncertain_at,
      :cancelled_at,
      :cancellation_reason,
      :surfaced_at
    ])
    |> validate_required([
      :id,
      :session_id,
      :worker_id,
      :run_id,
      :action_id,
      :occurrence_id,
      :attempt_id,
      :request_generation,
      :request,
      :response_state,
      :delivery_state,
      :surfaced_at
    ])
    |> validate_number(:request_generation, greater_than: 0)
    |> validate_inclusion(:response_state, ~w(pending responded cancelled obsolete))
    |> validate_inclusion(
      :delivery_state,
      ~w(response_not_delivered delivery_requested delivery_acknowledged delivery_uncertain)
    )
    |> foreign_key_constraint(:session_id)
    |> foreign_key_constraint(:worker_id)
    |> foreign_key_constraint(:run_id)
    |> foreign_key_constraint(:action_id)
    |> unique_constraint(:action_id, name: :human_attention_requests_one_active_per_action)
    |> check_constraint(:response_state, name: :human_attention_response_state_valid)
    |> check_constraint(:delivery_state, name: :human_attention_delivery_state_valid)
    |> check_constraint(:request_generation, name: :human_attention_request_generation_valid)
  end
end
