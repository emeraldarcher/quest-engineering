import { expect, test } from "bun:test";
import {
  CREW_BODY_LOCAL_POSITION,
  CREW_HIT_AREA,
  CREW_SHADOW_LOCAL_POSITION,
  crewGroundDepthY,
} from "./crew-grounding";

test("actor root, body, and shadow share the canonical ground point", () => {
  expect(CREW_BODY_LOCAL_POSITION).toEqual({ x: 0, y: 0 });
  expect(CREW_SHADOW_LOCAL_POSITION).toEqual({ x: 0, y: 0 });
  expect(CREW_HIT_AREA.y + CREW_HIT_AREA.height).toBe(2);
});

test("depth sorting uses ground Y only", () => {
  expect(crewGroundDepthY({ x: 900, y: 42.49 })).toBe(42);
  expect(crewGroundDepthY({ x: -200, y: 42.51 })).toBe(43);
});
