import { expect, test } from "bun:test";
import { placeProjects, spiralGridPoint } from "./world-placement";

const grid = { cellWidth: 1_696, cellHeight: 1_056 };
const project = (id: string) => ({ id, key: id, name: id });

test("spiral slots are unique and reserve the Home slot", () => {
  const points = Array.from({ length: 500 }, (_, index) =>
    spiralGridPoint(index + 1),
  );
  expect(new Set(points.map((point) => `${point.x}:${point.y}`)).size).toBe(
    points.length,
  );
  expect(points.some((point) => point.x === 0 && point.y === 0)).toBe(false);
});

test("stable Project identity placement ignores registration order", () => {
  const values = [project("alpha"), project("bravo"), project("charlie")];
  const forward = placeProjects(values, grid);
  const reverse = placeProjects([...values].reverse(), grid);
  expect(reverse).toEqual(forward);
});

test("an unrelated non-colliding Project does not reshuffle existing islands", () => {
  const values = [project("alpha"), project("bravo"), project("charlie")];
  const before = placeProjects(values, grid);
  const after = placeProjects([...values, project("unrelated")], grid);
  expect(after.filter((value) => value.project.id !== "unrelated")).toEqual(
    before,
  );
});

test("more than the former finite capacity receives unique non-overlapping placements", () => {
  const values = Array.from({ length: 700 }, (_, index) =>
    project(`scale-${String(index).padStart(4, "0")}`),
  );
  const originalProductData = structuredClone(values);
  const started = performance.now();
  const placements = placeProjects(values, grid);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(1_000);
  expect(placements).toHaveLength(values.length);
  expect(new Set(placements.map((value) => value.slot)).size).toBe(
    values.length,
  );
  expect(
    new Set(placements.map((value) => `${value.origin.x}:${value.origin.y}`))
      .size,
  ).toBe(values.length);
  expect(
    placements.some((value) => value.origin.x === 0 && value.origin.y === 0),
  ).toBe(false);

  const islandBounds = placements.map((value) => ({
    x: value.origin.x,
    y: value.origin.y,
    width: 256,
    height: 192,
  }));
  const home = { x: 0, y: 0, width: 1_440, height: 800 };
  const overlaps = (
    a: (typeof islandBounds)[number],
    b: (typeof islandBounds)[number],
  ) =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
  expect(islandBounds.some((bounds) => overlaps(bounds, home))).toBe(false);
  let projectOverlap = false;
  for (const [index, bounds] of islandBounds.entries()) {
    if (
      islandBounds.slice(index + 1).some((other) => overlaps(bounds, other))
    ) {
      projectOverlap = true;
      break;
    }
  }
  expect(projectOverlap).toBe(false);
  expect(values).toEqual(originalProductData);
});
