import metadataJson from "../../assets/sunnyside/generated/human-v1.0/human-v1.0.runtime.json";
import { memberIdentity } from "../visual-identity";

export type HumanVisualDirection =
  | "north"
  | "northeast"
  | "southeast"
  | "south"
  | "southwest"
  | "northwest";

export interface HumanV1Frame {
  index: number;
  rect: { x: number; y: number; w: number; h: number };
  durationMs: number;
}

export interface HumanV1Animation {
  id: string;
  tag: string;
  direction: string | null;
  playback: string;
  loop: boolean;
  frames: number[];
}

interface HumanV1Layer {
  name: string;
  file: string;
  role: string | null;
  frameIndices: number[];
}

interface HumanV1Metadata {
  formatVersion: number;
  canvas: { width: number; height: number; grid: number };
  sheet: { file: string; width: number; height: number; columns: number };
  frames: HumanV1Frame[];
  animations: HumanV1Animation[];
  directionalFamilies: Record<
    string,
    Record<
      HumanVisualDirection,
      { animationId: string | null; mirrorX: boolean }
    >
  >;
  layers: HumanV1Layer[];
}

export const HumanV1 = metadataJson as HumanV1Metadata;

export const HUMAN_HAIR_ROLES = HumanV1.layers
  .filter((layer) => layer.role?.startsWith("hair-"))
  .map((layer) => layer.role as string);

export interface HumanAppearance {
  hairRole: string;
  appearanceHash: number;
}

export function humanHairRoleForFrame(
  preferredRole: string,
  frameIndex: number,
): string {
  const preferred = HumanV1.layers.find(
    (layer) => layer.role === preferredRole,
  );
  if (preferred?.frameIndices.includes(frameIndex)) return preferredRole;
  const fallback = HumanV1.layers.find((layer) => layer.role === "hair-bowl");
  return fallback?.frameIndices.includes(frameIndex)
    ? "hair-bowl"
    : preferredRole;
}

export function humanAppearance(
  squadKey: string,
  memberKey: string,
): HumanAppearance {
  const identity = memberIdentity(squadKey, memberKey);
  const hairRole = HUMAN_HAIR_ROLES[identity.hash % HUMAN_HAIR_ROLES.length];
  if (!hairRole) throw new Error("Human v1 export has no hair layers");
  return { hairRole, appearanceHash: identity.hash };
}

export function humanAnimationById(id: string): HumanV1Animation {
  const animation = HumanV1.animations.find((value) => value.id === id);
  if (!animation) throw new Error(`Human v1 animation is unavailable: ${id}`);
  return animation;
}

/** Duplicate source tags deliberately select the latest/full action family. */
export function humanWorkAnimation(tag: string): HumanV1Animation {
  const animation = HumanV1.animations.findLast((value) => value.tag === tag);
  if (!animation)
    throw new Error(`Human v1 work animation is unavailable: ${tag}`);
  return animation;
}

const directionVectors: Record<HumanVisualDirection, { x: number; y: number }> =
  {
    north: { x: 0, y: -1 },
    northeast: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
    southeast: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    south: { x: 0, y: 1 },
    southwest: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
    northwest: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  };

export function closestHumanDirection(vector: {
  x: number;
  y: number;
}): HumanVisualDirection {
  if (Math.abs(vector.y) < 0.001 && Math.abs(vector.x) > 0.001)
    return vector.x < 0 ? "southwest" : "southeast";
  const length = Math.hypot(vector.x, vector.y) || 1;
  const normalized = { x: vector.x / length, y: vector.y / length };
  return (
    Object.entries(directionVectors) as Array<
      [HumanVisualDirection, { x: number; y: number }]
    >
  ).reduce((best, candidate) => {
    const score = candidate[1].x * normalized.x + candidate[1].y * normalized.y;
    const bestScore = best[1].x * normalized.x + best[1].y * normalized.y;
    return score > bestScore ? candidate : best;
  })[0];
}

export function humanDirectionalAnimation(
  family: "idle" | "walk" | "run",
  vector: { x: number; y: number },
): {
  animation: HumanV1Animation;
  direction: HumanVisualDirection;
  mirrorX: boolean;
} {
  const direction = closestHumanDirection(vector);
  const visual = HumanV1.directionalFamilies[family]?.[direction];
  if (!visual?.animationId)
    throw new Error(
      `Human v1 ${family} direction is unavailable: ${direction}`,
    );
  return {
    animation: humanAnimationById(visual.animationId),
    direction,
    mirrorX: visual.mirrorX,
  };
}

export function humanAnimationFrameAt(
  animation: HumanV1Animation,
  elapsedMs: number,
): HumanV1Frame {
  const durations = animation.frames.map(
    (frame) => HumanV1.frames[frame]?.durationMs ?? 100,
  );
  const total = durations.reduce((sum, duration) => sum + duration, 0) || 1;
  let remaining = animation.loop
    ? ((elapsedMs % total) + total) % total
    : Math.min(Math.max(0, elapsedMs), total - 1);
  for (const [index, duration] of durations.entries()) {
    if (remaining < duration)
      return HumanV1.frames[animation.frames[index] ?? 0] as HumanV1Frame;
    remaining -= duration;
  }
  return HumanV1.frames[animation.frames.at(-1) ?? 0] as HumanV1Frame;
}
