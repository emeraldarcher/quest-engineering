import type { TownPoint, TownRect } from "../authored/map-schema";

/** CrewActor root, body origin, and shadow all share one world ground point. */
export const CREW_BODY_LOCAL_POSITION = { x: 0, y: 0 } as const;
export const CREW_SHADOW_LOCAL_POSITION = { x: 0, y: 0 } as const;
export const CREW_HIT_AREA: TownRect = {
  x: -24,
  y: -40,
  width: 48,
  height: 42,
};

export function crewGroundDepthY(groundPosition: TownPoint): number {
  return Math.round(groundPosition.y);
}
