import { expect, test } from "bun:test";
import {
  crewFacingForMotion,
  crewWalkingVisual,
  crewWorkFacing,
} from "./crew-facing";

test("walking facing follows the current motion vector and approved mirroring", () => {
  expect(crewWalkingVisual({ x: 0, y: -1 })).toMatchObject({
    facing: "north",
    animation: { tag: "walk-n" },
    mirrorX: false,
  });
  expect(crewWalkingVisual({ x: 0, y: 1 })).toMatchObject({
    facing: "south",
    animation: { tag: "walk-s" },
    mirrorX: false,
  });
  expect(crewWalkingVisual({ x: 1, y: 0 })).toMatchObject({
    facing: "southeast",
    animation: { tag: "walk-se" },
    mirrorX: false,
  });
  expect(crewWalkingVisual({ x: -1, y: 0 })).toMatchObject({
    facing: "southwest",
    animation: { tag: "walk-se" },
    mirrorX: true,
  });
  expect(crewFacingForMotion({ x: 1, y: -1 })).toBe("northeast");
  expect(crewFacingForMotion({ x: -1, y: -1 })).toBe("northwest");
  expect(crewFacingForMotion({ x: 0, y: 0 }, "northwest")).toBe("northwest");
});

test("qeFacing overrides approach while missing metadata is deterministic", () => {
  expect(crewWorkFacing("west", "north")).toEqual({
    facing: "southwest",
    source: "authored qeFacing",
  });
  expect(crewWorkFacing(null, "northeast")).toEqual({
    facing: "northeast",
    source: "approach fallback",
  });
  expect(crewWorkFacing(null, null)).toEqual({
    facing: "south",
    source: "default",
  });
});
