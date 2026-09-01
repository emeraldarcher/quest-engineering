import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import {
  parseAuthoredTownMap,
  type TiledTilesetResource,
  TownMapValidationError,
} from "./map-validation";
import type { TiledMapJson } from "./tiled-types";

const maps = resolve(import.meta.dir, "../maps");

async function fixture(relativeMap = "town.tmj") {
  const mapPath = resolve(maps, relativeMap);
  const map = (await Bun.file(mapPath).json()) as TiledMapJson;
  const resources: Record<string, TiledTilesetResource> = {};
  for (const reference of map.tilesets) {
    const path = resolve(dirname(mapPath), reference.source);
    resources[reference.source] = {
      source: reference.source,
      basePath: dirname(path),
      json: await Bun.file(path).json(),
      resolveImage: (source) => resolve(dirname(path), source),
    };
  }
  return { map, resources };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("authored town map parses into the closed runtime representation", async () => {
  const { map, resources } = await fixture();
  const result = parseAuthoredTownMap(map, resources);
  expect(result.schemaVersion).toBe(1);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 640, height: 416 });
  expect(result.locations.map((location) => location.id).sort()).toEqual([
    "blacksmith",
    "gatehouse",
    "guild",
    "quest-board",
    "tavern",
    "work-area",
  ]);
  expect(
    result.tileLayers.find((layer) => layer.name === "Ground")?.tiles,
  ).toHaveLength(1040);
  expect(result.staticObjects).toHaveLength(0);
  expect(result.workstations).toHaveLength(10);
  expect(result.memberHomes).toHaveLength(12);
  expect(result.ambientZones).toHaveLength(0);
  expect(result.animalRoutes).toHaveLength(0);
  expect(result.statusAnchors[0]?.locationId).toBe("quest-board");
  expect(
    result.reservedSites.find((site) => site.id === "war-room"),
  ).toBeTruthy();
});

test("old-town reference preserves the previous authored pipeline wiring", async () => {
  const { map, resources } = await fixture(
    "reference/town-reference-v0.14b.tmj",
  );
  const result = parseAuthoredTownMap(map, resources);
  expect(
    result.tileLayers.reduce((sum, layer) => sum + layer.tiles.length, 0),
  ).toBe(1152);
  expect(result.staticObjects).toHaveLength(19);
  expect(result.ambientZones).toHaveLength(3);
  expect(result.animalRoutes).toHaveLength(2);
});

test("validator rejects duplicate stable IDs", async () => {
  const { map, resources } = await fixture();
  const malformed = clone(map);
  const layer = malformed.layers.find((value) => value.name === "Workstations");
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const first = layer.objects[0];
  const second = layer.objects[1];
  if (!first || !second) throw new Error("Missing fixture objects");
  second.name = first.name;
  expect(() => parseAuthoredTownMap(malformed, resources)).toThrow(
    TownMapValidationError,
  );
  try {
    parseAuthoredTownMap(malformed, resources);
  } catch (cause) {
    expect((cause as TownMapValidationError).issues).toContain(
      `duplicate workstation ID '${first.name}'`,
    );
  }
});

test("validator gives beginners an actionable companion-object error", async () => {
  const { map, resources } = await fixture();
  const malformed = clone(map);
  const layer = malformed.layers.find(
    (value) => value.name === "Camera Anchors",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  layer.objects = layer.objects.filter(
    (object) => object.name !== "guild" || object.type !== "camera_anchor",
  );
  try {
    parseAuthoredTownMap(malformed, resources);
    throw new Error("Expected validation failure");
  } catch (cause) {
    const issues = (cause as TownMapValidationError).issues;
    expect(
      issues.some(
        (issue) =>
          issue.includes("Location 'guild' needs a matching camera_anchor") &&
          issue.includes("reference/town-reference-v0.14b.tmj"),
      ),
    ).toBe(true);
  }
});

test("validator rejects bad schema versions and dangling camera anchors", async () => {
  const { map, resources } = await fixture();
  const malformed = clone(map);
  const version = malformed.properties?.find(
    (property) => property.name === "questEngineeringMapVersion",
  );
  if (version) version.value = 99;
  const layer = malformed.layers.find(
    (value) => value.name === "Camera Anchors",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const anchor = layer.objects.find(
    (object) => object.type === "camera_anchor",
  );
  const location = anchor?.properties?.find(
    (property) => property.name === "qeLocation",
  );
  if (location) location.value = "missing-location";
  try {
    parseAuthoredTownMap(malformed, resources);
    throw new Error("Expected validation failure");
  } catch (cause) {
    const issues = (cause as TownMapValidationError).issues;
    expect(
      issues.some((issue) => issue.includes("questEngineeringMapVersion")),
    ).toBe(true);
    expect(issues.some((issue) => issue.includes("unknown location"))).toBe(
      true,
    );
  }
});
