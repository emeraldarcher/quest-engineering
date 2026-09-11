import { expect, test } from "bun:test";
import type { Tactic } from "../../api/contracts";
import {
  appendChild,
  artifactContractLabel,
  artifactSourcesFor,
  asJson,
  BUILT_IN_ARTIFACT_KINDS,
  draftValidationIssues,
  emptyDraft,
  generatedArtifactName,
  generatedLocalKey,
  generatedPortKey,
  insertAfter,
  isPlanRevisionUntil,
  isReviewRemediationUntil,
  localDraftIssues,
  makeStep,
  makeUntil,
  makeUse,
  moveIntoPrevious,
  moveNode,
  moveOut,
  referencedOutputsForRemoval,
  removeNode,
  removeNodeWithSelection,
  renameArtifactOutputReferences,
  type SequenceNode,
  steps,
  subtreeSize,
  type TacticNode,
  usageFor,
} from "./tactic-model";

const builder = "builder";

function sequence(): SequenceNode {
  const empty: SequenceNode = { type: "sequence", children: [] };
  const implement = makeStep("Implement", empty, builder);
  implement.instruction = "Implement.";
  implement.produces = [
    { name: "change_set", kind: "change_set", review: null },
  ];
  const withImplement: SequenceNode = { ...empty, children: [implement] };
  const review = makeStep("Review", withImplement, "reviewer");
  review.instruction = "Review.";
  review.consumes = [
    {
      name: "change_set",
      kind: "change_set",
      source: { producer: implement.key, output: "change_set" },
      required: true,
    },
  ];
  return { ...empty, children: [implement, review] };
}

test("normal artifact suggestions contain kinds, never local output names", () => {
  expect([...BUILT_IN_ARTIFACT_KINDS]).toEqual([
    "quest_plan",
    "change_set",
    "review_verdict",
  ]);
  expect(BUILT_IN_ARTIFACT_KINDS.includes("verdict" as never)).toBe(false);
  const until = makeUntil(sequence(), builder);
  expect(until.condition.source).toEqual({
    producer: until.check.type === "step" ? until.check.key : "",
    output: "verdict",
  });
  if (until.check.type !== "step") throw new Error("Expected Review Step");
  expect(until.check.produces[0]).toMatchObject({
    name: "verdict",
    kind: "review_verdict",
    review: {
      gate_key: "implementation_acceptance",
      subject_input: "current_change_set",
    },
  });
});

test("insertion and reorder preserve stable Step keys and semantic references", () => {
  const body = sequence();
  const originalKeys = steps(body).map((step) => step.key);
  const [implementKey, reviewKey] = originalKeys;
  if (!implementKey || !reviewKey) throw new Error("Expected two Steps");
  const publish = makeStep("Publish", body, builder);
  publish.instruction = "Publish.";
  const inserted = insertAfter(body, [0], publish);
  const moved = moveNode(inserted, [2], -1).body;

  expect(steps(moved).map((step) => step.key)).toEqual([
    implementKey,
    reviewKey,
    publish.key,
  ]);
  expect(steps(moved)[1]?.consumes[0]?.source).toEqual({
    producer: implementKey,
    output: "change_set",
  });
});

test("nested insertion and removal manipulate only the local draft", () => {
  const body = sequence();
  const nested: SequenceNode = { type: "sequence", children: [] };
  const withNested = appendChild(body, [], nested);
  const child = makeStep("Nested", withNested, builder);
  child.instruction = "Nested work.";
  const populated = appendChild(withNested, [2], child);

  expect(steps(populated).at(-1)?.key).toBe(child.key);
  expect(
    steps(removeNode(populated, [2, 0])).some((step) => step.key === child.key),
  ).toBe(false);
});

