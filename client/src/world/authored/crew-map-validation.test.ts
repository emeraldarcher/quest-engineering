import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseAuthoredTownMap,
  type TiledTilesetResource,
  TownMapValidationError,
} from "./map-validation";
import type { TiledMapJson, TiledObjectLayer } from "./tiled-types";

async function fixture(): Promise<{
  map: TiledMapJson;
  resources: Record<string, TiledTilesetResource>;
}> {
  const mapPath = resolve(
    import.meta.dir,
    "../maps/reference/crew-authoring-fixture.tmj",
  );
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

function layer(map: TiledMapJson, name: string): TiledObjectLayer {
  const value = map.layers.find((item) => item.name === name);
  if (!value || value.type !== "objectgroup")
    throw new Error(`Missing ${name}`);
  return value;
}

function issuesFor(
  map: TiledMapJson,
  resources: Record<string, TiledTilesetResource>,
): string[] {
  try {
    parseAuthoredTownMap(map, resources);
    throw new Error("Expected validation failure");
  } catch (cause) {
    if (!(cause instanceof TownMapValidationError)) throw cause;
    return cause.issues;
  }
}

test("validator rejects duplicate spawn IDs and malformed routes", async () => {
  const { map, resources } = await fixture();
  const entrances = layer(map, "Crew Entrances");
  const entrance = entrances.objects[0];
  if (!entrance) throw new Error("Missing crew entrance");
  entrances.objects.push(structuredClone(entrance));
  const routes = layer(map, "Crew Navigation");
  const route = routes.objects[0];
  if (route) route.polyline = [{ x: 0, y: 0 }];
  const issues = issuesFor(map, resources);
  expect(
    issues.some((issue) => issue.includes("duplicate crew spawn ID")),
  ).toBe(true);
  expect(issues.some((issue) => issue.includes("at least two vertices"))).toBe(
    true,
  );
});

test("validator rejects disconnected route networks", async () => {
  const { map, resources } = await fixture();
  const route = layer(map, "Crew Navigation").objects[1];
  if (route) route.x += 10;
  expect(
    issuesFor(map, resources).some((issue) =>
      issue.includes("disconnected networks"),
    ),
  ).toBe(true);
});

test("validator rejects unknown activity and missing general fallback", async () => {
  const { map, resources } = await fixture();
  const activities = layer(map, "Crew Activity Zones");
  activities.objects = activities.objects.filter(
    (object) =>
      object.properties?.find((property) => property.name === "qeActivity")
        ?.value !== "general",
  );
  const property = activities.objects[0]?.properties?.find(
    (value) => value.name === "qeActivity",
  );
  if (property) property.value = "pretend-work";
  const issues = issuesFor(map, resources);
  expect(issues.some((issue) => issue.includes("unknown qeActivity"))).toBe(
    true,
  );
  expect(
    issues.some((issue) => issue.includes("general crew_activity fallback")),
  ).toBe(true);
});

test("validator rejects unreachable spawn and activity areas", async () => {
  const { map, resources } = await fixture();
  const spawn = layer(map, "Crew Entrances").objects[0];
  const activity = layer(map, "Crew Activity Zones").objects[0];
  if (spawn) spawn.y += 40;
  if (activity) activity.x += 40;
  const issues = issuesFor(map, resources);
  expect(
    issues.some(
      (issue) => issue.includes("crew_spawn") && issue.includes("unreachable"),
    ),
  ).toBe(true);
  expect(
    issues.some(
      (issue) =>
        issue.includes("crew_activity") && issue.includes("unreachable"),
    ),
  ).toBe(true);
});

test("partial crew layer migration receives actionable diagnostics", async () => {
  const { map, resources } = await fixture();
  map.layers = map.layers.filter((value) => value.name !== "Crew Navigation");
  expect(
    issuesFor(map, resources).some(
      (issue) =>
        issue.includes("incomplete") && issue.includes("Crew Navigation"),
    ),
  ).toBe(true);
});
