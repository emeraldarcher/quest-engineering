#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  parseAuthoredTownMap,
  type TiledTilesetResource,
  TownMapValidationError,
} from "../src/world/authored/map-validation";
import type { TiledMapJson } from "../src/world/authored/tiled-types";

const clientRoot = resolve(import.meta.dir, "..");
const mapPath = resolve(clientRoot, "src/world/maps/town.tmj");
const map = (await Bun.file(mapPath).json()) as TiledMapJson;
const resources: Record<string, TiledTilesetResource> = {};
for (const reference of map.tilesets ?? []) {
  const tilesetPath = resolve(dirname(mapPath), reference.source);
  if (!existsSync(tilesetPath)) {
    console.error(`Missing tileset: ${relative(clientRoot, tilesetPath)}`);
    process.exit(1);
  }
  resources[reference.source] = {
    source: reference.source,
    basePath: dirname(tilesetPath),
    json: await Bun.file(tilesetPath).json(),
    resolveImage(imageSource) {
      const imagePath = resolve(dirname(tilesetPath), imageSource);
      return existsSync(imagePath) ? imagePath : null;
    },
  };
}

try {
  const result = parseAuthoredTownMap(
    map,
    resources,
    relative(clientRoot, mapPath),
  );
  console.log(
    [
      `Town map v${result.schemaVersion} valid (${result.hash})`,
      `${result.bounds.width}x${result.bounds.height} world pixels`,
      `${result.tileLayers.reduce((sum, layer) => sum + layer.tiles.length, 0)} static tiles`,
      `${result.staticObjects.length} static objects`,
      `${result.locations.length} locations`,
      `${result.workstations.length} workstations`,
      `${result.memberHomes.length} Member homes`,
      `${result.ambientZones.length} ambient zones`,
      `${result.reservedSites.length} reserved sites`,
    ].join(" · "),
  );
} catch (cause) {
  if (cause instanceof TownMapValidationError) {
    console.error(cause.message);
    process.exit(1);
  }
  throw cause;
}
