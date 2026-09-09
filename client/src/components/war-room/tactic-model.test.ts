import { expect, test } from "bun:test";
import type { Tactic } from "../../api/contracts";
import {
  appendChild,
  artifactContractLabel,
  asJson,
  BUILT_IN_ARTIFACT_KINDS,
  emptyDraft,
  generatedLocalKey,
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
  removeNode,
  type SequenceNode,
  steps,
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
    output: "result",
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
  expect(isReviewRemediationUntil(until)).toBe(false);
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
