import type { CrewFacing, TownPoint } from "../authored/map-schema";
import {
  closestHumanDirection,
  type HumanV1Animation,
  type HumanVisualDirection,
  humanDirectionalAnimationForDirection,
} from "./human-v1-runtime";

export type CrewWorkFacingSource =
  | "authored qeFacing"
  | "approach fallback"
  | "default";

export interface CrewDirectionalVisual {
  facing: HumanVisualDirection;
  animation: HumanV1Animation;
  mirrorX: boolean;
}

export interface CrewWorkFacing {
  facing: HumanVisualDirection;
  source: CrewWorkFacingSource;
}

/** Distances below this value are not motion and may not change facing. */
export const CREW_MOTION_EPSILON = 0.01;
/** Once horizontal, tolerate this slope before changing upper/lower diagonal. */
export const CREW_HORIZONTAL_EXIT_SLOPE = 0.5;
/** A new horizontal sector starts only when motion is this level or flatter. */
export const CREW_HORIZONTAL_ENTER_SLOPE = 0.25;

function upperFacing(facing: HumanVisualDirection): boolean {
  return facing === "north" || facing === "northeast" || facing === "northwest";
}

function horizontalFacing(x: number, upper: boolean): HumanVisualDirection {
  if (x < 0) return upper ? "northwest" : "southwest";
  return upper ? "northeast" : "southeast";
}

/**
 * Quantizes Pixi world motion (positive y is south) into authored Human v1
 * directions. Horizontal roads retain their previous upper/lower diagonal and
 * use a wider exit threshold so tiny route noise cannot flip NE <-> SE.
 */
export function crewFacingForMotion(
  vector: TownPoint,
  previous: HumanVisualDirection = "south",
): HumanVisualDirection {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= CREW_MOTION_EPSILON) return previous;

  const horizontal = Math.abs(vector.x) > CREW_MOTION_EPSILON;
  if (horizontal) {
    const slope = Math.abs(vector.y / vector.x);
    const previousIsDiagonal =
      previous === "northeast" ||
      previous === "northwest" ||
      previous === "southeast" ||
      previous === "southwest";
    const threshold = previousIsDiagonal
      ? CREW_HORIZONTAL_EXIT_SLOPE
      : CREW_HORIZONTAL_ENTER_SLOPE;
    if (slope <= threshold)
      return horizontalFacing(vector.x, upperFacing(previous));
  }

  return closestHumanDirection(vector);
}

export function crewWalkingVisual(
  vector: TownPoint,
  previous: HumanVisualDirection = "south",
): CrewDirectionalVisual {
  const facing = crewFacingForMotion(vector, previous);
  return {
    facing,
    ...humanDirectionalAnimationForDirection("walk", facing),
  };
}

export function crewIdleVisual(
  facing: HumanVisualDirection,
): CrewDirectionalVisual {
  return {
    facing,
    ...humanDirectionalAnimationForDirection("idle", facing),
  };
}

export function visualDirectionForAuthoredFacing(
  facing: CrewFacing,
): HumanVisualDirection {
  if (facing === "north" || facing === "south") return facing;
  return facing === "east" ? "southeast" : "southwest";
}

export function crewWorkFacing(
  authored: CrewFacing | null,
  approach: HumanVisualDirection | null,
): CrewWorkFacing {
  if (authored)
    return {
      facing: visualDirectionForAuthoredFacing(authored),
      source: "authored qeFacing",
    };
  if (approach) return { facing: approach, source: "approach fallback" };
  return { facing: "south", source: "default" };
}

export function crewFacingMirrorsWork(facing: HumanVisualDirection): boolean {
  // Human v1 action art is authored facing screen-east; west mirrors it.
  return facing === "southwest" || facing === "northwest";
}

/** One parent sign is applied to the complete base/hair/tool composite. */
export function crewCompositeScaleX(mirrorX: boolean): 1 | -1 {
  return mirrorX ? -1 : 1;
}
