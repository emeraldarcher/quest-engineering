import type {
  ArtifactDetail,
  ArtifactSummary,
  ClassDefinition,
  DeliveryProjection,
  Loadout,
  Quest,
  QuestLifecycleState,
  RunProjection,
  RunStep,
  RunSummary,
  SnapshotMember,
  Squad,
  StarterCrewStatus,
  Tactic,
  TacticPreview,
  Workspace,
} from "../api/contracts";
import type { RealtimeStatus } from "../realtime/client";
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
  "member-inspector",
  "cleanup-available",
  "projects",
  "projects-empty",
  "projects-preparing",
  "projects-attention",
  "guild-empty",
  "forge",
  "forge-empty",
  "forge-custom",
  "tavern",
  "tavern-archived",
  "tavern-empty",
  "work-yard-overview",
  "work-yard-running",
  "work-yard-remediation",
  "work-yard-artifacts",
  "work-yard-awaiting-review",
  "work-yard-merged",
  "work-yard-cleanup",
  "work-yard-history",
  "work-yard-empty",
  "starter-empty",
  "starter-project-add",
  "starter-preparing",
  "starter-attention",
  "starter-ready",
  "starter-creating",
  "starter-complete",
  "starter-failure",
  "starter-partial",
  "starter-conflict",
  "starter-manual",
  "quest-board-empty",
  "quest-board-new",
  "quest-board-ready",
  "quest-board-project-preparing",
  "quest-board-project-offline",
  "quest-board-invalid-squad",
  "quest-board-tactic-error",
  "quest-board-launching",
  "quest-board-working",
  "quest-board-preparing-review",
  "quest-board-awaiting-review",
  "quest-board-attention",
  "quest-board-execution-complete",
  "quest-board-complete",
  "quest-board-closed-unmerged",
  "quest-board-no-changes",
  "quest-board-history",
  "quest-board-dirty",
  "war-room-empty",
  "war-room-detail",
  "war-room-new",
  "war-room-step",
  "war-room-step-advanced",
  "war-room-sequence",
  "war-room-parallel",
  "war-room-until",
  "war-room-affinity",
  "war-room-context",
  "war-room-artifacts",
  "war-room-use",
  "war-room-nested-use",
  "war-room-direct-cycle",
  "war-room-transitive-cycle",
  "war-room-contextual",
  "war-room-invalid",
  "war-room-ambiguous",
  "war-room-archived-class",
  "war-room-archived-use",
  "war-room-shared",
  "war-room-archive",
  "war-room-dirty",
  "war-room-responsive",
  "town-hud-idle",
  "town-hud-active",
  "town-hud-working",
  "town-hud-attention",
  "town-hud-reviews",
  "town-hud-mixed",
  "town-hud-disconnected",
  "town-hud-first-quest",
  "town-hud-preparing-review",
  "town-hud-responsive",
] as const;
export type FixtureName = (typeof fixtureNames)[number];

