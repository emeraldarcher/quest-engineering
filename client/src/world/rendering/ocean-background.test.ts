import { expect, test } from "bun:test";
import {
  OCEAN_RENDER_PADDING,
  oceanPresentation,
  SUNNYSIDE_OCEAN_TILE_LOCAL_ID,
  WORLD_PRESENTATION_LAYER_ORDER,
} from "./ocean-background";

test("one repeating Sunnyside ocean object covers regions and panning fringe", () => {
  const world = { x: -500, y: -300, width: 2_000, height: 1_200 };
  const ocean = oceanPresentation(world);
  expect(SUNNYSIDE_OCEAN_TILE_LOCAL_ID).toBe(1292);
  expect(ocean.displayObjects).toBe(1);
  expect(ocean.textureInstances).toBe(1);
  expect(ocean.culledWithRegions).toBe(false);
  expect(WORLD_PRESENTATION_LAYER_ORDER).toEqual(["ocean", "regions", "debug"]);
  expect(ocean.bounds).toEqual({
    x: world.x - OCEAN_RENDER_PADDING,
    y: world.y - OCEAN_RENDER_PADDING,
    width: world.width + OCEAN_RENDER_PADDING * 2,
    height: world.height + OCEAN_RENDER_PADDING * 2,
  });
  expect(ocean.estimatedVisibleTiles).toBeGreaterThan(0);
});
