import { expect, test } from "bun:test";
import {
  boundedFocus,
  cameraPosition,
  normalizeZoom,
  stepZoom,
} from "./camera";

test("camera exposes only discrete integer zoom levels", () => {
  expect(normalizeZoom(2.4)).toBe(2);
  expect(normalizeZoom(2.6)).toBe(3);
  expect(stepZoom(2, -1)).toBe(2);
  expect(stepZoom(3, 1)).toBe(4);
  expect(stepZoom(4, 1)).toBe(4);
});

test("camera bounds and final positions are pixel snapped", () => {
  const focus = boundedFocus(
    { x: -20, y: 999 },
    { width: 900, height: 600 },
    { width: 704, height: 448 },
    3,
  );
  expect(focus).toEqual({ x: 150, y: 348 });
  const position = cameraPosition(
    focus,
    { width: 901, height: 601 },
    { width: 704, height: 448 },
    3,
  );
  expect(Number.isInteger(position.x)).toBe(true);
  expect(Number.isInteger(position.y)).toBe(true);
});
