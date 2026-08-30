import type {
  ClassDefinition,
  DeliveryProjection,
  Loadout,
  Quest,
  RunProjection,
  RunStep,
  SnapshotMember,
  Squad,
  Tactic,
  Workspace,
} from "../api/contracts";
import type { ProductState } from "../state/app-store";

export const fixtureNames = [
  "idle",
  "density",
  "single-active",
  "parallel",
  "waiting",
  "uncertain",
  "failed",
  "preparing-review",
  "pr-review",
  "merged",
  "delivery-attention",
  "recent-runs",
  "member-inspector",
  "cleanup-available",
] as const;
export type FixtureName = (typeof fixtureNames)[number];

export interface ClientFixture {
  name: FixtureName;
  product: ProductState;
  runs: Record<string, RunProjection>;
  selectedRunId: string | null;
}

const classDefinition: ClassDefinition = {
  id: "class-builder",
  key: "builder",
  name: "Builder",
  description: "Builds and validates Product changes.",
  instructions: "Work carefully and report factual results.",
  archived_at: null,
};
const reviewerClass: ClassDefinition = {
  ...classDefinition,
  id: "class-reviewer",
  key: "reviewer",
  name: "Reviewer",
  description: "Reviews completed work.",
};
const loadout: Loadout = {
  id: "loadout-coding",
  key: "coding",
  name: "Coding Tools",
  description: "Repository tools and a connected model.",
  model: { provider: "fixture", model: "town-model" },
  reasoning: "medium",
  tools: ["workspace.filesystem"],
  workspace_access: "read_write",
  archived_at: null,
};
const workspace: Workspace = {
  id: "workspace-quest-engineering",
  key: "quest-engineering",
  name: "Quest Engineering",
  source_kind: "local_git",
  source_fingerprint: null,
  binding: { state: "ready", message: "Project ready." },
  archived_at: null,
};
const tactic: Tactic = {
  id: "tactic-standard",
  key: "standard",
  name: "Implement and Review",
  description: "A deterministic fixture Tactic.",
  body: {},
  archived_at: null,
};

const memberNames = [
  "Alda",
  "Brom",
  "Cora",
  "Dain",
  "Elowen",
  "Fenn",
  "Gilda",
  "Hale",
  "Iris",
  "Jory",
  "Kestrel",
  "Lina",
];
const snapshotMembers: SnapshotMember[] = memberNames.map((name, index) => ({
  member_key: `member-${index + 1}`,
  name,
  class:
    index % 4 === 3
      ? {
          id: reviewerClass.id,
          key: reviewerClass.key,
          name: reviewerClass.name,
        }
      : {
          id: classDefinition.id,
          key: classDefinition.key,
          name: classDefinition.name,
        },
  loadout: { id: loadout.id, key: loadout.key, name: loadout.name },
}));
const squad: Squad = {
  id: "squad-town",
  key: "town-crew",
  name: "Town Crew",
  description: "Twelve factual fixture Members.",
  members: snapshotMembers.map((member) => ({
    member_key: member.member_key,
    name: member.name,
    class_id: member.class.id,
    loadout_id: member.loadout.id,
  })),
  archived_at: null,
};

function delivery(state: DeliveryProjection["state"]): DeliveryProjection {
  const review = ["awaiting_review", "merged", "closed_unmerged"].includes(
    state,
  )
    ? {
        provider: "github" as const,
        state:
          state === "merged"
            ? "merged"
            : state === "closed_unmerged"
              ? "closed"
              : "open",
        number: 142,
        url: "https://github.com/example/quest-engineering/pull/142",
      }
    : null;
  return {
    state,
    changes: { files_changed: 8, additions: 214, deletions: 39 },
    review,
    revisions: { base: "a1b2c3d4", head: "e5f6a7b8" },
    issue:
      state === "attention_required"
        ? {
            code: "publication_attention",
            message: "Publishing needs attention.",
          }
        : null,
    can_retry: state === "attention_required",
  };
}

