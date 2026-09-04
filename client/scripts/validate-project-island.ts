#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { crewRouteComponents } from "../src/world/authored/crew-navigation";
import {
  parseAuthoredWorldRegion,
  type TiledTilesetResource,
  TownMapValidationError,
} from "../src/world/authored/map-validation";
import type { TiledMapJson } from "../src/world/authored/tiled-types";

const clientRoot = resolve(import.meta.dir, "..");
const mapPath = resolve(clientRoot, "src/world/maps/project-island.tmj");
const map = (await Bun.file(mapPath).json()) as TiledMapJson;
const resources: Record<string, TiledTilesetResource> = {};
const resourceLines: string[] = [];
for (const reference of map.tilesets ?? []) {
  const tilesetPath = resolve(dirname(mapPath), reference.source);
  if (!existsSync(tilesetPath)) {
    resourceLines.push(`${reference.source}: MISSING`);
    continue;
  }
  const tileset = await Bun.file(tilesetPath).json();
  resources[reference.source] = {
    source: reference.source,
    basePath: dirname(tilesetPath),
    json: tileset,
    resolveImage(imageSource) {
      const imagePath = resolve(dirname(tilesetPath), imageSource);
      return existsSync(imagePath) ? imagePath : null;
    },
  };
  const image = typeof tileset.image === "string" ? tileset.image : null;
  resourceLines.push(
    `${reference.source}: tileset OK${image && existsSync(resolve(dirname(tilesetPath), image)) ? " · image OK" : image ? " · image MISSING" : ""}`,
  );
}

try {
  const region = parseAuthoredWorldRegion(
    map,
    resources,
    relative(clientRoot, mapPath),
    "project_island",
  );
  const graph = region.crewNavigation.graph;
  const districts = region.crewNavigation.activities.filter(
    (activity) => activity.shape === "rectangle",
  );
  const anchors = region.crewNavigation.activities.filter(
    (activity) => activity.shape === "point",
  );
  console.log(`Project island valid (${region.hash})`);
  console.log(`profile: ${region.profile}`);
  console.log(
    `dimensions: ${region.bounds.width}x${region.bounds.height} world pixels`,
  );
  console.log(`external resources:\n  ${resourceLines.join("\n  ")}`);
  console.log(
    `spawns (${region.crewNavigation.spawns.length}): ${region.crewNavigation.spawns.map((spawn) => spawn.id).join(", ") || "none"}`,
  );
  console.log(
    `routes (${region.crewNavigation.routes.length}): ${region.crewNavigation.routes.map((route) => route.id).join(", ") || "none"}`,
  );
  console.log(
    `graph: ${graph.nodes.length} nodes · ${graph.edges.length} edges · ${crewRouteComponents(graph).length} connected components`,
  );
  console.log(
    `districts (${districts.length}): ${districts.map((activity) => `${activity.id}=${activity.activity}`).join(", ") || "none"}`,
  );
  console.log(
    `exact anchors (${anchors.length}): ${anchors.map((activity) => `${activity.id}=${activity.activity}`).join(", ") || "none"}`,
  );
  console.log(
    `sockets (${region.islandSockets.length}): ${region.islandSockets.map((socket) => `${socket.id}=${socket.role}/${socket.edge}/${socket.orientation}${socket.category ? `/${socket.category}` : ""}`).join(", ") || "none"}`,
  );
} catch (cause) {
  console.error(`External resources:\n  ${resourceLines.join("\n  ")}`);
  if (cause instanceof TownMapValidationError) {
    console.error(cause.message);
    process.exit(1);
  }
  throw cause;
}
