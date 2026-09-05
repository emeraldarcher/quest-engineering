import type { TownPoint, TownRect } from "../authored/map-schema";
import { stableHash } from "../visual-identity";
import type { RegionProjectIdentity } from "./world-region";

/** Eight primary slots keep ordinary Project counts in the first ring. */
export const DENSE_PRIMARY_SLOTS = 8;
export const HOME_PROJECT_GUTTER = 0;
export const PROJECT_OCEAN_GUTTER = 64;
export const PROJECT_CLEARANCE = PROJECT_OCEAN_GUTTER;

/** Slot zero is Home. Positive indices walk a deterministic square spiral. */
export function spiralGridPoint(index: number): TownPoint {
  if (index <= 0) return { x: 0, y: 0 };
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2);
  const side = ring * 2;
  const maximum = (ring * 2 + 1) ** 2 - 1;
  const offset = maximum - index;
  if (offset < side) return { x: ring - offset, y: ring };
  if (offset < side * 2) return { x: -ring, y: ring - (offset - side) };
  if (offset < side * 3) return { x: -ring + (offset - side * 2), y: -ring };
  return { x: ring, y: -ring + (offset - side * 3) };
}

export interface ProjectPlacement {
  project: RegionProjectIdentity;
  slot: number;
  origin: TownPoint;
}

export interface PlacementGrid {
  /** Full authored Home bounds; first-ring islands hug its water edge. */
  homeBounds: TownRect;
  projectBounds: TownRect;
  homeClearance: number;
  clearance: number;
}

export function placementGrid(
  homeBounds: TownRect,
  maximumProjectBounds: TownRect,
): PlacementGrid {
  return {
    homeBounds: { ...homeBounds },
    projectBounds: { ...maximumProjectBounds },
    homeClearance: HOME_PROJECT_GUTTER,
    clearance: PROJECT_CLEARANCE,
  };
}

function axisCenter(
  coordinate: number,
  homeStart: number,
  homeSize: number,
  projectSize: number,
  clearance: number,
): number {
  const homeCenter = homeStart + homeSize / 2;
  if (coordinate === 0) return homeCenter;
  const direction = Math.sign(coordinate);
  const first = homeSize / 2 + clearance + projectSize / 2;
  const additional = (Math.abs(coordinate) - 1) * (projectSize + clearance);
  return homeCenter + direction * (first + additional);
}

export function placementOrigin(
  point: TownPoint,
  grid: PlacementGrid,
): TownPoint {
  const home = grid.homeBounds;
  const project = grid.projectBounds;
  const edge = grid.homeClearance;
  let left: number;
  let top: number;

  // The first ring hugs the full Home map instead of occupying diagonal grid
  // cells. Home camera framing then keeps early islands discoverable without
  // allowing their authored regions to overlap Home land or water.
  if (Math.max(Math.abs(point.x), Math.abs(point.y)) === 1) {
    if (point.x === 1 && point.y === 0) {
      left = home.x + home.width + edge;
      top = home.y;
    } else if (point.x === 1 && point.y === -1) {
      left = home.x + home.width - project.width;
      top = home.y - edge - project.height;
    } else if (point.x === 0 && point.y === -1) {
      left = home.x;
      top = home.y - edge - project.height;
    } else if (point.x === -1 && point.y === -1) {
      left = home.x - edge - project.width;
      top = home.y;
    } else if (point.x === -1 && point.y === 0) {
      left = home.x - edge - project.width;
      top = home.y + home.height - project.height;
    } else if (point.x === -1 && point.y === 1) {
      left = home.x;
      top = home.y + home.height + edge;
    } else if (point.x === 0 && point.y === 1) {
      left = home.x + home.width - project.width;
      top = home.y + home.height + edge;
    } else {
      left = home.x + home.width + edge;
      top = home.y + home.height - project.height;
    }
    return { x: left - project.x, y: top - project.y };
  }

  const centerX = axisCenter(
    point.x,
    home.x,
    home.width,
    project.width,
    grid.clearance,
  );
  const centerY = axisCenter(
    point.y,
    home.y,
    home.height,
    project.height,
    grid.clearance,
  );
  return {
    x: centerX - project.width / 2 - project.x,
    y: centerY - project.height / 2 - project.y,
  };
}

function placedBounds(origin: TownPoint, grid: PlacementGrid): TownRect {
  return {
    x: origin.x + grid.projectBounds.x,
    y: origin.y + grid.projectBounds.y,
    width: grid.projectBounds.width,
    height: grid.projectBounds.height,
  };
}

function separated(a: TownRect, b: TownRect, clearance: number): boolean {
  if (clearance <= 0)
    return (
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  const horizontal = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const vertical = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return horizontal >= clearance || vertical >= clearance;
}

/**
 * Stable identities choose one of eight nearby primary slots. Deterministic
 * probing fills available positions in the current ring before expanding into
 * another ring. Unrelated additions normally preserve existing positions;
 * only a colliding probe chain can affect a later identity.
 */
export function placeProjects(
  projects: readonly RegionProjectIdentity[],
  grid: PlacementGrid,
): ProjectPlacement[] {
  const occupied = new Set<number>();
  const occupiedBounds: TownRect[] = [];
  return [...projects]
    .sort((a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key))
    .map((project) => {
      const bucket =
        stableHash(`${project.id}\0${project.key}`) % DENSE_PRIMARY_SLOTS;
      let probe = 0;
      let slot = bucket + 1;
      let origin = placementOrigin(spiralGridPoint(slot), grid);
      let bounds = placedBounds(origin, grid);
      while (
        occupied.has(slot) ||
        !separated(bounds, grid.homeBounds, grid.homeClearance) ||
        occupiedBounds.some(
          (other) => !separated(bounds, other, grid.clearance),
        )
      ) {
        probe += 1;
        const band = Math.floor(probe / DENSE_PRIMARY_SLOTS);
        const local = (bucket + probe) % DENSE_PRIMARY_SLOTS;
        slot = local + 1 + band * DENSE_PRIMARY_SLOTS;
        origin = placementOrigin(spiralGridPoint(slot), grid);
        bounds = placedBounds(origin, grid);
      }
      occupied.add(slot);
      occupiedBounds.push(bounds);
      return { project, slot, origin };
    });
}