function step(
  index: number,
  state: RunStep["state"],
  member: SnapshotMember | null,
): RunStep {
  return {
    occurrence_id: `occurrence-${index + 1}`,
    semantic_step_key: `step-${index + 1}`,
    name: `Work order ${index + 1}`,
    instruction:
      "Complete the factual assignment without inferring a world profession.",
    state,
    phase: null,
    remediation_cycle: null,
    control_path: [],
    member,
    performer: {
      selector: "class",
      class_key: "builder",
      source_occurrence_id: null,
      source_semantic_step_key: null,
    },
    context: {
      mode: "fresh",
      source_occurrence_id: null,
      source_semantic_step_key: null,
    },
    inputs: [],
    outputs: [],
    issue:
      state === "failed"
        ? { code: "fixture_failure", message: "The assignment failed safely." }
        : state === "uncertain"
          ? {
              code: "fixture_uncertain",
              message: "The assignment outcome is uncertain.",
            }
          : null,
  };
}

function densitySteps(): RunStep[] {
  return [
    step(0, "running", snapshotMembers[0] ?? null),
    step(1, "running", snapshotMembers[1] ?? null),
    step(2, "running", snapshotMembers[2] ?? null),
    step(3, "scheduled", snapshotMembers[3] ?? null),
    step(4, "scheduled", snapshotMembers[4] ?? null),
    step(5, "failed", snapshotMembers[5] ?? null),
    step(6, "uncertain", snapshotMembers[6] ?? null),
    step(7, "waiting", null),
    step(8, "waiting", null),
  ];
}

function counts(steps: RunStep[]): RunProjection["step_counts"] {
  const result = {
    pending: 0,
    waiting: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const value of steps) result[value.state] += 1;
  return result;
}

function run(
  id: string,
  steps: RunStep[],
  deliveryState: DeliveryProjection["state"] | null = null,
): RunProjection {
  const terminal = deliveryState !== null;
  return {
    id,
    status: terminal ? "completed" : "running",
    launched_at: "2026-08-30T12:00:00Z",
    revision: 7,
    quest: {
      id: "quest-density",
      title: "Living Town Overhaul",
      objective: "Make the town dense, truthful, and readable.",
    },
    execution_environment: {
      workspace: { id: workspace.id, key: workspace.key, name: workspace.name },
      state: terminal ? "retained" : "ready",
      message: terminal
        ? "Terminal Run workspace retained."
        : "Run workspace ready.",
      base_revision: "a1b2c3d4",
      branch: `qe/run/${id}`,
      source_dirty_changes_excluded: false,
      issue: null,
    },
    delivery: deliveryState ? delivery(deliveryState) : null,
    squad: {
      id: squad.id,
      key: squad.key,
      name: squad.name,
      members: snapshotMembers,
    },
    steps,
    artifacts: [],
    issues: [],
    step_counts: counts(steps),
  };
}

function lifecycle(name: FixtureName): Quest["lifecycle"] {
  if (name === "preparing-review")
    return {
      state: "preparing_review",
      label: "Preparing Review",
      current_run_id: "run-fixture",
      primary_action: null,
      delivery: delivery("preparing_review"),
    };
  if (name === "pr-review")
    return {
      state: "awaiting_review",
      label: "Awaiting Review",
      current_run_id: "run-fixture",
      primary_action: "open_pull_request",
      delivery: delivery("awaiting_review"),
    };
  if (name === "merged")
    return {
      state: "complete",
      label: "Complete",
      current_run_id: "run-fixture",
      primary_action: null,
      delivery: delivery("merged"),
    };
  if (name === "delivery-attention")
    return {
      state: "needs_attention",
      label: "Needs Attention",
      current_run_id: "run-fixture",
      primary_action: "retry_publishing",
      delivery: delivery("attention_required"),
    };
  return {
    state: "working",
    label: "Working",
    current_run_id: "run-fixture",
    primary_action: null,
  };
}

