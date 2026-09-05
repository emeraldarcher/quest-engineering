import type { ActiveCrewActivity } from "./active-crew";

export type CrewDemoScenario =
  | "none"
  | "entering"
  | "crafting"
  | "research"
  | "mining"
  | "woodcutting"
  | "parallel"
  | "short"
  | "sequential"
  | "parallel-tail"
  | "facing-fixture"
  | "showcase";

const projects = {
  first: { id: "crew-demo-a", key: "demo-a", name: "Demo Project A" },
  second: { id: "crew-demo-b", key: "demo-b", name: "Demo Project B" },
};

function activity(input: {
  index: number;
  runId: string;
  project: (typeof projects)[keyof typeof projects];
  squadKey: string;
  squadName: string;
  memberName: string;
  classKey: string;
  className: string;
  stepName: string;
}): ActiveCrewActivity {
  const memberKey = input.memberName.toLocaleLowerCase().replaceAll(" ", "-");
  return {
    activityId: `${input.runId}\0demo-occurrence-${input.index}`,
    actorId: `${input.runId}\0${input.squadKey}\0${memberKey}`,
    runId: input.runId,
    occurrenceId: `demo-occurrence-${input.index}`,
    project: input.project,
    quest: {
      id: `demo-quest-${input.runId}`,
      title: `Demo Quest ${input.runId.slice(-1).toUpperCase()}`,
      objective: "Deterministic CrewActor visual review",
    },
    squad: {
      id: `demo-${input.squadKey}`,
      key: input.squadKey,
      name: input.squadName,
    },
    member: {
      member_key: memberKey,
      name: input.memberName,
      class: {
        id: `demo-class-${input.classKey}`,
        key: input.classKey,
        name: input.className,
      },
      loadout: { id: "demo-loadout", key: "demo", name: "Demo" },
    },
    stepKey: input.stepName.toLocaleLowerCase().replaceAll(" ", "-"),
    stepName: input.stepName,
    stepInstruction: null,
    state: "running",
  };
}

const examples = [
  activity({
    index: 1,
    runId: "demo-run-a",
    project: projects.first,
    squadKey: "engineering-pair",
    squadName: "Engineering Pair",
    memberName: "Rowan",
    classKey: "builder",
    className: "Builder",
    stepName: "Implement login validation",
  }),
  activity({
    index: 2,
    runId: "demo-run-a",
    project: projects.first,
    squadKey: "engineering-pair",
    squadName: "Engineering Pair",
    memberName: "Mira",
    classKey: "reviewer",
    className: "Reviewer",
    stepName: "Review login validation",
  }),
  activity({
    index: 3,
    runId: "demo-run-b",
    project: projects.first,
    squadKey: "ore-team",
    squadName: "Ore Team",
    memberName: "Dara",
    classKey: "miner",
    className: "Miner",
    stepName: "Mine release blockers",
  }),
  activity({
    index: 4,
    runId: "demo-run-b",
    project: projects.first,
    squadKey: "ore-team",
    squadName: "Ore Team",
    memberName: "Theo",
    classKey: "woodworker",
    className: "Woodworker",
    stepName: "Chop dependency deadwood",
  }),
  activity({
    index: 5,
    runId: "demo-run-c",
    project: projects.second,
    squadKey: "island-two",
    squadName: "Island Two",
    memberName: "Iris",
    classKey: "builder",
    className: "Builder",
    stepName: "Build second island feature",
  }),
  activity({
    index: 6,
    runId: "demo-run-d",
    project: projects.second,
    squadKey: "island-review",
    squadName: "Island Review",
    memberName: "Ash",
    classKey: "reviewer",
    className: "Reviewer",
    stepName: "Research second island change",
  }),
];

export interface CrewDemoTransition {
  atMs: number;
  activities: ActiveCrewActivity[];
}

export function crewDemoTransitions(
  scenario: CrewDemoScenario,
): CrewDemoTransition[] {
  if (scenario === "short") return [{ atMs: 600, activities: [] }];
  if (scenario === "sequential")
    return [{ atMs: 7_000, activities: [examples[1] as ActiveCrewActivity] }];
  if (scenario === "parallel-tail")
    return [{ atMs: 7_000, activities: examples.slice(1, 4) }];
  return [];
}

export function crewDemoActivities(
  scenario: CrewDemoScenario,
): ActiveCrewActivity[] {
  if (scenario === "none") return [];
  if (
    scenario === "entering" ||
    scenario === "crafting" ||
    scenario === "short" ||
    scenario === "sequential"
  )
    return [examples[0] as ActiveCrewActivity];
  if (scenario === "research" || scenario === "facing-fixture")
    return [examples[1] as ActiveCrewActivity];
  if (scenario === "mining") return [examples[2] as ActiveCrewActivity];
  if (scenario === "woodcutting") return [examples[3] as ActiveCrewActivity];
  if (scenario === "parallel" || scenario === "parallel-tail")
    return examples.slice(0, 4);
  return [...examples];
}
