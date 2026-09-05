import { expect, test } from "bun:test";
import {
  CREW_PRESENTATION_TIMING,
  crewDepartureBudgetMs,
  crewPathDistance,
  crewVisualTailBudgetMs,
} from "./crew-presentation-timing";

test("path-aware tail includes travel, work, wrap, and bounded departure", () => {
  expect(
    crewPathDistance(
      { x: 0, y: 0 },
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 40 },
      ],
      1,
    ),
  ).toBe(70);
  const short = crewVisualTailBudgetMs({
    remainingTravelDistance: 0,
    remainingWorkMs: CREW_PRESENTATION_TIMING.minimumWorkMs,
    departureDistance: 20,
  });
  const long = crewVisualTailBudgetMs({
    remainingTravelDistance: 180,
    remainingWorkMs: CREW_PRESENTATION_TIMING.minimumWorkMs,
    departureDistance: 180,
  });
  expect(long).toBeGreaterThan(short);
  expect(long).toBeLessThanOrEqual(
    CREW_PRESENTATION_TIMING.maximumVisualTailMs,
  );
});

test("departure allowance communicates exit without requiring a full long route", () => {
  expect(crewDepartureBudgetMs(1)).toBe(
    CREW_PRESENTATION_TIMING.minimumDepartureMs,
  );
  expect(crewDepartureBudgetMs(10_000)).toBe(
    CREW_PRESENTATION_TIMING.maximumDepartureMs,
  );
});
