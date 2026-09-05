import { expect, test } from "bun:test";
import {
  CREW_MOTION_EPSILON,
  crewCompositeScaleX,
  crewFacingForMotion,
  crewFacingMirrorsWork,
  crewWalkingVisual,
  crewWorkFacing,
} from "./crew-facing";

test("walking facing follows Pixi coordinates and every authored/mirrored direction", () => {
  const cases = [
    [{ x: 0, y: -1 }, "south", "north", "walk-n", false],
    [{ x: 1, y: -1 }, "south", "northeast", "walk-ne", false],
    [{ x: 1, y: 0 }, "north", "northeast", "walk-ne", false],
    [{ x: 1, y: 1 }, "north", "southeast", "walk-se", false],
    [{ x: 0, y: 1 }, "north", "south", "walk-s", false],
    [{ x: -1, y: 1 }, "north", "southwest", "walk-se", true],
    [{ x: -1, y: 0 }, "north", "northwest", "walk-ne", true],
    [{ x: -1, y: -1 }, "south", "northwest", "walk-ne", true],
  ] as const;
  for (const [vector, previous, facing, tag, mirrorX] of cases)
    expect(crewWalkingVisual(vector, previous)).toMatchObject({
      facing,
      animation: { tag },
      mirrorX,
    });
});

test("horizontal hysteresis preserves upper/lower continuity until motion is decisive", () => {
  expect(crewFacingForMotion({ x: 1, y: 0 }, "north")).toBe("northeast");
  expect(crewFacingForMotion({ x: 1, y: 0 }, "south")).toBe("southeast");
  expect(crewFacingForMotion({ x: -1, y: 0 }, "northwest")).toBe("northwest");
  expect(crewFacingForMotion({ x: -1, y: 0 }, "southwest")).toBe("southwest");
  expect(crewFacingForMotion({ x: 1, y: 0.4 }, "northeast")).toBe("northeast");
  expect(crewFacingForMotion({ x: 1, y: -0.4 }, "southeast")).toBe("southeast");
  expect(crewFacingForMotion({ x: 1, y: 0.7 }, "northeast")).toBe("southeast");
  expect(crewFacingForMotion({ x: 1, y: -0.7 }, "southeast")).toBe("northeast");
});

test("zero and near-zero motion preserve facing across route junctions", () => {
  expect(crewFacingForMotion({ x: 0, y: 0 }, "northwest")).toBe("northwest");
  expect(
    crewFacingForMotion(
      { x: CREW_MOTION_EPSILON / 2, y: -CREW_MOTION_EPSILON / 2 },
      "southeast",
    ),
  ).toBe("southeast");
});

test("qeFacing overrides approach and west work mirrors the whole composite", () => {
  expect(crewWorkFacing("north", "south")).toEqual({
    facing: "north",
    source: "authored qeFacing",
  });
  expect(crewWorkFacing("south", "north")).toEqual({
    facing: "south",
    source: "authored qeFacing",
  });
  expect(crewWorkFacing("east", "north")).toEqual({
    facing: "southeast",
    source: "authored qeFacing",
  });
  expect(crewWorkFacing("west", "north")).toEqual({
    facing: "southwest",
    source: "authored qeFacing",
  });
  expect(crewFacingMirrorsWork("southeast")).toBe(false);
  expect(crewFacingMirrorsWork("southwest")).toBe(true);
  expect(crewCompositeScaleX(true)).toBe(-1);
  expect(Array.from({ length: 4 }, () => crewCompositeScaleX(true))).toEqual([
    -1, -1, -1, -1,
  ]);
  expect(crewWorkFacing(null, "northeast")).toEqual({
    facing: "northeast",
    source: "approach fallback",
  });
  expect(crewWorkFacing(null, null)).toEqual({
    facing: "south",
    source: "default",
  });
});
