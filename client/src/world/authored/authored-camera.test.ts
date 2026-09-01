import { expect, test } from "bun:test";
import {
  authoredCameraPosition,
  fitAuthoredBounds,
  unobscuredViewport,
} from "./authored-camera";

const world = { x: 0, y: 0, width: 640, height: 416 };
const town = { x: 24, y: 24, width: 592, height: 388 };

test("Town mode fits authored functional-town bounds", () => {
  const viewport = unobscuredViewport(
    { width: 1440, height: 900 },
    null,
    "right",
  );
  expect(fitAuthoredBounds(town, viewport)).toBe(2);
  const compact = unobscuredViewport(
    { width: 900, height: 600 },
    { x: 500, y: 64, width: 390, height: 520 },
    "right",
  );
  expect(fitAuthoredBounds(town, compact)).toBe(1);
});

test("authored anchor is centered in the unobscured viewport beside a panel", () => {
  const viewport = unobscuredViewport(
    { width: 1440, height: 900 },
    { x: 930, y: 66, width: 496, height: 620 },
    "right",
  );
  expect(viewport).toEqual({ x: 0, y: 52, width: 918, height: 848 });
  const placement = authoredCameraPosition(
    { x: 210, y: 112 },
    viewport,
    world,
    2,
  );
  expect(placement.boundedFocus).toEqual({ x: 229.5, y: 208 });
  expect(Number.isInteger(placement.x)).toBe(true);
  expect(Number.isInteger(placement.y)).toBe(true);
});

test("left-side panels use authored panel-side preference", () => {
  expect(
    unobscuredViewport(
      { width: 1200, height: 800 },
      { x: 0, y: 64, width: 420, height: 700 },
      "left",
    ),
  ).toEqual({ x: 432, y: 52, width: 768, height: 748 });
});
