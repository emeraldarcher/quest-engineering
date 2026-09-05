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

const MOTION_EPSILON = 0.001;

export function crewFacingForMotion(
  vector: TownPoint,
  previous: HumanVisualDirection = "south",
): HumanVisualDirection {
  return Math.hypot(vector.x, vector.y) <= MOTION_EPSILON
    ? previous
    : closestHumanDirection(vector);
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
  return facing === "southwest" || facing === "northwest";
}
