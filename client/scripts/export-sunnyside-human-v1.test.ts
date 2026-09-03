import { expect, test } from "bun:test";
import { animationDirection } from "./export-sunnyside-human-v1";

test("direction metadata is derived only from explicit source tag cues", () => {
  expect(animationDirection("walk-n")).toBe("north");
  expect(animationDirection("idle-s")).toBe("south");
  expect(animationDirection("walk-se")).toBe("southeast");
  expect(animationDirection("walk-ne")).toBe("northeast");
  expect(animationDirection("RUN-RIGHT")).toBe("east");
  expect(animationDirection("walk_left")).toBe("west");
  expect(animationDirection("walk")).toBeNull();
});
