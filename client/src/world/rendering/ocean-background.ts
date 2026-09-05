import type { TownRect } from "../authored/map-schema";

/** `sea` layer GID 1293 in town.tmj, minus the Sunnyside firstgid of 1. */
export const SUNNYSIDE_OCEAN_TILE_LOCAL_ID = 1292;
export const SUNNYSIDE_OCEAN_TILE_SIZE = 16;
export const OCEAN_RENDER_PADDING = 2_048;
export const WORLD_PRESENTATION_LAYER_ORDER = [
  "ocean",
  "regions",
  "debug",
] as const;

export interface OceanPresentation {
  bounds: TownRect;
  tileSize: number;
  estimatedVisibleTiles: number;
  displayObjects: 1;
  textureInstances: 1;
  culledWithRegions: false;
}

/** One repeating Pixi TilingSprite covers the composed world and camera fringe. */
export function oceanPresentation(worldBounds: TownRect): OceanPresentation {
  const bounds = {
    x: worldBounds.x - OCEAN_RENDER_PADDING,
    y: worldBounds.y - OCEAN_RENDER_PADDING,
    width: worldBounds.width + OCEAN_RENDER_PADDING * 2,
    height: worldBounds.height + OCEAN_RENDER_PADDING * 2,
  };
  return {
    bounds,
    tileSize: SUNNYSIDE_OCEAN_TILE_SIZE,
    estimatedVisibleTiles:
      Math.ceil(bounds.width / SUNNYSIDE_OCEAN_TILE_SIZE) *
      Math.ceil(bounds.height / SUNNYSIDE_OCEAN_TILE_SIZE),
    displayObjects: 1,
    textureInstances: 1,
    culledWithRegions: false,
  };
}
