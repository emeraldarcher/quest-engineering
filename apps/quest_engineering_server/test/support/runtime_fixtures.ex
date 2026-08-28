defmodule QuestEngineering.Server.RuntimeFixtures do
  @moduledoc false

  import QuestEngineering.Core.Tactics

  alias QuestEngineering.Core.Compiler
  alias QuestEngineering.Core.Runtime

  def pressure_plan(options \\ []) do
    max_remediations = Keyword.get(options, :max_remediations, 3)

    children = [
      work("plan",
        instruction:
          "Produce a plan for creating qe-pressure.txt in the workspace, initially containing exactly version 0 followed by a newline, and later repairing it to version 1 when review rejects it.",
        performer: class("architect"),
        context: fresh(),
        produces: ["plan"]
      ),
      work("implement",
        instruction:
          "Follow the supplied plan: create qe-pressure.txt containing exactly version 0 followed by a newline, then produce a change_set describing the workspace change.",
        performer: class("builder"),
        context: fresh(),
        consumes: ["plan"],
        produces: ["change_set"]
      ),
      until(
        check:
          work("review",
            instruction:
              "Independently inspect qe-pressure.txt. Produce verdict with status accepted only when it contains exactly version 1 followed by a newline; otherwise produce status rejected and explain the blocking finding.",
            performer: class("reviewer"),
            context: fresh(),
            consumes: ["change_set"],
            produces: ["verdict"]
          ),
        condition: equals(field(artifact("verdict"), "status"), "accepted"),
        otherwise:
          work("repair",
            instruction:
              "Address the rejected verdict by changing qe-pressure.txt to contain exactly version 1 followed by a newline, preserving the existing implementation lineage, then produce an updated change_set.",
            performer: same_as("implement"),
            context: continue_from("implement"),
            consumes: ["change_set", "verdict"],
            produces: ["change_set"]
          ),
        max_remediations: max_remediations
      )
    ]

    tactic =
      if Keyword.get(options, :publish, false) do
        sequence(children ++ [work("publish", consumes: ["change_set", "verdict"])])
      else
        sequence(children)
      end

    compile!(tactic)
  end

  def sequence_plan do
    compile!(sequence([work("a"), work("b"), work("c")]))
  end

  def control_plane_restart_plan do
    compile!(
      sequence([
        work("survive_control_plane_restart",
          instruction:
            "Use bash to run sleep 20 first, then create control-plane-restart-proof.txt containing exactly control plane restart survived followed by a newline, and produce proof describing the file.",
          produces: ["proof"]
        )
      ])
    )
  end

  def parallel_plan do
    compile!(
      sequence([
        work("start"),
        parallel([work("left"), work("right")]),
        work("finish")
      ])
    )
  end

  def complete(run, action, outputs),
    do: Runtime.transition(run, Runtime.completed(action, outputs))

  def action_for(run, semantic_step_key) do
    run.occurrence_order
    |> Enum.map(&run.occurrences[&1])
    |> Enum.find(&(&1.semantic_step_key == semantic_step_key and &1.status == :dispatched))
    |> then(fn occurrence ->
      %{
        occurrence_id: occurrence.id,
        attempt_id: occurrence.current_attempt_id
      }
    end)
  end

  defp work(key, options \\ []) do
    defaults = [
      name: String.capitalize(key),
      instruction: "Execute test step #{key}.",
      performer: class("builder")
    ]

    step(key, Keyword.merge(defaults, options))
  end

  defp compile!(tactic) do
    {:ok, plan} = Compiler.compile(tactic)
    plan
  end
end
