import { expect, test } from "bun:test";
import type { Quest, RunSummary } from "../../api/contracts";
import {
  archiveExplanation,
  currentRunSummary,
  questStatus,
  semanticSteps,
} from "./quest-presentation";

function quest(state: Quest["lifecycle"]["state"]): Quest {
  return {
    id: "quest",
    title: "A Quest",
    objective: "Do the work.",
    workspace_id: "project",
    squad_id: "squad",
    tactic_source: { type: "definition", tactic_definition_id: "tactic" },
    completion: { completed_at: null, completed_by_run_id: null },
    lifecycle: {
      state,
      label: state,
      current_run_id: state === "ready" ? null : "run-current",
      primary_action: state === "ready" ? "launch" : null,
    },
    archived_at: null,
  };
}

test("human-facing Quest vocabulary keeps unlaunched work ready rather than attention", () => {
  expect(questStatus(quest("ready")).label).toBe("Ready to launch");
  expect(questStatus(quest("working")).label).toBe("Working");
  expect(questStatus(quest("preparing_review")).label).toBe("Preparing review");
  expect(questStatus(quest("awaiting_review")).label).toBe("Awaiting review");
  expect(questStatus(quest("complete")).label).toBe("Complete");
});

test("current Run association uses the authoritative lifecycle Run ID", () => {
  const runs = [{ id: "run-older" }, { id: "run-current" }] as RunSummary[];
  expect(currentRunSummary(quest("working"), runs)?.id).toBe("run-current");
});

test("semantic Tactic preview omits compiler machinery and preserves remediation meaning", () => {
  const steps = semanticSteps({
    type: "sequence",
    children: [
      { type: "step", key: "implement", name: "Implement" },
      {
        type: "until",
        check: { type: "step", key: "review", name: "Review" },
        otherwise: { type: "step", key: "repair", name: "Repair" },
      },
    ],
  });

  expect(steps.map((step) => [step.name, step.branch])).toEqual([
    ["Implement", "main"],
    ["Review", "check"],
    ["Repair", "otherwise"],
  ]);
});

test("active archive copy explicitly preserves ongoing work and review", () => {
  expect(archiveExplanation("working")).toContain("current Run will continue");
  expect(archiveExplanation("working")).toContain("does not cancel");
  expect(archiveExplanation("awaiting_review")).toContain(
    "Pull Request and review lifecycle will continue",
  );
});
