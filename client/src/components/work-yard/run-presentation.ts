import type {
  ArtifactDetail,
  ArtifactSummary,
  DeliveryProjection,
  Quest,
  RunProjection,
  RunStep,
  RunSummary,
  StepState,
} from "../../api/contracts";

export type Tone = "neutral" | "active" | "success" | "warning" | "danger";

export interface StatusPresentation {
  label: string;
  description: string;
  tone: Tone;
}

const executionStates: Record<string, StatusPresentation> = {
  pending: {
    label: "Pending",
    description: "Execution has not started yet.",
    tone: "neutral",
  },
  waiting: {
    label: "Waiting",
    description: "Execution is waiting for an available Member and Worker.",
    tone: "warning",
  },
  scheduled: {
    label: "Scheduled",
    description: "Work has been assigned and is waiting to begin.",
    tone: "active",
  },
  running: {
    label: "Running",
    description: "Members are working on this Run.",
    tone: "active",
  },
  completed: {
    label: "Completed",
    description:
      "Execution completed. Delivery and Quest status remain separate.",
    tone: "success",
  },
  failed: {
    label: "Failed",
    description: "Execution reached a terminal failure.",
    tone: "danger",
  },
  uncertain: {
    label: "Uncertain",
    description: "Execution state is being reconciled.",
    tone: "warning",
  },
};

const deliveryStates: Record<DeliveryProjection["state"], StatusPresentation> =
  {
    preparing_review: {
      label: "Preparing review",
      description: "Quest Engineering is preparing this Run for review.",
      tone: "active",
    },
    awaiting_review: {
      label: "Awaiting review",
      description: "The Pull Request is open and waiting for review.",
      tone: "warning",
    },
    merged: {
      label: "Merged",
      description:
        "The Pull Request was merged and Quest completion is proven.",
      tone: "success",
    },
    closed_unmerged: {
      label: "Closed without merge",
      description: "The Pull Request closed without being merged.",
      tone: "warning",
    },
    no_changes: {
      label: "No changes to publish",
      description: "Delivery found no repository changes to publish.",
      tone: "neutral",
    },
    attention_required: {
      label: "Publishing needs attention",
      description: "Delivery could not continue without attention.",
      tone: "danger",
    },
  };

const workspaceStates: Record<
  RunProjection["execution_environment"]["state"],
  StatusPresentation
> = {
  waiting_for_host: {
    label: "Waiting for host",
    description: "Waiting for a compatible Worker to host this Run workspace.",
    tone: "warning",
  },
  preparing: {
    label: "Preparing",
    description: "Preparing an isolated Run workspace.",
    tone: "active",
  },
  ready: {
    label: "Ready",
    description: "The isolated Run workspace is ready.",
    tone: "success",
  },
  attention_required: {
    label: "Needs attention",
    description: "The Run workspace requires attention.",
    tone: "danger",
  },
  retained: {
    label: "Retained",
    description: "The isolated Run workspace is retained after execution.",
    tone: "neutral",
  },
  cleanup_requested: {
    label: "Cleanup requested",
    description: "The retained Run workspace is being removed.",
    tone: "active",
  },
  removed: {
    label: "Removed",
    description: "The isolated Run workspace was removed.",
    tone: "neutral",
  },
};

const diagnosticCopy: Record<string, { title: string; description: string }> = {
  base_branch_unresolved: {
    title: "Base branch couldn't be determined",
    description:
      "Quest Engineering couldn't determine which branch this Run should be published against.",
  },
  base_revision_unresolved: {
    title: "Base revision couldn't be determined",
    description:
      "Quest Engineering couldn't determine the repository revision this Run started from.",
  },
  pull_request_identity_mismatch: {
    title: "Pull Request identity changed",
    description:
      "The Pull Request no longer matches the repository and branch recorded for this Delivery.",
  },
  cross_repository_pull_request_not_supported: {
    title: "Cross-repository Pull Request isn't supported",
    description:
      "This Delivery cannot publish a Pull Request from a different repository.",
  },
  remote_branch_conflict: {
    title: "Published branch conflicts with this Run",
    description:
      "The remote Run branch contains content that does not match this Delivery.",
  },
  delivery_content_changed: {
    title: "Delivery content changed",
    description:
      "The retained Run content changed while Delivery was being prepared.",
  },
  worker_upgrade_required: {
    title: "Worker upgrade required",
    description:
      "The assigned Worker does not support this Delivery operation.",
  },
  github_cli_timeout: {
    title: "GitHub didn't respond in time",
    description: "Publishing can be retried after GitHub becomes available.",
  },
};

export function executionPresentation(state: string): StatusPresentation {
  return (
    executionStates[state] ?? {
      label: humanize(state),
      description: "Execution status is available in Technical details.",
      tone: "neutral",
    }
  );
}

export function deliveryPresentation(
  delivery: DeliveryProjection | null,
): StatusPresentation {
  return delivery
    ? deliveryStates[delivery.state]
    : {
        label: "Not started",
        description: "Delivery begins only after execution settles.",
        tone: "neutral",
      };
}

export function workspacePresentation(
  state: RunProjection["execution_environment"]["state"],
): StatusPresentation {
  return workspaceStates[state];
}

