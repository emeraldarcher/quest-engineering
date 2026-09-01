import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createFixture } from "../../fixtures/fixtures";
import { projectRunWorld } from "../projector";
import { assignMemberHomes, assignWorkSites } from "../visual-identity";
import { fitAuthoredBounds, unobscuredViewport } from "./authored-camera";
import { REQUIRED_LOCATION_IDS, REQUIRED_LOCATION_LABELS } from "./map-schema";
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
      resolveImage: (source) => {
        const imagePath = resolve(dirname(path), source);
        return existsSync(imagePath) ? imagePath : null;
      },
    };
  }
  return { map, resources };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resizeFiniteMap(
  source: TiledMapJson,
  width: number,
  height: number,
): TiledMapJson {
  const map = clone(source);
  map.width = width;
  map.height = height;
  for (const layer of map.layers) {
    if (layer.type !== "tilelayer") continue;
    const previous = layer.data;
    const previousWidth = layer.width;
    const previousHeight = layer.height;
    layer.width = width;
    layer.height = height;
    layer.data = Array.from({ length: width * height }, () => 0);
    for (let y = 0; y < previousHeight; y += 1)
      for (let x = 0; x < previousWidth; x += 1)
        layer.data[y * width + x] = previous[y * previousWidth + x] ?? 0;
  }
  for (const layer of map.layers) {
    if (layer.type !== "objectgroup" || layer.name === "Authoring Notes")
      continue;
    for (const object of layer.objects) {
      object.x += 8;
      object.y += 8;
    }
  }
  return map;
}

function expectUnique(values: string[]): void {
  expect(new Set(values).size).toBe(values.length);
  expect(values.every((value) => value.length > 0)).toBe(true);
}

test("production authored town satisfies semantic runtime contracts", async () => {
  const { map, resources } = await fixture();
  const result = parseAuthoredTownMap(map, resources);

  expect(result.schemaVersion).toBe(1);
  expect(result.tileSize).toBe(16);
  expect(result.bounds.width).toBe(map.width * map.tilewidth);
  expect(result.bounds.height).toBe(map.height * map.tileheight);
  expect(result.bounds.width).toBeGreaterThan(0);
  expect(result.bounds.height).toBeGreaterThan(0);
  expect(result.functionalTownBounds.width).toBeGreaterThan(0);
  expect(result.functionalTownBounds.height).toBeGreaterThan(0);
  expect(result.functionalTownBounds.x).toBeGreaterThanOrEqual(result.bounds.x);
  expect(result.functionalTownBounds.y).toBeGreaterThanOrEqual(result.bounds.y);
  expect(
    result.functionalTownBounds.x + result.functionalTownBounds.width,
  ).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
  expect(
    result.functionalTownBounds.y + result.functionalTownBounds.height,
  ).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);

  expect(result.locations.map((location) => location.id).sort()).toEqual(
    [...REQUIRED_LOCATION_IDS].sort(),
  );
  expect(
    Object.fromEntries(
      result.locations.map((location) => [location.id, location.label]),
    ),
  ).toEqual(REQUIRED_LOCATION_LABELS);
  for (const locationId of REQUIRED_LOCATION_IDS) {
    expect(
      result.interactionRegions.filter(
        (region) => region.locationId === locationId,
      ),
    ).toHaveLength(1);
    expect(
      result.cameraAnchors.filter((anchor) => anchor.id === locationId),
    ).toHaveLength(1);
  }
  expect(
    result.statusAnchors.filter(
      (anchor) => anchor.locationId === "quest-board",
    ),
  ).toHaveLength(1);

  expectUnique(result.locations.map((location) => location.id));
  expectUnique(result.interactionRegions.map((region) => region.id));
  expectUnique(result.cameraAnchors.map((anchor) => anchor.id));
  expectUnique(result.workstations.map((station) => station.id));
  expectUnique(result.memberHomes.map((home) => home.id));
  expectUnique(result.statusAnchors.map((anchor) => anchor.id));
  expectUnique(result.reservedSites.map((site) => site.id));
  expect(result.workstations.length).toBeGreaterThanOrEqual(8);
  expect(result.memberHomes.length).toBeGreaterThanOrEqual(12);
  expect(result.reservedSites.some((site) => site.id === "war-room")).toBe(
    true,
  );

  const viewport = unobscuredViewport(
    { width: 1440, height: 900 },
    null,
    "right",
  );
  const zoom = fitAuthoredBounds(result.functionalTownBounds, viewport);
  expect([1, 2, 3]).toContain(zoom);
  expect(result.functionalTownBounds.width * zoom).toBeLessThanOrEqual(
    viewport.width - 48,
  );
  expect(result.functionalTownBounds.height * zoom).toBeLessThanOrEqual(
    viewport.height - 48,
  );
});

