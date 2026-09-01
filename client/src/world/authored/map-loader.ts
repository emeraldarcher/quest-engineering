import townRaw from "../maps/town.tmj?raw";
import type { AuthoredTownMap } from "./map-schema";
import {
  parseAuthoredTownMap,
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
  return Object.fromEntries(
    Object.entries(tilesetModules).map(([path, raw]) => {
      const source = path.replace("../maps/", "");
      return [source, resource(source, raw)];
    }),
  );
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
