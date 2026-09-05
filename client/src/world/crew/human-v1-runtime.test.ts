import { expect, test } from "bun:test";
import {
  closestHumanDirection,
  HumanV1,
  humanAnimationFrameAt,
  humanAppearance,
  humanDirectionalAnimation,
  humanDirectionalAnimationForDirection,
  humanFrameGrounding,
  humanHairRoleForFrame,
  humanRenderedFootLocal,
  humanWorkAnimation,
} from "./human-v1-runtime";

test("Human v1 runtime uses only authored directions and legitimate mirroring", () => {
  expect(closestHumanDirection({ x: -1, y: 1 })).toBe("southwest");
  const southwest = humanDirectionalAnimation("walk", { x: -1, y: 1 });
  expect(southwest.animation.tag).toBe("walk-se");
  expect(southwest.mirrorX).toBe(true);
  const northwest = humanDirectionalAnimation("walk", { x: -1, y: -1 });
  expect(northwest.animation.tag).toBe("walk-ne");
  expect(northwest.mirrorX).toBe(true);
  expect(humanDirectionalAnimation("walk", { x: 1, y: 1 }).mirrorX).toBe(false);
});

test("source frame durations drive animation and full work actions are selected", () => {
  const walk = humanDirectionalAnimation("walk", { x: 0, y: 1 }).animation;
  const first = walk.frames[0] as number;
  const second = walk.frames[1] as number;
  expect(humanAnimationFrameAt(walk, 0).index).toBe(first);
  const firstDuration = HumanV1.frames[first]?.durationMs ?? 0;
  expect(humanAnimationFrameAt(walk, firstDuration).index).toBe(second);
  expect(humanWorkAnimation("axe").frames).toHaveLength(10);
  expect(humanWorkAnimation("hamering").frames).toHaveLength(23);
  expect(HumanV1.frames).toHaveLength(310);
});

test("all movement and work frames pin the calibrated foot to local ground zero", () => {
  const animations = [
    humanDirectionalAnimationForDirection("idle", "south").animation,
    humanDirectionalAnimationForDirection("walk", "north").animation,
    humanDirectionalAnimationForDirection("walk", "south").animation,
    humanDirectionalAnimationForDirection("walk", "northeast").animation,
    ...["doing", "hamering", "mining", "axe", "dig"].map(humanWorkAnimation),
  ];
  for (const animation of animations)
    for (const frameIndex of animation.frames) {
      const frame = HumanV1.frames[frameIndex];
      if (!frame) throw new Error(`Missing frame ${frameIndex}`);
      expect(humanFrameGrounding(frame).anchor).toEqual({
        x: 0.5,
        y: 39 / 64,
      });
      const foot = humanRenderedFootLocal(frame);
      expect(Math.abs(foot.x)).toBeLessThanOrEqual(0.001);
      expect(Math.abs(foot.y)).toBeLessThanOrEqual(0.001);
    }
});

test("the former bottom-of-canvas anchor reproduces the observed 25px float", () => {
  const animation = humanDirectionalAnimationForDirection("idle", "south");
  const frame = HumanV1.frames[animation.animation.frames[0] as number];
  if (!frame) throw new Error("Missing idle frame");
  expect(humanRenderedFootLocal(frame, { anchor: { x: 0.5, y: 1 } })).toEqual({
    x: 0,
    y: -25,
  });
});

test("Member appearance is stable across recreation and varies from stable identity", () => {
  expect(humanAppearance("squad", "rowan")).toEqual(
    humanAppearance("squad", "rowan"),
  );
  expect(humanAppearance("squad", "rowan").hairRole).toMatch(/^hair-/);
  const bowl = HumanV1.layers.find((layer) => layer.role === "hair-bowl");
  const long = HumanV1.layers.find((layer) => layer.role === "hair-long");
  const fallbackFrame = bowl?.frameIndices.find(
    (frame) => !long?.frameIndices.includes(frame),
  );
  expect(fallbackFrame).toBeDefined();
  expect(humanHairRoleForFrame("hair-long", fallbackFrame as number)).toBe(
    "hair-bowl",
  );
});