test("authored town dimensions and object coordinates may change without breaking runtime contracts", async () => {
  const { map, resources } = await fixture();
  const original = parseAuthoredTownMap(map, resources);
  const resized = resizeFiniteMap(map, map.width + 7, map.height + 5);
  const result = parseAuthoredTownMap(
    resized,
    resources,
    "resized-fixture.tmj",
  );

  expect(result.bounds.width).toBe((map.width + 7) * map.tilewidth);
  expect(result.bounds.height).toBe((map.height + 5) * map.tileheight);
  expect(result.locations).toHaveLength(REQUIRED_LOCATION_IDS.length);
  expect(result.locations[0]?.x).toBe((original.locations[0]?.x ?? 0) + 8);
});

test("representative runtime fixtures project onto production authored slots", async () => {
  const { map, resources } = await fixture();
  const authored = parseAuthoredTownMap(map, resources);
  const fixtureNames = [
    "idle",
    "single-active",
    "parallel",
    "waiting",
    "pr-review",
    "merged",
  ] as const;

  for (const fixtureName of fixtureNames) {
    const value = createFixture(fixtureName);
    const run = value?.selectedRunId ? value.runs[value.selectedRunId] : null;
    if (!run) throw new Error(`Fixture '${fixtureName}' has no selected Run.`);
    const projected = projectRunWorld(run);
    const homes = assignMemberHomes(
      projected.squadKey,
      projected.members.map((member) => member.member.member_key),
      authored.memberHomes,
    );
    const assignments = projected.members
      .filter((member) => member.activeOccurrenceId)
      .map((member) => ({
        occurrenceId: member.activeOccurrenceId as string,
        memberKey: member.member.member_key,
      }));
    const sites = assignWorkSites(assignments, authored.workstations);

    expect(homes.size).toBe(projected.members.length);
    expect(sites.size).toBe(assignments.length);
    expect(authored.cameraAnchors).toHaveLength(REQUIRED_LOCATION_IDS.length);
    expect(authored.locations).toHaveLength(REQUIRED_LOCATION_IDS.length);
  }
});

test("old-town reference preserves the previous authored pipeline wiring", async () => {
  const { map, resources } = await fixture(
    "reference/town-reference-v0.14b.tmj",
  );
  expect(
    map.properties?.some(
      (property) =>
        property.name === "questEngineeringReference" &&
        property.value === true,
    ),
  ).toBe(true);
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

test("validator gives a concise missing companion-object error", async () => {
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
    expect((cause as TownMapValidationError).issues).toContain(
      "Required camera anchor 'guild' is missing.",
    );
  }
});

test("validator reports functional-town-bounds outside the map", async () => {
  const { map, resources } = await fixture();
  const malformed = clone(map);
  const layer = malformed.layers.find(
    (value) => value.name === "Camera Anchors",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const bounds = layer.objects.find(
    (object) => object.name === "functional-town-bounds",
  );
  if (!bounds) throw new Error("Missing functional town bounds");
  bounds.x = -1;
  try {
    parseAuthoredTownMap(malformed, resources);
    throw new Error("Expected validation failure");
  } catch (cause) {
    expect((cause as TownMapValidationError).issues).toContain(
      "functional-town-bounds extends outside the authored map.",
    );
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