export function diagnosticPresentation(issue: {
  code: string;
  message: string;
}): { title: string; description: string } {
  const known = diagnosticCopy[issue.code];
  if (!known)
    return {
      title: "This operation needs attention",
      description: issue.message,
    };
  return {
    title: known.title,
    description:
      issue.message && issue.message !== known.title
        ? `${known.description} ${issue.message}`
        : known.description,
  };
}

export function completedSteps(summary: RunSummary): number {
  return summary.step_counts.completed ?? 0;
}

export function totalSteps(counts: Record<StepState, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function runProgress(summary: RunSummary): string {
  const total = totalSteps(summary.step_counts);
  return `${completedSteps(summary)} of ${total} ${total === 1 ? "step" : "steps"}`;
}

export function formatLaunchTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Launch time unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function canCleanUp(run: RunProjection): boolean {
  return (
    run.execution_environment.state === "retained" &&
    ["awaiting_review", "merged", "closed_unmerged", "no_changes"].includes(
      run.delivery?.state ?? "",
    )
  );
}

export function canRunAgain(run: RunProjection, quest: Quest | null): boolean {
  return Boolean(
    quest &&
      quest.lifecycle.current_run_id === run.id &&
      quest.lifecycle.primary_action === "run_again",
  );
}

export function questPresentation(
  run: RunProjection,
  quest: Quest | null,
): StatusPresentation | null {
  if (run.delivery?.state === "merged")
    return {
      label: "Complete",
      description: "This Run's merged Delivery proves Quest completion.",
      tone: "success",
    };
  if (!quest) return null;
  const labels: Record<Quest["lifecycle"]["state"], StatusPresentation> = {
    ready: {
      label: "Ready",
      description: quest.lifecycle.label,
      tone: "neutral",
    },
    working: {
      label: "In progress",
      description: quest.lifecycle.label,
      tone: "active",
    },
    preparing_review: {
      label: "Preparing review",
      description: quest.lifecycle.label,
      tone: "active",
    },
    awaiting_review: {
      label: "Awaiting review",
      description: quest.lifecycle.label,
      tone: "warning",
    },
    complete: {
      label: "Complete",
      description: quest.lifecycle.label,
      tone: "success",
    },
    needs_attention: {
      label: "Not complete",
      description: quest.lifecycle.label,
      tone: "danger",
    },
  };
  return labels[quest.lifecycle.state];
}

export function stepDisplayName(steps: RunStep[], index: number): string {
  const step = steps[index];
  if (!step) return "Step";
  const name = step.name ?? humanize(step.semantic_step_key);
  const pass = steps
    .slice(0, index + 1)
    .filter((item) => item.semantic_step_key === step.semantic_step_key).length;
  return pass > 1 ? `${name} · ${ordinal(pass)} pass` : name;
}

export function stepResult(
  step: RunStep,
  artifacts: ArtifactSummary[],
): string | null {
  for (const reference of step.outputs) {
    if (reference.type !== "verdict") continue;
    const artifact = artifacts.find(
      (item) => item.id === reference.artifact_id,
    );
    const preview = artifact?.preview;
    if (
      preview &&
      typeof preview === "object" &&
      !Array.isArray(preview) &&
      preview.kind === "scalar" &&
      typeof preview.value === "string"
    )
      return humanize(preview.value);
  }
  return null;
}

export function artifactTypeLabel(type: string): string {
  if (type === "change_set") return "Reported change set";
  return humanize(type);
}

export function artifactPreview(summary: ArtifactSummary): string {
  const preview = summary.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview))
    return String(preview ?? "Value available");
  if (preview.kind === "scalar")
    return typeof preview.value === "string"
      ? humanize(preview.value)
      : JSON.stringify(preview.value);
  return preview.summary === "array"
    ? "List"
    : preview.summary === "object"
      ? "Structured data"
      : "Value available";
}

export function friendlyArtifact(detail: ArtifactDetail): Array<{
  label: string;
  value: string;
}> {
  if (detail.type === "verdict" && typeof detail.value === "string")
    return [{ label: "Verdict", value: humanize(detail.value) }];
  if (
    !detail.value ||
    typeof detail.value !== "object" ||
    Array.isArray(detail.value)
  )
    return [{ label: "Value", value: String(detail.value ?? "None") }];
  const values: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(detail.value)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      values.push({ label: humanize(key), value: String(value) });
    else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    )
      values.push({ label: humanize(key), value: value.join(", ") || "None" });
  }
  return values.slice(0, 5);
}

export function artifactProducer(
  artifact: ArtifactSummary,
  steps: RunStep[],
): string {
  const index = steps.findIndex(
    (step) => step.occurrence_id === artifact.producer_occurrence_id,
  );
  if (index < 0) return "Producer unavailable";
  const step = steps[index];
  if (!step) return "Producer unavailable";
  return `${stepDisplayName(steps, index)}${step.member ? ` · ${step.member.name}` : ""}`;
}

export function humanize(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

function ordinal(value: number): string {
  if (value === 2) return "second";
  if (value === 3) return "third";
  return `${value}th`;
}
