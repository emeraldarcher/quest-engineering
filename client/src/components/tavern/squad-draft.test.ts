import { expect, test } from "bun:test";
import type {
  ClassDefinition,
  Loadout,
  SquadMember,
} from "../../api/contracts";
import {
  generatedMemberKey,
  moveRosterMember,
  referenceIssues,
  squadInput,
} from "./squad-draft";

const members: SquadMember[] = [
  {
    member_key: "rowan",
    name: "Rowan",
    class_id: "builder",
    loadout_id: "coding",
  },
  {
    member_key: "mira",
    name: "Mira",
    class_id: "reviewer",
    loadout_id: "review",
  },
];

const classes: ClassDefinition[] = [
  {
    id: "builder",
    key: "builder",
    name: "Builder",
    description: "",
    instructions: "Build.",
    archived_at: null,
  },
  {
    id: "reviewer",
    key: "reviewer",
    name: "Reviewer",
    description: "",
    instructions: "Review.",
    archived_at: "2026-01-01T00:00:00Z",
  },
];
const loadouts: Loadout[] = [
  {
    id: "coding",
    key: "coding",
    name: "Coding",
    description: "",
    model: { provider: "fixture", model: "town-model" },
    reasoning: "high",
    tools: [],
    workspace_access: "read_write",
    archived_at: null,
  },
  {
    id: "review",
    key: "review",
    name: "Review",
    description: "",
    model: { provider: "fixture", model: "town-model" },
    reasoning: "medium",
    tools: [],
    workspace_access: "read_only",
    archived_at: "2026-01-01T00:00:00Z",
  },
];

test("Member keys are deterministic and collision-safe", () => {
  expect(generatedMemberKey("Alex", [])).toBe("alex");
  expect(generatedMemberKey("Alex", ["alex", "alex-2"])).toBe("alex-3");
});

test("reordering changes only visible roster position", () => {
  const reordered = moveRosterMember(members, 1, -1);
  expect(reordered).toEqual([...members].reverse());
  expect(reordered.map((member) => member.member_key)).toEqual([
    "mira",
    "rowan",
  ]);
});

test("archived references are reported without mutating persisted Members", () => {
  const original = structuredClone(members);
  expect(referenceIssues(members, classes, loadouts)).toEqual([
    {
      memberIndex: 1,
      memberName: "Mira",
      kind: "class",
      state: "archived",
      definitionName: "Reviewer",
    },
    {
      memberIndex: 1,
      memberName: "Mira",
      kind: "loadout",
      state: "archived",
      definitionName: "Review",
    },
  ]);
  expect(members).toEqual(original);
});

test("Member payloads contain only canonical Product reference fields", () => {
  const input = squadInput({ name: "Pair", description: "", members });
  expect(Object.keys(input.members[0] ?? {}).sort()).toEqual([
    "class_id",
    "loadout_id",
    "member_key",
    "name",
  ]);
  expect(input.members[0]).not.toHaveProperty("instructions");
  expect(input.members[0]).not.toHaveProperty("model");
  expect(input.members[0]).not.toHaveProperty("reasoning");
  expect(input.members[0]).not.toHaveProperty("tools");
  expect(input.members[0]).not.toHaveProperty("workspace_access");
});
