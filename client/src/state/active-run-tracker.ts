import type { RunProjection, RunSummary } from "../api/contracts";
import {
  type ActiveCrewActivity,
  projectActiveCrewActivities,
} from "../world/crew/active-crew";

export interface ActiveRunTrackerDependencies {
  getRun(runId: string): Promise<RunProjection>;
  watchRun(runId: string): () => void;
  onActivities(activities: ActiveCrewActivity[]): void;
  onProjection?(projection: RunProjection): void;
  onError?(runId: string, cause: unknown): void;
}

export function isTrackableRun(summary: Pick<RunSummary, "status">): boolean {
  return summary.status !== "completed" && summary.status !== "failed";
}

/**
 * Keeps details only for nonterminal Runs. Product summaries discover Runs;
 * run channels invalidate their cached immutable/current projections.
 */
export class ActiveRunTracker {
  private readonly tracked = new Set<string>();
  private readonly terminal = new Set<string>();
  private readonly projections = new Map<string, RunProjection>();
  private readonly unwatch = new Map<string, () => void>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly refreshNeeded = new Set<string>();
  private disposed = false;

  constructor(private readonly dependencies: ActiveRunTrackerDependencies) {}

  updateSummaries(summaries: readonly RunSummary[]): void {
    if (this.disposed) return;
    const known = new Set(summaries.map((summary) => summary.id));
    for (const id of this.terminal)
      if (
        !known.has(id) ||
        summaries.some(
          (summary) => summary.id === id && !isTrackableRun(summary),
        )
      )
        this.terminal.delete(id);
    const desired = new Set(
      summaries
        .filter(isTrackableRun)
        .map((summary) => summary.id)
        .filter((id) => !this.terminal.has(id)),
    );
    for (const id of this.tracked) if (!desired.has(id)) this.stopTracking(id);
    for (const id of desired) {
      if (this.tracked.has(id)) continue;
      this.tracked.add(id);
      this.unwatch.set(id, this.dependencies.watchRun(id));
      void this.refresh(id);
    }
    this.emit();
  }

  seed(projection: RunProjection): void {
    if (this.disposed || !this.tracked.has(projection.id)) return;
    this.accept(projection);
  }

  invalidate(runId: string): void {
    if (!this.tracked.has(runId)) return;
    if (this.inFlight.has(runId)) {
      this.refreshNeeded.add(runId);
      return;
    }
    void this.refresh(runId);
  }

  suspend(): void {
    this.projections.clear();
    this.emit();
  }

  reconnect(): void {
    for (const runId of this.tracked) this.invalidate(runId);
  }

  snapshot(): ActiveCrewActivity[] {
    return projectActiveCrewActivities([...this.projections.values()]);
  }

  projection(runId: string): RunProjection | null {
    return this.projections.get(runId) ?? null;
  }

  isTracking(runId: string): boolean {
    return this.tracked.has(runId);
  }

  trackedRunIds(): string[] {
    return [...this.tracked].sort();
  }

  dispose(): void {
    this.disposed = true;
    for (const release of this.unwatch.values()) release();
    this.unwatch.clear();
    this.tracked.clear();
    this.projections.clear();
    this.refreshNeeded.clear();
  }

  private refresh(runId: string): Promise<void> {
    const existing = this.inFlight.get(runId);
    if (existing) return existing;
    const request = (async () => {
      do {
        this.refreshNeeded.delete(runId);
        try {
          const projection = await this.dependencies.getRun(runId);
          if (this.tracked.has(runId)) this.accept(projection);
        } catch (cause) {
          if (this.tracked.has(runId)) {
            this.projections.delete(runId);
            this.emit();
            this.dependencies.onError?.(runId, cause);
          }
        }
      } while (this.tracked.has(runId) && this.refreshNeeded.has(runId));
    })().finally(() => this.inFlight.delete(runId));
    this.inFlight.set(runId, request);
    return request;
  }

  private accept(projection: RunProjection): void {
    this.dependencies.onProjection?.(projection);
    if (projection.status === "completed" || projection.status === "failed") {
      this.terminal.add(projection.id);
      this.stopTracking(projection.id);
      return;
    }
    this.projections.set(projection.id, projection);
    this.emit();
  }

  private stopTracking(runId: string): void {
    this.tracked.delete(runId);
    this.refreshNeeded.delete(runId);
    this.projections.delete(runId);
    this.unwatch.get(runId)?.();
    this.unwatch.delete(runId);
    this.emit();
  }

  private emit(): void {
    this.dependencies.onActivities(this.snapshot());
  }
}