export interface ClientFixture {
  name: FixtureName;
  product: ProductState;
  runs: Record<string, RunProjection>;
  selectedRunId: string | null;
  starterStatus?: StarterCrewStatus;
  artifactDetails?: Record<string, Record<string, ArtifactDetail>>;
  tacticPreviews?: Record<string, TacticPreview>;
  realtimeStatus?: RealtimeStatus;
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
  description: "Independently reviews completed work.",
  instructions:
    "Review completed work independently. Check it against the objective and report factual findings.",
};
const loadout: Loadout = {
  id: "loadout-coding",
  key: "coding",
  name: "Coding Tools",
  description: "A full implementation environment for Product changes.",
  model: { provider: "fixture", model: "town-model" },
  reasoning: "high",
  tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
  workspace_access: "read_write",
  archived_at: null,
};
const reviewLoadout: Loadout = {
  ...loadout,
  id: "loadout-review",
  key: "review",
  name: "Review Tools",
  description: "Read-only tools for independent review.",
  reasoning: "medium",
  tools: ["workspace.filesystem", "workspace.search"],
  workspace_access: "read_only",
};
const customLoadout: Loadout = {
  ...loadout,
  id: "loadout-experimental",
  key: "experimental",
  name: "Experimental Bench",
  description: "Custom equipment for specialist Product work.",
  model: { provider: "acme-labs", model: "experimental-model-x" },
  tools: ["workspace.filesystem", "acme.special-tool"],
};
const archivedReviewerClass: ClassDefinition = {
  ...reviewerClass,
  archived_at: "2026-08-29T12:00:00Z",
};
const archivedReviewLoadout: Loadout = {
  ...reviewLoadout,
  archived_at: "2026-08-29T12:00:00Z",
};
const workspace: Workspace = {
  id: "workspace-quest-engineering",
  key: "quest-engineering",
  name: "Quest Engineering",
  source_kind: "git_remote",
  source_fingerprint: "https://github.com/emeraldarcher/quest-engineering",
  binding: { state: "ready", message: "Project ready." },
  archived_at: null,
};
const offlineWorkspace: Workspace = {
  ...workspace,
  id: "workspace-qtest",
  key: "qtest",
  name: "qtest",
  source_fingerprint: "https://github.com/emeraldarcher/qtest",
  binding: { state: "offline", message: "Project repository offline." },
};
const attentionWorkspace: Workspace = {
  ...workspace,
  id: "workspace-attention",
  key: "garden-tools",
  name: "Garden Tools",
  source_fingerprint: "https://github.com/emeraldarcher/garden-tools",
  binding: {
    state: "attention_required",
    message: "Project setup requires attention.",
    issue: { code: "workspace_binding_failed" },
  },
};
const preparingWorkspace: Workspace = {
  ...workspace,
  binding: { state: "preparing", message: "Preparing Project…" },
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
const productSquad: Squad = {
  ...squad,
  members: squad.members.map((member, index) => ({
    ...member,
    loadout_id: index % 4 === 3 ? reviewLoadout.id : loadout.id,
  })),
};
const engineeringPair: Squad = {
  id: "squad-engineering-pair",
  key: "engineering-pair",
  name: "Engineering Pair",
  description: "A small implementation and review team.",
  members: [
    {
      member_key: "rowan",
      name: "Rowan",
      class_id: classDefinition.id,
      loadout_id: loadout.id,
    },
    {
      member_key: "mira",
      name: "Mira",
      class_id: reviewerClass.id,
      loadout_id: reviewLoadout.id,
    },
  ],
  archived_at: null,
};
const backendTeam: Squad = {
  id: "squad-backend-team",
  key: "backend-team",
  name: "Backend Team",
  description: "Implementation team for larger Product changes.",
  members: ["Theo", "Iris", "Alda", "Brom"].map((name) => ({
    member_key: name.toLocaleLowerCase(),
    name,
    class_id: classDefinition.id,
    loadout_id: loadout.id,
  })),
  archived_at: null,
};
const archivedReferenceSquad: Squad = {
  ...engineeringPair,
  id: "squad-archived-reference",
  key: "legacy-pair",
  name: "Legacy Pair",
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
    attempt: [
      "scheduled",
      "running",
      "completed",
      "failed",
      "uncertain",
    ].includes(state)
      ? { id: `attempt-${index + 1}`, number: 1, state }
      : null,
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
    launch: { id: `launch-${id}` },
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

const workYardRowan: SnapshotMember = {
  member_key: "rowan",
  name: "Rowan",
  class: { id: classDefinition.id, key: classDefinition.key, name: "Builder" },
  loadout: { id: loadout.id, key: loadout.key, name: "Coding" },
};
const workYardMira: SnapshotMember = {
  member_key: "mira",
  name: "Mira",
  class: { id: reviewerClass.id, key: reviewerClass.key, name: "Reviewer" },
  loadout: { id: reviewLoadout.id, key: reviewLoadout.key, name: "Review" },
};
const workYardMembers = [workYardRowan, workYardMira];

function workYardStep(
  id: string,
  semanticKey: string,
  name: string,
  state: RunStep["state"],
  member: SnapshotMember,
  outputs: Array<{ type: string; artifact_id: string }> = [],
  remediationCycle: number | null = null,
): RunStep {
  return {
    occurrence_id: id,
    semantic_step_key: semanticKey,
    name,
    instruction: `${name} the requested Product change and report factual results.`,
    state,
    phase:
      remediationCycle === null
        ? null
        : name === "Repair"
          ? "otherwise"
          : "check",
    remediation_cycle: remediationCycle,
    control_path: [],
    attempt: ["pending", "waiting"].includes(state)
      ? null
      : {
          id: `attempt-${id}`,
          number: state === "running" ? 2 : 1,
          state,
        },
    member,
    performer: {
      selector: "class",
      class_key: member.class.key,
      source_occurrence_id: null,
      source_semantic_step_key: null,
    },
    context: {
      mode: semanticKey === "implement" ? "fresh" : "continue_from",
      source_occurrence_id:
        semanticKey === "implement" ? null : "occ-implement",
      source_semantic_step_key:
        semanticKey === "implement" ? null : "implement",
    },
    inputs: [],
    outputs,
    issue:
      state === "failed"
        ? {
            code: "execution_failed",
            message: "Execution reported a terminal failure.",
          }
        : state === "uncertain"
          ? {
              code: "execution_uncertain",
              message: "Execution state is being reconciled.",
            }
          : null,
  };
}

function workYardArtifacts(): {
  summaries: ArtifactSummary[];
  details: Record<string, ArtifactDetail>;
} {
  const values: Array<ArtifactDetail> = [
    {
      id: "artifact-verdict",
      type: "verdict",
      producer_occurrence_id: "occ-review",
      preview: { kind: "scalar", value: "approved" },
      value: "approved",
    },
    {
      id: "artifact-change-set",
      type: "change_set",
      producer_occurrence_id: "occ-implement",
      preview: { kind: "json_summary", summary: "object" },
      value: {
        created: ["hello_world.md"],
        updated: ["README.md"],
        summary: "Added the documented greeting and verification notes.",
      },
    },
    {
      id: "artifact-custom",
      type: "custom_metrics",
      producer_occurrence_id: "occ-review",
      preview: { kind: "json_summary", summary: "object" },
      value: {
        confidence: 0.94,
        checks: [
          { name: "contract", passed: true },
          { name: "accessibility", passed: true },
        ],
        metadata: { source: "custom-review-adapter", schema: 3 },
      },
    },
  ];
  return {
    summaries: values.map(({ value: _value, ...summary }) => summary),
    details: Object.fromEntries(values.map((value) => [value.id, value])),
  };
}

function workYardDelivery(
  state: DeliveryProjection["state"],
): DeliveryProjection {
  const base = delivery(state);
  if (state === "attention_required")
    return {
      ...base,
      issue: {
        code: "base_branch_unresolved",
        message: "The Run base branch is unavailable.",
      },
      can_retry: true,
    };
  if (state === "closed_unmerged")
    return {
      ...base,
      issue: {
        code: "closed_unmerged",
        message: "The Pull Request was closed without merge.",
      },
      can_retry: false,
    };
  if (state === "no_changes")
    return {
      ...base,
      issue: {
        code: "no_changes",
        message:
          "Agent work completed, but there are no repository changes to publish.",
      },
      can_retry: false,
    };
  return base;
}

function createWorkYardFixture(name: FixtureName): ClientFixture {
  const artifacts = workYardArtifacts();
  const isRemediation = name === "work-yard-remediation";
  const isRunning = name === "work-yard-running";
  const deliveryState: DeliveryProjection["state"] | null =
    name === "work-yard-awaiting-review" || name === "work-yard-cleanup"
      ? "awaiting_review"
      : name === "work-yard-merged"
        ? "merged"
        : isRunning
          ? null
          : "attention_required";
  const steps = isRemediation
    ? [
        workYardStep(
          "occ-implement",
          "implement",
          "Implement",
          "completed",
          workYardRowan,
          [{ type: "change_set", artifact_id: "artifact-change-set" }],
        ),
        workYardStep(
          "occ-review-first",
          "review",
          "Review",
          "completed",
          workYardMira,
          [{ type: "verdict", artifact_id: "artifact-changes-requested" }],
          0,
        ),
        workYardStep(
          "occ-repair",
          "repair",
          "Repair",
          "completed",
          workYardRowan,
          [],
          1,
        ),
        workYardStep(
          "occ-review",
          "review",
          "Review",
          "completed",
          workYardMira,
          [{ type: "verdict", artifact_id: "artifact-verdict" }],
          1,
        ),
      ]
    : [
        workYardStep(
          "occ-implement",
          "implement",
          "Implement",
          "completed",
          workYardRowan,
          [{ type: "change_set", artifact_id: "artifact-change-set" }],
        ),
        workYardStep(
          "occ-review",
          "review",
          "Review",
          isRunning ? "running" : "completed",
          workYardMira,
          isRunning
            ? []
            : [{ type: "verdict", artifact_id: "artifact-verdict" }],
        ),
      ];
  const runArtifacts = isRunning
    ? artifacts.summaries.slice(1, 2)
    : artifacts.summaries;
  if (isRemediation)
    runArtifacts.push({
      id: "artifact-changes-requested",
      type: "verdict",
      producer_occurrence_id: "occ-review-first",
      preview: { kind: "scalar", value: "changes_requested" },
    });
  const runValue: RunProjection = {
    id: "run-mini-test",
    status: isRunning ? "running" : "completed",
    launched_at: "2026-09-01T14:20:00Z",
    revision: 12,
    launch: { id: "launch-mini-test" },
    quest: {
      id: "quest-mini-test",
      title: "Mini Test Run",
      objective: "Add a small documented greeting and verify the result.",
    },
    execution_environment: {
      workspace: {
        id: "workspace-qe-test",
        key: "qe-test-space",
        name: "QE Test Space",
      },
      state: isRunning ? "ready" : "retained",
      message: isRunning
        ? "Run workspace ready."
        : "Terminal Run workspace retained.",
      base_revision: "a1b2c3d4e5f6789012345678901234567890abcd",
      branch: "qe/run/mini-test-run",
      source_dirty_changes_excluded: false,
      issue: null,
    },
    delivery: deliveryState ? workYardDelivery(deliveryState) : null,
    squad: {
      id: engineeringPair.id,
      key: engineeringPair.key,
      name: "Engineering Pair",
      members: workYardMembers,
    },
    steps,
    artifacts: runArtifacts,
    step_counts: counts(steps),
    issues: [],
  };
  const questValue: Quest = {
    id: runValue.quest.id,
    title: runValue.quest.title,
    objective: runValue.quest.objective,
    workspace_id: runValue.execution_environment.workspace.id,
    squad_id: runValue.squad.id,
    tactic_source: { type: "definition", tactic_definition_id: tactic.id },
    completion: {
      completed_at: deliveryState === "merged" ? "2026-09-01T15:00:00Z" : null,
      completed_by_run_id: deliveryState === "merged" ? runValue.id : null,
    },
    lifecycle:
      deliveryState === "merged"
        ? {
            state: "complete",
            label: "Complete",
            current_run_id: runValue.id,
            primary_action: null,
            delivery: workYardDelivery("merged"),
          }
        : deliveryState === "attention_required"
          ? {
              state: "needs_attention",
              label: "Needs Attention",
              current_run_id: runValue.id,
              primary_action: "retry_publishing",
              delivery: workYardDelivery("attention_required"),
            }
          : deliveryState === "awaiting_review"
            ? {
                state: "awaiting_review",
                label: "Awaiting Review",
                current_run_id: runValue.id,
                primary_action: "open_pull_request",
                delivery: workYardDelivery("awaiting_review"),
              }
            : {
                state: "working",
                label: "Working",
                current_run_id: runValue.id,
                primary_action: null,
              },
    archived_at: null,
  };
  const history = Array.from(
    { length: name === "work-yard-history" ? 5 : 0 },
    (_, index) => {
      const state: DeliveryProjection["state"] =
        index % 2 === 0 ? "merged" : "no_changes";
      const value: RunProjection = {
        ...runValue,
        id: `run-history-${index + 1}`,
        launch: { id: `launch-history-${index + 1}` },
        launched_at: `2026-08-${String(31 - index).padStart(2, "0")}T10:00:00Z`,
        quest: {
          ...runValue.quest,
          id: `quest-history-${index + 1}`,
          title:
            [
              "Accessibility Polish",
              "API Contract Cleanup",
              "Garden Notes",
              "Roster Repair",
              "Project Setup",
            ][index] ?? "Historical Quest",
        },
        delivery: workYardDelivery(state),
        artifacts: [],
      };
      return value;
    },
  );
  const allRuns = [runValue, ...history];
  const summaries = allRuns.map((value) => ({
    id: value.id,
    status: value.status,
    quest_title: value.quest.title,
    launched_at: value.launched_at,
    step_counts: value.step_counts,
    delivery: value.delivery,
  }));
  const isEmpty = name === "work-yard-empty";
  return {
    name,
    product: {
      classes: [classDefinition, reviewerClass],
      classCatalog: [classDefinition, reviewerClass],
      loadouts: [loadout, reviewLoadout],
      loadoutCatalog: [loadout, reviewLoadout],
      squads: [engineeringPair],
      tactics: [tactic],
      quests: isEmpty ? [] : [questValue],
      workspaces: [workspace],
      workspaceSources: [],
      executionOptions: [],
      runs: isEmpty ? [] : summaries,
    },
    runs: isEmpty
      ? {}
      : Object.fromEntries(allRuns.map((value) => [value.id, value])),
    selectedRunId: isEmpty ? null : runValue.id,
    artifactDetails: isEmpty
      ? {}
      : {
          [runValue.id]: {
            ...artifacts.details,
            "artifact-changes-requested": {
              id: "artifact-changes-requested",
              type: "verdict",
              producer_occurrence_id: "occ-review-first",
              preview: { kind: "scalar", value: "changes_requested" },
              value: "changes_requested",
            },
          },
        },
  };
}

function createQuestBoardFixture(name: FixtureName): ClientFixture {
  const questTactic: Tactic = {
    id: "tactic-implement-review",
    key: "implement-and-review",
    name: "Implement & Review",
    description: "A small implementation and independent review workflow.",
    body: {
      type: "sequence",
      children: [
        {
          type: "step",
          key: "implement",
          name: "Implement",
          instruction: "Implement the Quest objective.",
          performer: { selector: "class", value: "builder" },
          context: { selector: "fresh", value: null },
          consumes: [],
          produces: [{ type: "change_set", source: null }],
        },
        {
          type: "step",
          key: "review",
          name: "Review",
          instruction: "Review the implementation.",
          performer: { selector: "class", value: "reviewer" },
          context: { selector: "fresh", value: null },
          consumes: [{ type: "change_set", source: "implement" }],
          produces: [{ type: "verdict", source: null }],
        },
      ],
    },
    archived_at: null,
  };
  const remediationTactic: Tactic = {
    ...questTactic,
    id: "tactic-remediation",
    key: "implement-review-repair",
    name: "Implement, Review & Repair",
    description: "Review and repair until the result is accepted.",
    body: {
      type: "sequence",
      children: [
        {
          type: "step",
          key: "implement",
          name: "Implement",
          instruction: "Implement.",
          performer: { selector: "class", value: "builder" },
        },
        {
          type: "until",
          check: {
            type: "step",
            key: "review",
            name: "Review",
            instruction: "Review.",
            performer: { selector: "class", value: "reviewer" },
          },
          otherwise: {
            type: "step",
            key: "repair",
            name: "Repair",
            instruction: "Repair.",
            performer: { selector: "class", value: "builder" },
          },
        },
      ],
    },
  };
  const selectedProject =
    name === "quest-board-project-offline"
      ? {
          ...workspace,
          binding: {
            state: "offline" as const,
            message: "Project repository offline.",
          },
        }
      : name === "quest-board-project-preparing"
        ? preparingWorkspace
        : workspace;
  const selectedSquad =
    name === "quest-board-invalid-squad"
      ? {
          ...engineeringPair,
          id: "squad-needs-configuration",
          name: "Engineering Pair · Needs Configuration",
        }
      : engineeringPair;
  const deliveryState: DeliveryProjection["state"] | null =
    name === "quest-board-preparing-review"
      ? "preparing_review"
      : name === "quest-board-awaiting-review"
        ? "awaiting_review"
        : name === "quest-board-attention"
          ? "attention_required"
          : name === "quest-board-complete"
            ? "merged"
            : name === "quest-board-closed-unmerged"
              ? "closed_unmerged"
              : name === "quest-board-no-changes"
                ? "no_changes"
                : null;
  const runId = "run-quest-board-current";
  const isWorking = name === "quest-board-working";
  const executionComplete =
    deliveryState !== null || name === "quest-board-execution-complete";
  const runSteps = [
    workYardStep(
      "quest-occ-implement",
      "implement",
      "Implement",
      executionComplete || isWorking ? "completed" : "waiting",
      workYardRowan,
    ),
    workYardStep(
      "quest-occ-review",
      "review",
      "Review",
      executionComplete ? "completed" : isWorking ? "running" : "pending",
      workYardMira,
    ),
  ];
  const runDelivery = deliveryState ? workYardDelivery(deliveryState) : null;
  const runValue: RunProjection = {
    id: runId,
    status: executionComplete ? "completed" : "running",
    launched_at: "2026-09-02T10:15:00Z",
    revision: 4,
    launch: { id: "launch-quest-board-current" },
    quest: {
      id: "quest-login-validation",
      title: "Add login validation",
      objective:
        "Validate login requests and return clear errors for invalid credentials.",
    },
    execution_environment: {
      workspace: {
        id: selectedProject.id,
        key: selectedProject.key,
        name: selectedProject.name,
      },
      state: "retained",
      message: executionComplete
        ? "Terminal Run workspace retained."
        : "Run workspace ready.",
      base_revision: "1234567890abcdef1234567890abcdef12345678",
      branch: "qe/run/quest-board-current",
      source_dirty_changes_excluded: false,
      issue: null,
    },
    delivery: runDelivery,
    squad: {
      id: selectedSquad.id,
      key: selectedSquad.key,
      name: selectedSquad.name,
      members: workYardMembers,
    },
    steps: runSteps,
    artifacts: [],
    step_counts: counts(runSteps),
    issues: [],
  };
  if (isWorking) runValue.execution_environment.state = "ready";
  const lifecycleState: Quest["lifecycle"] =
    name === "quest-board-working"
      ? {
          state: "working",
          label: "Working",
          current_run_id: runId,
          primary_action: null,
        }
      : name === "quest-board-preparing-review" ||
          name === "quest-board-execution-complete"
        ? {
            state: "preparing_review",
            label: "Preparing Review",
            current_run_id: runId,
            primary_action: null,
            ...(runDelivery ? { delivery: runDelivery } : {}),
          }
        : name === "quest-board-awaiting-review"
          ? {
              state: "awaiting_review",
              label: "Awaiting Review",
              current_run_id: runId,
              primary_action: "open_pull_request",
              delivery: runDelivery as DeliveryProjection,
            }
          : name === "quest-board-complete"
            ? {
                state: "complete",
                label: "Complete",
                current_run_id: runId,
                primary_action: null,
              }
            : [
                  "quest-board-attention",
                  "quest-board-closed-unmerged",
                  "quest-board-no-changes",
                ].includes(name)
              ? {
                  state: "needs_attention",
                  label: "Needs Attention",
                  current_run_id: runId,
                  primary_action:
                    name === "quest-board-attention" ? null : "run_again",
                  delivery: runDelivery as DeliveryProjection,
                }
              : {
                  state: "ready",
                  label: "Ready",
                  current_run_id: null,
                  primary_action: "launch",
                };
  const selectedQuest: Quest = {
    id: runValue.quest.id,
    title: runValue.quest.title,
    objective: runValue.quest.objective,
    workspace_id: selectedProject.id,
    squad_id: selectedSquad.id,
    tactic_source: { type: "definition", tactic_definition_id: questTactic.id },
    completion: {
      completed_at:
        name === "quest-board-complete" ? "2026-09-02T11:30:00Z" : null,
      completed_by_run_id: name === "quest-board-complete" ? runId : null,
    },
    lifecycle: lifecycleState,
    archived_at: null,
  };
  const cardQuests: Quest[] = [
    selectedQuest,
    {
      ...selectedQuest,
      id: "quest-onboarding",
      title: "Improve onboarding",
      objective: "Make the first Project experience clearer.",
      lifecycle: {
        state: "working",
        label: "Working",
        current_run_id: "run-other-working",
        primary_action: null,
      },
    },
    {
      ...selectedQuest,
      id: "quest-export",
      title: "Fix export handling",
      objective: "Preserve exported settings safely.",
      lifecycle: {
        state: "needs_attention",
        label: "Needs Attention",
        current_run_id: "run-other-attention",
        primary_action: "run_again",
      },
    },
    {
      ...selectedQuest,
      id: "quest-settings",
      title: "Create settings screen",
      objective: "Create an approachable settings experience.",
      lifecycle: {
        state: "complete",
        label: "Complete",
        current_run_id: "run-other-complete",
        primary_action: null,
      },
      completion: {
        completed_at: "2026-09-01T16:00:00Z",
        completed_by_run_id: "run-other-complete",
      },
    },
  ];
  const empty = name === "quest-board-empty" || name === "quest-board-new";
  const hasCurrentRun = lifecycleState.current_run_id !== null;
  const historySummaries: RunSummary[] =
    name === "quest-board-history"
      ? Array.from({ length: 3 }, (_, index) => ({
          id: `run-quest-history-${index + 1}`,
          status: "completed",
          quest_title: selectedQuest.title,
          launched_at: `2026-08-${29 - index}T12:00:00Z`,
          step_counts: {
            pending: 0,
            waiting: 0,
            scheduled: 0,
            running: 0,
            completed: 2,
            failed: 0,
            uncertain: 0,
          },
          delivery: workYardDelivery(
            index === 0 ? "closed_unmerged" : "no_changes",
          ),
        }))
      : [];
  const currentSummary: RunSummary = {
    id: runValue.id,
    status: runValue.status,
    quest_title: runValue.quest.title,
    launched_at: runValue.launched_at,
    step_counts: runValue.step_counts,
    delivery: runValue.delivery,
  };
  return {
    name,
    product: {
      classes:
        name === "quest-board-invalid-squad"
          ? [classDefinition]
          : [classDefinition, reviewerClass],
      classCatalog:
        name === "quest-board-invalid-squad"
          ? [classDefinition, archivedReviewerClass]
          : [classDefinition, reviewerClass],
      loadouts: [loadout, reviewLoadout],
      loadoutCatalog: [loadout, reviewLoadout],
      squads: [selectedSquad, backendTeam],
      tactics: [questTactic, remediationTactic],
      quests: empty ? [] : cardQuests,
      workspaces: [selectedProject, offlineWorkspace],
      workspaceSources: [
        {
          candidate_id: "quest-board-source",
          name: "quest-engineering",
          source_kind: "git_remote",
          source_fingerprint: selectedProject.source_fingerprint,
          publication_repository_identity: "emeraldarcher/quest-engineering",
          max_access: "read_write",
          shell_available: true,
        },
      ],
      executionOptions: [],
      runs: [...(hasCurrentRun ? [currentSummary] : []), ...historySummaries],
    },
    runs: hasCurrentRun ? { [runId]: runValue } : {},
    selectedRunId: null,
    starterStatus: { state: "manual_configuration", conflict: null },
  };
}

function createStarterFixture(name: FixtureName): ClientFixture {
  const projectState =
    name === "starter-preparing"
      ? "preparing"
      : name === "starter-attention"
        ? "attention_required"
        : "ready";
  const starterProject: Workspace = {
    id: "workspace-starter",
    key: "starter-project",
    name: "Quest Engineering",
    source_kind: "git_remote",
    source_fingerprint: "https://github.com/example/quest-engineering",
    binding: {
      state: projectState,
      message:
        projectState === "ready"
          ? "Project ready."
          : projectState === "preparing"
            ? "Preparing Project…"
            : "Project setup requires attention.",
      ...(projectState === "attention_required"
        ? { issue: { code: "workspace_binding_failed" } }
        : {}),
    },
    archived_at: null,
  };
  const builder: ClassDefinition = {
    id: "starter-class-builder",
    key: "builder",
    name: "Builder",
    description: "Builds the requested change.",
    instructions:
      "Implement the requested change carefully and report the declared result.",
    archived_at: null,
  };
  const reviewer: ClassDefinition = {
    id: "starter-class-reviewer",
    key: "reviewer",
    name: "Reviewer",
    description: "Independently reviews completed work.",
    instructions:
      "Review the supplied work independently and report the declared result.",
    archived_at: null,
  };
  const coding: Loadout = {
    id: "starter-loadout-coding",
    key: "coding",
    name: "Coding",
    description: "Writable engineering capabilities.",
    model: { provider: "fixture", model: "starter-model" },
    reasoning: "medium",
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    workspace_access: "read_write",
    archived_at: null,
  };
  const review: Loadout = {
    id: "starter-loadout-review",
    key: "review",
    name: "Review",
    description: "Read-only review capabilities.",
    model: coding.model,
    reasoning: coding.reasoning,
    tools: ["workspace.filesystem", "workspace.search"],
    workspace_access: "read_only",
    archived_at: null,
  };
  const starterSquad: Squad = {
    id: "starter-squad",
    key: "engineering-pair",
    name: "Engineering Pair",
    description: "A builder and independent reviewer.",
    members: [
      {
        member_key: "builder",
        name: "Builder",
        class_id: builder.id,
        loadout_id: coding.id,
      },
      {
        member_key: "reviewer",
        name: "Reviewer",
        class_id: reviewer.id,
        loadout_id: review.id,
      },
    ],
    archived_at: null,
  };
  const starterTactic: Tactic = {
    id: "starter-tactic",
    key: "implement-and-review",
    name: "Implement & Review",
    description:
      "A small sequential implementation and independent review tactic.",
    body: {
      type: "sequence",
      children: [
        {
          type: "step",
          key: "implement",
          name: "Implement",
          instruction: "Implement the Quest objective.",
          performer: { selector: "class", value: "builder" },
          context: { selector: "fresh", value: null },
          consumes: [],
          produces: [{ type: "change_set", source: null }],
        },
        {
          type: "step",
          key: "review",
          name: "Review",
          instruction: "Review the implementation against the Quest objective.",
          performer: { selector: "class", value: "reviewer" },
          context: { selector: "fresh", value: null },
          consumes: [{ type: "change_set", source: "implement" }],
          produces: [{ type: "verdict", source: null }],
        },
      ],
    },
    archived_at: null,
  };
  const noProject = name === "starter-empty" || name === "starter-project-add";
  const complete = name === "starter-complete";
  const partial = name === "starter-partial";
  const conflict = name === "starter-conflict";
  const manual = name === "starter-manual";
  const hasProject = !noProject;
  const status: StarterCrewStatus = {
    state: complete
      ? "complete"
      : partial
        ? "recoverable_partial"
        : conflict
          ? "conflict"
          : manual
            ? "manual_configuration"
            : "empty",
    conflict: conflict ? { entity_type: "loadout", key: "coding" } : null,
  };
  const classes = complete
    ? [builder, reviewer]
    : partial
      ? [builder]
      : manual
        ? [
            {
              ...builder,
              id: "manual-class",
              key: "architect",
              name: "Architect",
            },
          ]
        : [];
  return {
    name,
    product: {
      classes,
      classCatalog: classes,
      loadouts: complete
        ? [coding, review]
        : conflict
          ? [{ ...coding, model: { provider: "custom", model: "different" } }]
          : [],
      loadoutCatalog: complete
        ? [coding, review]
        : conflict
          ? [{ ...coding, model: { provider: "custom", model: "different" } }]
          : [],
      squads: complete ? [starterSquad] : [],
      tactics: complete ? [starterTactic] : [],
      quests: [],
      workspaces: hasProject ? [starterProject] : [],
      workspaceSources: [
        {
          candidate_id: "starter-source",
          name: "quest-engineering",
          source_kind: "git_remote",
          source_fingerprint: starterProject.source_fingerprint,
          publication_repository_identity: "example/quest-engineering",
          max_access: "read_write",
          shell_available: true,
        },
      ],
      executionOptions:
        hasProject && projectState === "ready"
          ? [
              {
                model: coding.model,
                reasoning: ["low", "medium"],
                tools: coding.tools,
                workspaces: [
                  {
                    workspace_id: starterProject.id,
                    workspace_access: ["none", "read_only", "read_write"],
                  },
                ],
                available: true,
              },
            ]
          : [],
      runs: [],
    },
    runs: {},
    selectedRunId: null,
    starterStatus: status,
  };
}

function createWarRoomFixture(name: FixtureName): ClientFixture {
  const stepNode = (
    key: string,
    role: string,
    options: { consumes?: string[]; produces?: string[] } = {},
  ) => ({
    type: "step",
    key,
    name: key
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()),
    instruction: `${key.replaceAll("-", " ")} the Quest objective.`,
    performer: { selector: "class", value: role },
    context: { selector: "fresh", value: null },
    consumes: (options.consumes ?? []).map((type) => ({ type, source: null })),
    produces: (options.produces ?? []).map((type) => ({ type, source: null })),
  });
  const implement = stepNode("implement", "builder", {
    produces: ["change_set"],
  });
  const review = {
    ...stepNode("review", "reviewer", {
      consumes: ["change_set"],
      produces: ["verdict"],
    }),
    consumes: [{ type: "change_set", source: null }],
    instruction: "Review the implementation against the Quest objective.",
  };
  const implementReview: Tactic = {
    id: "war-tactic-implement-review",
    key: "implement-and-review",
    name: "Implement & Review",
    description: "A simple implementation and independent review approach.",
    body: { type: "sequence", children: [implement, review] },
    archived_at: null,
  };
  const planning: Tactic = {
    id: "war-tactic-plan",
    key: "plan-and-build",
    name: "Plan & Build",
    description: "Plan the work before implementation.",
    body: {
      type: "sequence",
      children: [
        stepNode("plan", "builder", { produces: ["plan"] }),
        stepNode("build", "builder", {
          consumes: ["plan"],
          produces: ["change_set"],
        }),
      ],
    },
    archived_at: null,
  };
  const parallelTactic: Tactic = {
    id: "war-tactic-parallel",
    key: "parallel-build",
    name: "Parallel Build",
    description: "Plan, build backend and frontend together, then review.",
    body: {
      type: "sequence",
      children: [
        stepNode("plan", "builder", { produces: ["plan"] }),
        {
          type: "parallel",
          children: [
            stepNode("backend", "builder", {
              consumes: ["plan"],
              produces: ["backend_change"],
            }),
            stepNode("frontend", "builder", {
              consumes: ["plan"],
              produces: ["frontend_change"],
            }),
          ],
        },
        stepNode("review", "reviewer", {
          consumes: ["backend_change", "frontend_change"],
          produces: ["verdict"],
        }),
      ],
    },
    archived_at: null,
  };
  const ambiguousTactic: Tactic = {
    ...parallelTactic,
    id: "war-tactic-ambiguous",
    key: "ambiguous-build",
    name: "Ambiguous Build",
    description: "Two branches currently produce the same artifact type.",
    body: {
      type: "sequence",
      children: [
        {
          type: "parallel",
          children: [
            stepNode("backend", "builder", { produces: ["change_set"] }),
            stepNode("frontend", "builder", { produces: ["change_set"] }),
          ],
        },
        stepNode("review", "reviewer", {
          consumes: ["change_set"],
          produces: ["verdict"],
        }),
      ],
    },
  };
  const invalidTactic: Tactic = {
    ...implementReview,
    id: "war-tactic-invalid-draft",
    key: "invalid-draft",
    name: "Incomplete Structure",
    description: "A deterministic incomplete local draft.",
    body: { type: "parallel", children: [] },
  };
  const remediation: Tactic = {
    id: "war-tactic-remediation",
    key: "review-and-repair",
    name: "Review & Repair",
    description: "Review and repair with a bounded remediation loop.",
    body: {
      type: "sequence",
      children: [
        implement,
        {
          type: "until",
          check: review,
          condition: {
            artifact: { type: "verdict", source: "review" },
            field: "status",
            operator: "equals",
            value: "accepted",
          },
          otherwise: {
            ...stepNode("repair", "builder", {
              consumes: ["change_set", "verdict"],
              produces: ["change_set"],
            }),
            performer: { selector: "same_as", value: "implement" },
            context: { selector: "continue_from", value: "implement" },
          },
          max_remediations: 2,
        },
      ],
    },
    archived_at: null,
  };
  const contextual: Tactic = {
    id: "war-tactic-contextual",
    key: "implement-from-plan",
    name: "Implement from Plan",
    description: "Uses a plan supplied by its surrounding flow.",
    body: stepNode("implement", "builder", {
      consumes: ["plan"],
      produces: ["change_set"],
    }),
    archived_at: null,
  };
  const composed: Tactic = {
    id: "war-tactic-composed",
    key: "composed-delivery",
    name: "Composed Delivery",
    description: "Reuses planning and implementation semantics.",
    body: {
      type: "sequence",
      children: [
        {
          type: "use",
          instance_key: "planning",
          tactic_definition_id: planning.id,
        },
        {
          type: "use",
          instance_key: "delivery",
          tactic_definition_id: implementReview.id,
        },
      ],
    },
    archived_at: null,
  };
  const archivedClass: ClassDefinition = {
    ...reviewerClass,
    id: "class-archived-auditor",
    key: "auditor",
    name: "Auditor",
    archived_at: "2026-09-03T09:00:00Z",
  };
  const archivedChild: Tactic = {
    ...planning,
    id: "war-tactic-archived-child",
    key: "archived-plan",
    name: "Archived Plan",
    archived_at: "2026-09-03T09:00:00Z",
  };
  const archivedUse: Tactic = {
    ...composed,
    id: "war-tactic-archived-use",
    key: "uses-archived-plan",
    name: "Uses Archived Plan",
    body: {
      type: "use",
      instance_key: "planning",
      tactic_definition_id: archivedChild.id,
    },
  };
  const classReference: Tactic = {
    ...implementReview,
    id: "war-tactic-archived-class",
    key: "archived-audit",
    name: "Archived Audit",
    body: stepNode("audit", "auditor", { produces: ["verdict"] }),
  };
  const selected =
    name === "war-room-parallel"
      ? parallelTactic
      : name === "war-room-ambiguous"
        ? ambiguousTactic
        : name === "war-room-invalid"
          ? invalidTactic
          : [
                "war-room-until",
                "war-room-affinity",
                "war-room-context",
              ].includes(name)
            ? remediation
            : name === "war-room-contextual"
              ? contextual
              : name === "war-room-use" || name === "war-room-nested-use"
                ? composed
                : name === "war-room-archived-class"
                  ? classReference
                  : name === "war-room-archived-use"
                    ? archivedUse
                    : implementReview;
  const active = [
    selected,
    implementReview,
    planning,
    parallelTactic,
    remediation,
    contextual,
    composed,
    archivedUse,
    classReference,
  ].filter(
    (item, index, values) =>
      !item.archived_at &&
      values.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const sharedQuest: Quest = {
    id: "war-quest-shared",
    title: "Ship account validation",
    objective: "Implement and review account validation.",
    workspace_id: workspace.id,
    squad_id: squad.id,
    tactic_source: {
      type: "definition",
      tactic_definition_id: implementReview.id,
    },
    completion: { completed_at: null, completed_by_run_id: null },
    lifecycle: {
      state: "ready",
      label: "Ready",
      current_run_id: null,
      primary_action: "launch",
    },
    archived_at: null,
  };
  return {
    name,
    product: {
      classes: [classDefinition, reviewerClass],
      classCatalog: [classDefinition, reviewerClass, archivedClass],
      loadouts: [loadout, reviewLoadout],
      loadoutCatalog: [loadout, reviewLoadout],
      squads: [squad],
      tactics: name === "war-room-empty" ? [] : [...active, archivedChild],
      quests:
        name === "war-room-shared" || name === "war-room-archive"
          ? [sharedQuest]
          : [],
      workspaces: [workspace],
      workspaceSources: [],
      executionOptions: [],
      runs: [],
    },
    runs: {},
    selectedRunId: null,
    tacticPreviews:
      name === "war-room-empty"
        ? {}
        : {
            [selected.id]: {
              resolved_tactic: selected.body,
              artifact_bindings:
                selected.id === implementReview.id
                  ? [
                      {
                        artifact_type: "change_set",
                        consumer: {
                          name: "Review",
                          local_key: "review",
                          definition: {
                            key: implementReview.key,
                            name: implementReview.name,
                          },
                          instance_path: [],
                        },
                        selection: "inferred",
                        source: {
                          kind: "step",
                          step: {
                            name: "Implement",
                            local_key: "implement",
                            definition: {
                              key: implementReview.key,
                              name: implementReview.name,
                            },
                            instance_path: [],
                          },
                        },
                      },
                    ]
                  : [],
              provenance: null,
              step_origins: [],
            },
          },
  };
}

function hudQuest(
  index: number,
  state: QuestLifecycleState,
  archived = false,
): Quest {
  const runId = state === "ready" ? null : "run-hud";
  const deliveryState =
    state === "preparing_review"
      ? "preparing_review"
      : state === "awaiting_review"
        ? "awaiting_review"
        : state === "needs_attention"
          ? "attention_required"
          : state === "complete"
            ? "merged"
            : null;
  return {
    id: `quest-hud-${index}`,
    title: `Town Quest ${index}`,
    objective: "Exercise truthful HUD lifecycle presentation.",
    workspace_id: workspace.id,
    squad_id: productSquad.id,
    tactic_source: { type: "definition", tactic_definition_id: tactic.id },
    completion: {
      completed_at: state === "complete" ? "2026-08-30T12:30:00Z" : null,
      completed_by_run_id: state === "complete" ? "run-hud" : null,
    },
    lifecycle: {
      state,
      label: state.replaceAll("_", " "),
      current_run_id: runId,
      primary_action:
        state === "ready"
          ? "launch"
          : state === "awaiting_review"
            ? "open_pull_request"
            : state === "needs_attention"
              ? "retry_publishing"
              : state === "complete"
                ? "run_again"
                : null,
      ...(deliveryState ? { delivery: delivery(deliveryState) } : {}),
    },
    archived_at: archived ? "2026-08-29T12:00:00Z" : null,
  };
}

function createTownHudFixture(name: FixtureName): ClientFixture {
  const states: QuestLifecycleState[] =
    name === "town-hud-idle"
      ? ["complete"]
      : name === "town-hud-active"
        ? ["ready", "ready", "preparing_review", "complete"]
        : name === "town-hud-working"
          ? ["working", "working", "working", "ready"]
          : name === "town-hud-attention"
            ? ["working", "needs_attention", "ready"]
            : name === "town-hud-reviews"
              ? [
                  "awaiting_review",
                  "awaiting_review",
                  "awaiting_review",
                  "ready",
                ]
              : name === "town-hud-first-quest"
                ? ["ready"]
                : name === "town-hud-preparing-review"
                  ? ["preparing_review", "ready"]
                  : [
                      "working",
                      "working",
                      "needs_attention",
                      "awaiting_review",
                      "awaiting_review",
                      "preparing_review",
                    ];
  const quests = states.map((state, index) => hudQuest(index + 1, state));
  if (name === "town-hud-idle")
    quests.push(hudQuest(2, "needs_attention", true));
  const hasWorkingTown = states.includes("working");
  const selected = run(
    "run-hud",
    hasWorkingTown ? densitySteps().slice(0, 5) : [],
  );
  const summary: RunSummary = {
    id: selected.id,
    status: selected.status,
    quest_title: selected.quest.title,
    launched_at: selected.launched_at,
    step_counts: selected.step_counts,
    delivery: selected.delivery,
  };
  return {
    name,
    product: {
      classes: [classDefinition, reviewerClass],
      classCatalog: [classDefinition, reviewerClass],
      loadouts: [loadout, reviewLoadout],
      loadoutCatalog: [loadout, reviewLoadout],
      squads: [productSquad],
      tactics: [{ ...tactic, body: { type: "sequence", children: [] } }],
      quests,
      workspaces: [workspace],
      workspaceSources: [
        {
          candidate_id: "fixture-source",
          name: "quest-engineering",
          source_kind: "git_remote",
          source_fingerprint:
            "https://github.com/emeraldarcher/quest-engineering",
          publication_repository_identity: "emeraldarcher/quest-engineering",
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
      runs: hasWorkingTown ? [summary] : [],
    },
    runs: hasWorkingTown ? { [selected.id]: selected } : {},
    selectedRunId: hasWorkingTown ? selected.id : null,
    realtimeStatus:
      name === "town-hud-disconnected" ? "disconnected" : "connected",
  };
}

export function createFixture(nameValue: string | null): ClientFixture | null {
  if (!nameValue) return null;
  if (nameValue.startsWith("town-hud-"))
    return createTownHudFixture(nameValue as FixtureName);
  if (nameValue.startsWith("starter-"))
    return createStarterFixture(nameValue as FixtureName);
  if (nameValue.startsWith("quest-board-"))
    return createQuestBoardFixture(nameValue as FixtureName);
  if (nameValue.startsWith("work-yard-"))
    return createWorkYardFixture(nameValue as FixtureName);
  if (nameValue.startsWith("war-room-"))
    return createWarRoomFixture(nameValue as FixtureName);
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
  const runs = { [selected.id]: selected };
  const summaries = [
    {
      id: selected.id,
      status: selected.status,
      quest_title: selected.quest.title,
      launched_at: selected.launched_at,
      step_counts: selected.step_counts,
      delivery: selected.delivery,
    },
  ];
  const tavernQuests = ["Compiler Cleanup", "Roster UX", "API Polish"].map(
    (title, index): Quest => ({
      ...quest,
      id: `quest-tavern-${index + 1}`,
      title,
      squad_id:
        name === "tavern-archived"
          ? archivedReferenceSquad.id
          : engineeringPair.id,
    }),
  );
  const fixtureClasses =
    name === "guild-empty"
      ? []
      : name === "tavern-archived"
        ? [classDefinition]
        : [classDefinition, reviewerClass];
  const classCatalog =
    name === "tavern-archived"
      ? [classDefinition, archivedReviewerClass]
      : fixtureClasses;
  const fixtureLoadouts =
    name === "forge-empty"
      ? []
      : name === "tavern-archived"
        ? [loadout]
        : name === "forge-custom"
          ? [loadout, reviewLoadout, customLoadout]
          : [loadout, reviewLoadout];
  const loadoutCatalog =
    name === "tavern-archived"
      ? [loadout, archivedReviewLoadout]
      : fixtureLoadouts;
  const fixtureSquads =
    name === "tavern-empty"
      ? []
      : name === "tavern-archived"
        ? [archivedReferenceSquad]
        : name === "tavern"
          ? [engineeringPair, backendTeam]
          : [productSquad];
  return {
    name,
    product: {
      classes: fixtureClasses,
      classCatalog,
      loadouts: fixtureLoadouts,
      loadoutCatalog,
      squads: fixtureSquads,
      tactics: [tactic],
      quests: name.startsWith("tavern")
        ? name === "tavern-empty"
          ? []
          : tavernQuests
        : name === "density"
          ? [quest, reviewQuest]
          : [quest],
      workspaces:
        name === "projects-empty"
          ? []
          : name === "projects-preparing"
            ? [preparingWorkspace]
            : name === "projects-attention"
              ? [attentionWorkspace]
              : name === "projects"
                ? [workspace, offlineWorkspace, attentionWorkspace]
                : [workspace],
      workspaceSources: [
        {
          candidate_id: "fixture-source",
          name: "quest-engineering",
          source_kind: "git_remote",
          source_fingerprint:
            "https://github.com/emeraldarcher/quest-engineering",
          publication_repository_identity: "emeraldarcher/quest-engineering",
          max_access: "read_write",
          shell_available: true,
        },
        {
          candidate_id: "fixture-qtest",
          name: "qtest",
          source_kind: "git_remote",
          source_fingerprint: "https://github.com/emeraldarcher/qtest",
          publication_repository_identity: "emeraldarcher/qtest",
          max_access: "read_write",
          shell_available: true,
        },
        {
          candidate_id: "fixture-local",
          name: "garden-notes",
          source_kind: "local_git",
          source_fingerprint: null,
          publication_repository_identity: null,
          max_access: "read_write",
          shell_available: false,
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
