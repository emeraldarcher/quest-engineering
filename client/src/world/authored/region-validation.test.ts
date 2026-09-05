import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseAuthoredWorldRegion,
  type TiledTilesetResource,
  TownMapValidationError,
} from "./map-validation";
import type { TiledMapJson } from "./tiled-types";

async function fixture(name: string) {
  const mapPath = resolve(import.meta.dir, `../maps/reference/${name}`);
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
  return { map, resources, mapPath };
}

function issues(
  map: TiledMapJson,
  resources: Record<string, TiledTilesetResource>,
  source: string,
  profile: "project_island" | "project_expansion",
): string[] {
  try {
    parseAuthoredWorldRegion(map, resources, source, profile);
    throw new Error("Expected validation failure");
  } catch (cause) {
    if (!(cause instanceof TownMapValidationError)) throw cause;
    return cause.issues;
  }
}

test("Project-island profile requires and parses local crew semantics", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const region = parseAuthoredWorldRegion(
    map,
    resources,
    mapPath,
    "project_island",
  );
  expect(region.profile).toBe("project_island");
  expect(region.crewNavigation.spawns).toHaveLength(1);
  expect(
    region.crewNavigation.activities.some(
      (zone) => zone.activity === "general",
    ),
  ).toBe(true);
  expect(
    region.crewNavigation.activities.find(
      (activity) => activity.id === "fixture-research-anchor",
    )?.facing,
  ).toBe("east");
  expect(region.islandSockets[0]).toMatchObject({
    role: "outbound",
    edge: "fixture-footbridge",
    orientation: "east",
  });
});

test("Project-island validation rejects a missing general district", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const layer = map.layers.find(
    (value) => value.name === "Crew Activity Zones",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  layer.objects = layer.objects.filter(
    (object) =>
      object.properties?.find((property) => property.name === "qeActivity")
        ?.value !== "general",
  );
  expect(
    issues(map, resources, mapPath, "project_island").some((issue) =>
      issue.includes("general crew_activity fallback"),
    ),
  ).toBe(true);
});

test("optional qeFacing is parsed only for exact activity anchors", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const layer = map.layers.find(
    (value) => value.name === "Crew Activity Zones",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const point = layer.objects.find((object) => object.point === true);
  if (!point) throw new Error("Missing exact fixture anchor");
  point.properties = [
    ...(point.properties ?? []).filter(
      (property) => property.name !== "qeFacing",
    ),
    { name: "qeFacing", type: "string", value: "west" },
  ];
  const region = parseAuthoredWorldRegion(
    map,
    resources,
    mapPath,
    "project_island",
  );
  expect(
    region.crewNavigation.activities.find(
      (activity) => activity.id === point.name,
    )?.facing,
  ).toBe("west");

  const rectangle = layer.objects.find((object) => !object.point);
  if (!rectangle) throw new Error("Missing fixture district");
  rectangle.properties = [
    ...(rectangle.properties ?? []),
    { name: "qeFacing", type: "string", value: "north" },
  ];
  expect(
    issues(map, resources, mapPath, "project_island").some((issue) =>
      issue.includes("valid only on point-shaped exact anchors"),
    ),
  ).toBe(true);
});

test("invalid qeFacing receives an actionable diagnostic", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const layer = map.layers.find(
    (value) => value.name === "Crew Activity Zones",
  );
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const point = layer.objects.find((object) => object.point === true);
  if (!point) throw new Error("Missing exact fixture anchor");
  point.properties = [
    ...(point.properties ?? []).filter(
      (property) => property.name !== "qeFacing",
    ),
    { name: "qeFacing", type: "string", value: "sideways" },
  ];
  expect(
    issues(map, resources, mapPath, "project_island").some((issue) =>
      issue.includes("qeFacing must be north, south, east, or west"),
    ),
  ).toBe(true);
});

test("Project-expansion profile requires an inbound route-connected socket", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-expansion-fixture.tmj",
  );
  const region = parseAuthoredWorldRegion(
    map,
    resources,
    mapPath,
    "project_expansion",
  );
  expect(region.islandSockets).toHaveLength(1);
  const layer = map.layers.find((value) => value.name === "Expansion Sockets");
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  layer.objects = [];
  expect(
    issues(map, resources, mapPath, "project_expansion").some((issue) =>
      issue.includes("inbound island_socket"),
    ),
  ).toBe(true);
});

test("rotated Tiled crew routes are transformed into authored coordinates", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const navigation = map.layers.find(
    (value) => value.name === "Crew Navigation",
  );
  const entrances = map.layers.find((value) => value.name === "Crew Entrances");
  const activities = map.layers.find(
    (value) => value.name === "Crew Activity Zones",
  );
  const sockets = map.layers.find(
    (value) => value.name === "Expansion Sockets",
  );
  if (
    !navigation ||
    navigation.type !== "objectgroup" ||
    !entrances ||
    entrances.type !== "objectgroup" ||
    !activities ||
    activities.type !== "objectgroup" ||
    !sockets ||
    sockets.type !== "objectgroup"
  )
    throw new Error("Missing fixture layers");
  const route = navigation.objects[0];
  if (!route) throw new Error("Missing fixture route");
  route.x = 64;
  route.y = 32;
  route.rotation = 90;
  route.polyline = [
    { x: 0, y: 0 },
    { x: 32, y: 0 },
  ];
  const spawn = entrances.objects[0];
  if (spawn) Object.assign(spawn, { x: 64, y: 32 });
  const general = activities.objects[0];
  if (general) Object.assign(general, { x: 48, y: 40, width: 32, height: 24 });
  const research = activities.objects[1];
  if (research) Object.assign(research, { x: 64, y: 64 });
  sockets.objects = [];
  const region = parseAuthoredWorldRegion(
    map,
    resources,
    mapPath,
    "project_island",
  );
  expect(region.crewNavigation.routes[0]?.points).toEqual([
    { x: 64, y: 32 },
    { x: 64, y: 64 },
  ]);
});

test("unsupported crew point and junction types receive actionable diagnostics", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-island-fixture.tmj",
  );
  const activities = map.layers.find(
    (value) => value.name === "Crew Activity Zones",
  );
  const navigation = map.layers.find(
    (value) => value.name === "Crew Navigation",
  );
  if (
    !activities ||
    activities.type !== "objectgroup" ||
    !navigation ||
    navigation.type !== "objectgroup"
  )
    throw new Error("Missing fixture layers");
  activities.objects.push({
    id: 99,
    name: "unsupported-anchor",
    type: "crew_activity_point",
    point: true,
    x: 64,
    y: 64,
  });
  navigation.objects.push({
    id: 100,
    name: "unsupported-center",
    type: "crew_route_center",
    point: true,
    x: 64,
    y: 64,
  });
  const diagnostics = issues(map, resources, mapPath, "project_island");
  expect(
    diagnostics.some((issue) => issue.includes("crew_activity_point")),
  ).toBe(true);
  expect(diagnostics.some((issue) => issue.includes("crew_route_center"))).toBe(
    true,
  );
});

test("expansion sockets must identify an exact route-graph junction", async () => {
  const { map, resources, mapPath } = await fixture(
    "project-expansion-fixture.tmj",
  );
  const layer = map.layers.find((value) => value.name === "Expansion Sockets");
  if (!layer || layer.type !== "objectgroup")
    throw new Error("Missing fixture layer");
  const socket = layer.objects[0];
  if (socket) socket.x += 2;
  expect(
    issues(map, resources, mapPath, "project_expansion").some((issue) =>
      issue.includes("coincide with a crew_route vertex"),
    ),
  ).toBe(true);
});
