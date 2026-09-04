import type { TownPoint, TownRect } from "../authored/map-schema";
import { stableHash } from "../visual-identity";
import type { RegionProjectIdentity } from "./world-region";

const INITIAL_HASH_BUCKETS = 512;
export const REGION_GUTTER = 256;

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
  cellWidth: number;
  cellHeight: number;
}

export function placementGrid(
  homeBounds: TownRect,
  maximumProjectBounds: TownRect,
): PlacementGrid {
  return {
    cellWidth:
      Math.max(homeBounds.width, maximumProjectBounds.width) + REGION_GUTTER,
    cellHeight:
      Math.max(homeBounds.height, maximumProjectBounds.height) + REGION_GUTTER,
  };
}

/**
 * Stable identities choose a first-band bucket, then collisions advance through
 * that bucket's infinite sequence of spiral bands. Only Projects sharing a hash
 * bucket can affect one another; there is no finite slot pool to exhaust.
 */
export function placeProjects(
  projects: readonly RegionProjectIdentity[],
  grid: PlacementGrid,
): ProjectPlacement[] {
  const nextBandByBucket = new Map<number, number>();
  return [...projects]
    .sort((a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key))
    .map((project) => {
      const bucket =
        stableHash(`${project.id}\0${project.key}`) % INITIAL_HASH_BUCKETS;
      const band = nextBandByBucket.get(bucket) ?? 0;
      nextBandByBucket.set(bucket, band + 1);
      const slot = bucket + 1 + band * INITIAL_HASH_BUCKETS;
      const point = spiralGridPoint(slot);
      return {
        project,
        slot,
        origin: {
          x: point.x * grid.cellWidth,
          y: point.y * grid.cellHeight,
        },
      };
    });
}