test("keyboard movement can move into and out of semantic groups", () => {
  const body = sequence();
  const group: SequenceNode = { type: "sequence", children: [] };
  const withGroup: SequenceNode = {
    ...body,
    children: [group, ...body.children],
  };
  const nested = moveIntoPrevious(withGroup, [1]);
  expect(nested.path).toEqual([0, 0]);
  expect(steps(nested.body)[0]?.key).toBe("implement");
  const unnested = moveOut(nested.body, nested.path);
  expect(unnested.path).toEqual([1]);
  expect(steps(unnested.body)[0]?.key).toBe("implement");
});

test("move up and down preserve every semantic node type", () => {
  const base = sequence();
  const target: Tactic = {
    id: "move-target",
    key: "move-target",
    name: "Move Target",
    description: "",
    body: asJson(base),
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  const first = base.children[0];
  const second = base.children[1];
  if (!first || !second) throw new Error("Expected sequence children");
  const nodes: TacticNode[] = [
    first,
    { type: "sequence", children: [second] },
    { type: "parallel", children: [makeStep("Branch", base, builder)] },
    makeUntil(base, builder),
    makeUse(target, base),
  ];
  const root: SequenceNode = { type: "sequence", children: nodes };
  for (const [index, node] of nodes.entries()) {
    if (index > 0) {
      const moved = moveNode(root, [index], -1);
      expect(moved.path).toEqual([index - 1]);
      expect(
        moved.body.type === "sequence" && moved.body.children[index - 1],
      ).toEqual(node);
    }
    if (index < nodes.length - 1) {
      const moved = moveNode(root, [index], 1);
      expect(moved.path).toEqual([index + 1]);
      expect(
        moved.body.type === "sequence" && moved.body.children[index + 1],
      ).toEqual(node);
    }
  }
});

test("interface port keys are generated from friendly names with canonical concise conventions", () => {
  expect(generatedPortKey("Quest Plan", "quest_plan", "input", [])).toBe(
    "plan",
  );
  expect(
    generatedPortKey("Accepted Quest Plan", "quest_plan", "output", [], true),
  ).toBe("accepted_plan");
  expect(
    generatedPortKey(
      "Accepted Change Set",
      "change_set",
      "output",
      ["accepted_change_set"],
      true,
    ),
  ).toBe("accepted_change_set_2");
  expect(generatedPortKey("QA Report", "qa_report", "output", [])).toBe(
    "qa_report",
  );
});

test("removal supports every semantic position and chooses a useful next selection", () => {
  const body = sequence();
  const until = makeUntil(body, builder);
  const target: Tactic = {
    id: "child",
    key: "child",
    name: "Child",
    description: "",
    body: asJson(body),
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  const use = makeUse(target, body);
  const first = body.children[0];
  const second = body.children[1];
  if (!first || !second) throw new Error("Expected sequence children");
  const root: SequenceNode = {
    type: "sequence",
    children: [first, until, use, second],
  };

  const stepRemoval = removeNodeWithSelection(root, [0]);
  expect(stepRemoval.removed).toBe(true);
  expect(stepRemoval.path).toEqual([0]);
  expect(
    stepRemoval.body.type === "sequence" && stepRemoval.body.children[0]?.type,
  ).toBe("until");

  const untilRemoval = removeNodeWithSelection(root, [1]);
  expect(
    untilRemoval.body.type === "sequence" &&
      untilRemoval.body.children.some((node) => node.type === "until"),
  ).toBe(false);

  const useRemoval = removeNodeWithSelection(root, [2]);
  expect(
    useRemoval.body.type === "sequence" &&
      useRemoval.body.children.some((node) => node.type === "use"),
  ).toBe(false);

  const checkRemoval = removeNodeWithSelection(root, [1, "check"]);
  expect(checkRemoval.path).toEqual([1]);
  const changedUntil =
    checkRemoval.body.type === "sequence"
      ? checkRemoval.body.children[1]
      : null;
  expect(changedUntil?.type === "until" && changedUntil.check).toEqual({
    type: "sequence",
    children: [],
  });

  const emptyContainer: SequenceNode = { type: "sequence", children: [] };
  const nestedRoot: SequenceNode = {
    type: "sequence",
    children: [emptyContainer],
  };
  expect(removeNodeWithSelection(nestedRoot, [0]).body).toEqual({
    type: "sequence",
    children: [],
  });
  expect(subtreeSize(until)).toBe(3);
});

test("removal impact reports exact bindings and interface exports without changing them", () => {
  const body = sequence();
  const draft = {
    id: null,
    key: "delivery",
    name: "Delivery",
    description: "",
    body,
    interface: {
      inputs: [],
      outputs: [
        {
          key: "change_set",
          label: "Change Set",
          kind: "change_set",
          source: {
            type: "binding" as const,
            binding: { producer: "implement", output: "change_set" },
          },
        },
      ],
    },
  };
  expect(referencedOutputsForRemoval(draft, [0])).toEqual([
    "Review → Change Set",
    "Tactic output → Change Set",
  ]);
  expect(draft.interface.outputs[0]?.source).toEqual({
    type: "binding",
    binding: { producer: "implement", output: "change_set" },
  });
  const removed = { ...draft, body: removeNode(draft.body, [0]) };
  expect(localDraftIssues(removed)).toContain(
    "Change Set needs an export source.",
  );
});

test("Step and TacticUse identities share stable collision-safe keys", () => {
  const body = sequence();
  const tactic: Tactic = {
    id: "tactic-plan",
    key: "plan",
    name: "Implement",
    description: "",
    body: asJson(sequence()),
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  const use = makeUse(tactic, body);
  expect(use.instance_key).toBe("implement-2");
  expect(generatedLocalKey("Implement", body)).toBe("implement-2");
});

test("Until authoring states exact remediation-count semantics", () => {
  const until = makeUntil(sequence(), builder);
  expect(until.max_remediations).toBe(3);
  expect(until.max_remediations + 1).toBe(4);
  expect(until.condition.operator).toBe("equals");
  expect(isReviewRemediationUntil(until)).toBe(true);
  if (until.check.type !== "step" || until.otherwise.type !== "step")
    throw new Error("Expected Step phases");
  until.check.name = "Review";
  until.check.consumes = [
    { name: "change_set", kind: "change_set", source: null, required: true },
  ];
  until.check.produces = [
    {
      name: "verdict",
      kind: "review_verdict",
      review: {
        gate_key: "implementation_acceptance",
        subject_input: "change_set",
      },
    },
  ];
  until.condition.source = { producer: until.check.key, output: "verdict" };
  until.otherwise.name = "Repair";
  expect(isReviewRemediationUntil(until)).toBe(true);
  const invalid = {
    id: null,
    key: "invalid-until",
    name: "Invalid Until",
    description: "",
    body: { ...until, max_remediations: 0 },
    interface: { inputs: [], outputs: [] },
  };
  expect(localDraftIssues(invalid)).toContain(
    "Maximum remediation iterations must be a positive whole number.",
  );
});

test("plan review loops use document contracts and count plan revisions", () => {
  const until = makeUntil(sequence(), "plan-reviewer");
  if (until.check.type !== "step" || until.otherwise.type !== "step")
    throw new Error("Expected Step phases");
  until.check.name = "Plan Review";
  until.check.consumes = [
    {
      name: "plan",
      kind: "quest_plan",
      source: { producer: "plan", output: "plan" },
      required: true,
    },
  ];
  until.check.produces = [
    {
      name: "verdict",
      kind: "review_verdict",
      review: { gate_key: "plan_acceptance", subject_input: "plan" },
    },
  ];
  until.condition.source = { producer: until.check.key, output: "verdict" };
  until.otherwise.name = "Revise Plan";
  until.otherwise.produces = [
    { name: "plan", kind: "quest_plan", review: null },
  ];
  until.max_remediations = 2;

  expect(isPlanRevisionUntil(until)).toBe(true);
  expect(isReviewRemediationUntil(until)).toBe(false);
  const planInput = until.check.consumes[0];
  const planOutput = until.otherwise.produces[0];
  if (!planInput || !planOutput) throw new Error("Expected plan artifacts");
  expect(artifactContractLabel(until.check, planInput, "consumes")).toBe(
    "Current Quest Plan",
  );
  expect(artifactContractLabel(until.otherwise, planOutput, "produces")).toBe(
    "Updated Quest Plan",
  );
  expect(until.max_remediations + 1).toBe(3);
});

test("Plan review defaults persist an explicit gate, loop carry, feedback, and accepted export", () => {
  const empty: SequenceNode = { type: "sequence", children: [] };
  const plan = makeStep("Plan", empty, "planner");
  plan.instruction = "Create a Quest Plan.";
  plan.produces = [{ name: "plan", kind: "quest_plan", review: null }];
  const beforeLoop: SequenceNode = { type: "sequence", children: [plan] };
  const until = makeUntil(beforeLoop, "plan-reviewer");
  if (until.check.type !== "step" || until.otherwise.type !== "step")
    throw new Error("Expected Step phases");
  const draft = {
    id: null,
    key: "plan-review",
    name: "Plan & Review",
    description: "",
    body: { type: "sequence" as const, children: [plan, until] },
    interface: {
      inputs: [],
      outputs: [
        {
          key: "accepted_plan",
          label: "Accepted Quest Plan",
          kind: "quest_plan",
          source: {
            type: "accepted_subject" as const,
            gate_key: "plan_acceptance",
          },
        },
      ],
    },
  };

  expect(until.check.name).toBe("Review Plan");
  expect(until.check.consumes).toEqual([
    {
      name: "current_plan",
      kind: "quest_plan",
      source: { producer: "plan", output: "plan" },
      required: true,
    },
  ]);
  expect(until.check.produces[0]?.review).toEqual({
    gate_key: "plan_acceptance",
    subject_input: "current_plan",
  });
  expect(until.otherwise.consumes).toEqual([
    {
      name: "current_plan",
      kind: "quest_plan",
      source: { producer: "plan", output: "plan" },
      required: true,
    },
    {
      name: "review_feedback",
      kind: "review_verdict",
      source: { producer: "review-plan", output: "verdict" },
      required: true,
    },
  ]);
  expect(until.otherwise.produces[0]).toMatchObject({
    name: "plan",
    kind: "quest_plan",
  });
  expect(draftValidationIssues(draft)).toEqual([]);
  expect(
    artifactSourcesFor(draft, [], [1, "check"], "quest_plan")[0]?.label,
  ).toBe("Current Quest Plan");
  const remediationSources = artifactSourcesFor(draft, [], [1, "otherwise"]);
  expect(remediationSources.map((candidate) => candidate.label)).toContain(
    "Current Quest Plan",
  );
  expect(remediationSources.map((candidate) => candidate.label)).toContain(
    "Latest rejected Plan Review",
  );
});

test("draft validation identifies each reproduced semantic wiring failure", () => {
  const empty: SequenceNode = { type: "sequence", children: [] };
  const plan = makeStep("Plan", empty, "planner");
  plan.instruction = "Plan.";
  plan.produces = [{ name: "plan", kind: "quest_plan", review: null }];
  const review = makeStep("Review Plan", empty, "reviewer");
  review.instruction = "Review.";
  review.consumes = [
    { name: "current_plan", kind: "", source: null, required: true },
  ];
  review.produces = [
    {
      name: "verdict",
      kind: "review_verdict",
      review: {
        gate_key: "implementation_acceptance",
        subject_input: "current_plan",
      },
    },
  ];
  const remediate = makeStep("Remediate", empty, "planner");
  remediate.instruction = "Revise.";
  remediate.consumes = [
    { name: "current_plan", kind: "", source: null, required: true },
    { name: "review_feedback", kind: "", source: null, required: true },
  ];
  remediate.produces = [{ name: "plan", kind: "", review: null }];
  const draft = {
    id: null,
    key: "plan-review",
    name: "Plan & Review",
    description: "",
    body: {
      type: "sequence" as const,
      children: [
        plan,
        {
          type: "until" as const,
          check: review,
          condition: {
            source: { producer: review.key, output: "verdict" },
            field: "status",
            operator: "equals" as const,
            value: "accepted",
          },
          otherwise: remediate,
          max_remediations: 2,
        },
      ],
    },
    interface: {
      inputs: [],
      outputs: [
        {
          key: "accepted_plan",
          label: "Accepted Quest Plan",
          kind: "quest_plan",
          source: {
            type: "binding" as const,
            binding: { producer: "", output: "" },
          },
        },
      ],
    },
  };
  const messages = draftValidationIssues(draft).map((issue) => issue.message);
  expect(messages).toContain(
    "Review Plan → Current Quest Plan needs an artifact type.",
  );
  expect(messages).toContain(
    "Remediate → Current Quest Plan needs an artifact type.",
  );
  expect(messages).toContain(
    "Remediate → Review Feedback needs an artifact type.",
  );
  expect(messages).toContain("Remediate → Quest Plan needs an artifact type.");
  expect(messages).toContain("Accepted Quest Plan needs an export source.");
});

test("renaming a Review output preserves its exact condition and export references", () => {
  const until = makeUntil({ type: "sequence", children: [] }, builder);
  if (until.check.type !== "step") throw new Error("Expected Check Step");
  const draft = {
    id: null,
    key: "generic-review",
    name: "Generic Review",
    description: "",
    body: until,
    interface: {
      inputs: [],
      outputs: [
        {
          key: "result",
          label: "Result",
          kind: "review_verdict",
          source: {
            type: "binding" as const,
            binding: { producer: until.check.key, output: "result" },
          },
        },
      ],
    },
  };
  const renamed = renameArtifactOutputReferences(
    draft,
    until.check.key,
    "result",
    "verdict",
  );
  expect(
    renamed.body.type === "until" && renamed.body.condition.source,
  ).toEqual({
    producer: until.check.key,
    output: "verdict",
  });
  expect(renamed.interface.outputs[0]?.source).toEqual({
    type: "binding",
    binding: { producer: until.check.key, output: "verdict" },
  });
});

test("friendly artifact names generate stable Step slots", () => {
  expect(
    generatedArtifactName("Current Quest Plan", "quest_plan", "input", []),
  ).toBe("current_plan");
  expect(
    generatedArtifactName("Review Feedback", "review_verdict", "input", []),
  ).toBe("review_feedback");
  expect(generatedArtifactName("Quest Plan", "quest_plan", "output", [])).toBe(
    "plan",
  );
});

test("empty and malformed local drafts are guided without compiler inference", () => {
  const draft = emptyDraft([]);
  expect(localDraftIssues(draft)).toContain("Give this Tactic a name.");
  expect(localDraftIssues(draft)).toContain(
    "Add at least one item to this sequence.",
  );
});

test("usage counts exact active Quest and nested TacticUse references", () => {
  const target: Tactic = {
    id: "target",
    key: "target",
    name: "Target",
    description: "",
    body: asJson(sequence()),
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  const parent: Tactic = {
    id: "parent",
    key: "parent",
    name: "Parent",
    description: "",
    body: {
      type: "use",
      instance_key: "target",
      tactic_definition_id: target.id,
      input_bindings: [],
    },
    interface: { inputs: [], outputs: [] },
    archived_at: null,
  };
  expect(
    usageFor(
      target.id,
      [target, parent],
      [
        {
          tactic_source: {
            type: "definition",
            tactic_definition_id: target.id,
          },
        },
      ],
    ),
  ).toEqual({ quests: 1, tactics: 1 });
});
