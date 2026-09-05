/** Presentation-only smoothing. These values never delay semantic execution. */
export const CREW_PRESENTATION_TIMING = {
  minimumVisibleMs: 1_800,
  minimumWorkMs: 650,
  wrapUpMs: 350,
  maximumDepartureMs: 2_600,
} as const;

export const CREW_WALK_SPEED = 22;
