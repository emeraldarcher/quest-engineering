import type { WorldComposerTemplates } from "../composition/world-composer";
import type { WorldRegionTemplate } from "../composition/world-region";
import productionProjectIslandRaw from "../maps/project-island.tmj?raw";
import projectExpansionRaw from "../maps/reference/project-expansion-fixture.tmj?raw";
import referenceProjectIslandRaw from "../maps/reference/project-island-fixture.tmj?raw";
import townRaw from "../maps/town.tmj?raw";
import type {
  AuthoredTownMap,
  WorldRegionKind,
  WorldRegionProfile,
} from "./map-schema";
import {
  parseAuthoredTownMap,
  parseAuthoredWorldRegion,
  type TiledTilesetResource,
  TownMapValidationError,
} from "./map-validation";

const imageModules = import.meta.glob<string>(
  "../../assets/sunnyside/**/*.png",
  { eager: true, query: "?url", import: "default" },
);
const tilesetModules = import.meta.glob<string>("../maps/tilesets/*.tsj", {
  eager: true,
  query: "?raw",
  import: "default",
});

function normalizePath(value: string): string {
  const output: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

const imageUrls = new Map(
  Object.entries(imageModules).map(([source, url]) => [
    normalizePath(`world/authored/${source}`),
    url,
  ]),
);

function resource(source: string, raw: string): TiledTilesetResource {
  const basePath = "world/maps/tilesets";
  return {
    source,
    basePath,
    json: JSON.parse(raw),
    resolveImage(imageSource) {
      return imageUrls.get(normalizePath(`${basePath}/${imageSource}`)) ?? null;
    },
  };
}

function bundledTilesets(): Record<string, TiledTilesetResource> {
  const output: Record<string, TiledTilesetResource> = {};
  for (const [path, raw] of Object.entries(tilesetModules)) {
    const source = path.replace("../maps/", "");
    const value = resource(source, raw);
    output[source] = value;
    output[`../${source}`] = value;
  }
  return output;
}

export type BundledTownMapResult =
  | { map: AuthoredTownMap; error: null }
  | { map: null; error: TownMapValidationError };

export function loadBundledTownMap(): BundledTownMapResult {
  try {
    return {
      map: parseAuthoredTownMap(
        JSON.parse(townRaw),
        bundledTilesets(),
        "client/src/world/maps/town.tmj",
      ),
      error: null,
    };
  } catch (cause) {
    if (cause instanceof TownMapValidationError)
      return { map: null, error: cause };
    return {
      map: null,
      error: new TownMapValidationError([
        cause instanceof SyntaxError
          ? "town map or external tileset is not valid JSON"
          : "town map could not be parsed",
      ]),
    };
  }
}

export type BundledWorldTemplatesResult =
  | { templates: WorldComposerTemplates; error: null }
  | { templates: null; error: TownMapValidationError };

function template(
  raw: string,
  templateId: string,
  kind: WorldRegionKind,
  profile: WorldRegionProfile,
  source: string,
): WorldRegionTemplate {
  return {
    templateId,
    kind,
    authored: parseAuthoredWorldRegion(
      JSON.parse(raw),
      bundledTilesets(),
      source,
      profile,
    ),
  };
}

export type ProjectIslandTemplateSelection = "production" | "reference-fixture";

export function loadBundledWorldTemplates(
  selection: ProjectIslandTemplateSelection = "production",
): BundledWorldTemplatesResult {
  try {
    const town = loadBundledTownMap();
    if (!town.map) return { templates: null, error: town.error };
    const projectIsland =
      selection === "reference-fixture"
        ? template(
            referenceProjectIslandRaw,
            "project-island-fixture",
            "project",
            "project_island",
            "client/src/world/maps/reference/project-island-fixture.tmj",
          )
        : template(
            productionProjectIslandRaw,
            "project-island",
            "project",
            "project_island",
            "client/src/world/maps/project-island.tmj",
          );
    return {
      templates: {
        home: { templateId: "home-town", kind: "home", authored: town.map },
        projectIsland,
        ...(selection === "reference-fixture"
          ? {
              projectExpansion: template(
                projectExpansionRaw,
                "project-expansion-fixture",
                "expansion",
                "project_expansion",
                "client/src/world/maps/reference/project-expansion-fixture.tmj",
              ),
            }
          : {}),
      },
      error: null,
    };
  } catch (cause) {
    if (cause instanceof TownMapValidationError)
      return { templates: null, error: cause };
    return {
      templates: null,
      error: new TownMapValidationError([
        cause instanceof SyntaxError
          ? "world region map or external tileset is not valid JSON"
          : "world region template could not be parsed",
      ]),
    };
  }
}
