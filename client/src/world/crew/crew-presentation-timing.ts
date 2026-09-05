import type { TownPoint } from "../authored/map-schema";

/** Presentation-only smoothing. These values never delay semantic execution. */
export interface CrewPresentationTiming {
  minimumVisibleMs: number;
  minimumWorkMs: number;
  wrapUpMs: number;
  minimumDepartureMs: number;
  maximumDepartureMs: number;
  maximumVisualTailMs: number;
  deadlineSlackMs: number;
  walkSpeed: number;
}

/**
 * 36px/s keeps island traversal readable without the previous 8–10 second
 * crawl. Grounded 2.0/2.5/3.0/3.5s captures selected 3s as the shortest beat
 * that remains unmistakably readable during real short-Step observation.
 */
export const CREW_PRESENTATION_TIMING: CrewPresentationTiming = {
  minimumVisibleMs: 1_800,
  minimumWorkMs: 3_000,
  wrapUpMs: 400,
  minimumDepartureMs: 900,
  maximumDepartureMs: 1_800,
  maximumVisualTailMs: 14_000,
  deadlineSlackMs: 250,
  walkSpeed: 36,
};

export const CREW_WALK_SPEED = CREW_PRESENTATION_TIMING.walkSpeed;

export function crewPathDistance(
  position: TownPoint,
  path: readonly TownPoint[],
  pathIndex: number,
): number {
  let total = 0;
  let from = position;
  for (const point of path.slice(pathIndex)) {
    total += Math.hypot(point.x - from.x, point.y - from.y);
    from = point;
  }
  return total;
}

export function crewDepartureBudgetMs(
  distance: number,
  timing: CrewPresentationTiming = CREW_PRESENTATION_TIMING,
): number {
  if (distance <= 0) return 0;
  return Math.min(
    timing.maximumDepartureMs,
    Math.max(timing.minimumDepartureMs, (distance / timing.walkSpeed) * 1_000),
  );
}

export function crewVisualTailBudgetMs(
  input: {
    remainingTravelDistance: number;
    remainingWorkMs: number;
    departureDistance: number;
  },
  timing: CrewPresentationTiming = CREW_PRESENTATION_TIMING,
): number {
  const travelMs = (input.remainingTravelDistance / timing.walkSpeed) * 1_000;
  return Math.min(
    timing.maximumVisualTailMs,
    Math.max(
      timing.minimumVisibleMs,
      travelMs +
        input.remainingWorkMs +
        timing.wrapUpMs +
        crewDepartureBudgetMs(input.departureDistance, timing) +
        timing.deadlineSlackMs,
    ),
  );
}
