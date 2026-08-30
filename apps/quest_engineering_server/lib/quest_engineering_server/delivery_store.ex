# credo:disable-for-this-file Credo.Check.Refactor.Nesting
defmodule QuestEngineering.Server.DeliveryStore do
  @moduledoc "Post-Run Delivery persistence, launch eligibility, and exact PR identity checks."

  import Ecto.Query
  alias Ecto.Changeset
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.RunWorkspaceAssignment
  alias QuestEngineering.Server.Persistence.Worker
  alias QuestEngineering.Server.ProductChangeNotifier
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.RunChangeNotifier

  @active ~w(pending preparing publishing creating_review review_open)
  @nonrecoverable_attention ~w(pull_request_identity_mismatch cross_repository_pull_request_not_supported remote_branch_conflict delivery_content_changed base_branch_unresolved base_revision_unresolved)

  def ensure_for_completed_run(run_id) do
    launch = Repo.get_by!(QuestLaunch, run_id: run_id)

    case launch && Repo.get_by(RunDelivery, run_id: run_id) do
      %RunDelivery{} = delivery ->
        delivery

      nil when not is_nil(launch) ->
        now = now()

        Repo.insert!(
          RunDelivery.changeset(%{
            id: Ecto.UUID.generate(),
            run_id: run_id,
            quest_id: launch.quest_id,
            state: "pending",
            command_revision: 1,
            automatic_attempted_at: now
          })
        )

      nil ->
        Repo.rollback(:launch_not_found)
    end
  end

  def fetch(run_id), do: Repo.get_by(RunDelivery, run_id: run_id)

  def ensure_latest_completed_runs do
    Repo.all(
      from launch in QuestLaunch,
        join: run in RuntimeRun,
        on: run.id == launch.run_id,
        join: quest in ProductQuest,
        on: quest.id == launch.quest_id,
        left_join: delivery in RunDelivery,
        on: delivery.run_id == launch.run_id,
        where: run.status == "completed" and is_nil(quest.completed_at) and is_nil(delivery.id),
        order_by: [desc: launch.inserted_at]
    )
    |> Enum.uniq_by(& &1.quest_id)
    |> Enum.each(fn launch ->
      case Repo.transaction(fn -> ensure_for_completed_run(launch.run_id) end) do
        {:ok, _} -> :ok
        {:error, _} -> :ok
      end
    end)

    :ok
  end

  def list_reconcilable do
    Repo.all(
      from delivery in RunDelivery,
        where: delivery.state in ^@active or delivery.state == "attention_required",
        order_by: delivery.inserted_at
    )
  end

  def list_open do
    Repo.all(
      from delivery in RunDelivery,
        where: delivery.state == "review_open",
        order_by: delivery.last_reconciled_at
    )
  end

  def launch_eligibility(quest_id) do
    quest = Repo.one(from quest in ProductQuest, where: quest.id == ^quest_id, lock: "FOR UPDATE")

    cond do
      is_nil(quest) -> {:error, :not_found}
      quest.completed_at -> {:error, :quest_completed}
      true -> latest_eligibility(quest_id)
    end
  end

  defp latest_eligibility(quest_id) do
    latest =
      Repo.one(
        from launch in QuestLaunch,
          where: launch.quest_id == ^quest_id,
          order_by: [desc: launch.inserted_at],
          limit: 1
      )

    if is_nil(latest), do: :ok, else: run_eligibility(latest.run_id)
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp run_eligibility(run_id) do
    run = Repo.get(RuntimeRun, run_id)
    delivery = fetch(run_id)

    cond do
      is_nil(run) ->
        {:error, :run_state_uncertain}

      run.status == "running" ->
        {:error, :run_active}

      run.status == "failed" ->
        :ok

      is_nil(delivery) ->
        {:error, :delivery_pending}

      delivery.state in ["closed_unmerged", "no_changes"] ->
        :ok

      delivery.state == "merged" ->
        {:error, :quest_completed}

      delivery.state == "attention_required" and recoverable_attention?(delivery) ->
        {:error, :retry_publishing_required}

      delivery.state == "attention_required" ->
        :ok

      delivery.state in @active ->
        {:error, :delivery_active}

      true ->
        {:error, :delivery_pending}
    end
  end

  def preparing(run_id) do
    transition(run_id, ~w(pending attention_required), %{
      state: "preparing",
      failure_stage: nil,
      failure_code: nil,
      failure_details: nil
    })
  end

  def inspected(worker_id, generation, message) do
    update_locked(message.delivery_id, fn delivery ->
      if delivery.state not in ~w(preparing publishing),
        do: Repo.rollback(:stale_delivery_message)

      assignment = lock_assignment!(delivery.run_id)
      validate_worker!(assignment, worker_id, generation)
      validate_delivery_identity!(delivery, assignment, message)

      if message.no_changes do
        change(delivery, %{
          state: "no_changes",
          change_evidence_version: 1,
          change_evidence: message.evidence,
          change_fingerprint: message.fingerprint,
          base_revision: message.base_revision,
          base_branch_name: message.base_branch_name,
          branch_name: message.branch_name,
          repository_host: message.repository_host,
          repository_identity: normalize_repository(message.repository_identity),
          remote_name: message.remote_name,
          head_before_finalize: message.head_before_finalize
        })
      else
        change(delivery, %{
          state: "publishing",
          change_evidence_version: 1,
          change_evidence: message.evidence,
          change_fingerprint: message.fingerprint,
          base_revision: message.base_revision,
          base_branch_name: message.base_branch_name,
          branch_name: message.branch_name,
          repository_host: message.repository_host,
          repository_identity: normalize_repository(message.repository_identity),
          remote_name: message.remote_name,
          head_before_finalize: message.head_before_finalize
        })
      end
    end)
  end

  def published(worker_id, generation, message) do
    update_locked(message.delivery_id, fn delivery ->
      if delivery.state not in ~w(publishing creating_review),
        do: Repo.rollback(:stale_delivery_message)

      assignment = lock_assignment!(delivery.run_id)
      validate_worker!(assignment, worker_id, generation)

      if delivery.change_fingerprint != message.fingerprint or
           delivery.branch_name != message.branch_name,
         do: Repo.rollback(:delivery_identity_conflict)

      change(delivery, %{
        state: "creating_review",
        head_revision: message.head_revision,
        published_at: now(),
        failure_stage: nil,
        failure_code: nil,
        failure_details: nil
      })
    end)
  end

  def failed(worker_id, generation, message) do
    update_locked(message.delivery_id, fn delivery ->
      if delivery.state not in ~w(preparing publishing creating_review),
        do: Repo.rollback(:stale_delivery_message)

      assignment = lock_assignment!(delivery.run_id)
      validate_worker!(assignment, worker_id, generation)
      attention(delivery, message.stage, message.code, message.details)
    end)
  end

  def attach_review(delivery_id, metadata) do
    update_locked(delivery_id, fn delivery ->
      case verify_review_identity(delivery, metadata) do
        :ok ->
          change(
            delivery,
            review_attributes(metadata, %{
              state: provider_state(metadata),
              review_created_at: delivery.review_created_at || now()
            })
          )

        {:error, mismatches} ->
          attention(
            change(delivery, review_attributes(metadata, %{})),
            "review_identity",
            "pull_request_identity_mismatch",
            %{mismatches: mismatches}
          )
      end
    end)
  end

  def observe_review(delivery_id, metadata) do
    Repo.transaction(fn ->
      delivery = Repo.one!(from d in RunDelivery, where: d.id == ^delivery_id, lock: "FOR UPDATE")

      updated =
        case verify_review_identity(delivery, metadata) do
          {:error, mismatches} ->
            attention(
              change(delivery, review_attributes(metadata, %{})),
              "review_identity",
              "pull_request_identity_mismatch",
              %{mismatches: mismatches}
            )

          :ok ->
            case metadata.state do
              "merged" ->
                merged_at = metadata.merged_at || now()
                complete_quest!(delivery, merged_at)

                change(
                  delivery,
                  review_attributes(metadata, %{state: "merged", merged_at: merged_at})
                )

              "closed" ->
                change(
                  delivery,
                  review_attributes(metadata, %{state: "closed_unmerged", closed_at: now()})
                )

              "open" ->
                change(delivery, review_attributes(metadata, %{state: "review_open"}))
            end
        end

      Repo.update!(RunDelivery.changeset(updated, %{last_reconciled_at: now()}))
    end)
    |> notify_result()
  end

  def retry(run_id) do
    case Repo.transaction(fn ->
           delivery =
             Repo.one(from d in RunDelivery, where: d.run_id == ^run_id, lock: "FOR UPDATE") ||
               Repo.rollback(:not_found)

           if delivery.state != "attention_required" or not recoverable_attention?(delivery),
             do: Repo.rollback(:delivery_not_retryable)

           delivery
           |> Changeset.change(
             state: "pending",
             command_revision: delivery.command_revision + 1,
             retry_requested_at: now(),
             failure_stage: nil,
             failure_code: nil,
             failure_details: nil
           )
           |> Repo.update!()
         end) do
      {:ok, delivery} ->
        RunChangeNotifier.notify(run_id)
        {:ok, delivery}

      error ->
        error
    end
  end

  def mark_attention(run_id, stage, code, details \\ %{}) do
    update_locked_by_run(run_id, &attention(&1, stage, code, details))
  end

  def projection(nil), do: nil

  def projection(delivery) do
    evidence = delivery.change_evidence || %{}

    %{
      state: public_state(delivery.state),
      changes: Map.get(evidence, "summary", Map.get(evidence, :summary)),
      review:
        if(delivery.pull_request_number,
          do: %{
            provider: delivery.provider,
            state: delivery.pull_request_state,
            number: delivery.pull_request_number,
            url: delivery.pull_request_url
          },
          else: nil
        ),
      revisions: %{base: delivery.base_revision, head: delivery.head_revision},
      issue: projection_issue(delivery),
      can_retry: delivery.state == "attention_required" and recoverable_attention?(delivery)
    }
  end

  def changes(run_id) do
    case fetch(run_id) do
      nil ->
        {:error, :not_found}

      delivery ->
        {:ok, %{version: delivery.change_evidence_version, evidence: delivery.change_evidence}}
    end
  end

  def verify_review_identity(delivery, metadata) do
    checks = [
      pull_request_url:
        {canonical_review_url(delivery.repository_identity, metadata.number),
         normalize_review_url(metadata.url)},
      repository:
        {normalize_repository(delivery.repository_identity),
         normalize_repository(metadata.repository_identity)},
      base_branch: {delivery.base_branch_name, metadata.base_branch},
      head_repository:
        {normalize_repository(delivery.repository_identity),
         normalize_repository(metadata.head_repository_identity)},
      head_branch: {delivery.branch_name, metadata.head_branch},
      head_revision: {delivery.head_revision, metadata.head_revision}
    ]

    mismatches =
      for {field, {expected, actual}} <- checks,
          expected != actual,
          do: %{field: field, expected: expected, actual: actual}

    if mismatches == [], do: :ok, else: {:error, mismatches}
  end

  defp provider_state(%{state: "open"}), do: "review_open"
  defp provider_state(%{state: "closed"}), do: "closed_unmerged"
  defp provider_state(%{state: "merged"}), do: "merged"

  defp review_attributes(metadata, extra) do
    Map.merge(
      %{
        provider: "github",
        pull_request_number: metadata.number,
        pull_request_url: metadata.url,
        pull_request_state: metadata.state,
        pull_request_base_branch: metadata.base_branch,
        pull_request_head_repository: metadata.head_repository_identity,
        pull_request_head_branch: metadata.head_branch,
        pull_request_head_revision: metadata.head_revision,
        last_reconciled_at: now()
      },
      extra
    )
  end

  defp complete_quest!(delivery, merged_at) do
    quest =
      Repo.one!(from q in ProductQuest, where: q.id == ^delivery.quest_id, lock: "FOR UPDATE")

    if is_nil(quest.completed_at) do
      quest
      |> Changeset.change(completed_at: merged_at, completed_by_run_id: delivery.run_id)
      |> Repo.update!()
    else
      if quest.completed_by_run_id != delivery.run_id,
        do: Repo.rollback(:quest_completion_conflict)
    end

    delivery
  end

  defp update_locked(id, fun) do
    result =
      Repo.transaction(fn ->
        delivery =
          Repo.one(from d in RunDelivery, where: d.id == ^id, lock: "FOR UPDATE") ||
            Repo.rollback(:not_found)

        fun.(delivery) |> Repo.update!()
      end)

    notify_result(result)
  end

  defp update_locked_by_run(run_id, fun) do
    result =
      Repo.transaction(fn ->
        delivery =
          Repo.one(from d in RunDelivery, where: d.run_id == ^run_id, lock: "FOR UPDATE") ||
            Repo.rollback(:not_found)

        fun.(delivery) |> Repo.update!()
      end)

    notify_result(result)
  end

  defp transition(run_id, allowed, attrs) do
    update_locked_by_run(run_id, fn delivery ->
      if delivery.state not in allowed, do: Repo.rollback(:invalid_delivery_transition)
      change(delivery, attrs)
    end)
  end

  defp change(delivery, attrs), do: RunDelivery.changeset(delivery, attrs)

  defp attention(delivery_or_changeset, stage, code, details),
    do:
      Changeset.change(delivery_or_changeset,
        state: "attention_required",
        failure_stage: stage,
        failure_code: code,
        failure_details: sanitize(details)
      )

  defp lock_assignment!(run_id),
    do:
      Repo.one!(from a in RunWorkspaceAssignment, where: a.run_id == ^run_id, lock: "FOR UPDATE")

  defp validate_worker!(assignment, worker_id, generation) do
    worker = Repo.get(Worker, worker_id)

    if assignment.worker_id != worker_id or is_nil(worker) or
         worker.connection_generation != generation or worker.status != "connected",
       do: Repo.rollback(:stale_worker_generation)
  end

  defp validate_delivery_identity!(delivery, assignment, message) do
    if delivery.run_id != message.run_id or assignment.worktree_id != message.worktree_id or
         assignment.identity_hash != message.identity_hash,
       do: Repo.rollback(:delivery_identity_conflict)
  end

  defp sanitize(value) when is_map(value),
    do: value |> Enum.take(20) |> Map.new(fn {k, v} -> {to_string(k), sanitize(v)} end)

  defp sanitize(value) when is_list(value), do: value |> Enum.take(20) |> Enum.map(&sanitize/1)
  defp sanitize(value) when is_binary(value), do: String.slice(value, 0, 500)
  defp sanitize(value) when is_number(value) or is_boolean(value) or is_nil(value), do: value
  defp sanitize(_), do: nil

  defp notify_result({:ok, delivery} = result) do
    RunChangeNotifier.notify(delivery.run_id)
    ProductChangeNotifier.notify(["quests", "runs"])
    result
  end

  defp notify_result(result), do: result

  defp recoverable_attention?(delivery),
    do: delivery.failure_code not in @nonrecoverable_attention

  defp public_state(state) when state in ~w(pending preparing publishing creating_review),
    do: "preparing_review"

  defp public_state("review_open"), do: "awaiting_review"
  defp public_state(state), do: state

  defp projection_issue(%{failure_code: code}) when is_binary(code),
    do: %{code: code, message: issue_message(code)}

  defp projection_issue(%{state: "closed_unmerged"}),
    do: %{code: "closed_unmerged", message: issue_message("closed_unmerged")}

  defp projection_issue(%{state: "no_changes"}),
    do: %{code: "no_changes", message: issue_message("no_changes")}

  defp projection_issue(_), do: nil

  defp issue_message("pull_request_identity_mismatch"),
    do: "The Pull Request no longer matches the published Delivery."

  defp issue_message("closed_unmerged"), do: "The Pull Request was closed without merge."

  defp issue_message("no_changes"),
    do: "Agent work completed, but there are no repository changes to publish."

  defp issue_message(_), do: "Publishing requires attention."

  defp canonical_review_url(repository, number) when is_binary(repository) and is_integer(number),
    do: "https://github.com/#{String.downcase(repository)}/pull/#{number}"

  defp canonical_review_url(_, _), do: nil

  defp normalize_review_url(value) when is_binary(value) do
    uri = URI.parse(value)

    if uri.scheme == "https" and String.downcase(uri.host || "") == "github.com" and
         is_nil(uri.userinfo) and is_nil(uri.query) and is_nil(uri.fragment),
       do: "https://github.com#{String.downcase(uri.path || "")}",
       else: nil
  end

  defp normalize_review_url(_), do: nil

  defp normalize_repository(nil), do: nil
  defp normalize_repository(value), do: value |> String.trim() |> String.downcase()
  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
