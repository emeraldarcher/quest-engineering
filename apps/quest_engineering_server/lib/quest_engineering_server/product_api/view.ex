defmodule QuestEngineering.Server.ProductApi.View do
  @moduledoc false

  import Ecto.Query
  alias QuestEngineering.Core.Product.TacticSource.Definition
  alias QuestEngineering.Core.Product.TacticSource.Inline
  alias QuestEngineering.Server.DeliveryStore
  alias QuestEngineering.Server.Persistence.ProductQuest
  alias QuestEngineering.Server.Persistence.QuestLaunch
  alias QuestEngineering.Server.Persistence.RunDelivery
  alias QuestEngineering.Server.Persistence.RuntimeRun
  alias QuestEngineering.Server.Persistence.TacticCodec
  alias QuestEngineering.Server.Repo
  alias QuestEngineering.Server.WorkspaceControl

  def workspace(value, archived_at \\ nil) do
    binding = WorkspaceControl.binding_state(value.id)

    %{
      id: value.id,
      key: value.key,
      name: value.name,
      source_kind: Atom.to_string(value.source_kind),
      source_fingerprint: value.source_fingerprint,
      binding: binding_projection(binding),
      archived_at: timestamp(archived_at)
    }
  end

  defp binding_projection(nil), do: %{state: "unbound", message: "Add this Project to a Worker."}

  defp binding_projection(%{state: "pending"}),
    do: %{state: "preparing", message: "Preparing Project…"}

  defp binding_projection(%{state: "available"}), do: %{state: "ready", message: "Project ready."}

  defp binding_projection(%{state: state, failure_code: code}),
    do: %{
      state: state,
      message: "Project setup requires attention.",
      issue: %{code: code || "workspace_binding_failed"}
    }

  def class(value, archived_at \\ nil) do
    %{
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      instructions: value.instructions,
      archived_at: timestamp(archived_at)
    }
  end

  def loadout(value, archived_at \\ nil) do
    %{
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      model: %{provider: value.model.provider, model: value.model.model},
      reasoning: Atom.to_string(value.reasoning),
      tools: value.tools,
      workspace_access: Atom.to_string(value.workspace_access),
      archived_at: timestamp(archived_at)
    }
  end

  def squad(value, archived_at \\ nil) do
    %{
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      members: Enum.map(value.members, &member/1),
      archived_at: timestamp(archived_at)
    }
  end

  def member(value),
    do: %{
      member_key: value.key,
      name: value.name,
      class_id: value.class_id,
      loadout_id: value.loadout_id
    }

  def tactic(value, archived_at \\ nil) do
    %{
      id: value.id,
      key: value.key,
      name: value.name,
      description: value.description,
      body: TacticCodec.encode(value.body),
      archived_at: timestamp(archived_at)
    }
  end

  def quest(value, archived_at \\ nil) do
    row = Repo.get(ProductQuest, value.id)
    lifecycle = quest_lifecycle(row)

    %{
      id: value.id,
      title: value.title,
      objective: value.objective,
      workspace_id: value.workspace_id,
      squad_id: value.squad_id,
      tactic_source: tactic_source(value.tactic_source),
      completion: %{
        completed_at: row && timestamp(row.completed_at),
        completed_by_run_id: row && row.completed_by_run_id
      },
      lifecycle: lifecycle,
      archived_at: timestamp(archived_at)
    }
  end

  defp quest_lifecycle(nil),
    do: %{state: "ready", label: "Ready", current_run_id: nil, primary_action: "launch"}

  defp quest_lifecycle(%{completed_at: completed_at, completed_by_run_id: run_id})
       when not is_nil(completed_at),
       do: %{state: "complete", label: "Complete", current_run_id: run_id, primary_action: nil}

  defp quest_lifecycle(row) do
    latest =
      Repo.one(
        from launch in QuestLaunch,
          where: launch.quest_id == ^row.id,
          order_by: [desc: launch.inserted_at],
          limit: 1
      )

    if is_nil(latest) do
      %{state: "ready", label: "Ready", current_run_id: nil, primary_action: "launch"}
    else
      run = Repo.get(RuntimeRun, latest.run_id)
      delivery = Repo.get_by(RunDelivery, run_id: latest.run_id)
      lifecycle_for_run(latest.run_id, run, delivery)
    end
  end

  defp lifecycle_for_run(run_id, %{status: "running"}, _delivery),
    do: %{state: "working", label: "Working", current_run_id: run_id, primary_action: nil}

  defp lifecycle_for_run(run_id, %{status: "failed"}, _delivery),
    do: %{
      state: "needs_attention",
      label: "Needs Attention",
      current_run_id: run_id,
      primary_action: "run_again"
    }

  defp lifecycle_for_run(run_id, _run, %RunDelivery{state: state} = delivery)
       when state in ~w(pending preparing publishing creating_review),
       do: %{
         state: "preparing_review",
         label: "Preparing Review",
         current_run_id: run_id,
         primary_action: nil,
         delivery: DeliveryStore.projection(delivery)
       }

  defp lifecycle_for_run(run_id, _run, %RunDelivery{state: "review_open"} = delivery),
    do: %{
      state: "awaiting_review",
      label: "Awaiting Review",
      current_run_id: run_id,
      primary_action: "open_pull_request",
      delivery: DeliveryStore.projection(delivery)
    }

  defp lifecycle_for_run(run_id, _run, %RunDelivery{state: state} = delivery)
       when state in ~w(closed_unmerged no_changes),
       do: %{
         state: "needs_attention",
         label: "Needs Attention",
         current_run_id: run_id,
         primary_action: "run_again",
         delivery: DeliveryStore.projection(delivery)
       }

  defp lifecycle_for_run(run_id, _run, %RunDelivery{} = delivery) do
    projection = DeliveryStore.projection(delivery)

    %{
      state: "needs_attention",
      label: "Needs Attention",
      current_run_id: run_id,
      primary_action:
        cond do
          projection.can_retry -> "retry_publishing"
          delivery.state == "attention_required" -> "run_again"
          true -> nil
        end,
      delivery: projection
    }
  end

  defp lifecycle_for_run(run_id, _run, nil),
    do: %{
      state: "preparing_review",
      label: "Preparing Review",
      current_run_id: run_id,
      primary_action: nil
    }

  def tactic_source(%Inline{body: body}), do: %{type: "inline", body: TacticCodec.encode(body)}

  def tactic_source(%Definition{tactic_definition_id: id}),
    do: %{type: "definition", tactic_definition_id: id}

  def preview(preview) do
    %{
      resolved_tactic: TacticCodec.encode(preview.resolved_tactic),
      execution_plan: plan(preview.execution_plan),
      provenance: provenance(preview.provenance),
      step_origins: step_origins(preview.step_origins)
    }
  end

  def quest_preview(snapshot) do
    %{
      quest: %{
        id: snapshot.quest.id,
        title: snapshot.quest.title,
        objective: snapshot.quest.objective
      },
      workspace: %{
        id: snapshot.workspace.id,
        key: snapshot.workspace.key,
        name: snapshot.workspace.name,
        source_kind: Atom.to_string(snapshot.workspace.source_kind)
      },
      squad: %{
        id: snapshot.squad.id,
        key: snapshot.squad.key,
        name: snapshot.squad.name,
        members:
          Enum.map(snapshot.squad.members, fn member ->
            %{
              member_key: member.key,
              name: member.name,
              class: %{id: member.class.id, key: member.class.key, name: member.class.name},
              loadout: %{
                id: member.loadout.id,
                key: member.loadout.key,
                name: member.loadout.name
              }
            }
          end)
      },
      tactic: %{
        resolved_tactic: TacticCodec.encode(snapshot.tactic),
        provenance: provenance(snapshot.tactic_provenance)
      },
      execution_plan: plan(snapshot.execution_plan)
    }
  end

  def provenance(nil), do: nil

  def provenance(value) do
    %{
      root: %{
        kind: Atom.to_string(value.root.kind),
        definition_id: value.root.definition_id,
        definition_key: value.root.definition_key,
        definition_name: value.root.definition_name
      },
      definitions:
        Enum.map(value.definitions, fn item ->
          %{
            instance_path: item.instance_path,
            definition_id: item.definition_id,
            definition_key: item.definition_key,
            definition_name: item.definition_name
          }
        end)
    }
  end

  def step_origins(origins) do
    origins
    |> Enum.sort_by(fn {key, _} -> key end)
    |> Enum.map(fn {key, value} ->
      %{
        semantic_step_key: key,
        instance_path: value.instance_path,
        local_step_key: value.local_step_key,
        authoring_path: value.body_path,
        definition_id: value.definition_id,
        definition_key: value.definition_key
      }
    end)
  end

  def plan(plan) do
    %{
      steps:
        Enum.map(plan.steps, fn step ->
          %{
            key: step.key,
            name: step.name,
            instruction: step.instruction,
            performer: requirement(step.performer),
            context: requirement(step.context),
            produces: step.produces
          }
        end),
      dependencies:
        Enum.map(plan.control_dependencies, fn dependency ->
          %{before: endpoint(dependency.prerequisite), after: endpoint(dependency.dependent)}
        end),
      until_regions:
        Enum.map(plan.control_regions, fn region ->
          %{
            id: region.id,
            parent_region_id: region.parent_region,
            max_remediations: region.max_remediations,
            check: subtree(region.check),
            otherwise: subtree(region.otherwise),
            condition: %{
              artifact_type: region.condition_binding.artifact_type,
              source_step_key: region.condition_binding.producer,
              field: region.condition_binding.field,
              operator: Atom.to_string(region.condition_binding.operator),
              value: region.condition_binding.value
            }
          }
        end)
    }
  end

  def requirement(value), do: %{selector: Atom.to_string(value.selector), value: value.value}
  defp endpoint(value) when is_binary(value), do: %{type: "step", key: value}
  defp endpoint(value), do: %{type: "region", id: value.id}
  defp subtree(value), do: %{step_keys: value.step_keys, region_ids: value.control_regions}
  def timestamp(nil), do: nil
  def timestamp(value), do: DateTime.to_iso8601(value)
end
