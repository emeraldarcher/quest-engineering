import { expect, test } from "bun:test";
import {
  DENSE_PRIMARY_SLOTS,
  placementGrid,
  placementOrigin,
  placeProjects,
  spiralGridPoint,
} from "./world-placement";

const home = { x: 0, y: 0, width: 1_440, height: 800 };
const functionalHome = { x: 161, y: 34, width: 1_116, height: 648 };
const projectBounds = { x: 0, y: 0, width: 352, height: 288 };
const grid = placementGrid(home, projectBounds);
const project = (id: string) => ({ id, key: id, name: id });

function bounds(origin: { x: number; y: number }) {
  return {
    ...origin,
    width: projectBounds.width,
    height: projectBounds.height,
  };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function hasClearance(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const horizontal = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const vertical = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return horizontal >= grid.clearance || vertical >= grid.clearance;
}

function assertNoOverlaps(origins: Array<{ x: number; y: number }>) {
  const values = origins.map(bounds);
  expect(values.some((value) => overlaps(value, home))).toBe(false);
  let separated = true;
  for (const [index, value] of values.entries())
    for (const other of values.slice(index + 1))
      if (overlaps(value, other) || !hasClearance(value, other)) {
        separated = false;
        break;
      }
  expect(separated).toBe(true);
}

function homeDistance(origin: { x: number; y: number }): number {
  const homeCenter = {
    x: home.x + home.width / 2,
    y: home.y + home.height / 2,
  };
  const projectCenter = {
    x: origin.x + projectBounds.width / 2,
    y: origin.y + projectBounds.height / 2,
  };
  return Math.hypot(
    projectCenter.x - homeCenter.x,
    projectCenter.y - homeCenter.y,
  );
}

test("spiral slots are unique and reserve the Home slot", () => {
  const points = Array.from({ length: 500 }, (_, index) =>
    spiralGridPoint(index + 1),
  );
  expect(new Set(points.map((point) => `${point.x}:${point.y}`)).size).toBe(
    points.length,
  );
  expect(points.some((point) => point.x === 0 && point.y === 0)).toBe(false);
});

test("Home-only and early Project counts form a dense non-overlapping archipelago", () => {
  expect(placeProjects([], grid)).toEqual([]);
  for (const count of [1, 4, 10, 50]) {
    const placements = placeProjects(
      Array.from({ length: count }, (_, index) =>
        project(`dense-${String(index).padStart(2, "0")}`),
      ),
      grid,
    );
    expect(placements).toHaveLength(count);
    assertNoOverlaps(placements.map((value) => value.origin));
    if (count === 1) {
      const first = placements[0]?.origin ?? { x: 0, y: 0 };
      expect(homeDistance(first)).toBeLessThan(1_100);
      expect(overlaps(bounds(first), home)).toBe(false);
    }
    if (count === 4)
      expect(
        Math.max(...placements.map((value) => value.slot)),
      ).toBeLessThanOrEqual(DENSE_PRIMARY_SLOTS);
    if (count === 10) {
      expect(
        Math.max(...placements.map((value) => value.slot)),
      ).toBeLessThanOrEqual(DENSE_PRIMARY_SLOTS * 2);
      expect(
        Math.max(...placements.map((value) => homeDistance(value.origin))),
      ).toBeLessThan(3_000);
    }
  }
});

test("every first-ring island is discoverable in a one-Project Home overview", () => {
  for (let slot = 1; slot <= DENSE_PRIMARY_SLOTS; slot += 1) {
    const island = bounds(placementOrigin(spiralGridPoint(slot), grid));
    const overview = {
      x: Math.min(functionalHome.x, island.x),
      y: Math.min(functionalHome.y, island.y),
      width:
        Math.max(
          functionalHome.x + functionalHome.width,
          island.x + island.width,
        ) - Math.min(functionalHome.x, island.x),
      height:
        Math.max(
          functionalHome.y + functionalHome.height,
          island.y + island.height,
        ) - Math.min(functionalHome.y, island.y),
    };
    const focus = {
      x: overview.x + overview.width / 2,
      y: overview.y + overview.height / 2,
    };
    const visible = {
      x: focus.x - 720,
      y: focus.y - 424,
      width: 1_440,
      height: 848,
    };
    const visibleWidth = Math.max(
      0,
      Math.min(island.x + island.width, visible.x + visible.width) -
        Math.max(island.x, visible.x),
    );
    const visibleHeight = Math.max(
      0,
      Math.min(island.y + island.height, visible.y + visible.height) -
        Math.max(island.y, visible.y),
    );
    expect(
      (visibleWidth * visibleHeight) / (island.width * island.height),
    ).toBeGreaterThan(0.6);
  }
});

test("stable Project identity placement ignores registration order", () => {
  const values = [project("alpha"), project("bravo"), project("charlie")];
  expect(placeProjects([...values].reverse(), grid)).toEqual(
    placeProjects(values, grid),
  );
});

test("an unrelated non-colliding Project does not reshuffle existing islands", () => {
  const values = [project("alpha"), project("bravo")];
  const before = placeProjects(values, grid);
  const candidate = Array.from({ length: 100 }, (_, index) =>
    project(`unrelated-${index}`),
  ).find((value) => {
    const after = placeProjects([...values, value], grid);
    return after
      .filter((placement) => placement.project.id !== value.id)
      .every(
        (placement, index) =>
          JSON.stringify(placement) === JSON.stringify(before[index]),
      );
  });
  expect(candidate).toBeDefined();
  const after = placeProjects(
    [...values, candidate as ReturnType<typeof project>],
    grid,
  );
  expect(after.filter((value) => value.project.id !== candidate?.id)).toEqual(
    before,
  );
});

test("more than the former finite capacity remains unique, unbounded, and fast", () => {
  const values = Array.from({ length: 700 }, (_, index) =>
    project(`scale-${String(index).padStart(4, "0")}`),
  );
  const originalProductData = structuredClone(values);
  const started = performance.now();
  const placements = placeProjects(values, grid);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(placements).toHaveLength(values.length);
  expect(new Set(placements.map((value) => value.slot)).size).toBe(
    values.length,
  );
  expect(
    new Set(placements.map((value) => `${value.origin.x}:${value.origin.y}`))
      .size,
  ).toBe(values.length);
  assertNoOverlaps(placements.map((value) => value.origin));
  expect(Math.max(...placements.map((value) => value.slot))).toBeGreaterThan(
    624,
  );
  expect(values).toEqual(originalProductData);
});
