import type {
  ApiError,
  ClassDefinition,
  JsonValue,
  Loadout,
  Quest,
  RunSummary,
  Squad,
  Tactic,
  Workspace,
} from "../../api/contracts";
import type { Tone } from "../work-yard/run-presentation";

export interface QuestStatusPresentation {
  label: string;
  description: string;
  tone: Tone;
  needsHuman: boolean;
}

export interface SemanticStep {
  key: string;
  name: string;
  branch: "main" | "check" | "otherwise" | "parallel";
  depth: number;
}

export interface SquadReferenceIssue {
  memberName: string;
  kind: "Class" | "Loadout";
  state: "archived" | "unavailable";
}

export function questStatus(quest: Quest): QuestStatusPresentation {
  switch (quest.lifecycle.state) {
    case "ready":
      return {
        label: "Ready to launch",
        description: "This Quest is saved and has not launched yet.",
        tone: "neutral",
        needsHuman: false,
      };
    case "working":
      return {
        label: "Working",
        description: "The current Run is in progress.",
        tone: "active",
        needsHuman: false,
      };
    case "preparing_review":
      return {
        label: "Preparing review",
        description:
          "Execution has settled. Quest Engineering is preparing this Run for review.",
        tone: "active",
        needsHuman: false,
      };
    case "awaiting_review":
      return {
        label: "Awaiting review",
        description: "The Pull Request is open and waiting for review.",
        tone: "warning",
        needsHuman: true,
      };
    case "needs_attention":
      return {
        label: "Needs attention",
        description:
          quest.lifecycle.delivery?.issue?.message ??
          "This Quest needs attention before its lifecycle can continue.",
        tone: "danger",
        needsHuman: true,
      };
    case "complete":
      return {
        label: "Complete",
        description: "The delivered changes were merged.",
        tone: "success",
        needsHuman: false,
      };
  }
}

export function currentRunSummary(
  quest: Quest,
  runs: RunSummary[],
): RunSummary | null {
  const id = quest.lifecycle.current_run_id;
  return id ? (runs.find((run) => run.id === id) ?? null) : null;
}

export function runSummaryLabel(quest: Quest, run: RunSummary): string {
  if (quest.lifecycle.state === "working") return "Execution in progress";
  if (run.status === "completed") return "Execution complete";
  if (run.status === "failed") return "Execution failed";
  return humanize(run.status);
}

export function projectForQuest(
  quest: Quest,
  projects: Workspace[],
): Workspace | null {
  return projects.find((project) => project.id === quest.workspace_id) ?? null;
}

export function squadForQuest(quest: Quest, squads: Squad[]): Squad | null {
  return squads.find((squad) => squad.id === quest.squad_id) ?? null;
}

export function tacticForQuest(quest: Quest, tactics: Tactic[]): Tactic | null {
  if (quest.tactic_source.type !== "definition") return null;
  const definitionId = quest.tactic_source.tactic_definition_id;
  return tactics.find((tactic) => tactic.id === definitionId) ?? null;
}

export function squadReferenceIssues(
  squad: Squad,
  classes: ClassDefinition[],
  loadouts: Loadout[],
): SquadReferenceIssue[] {
  const issues: SquadReferenceIssue[] = [];
  for (const member of squad.members) {
    const classDefinition = classes.find(
      (definition) => definition.id === member.class_id,
    );
    const memberLoadout = loadouts.find(
      (definition) => definition.id === member.loadout_id,
    );
    if (!classDefinition)
      issues.push({
        memberName: member.name,
        kind: "Class",
        state: "unavailable",
      });
    else if (classDefinition.archived_at)
      issues.push({
        memberName: member.name,
        kind: "Class",
        state: "archived",
      });
    if (!memberLoadout)
      issues.push({
        memberName: member.name,
        kind: "Loadout",
        state: "unavailable",
      });
    else if (memberLoadout.archived_at)
      issues.push({
        memberName: member.name,
        kind: "Loadout",
        state: "archived",
      });
  }
  return issues;
}

export function squadIssueSummary(issues: SquadReferenceIssue[]): string {
  const issue = issues[0];
  if (!issue) return "";
  const state = issue.state === "archived" ? "an archived" : "an unavailable";
  const first = `${issue.memberName} uses ${state} ${issue.kind}.`;
  return issues.length === 1
    ? first
    : `${first} ${issues.length - 1} more need attention.`;
}

