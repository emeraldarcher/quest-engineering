#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const clientRoot = resolve(import.meta.dir, "..");
const mapPath = resolve(
  clientRoot,
  "src/world/maps/reference/sunnyside-example-world.tmj",
);
const tiledGidMask = 0x1fffffff;
const expectedLayers = [
  "sea",
  "clouds_02",
  "land",
  "paths",
  "shadows",
  "decoration_01",
  "Assets_2",
  "forest",
  "building",
  "walls",
  "decoration_02",
  "decoration_03",
  "Assets_1",
  "cloud_shadow",
  "clouds_01",
  "Authoring Notes",
];

const map = (await Bun.file(mapPath).json()) as {
  width: number;
  height: number;
  properties?: { name: string; value: unknown }[];
  tilesets: { firstgid: number; source: string }[];
  layers: {
    name: string;
    type: string;
    data?: number[];
    objects?: { gid?: number }[];
  }[];
};
const properties = Object.fromEntries(
  (map.properties ?? []).map((property) => [property.name, property.value]),
);
if (properties.qeReferenceMap !== true || properties.qeRuntimeMap !== false) {
  throw new Error(
    "Reference map must declare qeReferenceMap=true and qeRuntimeMap=false",
  );
}
if (
  map.layers.map((layer) => layer.name).join("|") !== expectedLayers.join("|")
) {
  throw new Error(
    `Unexpected reference layer order: ${map.layers.map((layer) => layer.name).join(", ")}`,
  );
}

const ranges = [] as { first: number; last: number; source: string }[];
for (const [index, reference] of map.tilesets.entries()) {
  const tilesetPath = resolve(dirname(mapPath), reference.source);
  if (!existsSync(tilesetPath))
    throw new Error(`Missing tileset ${reference.source}`);
  const tileset = (await Bun.file(tilesetPath).json()) as {
    tilecount: number;
    image?: string;
    tiles?: { image?: string }[];
  };
  const imageSources = [
    tileset.image,
    ...(tileset.tiles ?? []).map((tile) => tile.image),
  ].filter(Boolean) as string[];
  for (const image of imageSources) {
    if (!existsSync(resolve(dirname(tilesetPath), image))) {
      throw new Error(
        `Missing tileset image ${relative(clientRoot, resolve(dirname(tilesetPath), image))}`,
      );
    }
  }
  ranges.push({
    first: reference.firstgid,
    last:
      (map.tilesets[index + 1]?.firstgid ??
        reference.firstgid + tileset.tilecount) - 1,
    source: reference.source,
  });
}

let checkedGids = 0;
function validateGid(gid: number, location: string) {
  if (!gid) return;
  const plainGid = gid & tiledGidMask;
  if (
    !ranges.some((range) => plainGid >= range.first && plainGid <= range.last)
  ) {
    throw new Error(`Invalid GID ${gid >>> 0} at ${location}`);
  }
  checkedGids += 1;
}
for (const layer of map.layers) {
  if (layer.type === "tilelayer") {
    if (layer.data?.length !== map.width * map.height) {
      throw new Error(`Tile layer '${layer.name}' has invalid cell count`);
    }
    layer.data.forEach((gid, index) => {
      validateGid(gid, `${layer.name}[${index}]`);
    });
  }
  layer.objects?.forEach((object, index) => {
    validateGid(object.gid ?? 0, `${layer.name} object ${index}`);
  });
}
console.log(
  `Reference map valid (${map.width}x${map.height}, ${checkedGids} GIDs, ${ranges.length} external tilesets)`,
);