export function createFixture(nameValue: string | null): ClientFixture | null {
  if (!nameValue) return null;
  const name = fixtureNames.includes(nameValue as FixtureName)
    ? (nameValue as FixtureName)
    : "density";
  let steps = densitySteps();
  let deliveryState: DeliveryProjection["state"] | null = null;
  if (name === "idle") steps = [];
  if (name === "single-active" || name === "member-inspector")
    steps = [step(0, "running", snapshotMembers[0] ?? null)];
  if (name === "parallel") steps = densitySteps().slice(0, 5);
  if (name === "waiting")
    steps = [
      step(7, "pending", null),
      step(8, "waiting", null),
      step(9, "waiting", null),
    ];
  if (name === "uncertain")
    steps = [step(6, "uncertain", snapshotMembers[6] ?? null)];
  if (name === "failed")
    steps = [step(5, "failed", snapshotMembers[5] ?? null)];
  if (name === "preparing-review") deliveryState = "preparing_review";
  if (name === "pr-review" || name === "cleanup-available")
    deliveryState = "awaiting_review";
  if (name === "merged") deliveryState = "merged";
  if (name === "delivery-attention") deliveryState = "attention_required";
  if (deliveryState)
    steps = snapshotMembers
      .slice(0, 7)
      .map((member, index) => step(index, "completed", member));

  const selected = run("run-fixture", steps, deliveryState);
  const quest: Quest = {
    id: "quest-density",
    title: "Living Town Overhaul",
    objective: "Make the town dense, truthful, and readable.",
    workspace_id: workspace.id,
    squad_id: squad.id,
    tactic_source: { type: "definition", tactic_definition_id: tactic.id },
    completion: {
      completed_at: name === "merged" ? "2026-08-30T12:30:00Z" : null,
      completed_by_run_id: name === "merged" ? selected.id : null,
    },
    lifecycle: lifecycle(name),
    archived_at: null,
  };
  const reviewQuest: Quest = {
    ...quest,
    id: "quest-review",
    title: "API Contract Cleanup",
    lifecycle: {
      state: "awaiting_review",
      label: "Awaiting Review",
      current_run_id: "run-history-review",
      primary_action: "open_pull_request",
      delivery: delivery("awaiting_review"),
    },
  };
  const historical = Array.from({ length: 5 }, (_, index) => {
    const value = run(
      `run-history-${index + 1}`,
      [],
      index === 0 ? "merged" : "closed_unmerged",
    );
    value.quest = { ...value.quest, title: `Recent Quest ${index + 1}` };
    return value;
  });
  const runs = Object.fromEntries(
    [selected, ...historical].map((value) => [value.id, value]),
  );
  const summaries = (
    name === "recent-runs" ? [selected, ...historical] : [selected]
  ).map((value) => ({
    id: value.id,
    status: value.status,
    quest_title: value.quest.title,
    launched_at: value.launched_at,
    step_counts: value.step_counts,
    delivery: value.delivery,
  }));
  return {
    name,
    product: {
      classes: [classDefinition, reviewerClass],
      loadouts: [loadout],
      squads: [squad],
      tactics: [tactic],
      quests: name === "density" ? [quest, reviewQuest] : [quest],
      workspaces: [workspace],
      workspaceSources: [
        {
          candidate_id: "fixture-source",
          name: "Quest Engineering",
          source_kind: "local_git",
          source_fingerprint: null,
          max_access: "read_write",
          shell_available: true,
        },
      ],
      executionOptions: [
        {
          model: loadout.model,
          reasoning: ["medium"],
          tools: loadout.tools,
          workspaces: [
            { workspace_id: workspace.id, workspace_access: ["read_write"] },
          ],
          available: true,
        },
      ],
      runs: summaries,
    },
    runs,
    selectedRunId: selected.id,
  };
}
