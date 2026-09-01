import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeGameMakerTileData,
  GAME_MAKER_EMPTY_TILE,
  importSunnysideExample,
  mapGameMakerTile,
} from "./sunnyside-example-importer";

const tiledHorizontal = 0x80000000;
const tiledVertical = 0x40000000;
const tiledDiagonal = 0x20000000;

test("decodes GameMaker format-1 RLE tile cells deterministically", () => {
  const encoded = [-3, 7, 2, 8, 9, -2, -2147483648];
  expect(decodeGameMakerTileData(encoded, 7)).toEqual([
    7,
    7,
    7,
    8,
    9,
    GAME_MAKER_EMPTY_TILE,
    GAME_MAKER_EMPTY_TILE,
  ]);
  expect(() => decodeGameMakerTileData([-3], 3)).toThrow("Truncated");
});

test("maps explicit GameMaker source tile IDs and transforms to valid Tiled GIDs", () => {
  expect(mapGameMakerTile(12, 1, 4096)).toBe(13);
  expect(mapGameMakerTile(GAME_MAKER_EMPTY_TILE, 1, 4096)).toBe(0);
  expect(mapGameMakerTile(12 | 0x10000000, 1, 4096)).toBe(
    (13 | tiledHorizontal) >>> 0,
  );
  expect(mapGameMakerTile(12 | 0x20000000, 1, 4096)).toBe(
    (13 | tiledVertical) >>> 0,
  );
  expect(mapGameMakerTile(12 | 0x40000000, 1, 4096)).toBe(
    (13 | tiledDiagonal | tiledHorizontal) >>> 0,
  );
  expect(() => mapGameMakerTile(4096, 1, 4096)).toThrow(
    "Unknown GameMaker tile ID",
  );
});

test("fails clearly when the configured GameMaker source resource is unavailable", async () => {
  await expect(importSunnysideExample("/does-not-exist")).rejects.toThrow(
    "Missing Sunnyside GameMaker project",
  );
});

test("generated map has a stable reference contract and source layer order", async () => {
  const path = resolve(
    import.meta.dir,
    "../src/world/maps/reference/sunnyside-example-world.tmj",
  );
  const text = await readFile(path, "utf8");
  const map = JSON.parse(text) as {
    layers: { name: string }[];
    properties: { name: string; value: unknown }[];
  };
  expect(`${JSON.stringify(map, null, 2)}\n`).toBe(text);
  expect(map.layers.map((layer) => layer.name)).toEqual([
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
  ]);
  expect(
    Object.fromEntries(
      map.properties.map((property) => [property.name, property.value]),
    ),
  ).toMatchObject({
    qeReferenceMap: true,
    qeRuntimeMap: false,
  });
});
