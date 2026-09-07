defmodule QuestEngineering.Server.RunProjectionTest do
  use QuestEngineering.Server.DataCase, async: false

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Product.ModelRef
  alias QuestEngineering.Core.Product.TacticSource
  alias QuestEngineering.Server.CompletionAdapter
  alias QuestEngineering.Server.ExecutionSessionStore
  alias QuestEngineering.Server.LaunchQuest
  alias QuestEngineering.Server.Product.Repository, as: Products
  alias QuestEngineering.Server.RunProjection
  alias QuestEngineering.Server.SchedulingStore
  alias QuestEngineering.Server.WorkerStore

  test "distinguishes Core pending occurrences from dispatched work awaiting scheduling" do
    root = Path.expand(".pi/tmp/projection-workspace-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, ".git"))
    previous = Application.get_env(:quest_engineering_server, :workspaces)
    Application.put_env(:quest_engineering_server, :workspaces, %{"workspace:projection" => root})

    on_exit(fn ->
      File.rm_rf!(root)
      Application.put_env(:quest_engineering_server, :workspaces, previous || %{})
    end)

    {:ok, class} =
      Products.create_class(%{key: "builder-projection", name: "Builder", instructions: "Build."})

    {:ok, loadout} =
      Products.create_loadout(%{
        key: "loadout-projection",
        name: "Loadout",
        model: %ModelRef{provider: "fake", model: "test"},
        reasoning: :low,
        tools: [],
        workspace_access: :read_write
      })

    {:ok, squad} =
      Products.create_squad(%{
        key: "squad-projection",
        name: "Squad",
        members: [%{key: "alice", name: "Alice", class_id: class.id, loadout_id: loadout.id}]
      })

    tactic =
      sequence([
        step("first",
          name: "First",
          instruction: "First.",
          performer: class("builder-projection")
        ),
        step("second",
          name: "Second",
          instruction: "Second.",
          performer: same_as("first"),
          context: continue_from("first")
        )
      ])

    {:ok, quest} =
      Products.create_quest(%{
        title: "Projection",
        objective: "Projection.",
        workspace_ref: "workspace:projection",
        squad_id: squad.id,
        tactic_source: TacticSource.inline(tactic)
      })

    {:ok, launched} = LaunchQuest.launch(quest.id)
    {:ok, projection} = RunProjection.get(launched.run_id)

    assert projection.status == "waiting"
    assert projection.step_counts["pending"] == 1
    assert projection.step_counts["waiting"] == 1
    assert [%{state: "waiting"}, %{state: "pending"}] = projection.steps

    worker = register_worker(root)
    assert {:ok, first} = SchedulingStore.schedule_next(launched.run_id)

    assert {:ok, _} =
             CompletionAdapter.complete(
               worker.id,
               worker.connection_generation,
               completion(first)
             )

    assert {:ok, second} = SchedulingStore.schedule_next(launched.run_id)

    attention = %{
      "attention_id" => Ecto.UUID.generate(),
      "category" => "needs_input",
      "message" => "Choose the safe implementation.",
      "requested_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "interaction" => %{
        "kind" => "conversational_intervention",
        "control_state" => "intervention_pending",
        "resume_command" => "/qe-resume"
      }
    }

    assert {:ok, _session} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               session(second, :waiting_for_human, attention)
             )

    {:ok, active} = RunProjection.get(launched.run_id)
    [first_step, second_step] = active.steps

    assert second_step.member.member_key == "alice"
    assert second_step.performer.source_occurrence_id == first_step.occurrence_id
    assert second_step.performer.source_semantic_step_key == "first"
    assert second_step.context.source_occurrence_id == first_step.occurrence_id
    assert second_step.context.source_semantic_step_key == "first"
    assert second_step.state == "scheduled"
    assert second_step.session.state == "waiting_for_human"
    assert second_step.session.attention["attention_id"] == attention["attention_id"]
    assert second_step.session.attachment.available
    assert second_step.attempt.session.id == second_step.session.id
    assert Enum.map(second_step.session.events, & &1.type) == ["attention_requested"]

    assert {:ok, takeover_descriptor} =
             ExecutionSessionStore.attachment_descriptor(
               launched.run_id,
               second.execution.identity.attempt_id,
               second_step.session.id
             )

    assert takeover_descriptor.takeover_allowed

    assert {:ok, observed_session} =
             ExecutionSessionStore.record_opened(
               takeover_descriptor.descriptor_token,
               "observe"
             )

    assert observed_session.attention["interaction"]["control_state"] ==
             "intervention_pending"

    assert {:ok, _session} =
             ExecutionSessionStore.record_opened(
               takeover_descriptor.descriptor_token,
               "takeover"
             )

    {:ok, human_control} = RunProjection.get(launched.run_id)
    human_session = List.last(human_control.steps).session
    assert human_session.attention["interaction"]["control_state"] == "human_control"

    human_control_event =
      Enum.find(human_session.events, &(&1.type == "local_session_opened"))

    assert human_control_event.metadata == %{
             "human_control_started" => true,
             "mode" => "takeover"
           }

    stale_update =
      second
      |> session(:running, nil)
      |> Map.put(:last_activity_at, ~U[2020-01-01 00:00:00Z])

    assert {:ok, _ignored} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               stale_update
             )

    {:ok, after_stale} = RunProjection.get(launched.run_id)
    assert List.last(after_stale.steps).session.state == "waiting_for_human"

    assert {:ok, _same_attention} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               session(second, :waiting_for_human, attention)
             )

    {:ok, repeated} = RunProjection.get(launched.run_id)

    repeated_session = List.last(repeated.steps).session
    assert repeated_session.attention["interaction"]["control_state"] == "human_control"

    assert Enum.map(repeated_session.events, & &1.type) == [
             "attention_requested",
             "attachment_descriptor_issued",
             "local_session_opened"
           ]

    resumed_intervention = %{
      "attention_id" => attention["attention_id"],
      "kind" => "conversational_intervention",
      "state" => "resumed",
      "requested_at" => attention["requested_at"],
      "handed_back_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "automation_resumed_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    assert {:ok, _session} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               session(second, :running, nil)
               |> Map.put(:intervention, resumed_intervention)
             )

    {:ok, resumed} = RunProjection.get(launched.run_id)
    resumed_step = List.last(resumed.steps)
    assert resumed_step.state == "scheduled"
    assert resumed_step.session.state == "running"
    assert is_nil(resumed_step.session.attention)

    assert Enum.map(resumed_step.session.events, & &1.type) == [
             "attention_requested",
             "attachment_descriptor_issued",
             "local_session_opened",
             "attention_resolved"
           ]

    resolution_event = List.last(resumed_step.session.events)
    assert resolution_event.metadata["human_control_returned"]
    assert resolution_event.metadata["automation_resumed"]

    second_attention = %{
      attention
      | "attention_id" => Ecto.UUID.generate(),
        "message" => "A second distinct question."
    }

    assert {:ok, _session} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               session(second, :waiting_for_human, second_attention)
             )

    {:ok, second_request} = RunProjection.get(launched.run_id)

    assert Enum.count(
             List.last(second_request.steps).session.events,
             &(&1.type == "attention_requested")
           ) == 2

    assert {:ok, _session} =
             ExecutionSessionStore.record(
               worker.id,
               worker.connection_generation,
               session(second, :running, nil)
             )

    assert {:ok, descriptor} =
             ExecutionSessionStore.attachment_descriptor(
               launched.run_id,
               second.execution.identity.attempt_id,
               resumed_step.session.id
             )

    assert descriptor.mode == "local_native_terminal"
    refute descriptor.takeover_allowed
    assert {:ok, _session} = ExecutionSessionStore.record_opened(descriptor.descriptor_token)

    {:ok, restarted_worker} =
      WorkerStore.register(worker.id, worker.capabilities, Ecto.UUID.generate())

    assert restarted_worker.connection_generation == worker.connection_generation + 1

    {:ok, recovering} = RunProjection.get(launched.run_id)
    assert List.last(recovering.steps).session.state == "recovering"
    refute List.last(recovering.steps).session.attachment.available

    assert {:error, :stale_attachment_descriptor} =
             ExecutionSessionStore.record_opened(descriptor.descriptor_token)

    assert {:ok, _session} =
             ExecutionSessionStore.record(
               restarted_worker.id,
               restarted_worker.connection_generation,
               session(second, :running, nil)
             )

    {:ok, reconciled} = RunProjection.get(launched.run_id)
    assert List.last(reconciled.steps).session.state == "running"
    assert List.last(reconciled.steps).session.attachment.available

    assert {:ok, _worker} =
             WorkerStore.disconnect(
               restarted_worker.id,
               restarted_worker.connection_id,
               restarted_worker.connection_generation
             )

    {:ok, disconnected} = RunProjection.get(launched.run_id)
    disconnected_session = List.last(disconnected.steps).session
    assert disconnected_session.state == "unavailable"
    refute disconnected_session.attachment.available
    assert disconnected_session.attachment.reason == "worker_offline"
  end

  defp session(dispatch, state, attention) do
    now = DateTime.utc_now() |> DateTime.to_iso8601()
    identity = dispatch.execution.identity

    %{
      session_id: "session-" <> dispatch.action_id,
      action_id: dispatch.action_id,
      run_id: dispatch.run_id,
      occurrence_id: identity.occurrence_id,
      attempt_id: identity.attempt_id,
      member_key: dispatch.execution.performer.member_key,
      harness_kind: "pi",
      harness_display_name: "Pi",
      state: state,
      capabilities: %{
        "can_attach_terminal" => true,
        "can_send_input" => true,
        "can_interrupt" => true,
        "can_detect_attention" => true,
        "can_resume" => true,
        "can_observe_structured_events" => true
      },
      terminal: %{
        "attachment_mode" => "local_native_terminal",
        "backend_kind" => "herdr",
        "terminal_session_id" => "worker-test",
        "terminal_target_id" => "qe-test",
        "supports_observation" => true,
        "supports_takeover" => true
      },
      provider_session_id: "pi-test",
      attention: attention,
      started_at: DateTime.from_iso8601(now) |> elem(1),
      last_activity_at: DateTime.from_iso8601(now) |> elem(1)
    }
  end

  defp completion(dispatch) do
    %{
      action_id: dispatch.action_id,
      occurrence_id: dispatch.execution.identity.occurrence_id,
      attempt_id: dispatch.execution.identity.attempt_id,
      outputs: %{}
    }
  end

  defp register_worker(root) do
    capabilities = %{
      "os" => "test",
      "arch" => "test",
      "max_concurrency" => 1,
      "tags" => [],
      "executors" => [
        %{
          "adapter" => "fake",
          "models" => [%{"provider" => "fake", "model" => "test"}],
          "reasoning" => ["low", "medium", "high"],
          "tools" => [],
          "workspaces" => [
            %{"ref" => "workspace:projection", "root" => root, "max_access" => "read_write"}
          ]
        }
      ]
    }

    {:ok, worker} = WorkerStore.register("worker-projection", capabilities, Ecto.UUID.generate())
    worker
  end
end