export function memberSummary(
  squad: Squad,
  classes: ClassDefinition[],
  loadouts: Loadout[],
): Array<{ name: string; className: string; loadoutName: string }> {
  return squad.members.map((member) => ({
    name: member.name,
    className:
      classes.find((definition) => definition.id === member.class_id)?.name ??
      "Class unavailable",
    loadoutName:
      loadouts.find((definition) => definition.id === member.loadout_id)
        ?.name ?? "Loadout unavailable",
  }));
}

export function semanticSteps(value: JsonValue): SemanticStep[] {
  const steps: SemanticStep[] = [];
  visit(value, steps, "main", 0);
  return steps;
}

function visit(
  value: JsonValue,
  steps: SemanticStep[],
  branch: SemanticStep["branch"],
  depth: number,
) {
  if (!isRecord(value)) return;
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "step") {
    const key =
      typeof value.key === "string" ? value.key : `step-${steps.length + 1}`;
    const name =
      typeof value.name === "string" && value.name.trim()
        ? value.name
        : humanize(key);
    steps.push({ key, name, branch, depth });
    return;
  }
  if (type === "until") {
    visit(value.check as JsonValue, steps, "check", depth + 1);
    visit(value.otherwise as JsonValue, steps, "otherwise", depth + 1);
    return;
  }
  const children = Array.isArray(value.children) ? value.children : [];
  for (const child of children)
    visit(
      child as JsonValue,
      steps,
      type === "parallel" ? "parallel" : branch,
      depth + (type === "parallel" ? 1 : 0),
    );
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolvedTacticFromQuestPreview(
  preview: unknown,
): JsonValue | null {
  if (!preview || typeof preview !== "object" || Array.isArray(preview))
    return null;
  const tactic = (preview as Record<string, unknown>).tactic;
  if (!tactic || typeof tactic !== "object" || Array.isArray(tactic))
    return null;
  const resolved = (tactic as Record<string, unknown>).resolved_tactic;
  return (resolved as JsonValue | undefined) ?? null;
}

export function resolvedTacticFromDefinitionPreview(
  preview: unknown,
): JsonValue | null {
  if (!preview || typeof preview !== "object" || Array.isArray(preview))
    return null;
  return (
    ((preview as Record<string, unknown>).resolved_tactic as
      | JsonValue
      | undefined) ?? null
  );
}

export function previewIssue(failure: ApiError | null): {
  title: string;
  description: string;
} | null {
  if (!failure) return null;
  if (
    ["network_unavailable", "invalid_response", "client_error"].includes(
      failure.code,
    )
  )
    return {
      title: "Launch check unavailable",
      description:
        "Quest Engineering couldn't verify this configuration yet. Launch remains server-authoritative.",
    };
  const codes = new Set(failure.details.map((detail) => detail.code));
  if (codes.has("class_not_found") || codes.has("loadout_not_found"))
    return {
      title: "Squad needs configuration",
      description:
        "One or more Members reference a Class or Loadout that is no longer available.",
    };
  if (codes.has("unsatisfied_performer_class"))
    return {
      title: "Approach needs attention",
      description:
        "The selected Squad does not currently include every role this Approach requires.",
    };
  if (failure.code === "archived_reference")
    return {
      title: "Approach needs attention",
      description: "A reusable Tactic used by this Quest has been archived.",
    };
  return {
    title: "Quest setup needs attention",
    description:
      "Quest Engineering couldn't prepare this saved configuration for a new Run.",
  };
}

export function archiveExplanation(state: Quest["lifecycle"]["state"]): string {
  if (state === "working")
    return "Its current Run will continue. Archiving does not cancel work already in progress, and Run history remains available in the Work Yard.";
  if (state === "preparing_review")
    return "Publishing will continue, and existing Run history remains available in the Work Yard.";
  if (state === "awaiting_review")
    return "The existing Pull Request and review lifecycle will continue. Run history remains available in the Work Yard.";
  if (state === "complete")
    return "The Quest will leave the active board. Its completed Run history remains available in the Work Yard.";
  return "The Quest will be removed from the active Quest Board. Existing Run history, if any, remains available in the Work Yard.";
}

export function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
