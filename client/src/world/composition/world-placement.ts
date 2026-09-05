import type { TownPoint, TownRect } from "../authored/map-schema";
import { stableHash } from "../visual-identity";
import type { RegionProjectIdentity } from "./world-region";

/** Eight primary slots keep ordinary Project counts in the first ring. */
export const DENSE_PRIMARY_SLOTS = 8;
export const PROJECT_OCEAN_GUTTER = 64;
export const PROJECT_EXPANSION_RESERVE = 48;
export const PROJECT_CLEARANCE =
  PROJECT_OCEAN_GUTTER + PROJECT_EXPANSION_RESERVE * 2;

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
  homeBounds: TownRect;
  projectBounds: TownRect;
  clearance: number;
}

export function placementGrid(
  homeBounds: TownRect,
  maximumProjectBounds: TownRect,
): PlacementGrid {
  return {
    homeBounds: { ...homeBounds },
    projectBounds: { ...maximumProjectBounds },
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
  const centerX = axisCenter(
    point.x,
    grid.homeBounds.x,
    grid.homeBounds.width,
    grid.projectBounds.width,
    grid.clearance,
  );
  const centerY = axisCenter(
    point.y,
    grid.homeBounds.y,
    grid.homeBounds.height,
    grid.projectBounds.height,
    grid.clearance,
  );
  return {
    x: centerX - grid.projectBounds.width / 2 - grid.projectBounds.x,
    y: centerY - grid.projectBounds.height / 2 - grid.projectBounds.y,
  };
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
  return [...projects]
    .sort((a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key))
    .map((project) => {
      const bucket =
        stableHash(`${project.id}\0${project.key}`) % DENSE_PRIMARY_SLOTS;
      let probe = 0;
      let slot = bucket + 1;
      while (occupied.has(slot)) {
        probe += 1;
        const band = Math.floor(probe / DENSE_PRIMARY_SLOTS);
        const local = (bucket + probe) % DENSE_PRIMARY_SLOTS;
        slot = local + 1 + band * DENSE_PRIMARY_SLOTS;
      }
      occupied.add(slot);
      return {
        project,
        slot,
        origin: placementOrigin(spiralGridPoint(slot), grid),
      };
    });
}
