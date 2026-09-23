defmodule QuestEngineering.Server.Repo.Migrations.AddExecutionCancellation do
  use Ecto.Migration

  def change do
    alter table(:worker_dispatches) do
      add :cancellation_request_id, :text
      add :cancellation_origin, :string
      add :cancellation_reason, :text
      add :cancellation_requested_generation, :bigint
      add :cancellation_requested_at, :utc_datetime_usec
    end

    create unique_index(:worker_dispatches, [:cancellation_request_id],
             where: "cancellation_request_id IS NOT NULL",
             name: :worker_dispatches_cancellation_request_index
           )

    create constraint(:worker_dispatches, :worker_dispatches_cancellation_provenance_valid,
             check: """
             (cancellation_request_id IS NULL AND cancellation_origin IS NULL AND cancellation_reason IS NULL AND cancellation_requested_generation IS NULL AND cancellation_requested_at IS NULL)
             OR
             (cancellation_request_id IS NOT NULL AND cancellation_origin = 'product_operator' AND cancellation_requested_generation IS NOT NULL AND cancellation_requested_at IS NOT NULL)
             """
           )
  end
end
