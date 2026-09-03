import {
  buildCrewRouteGraph,
  CREW_ROUTE_ACCESS_TOLERANCE,
  CREW_ROUTE_CONNECTION_TOLERANCE,
  crewRouteComponents,
  nearestCrewRouteConnection,
} from "./crew-navigation";
import {
  type AuthoredAmbientZone,
  type AuthoredAnimalRoute,
  type AuthoredCameraAnchor,
  type AuthoredCrewActivity,
  type AuthoredCrewRoute,
  type AuthoredCrewSpawn,
  type AuthoredImageTile,
  type AuthoredInteractionRegion,
  type AuthoredLocation,
  type AuthoredLocationId,
  type AuthoredMemberHome,
  type AuthoredReservedSite,
  type AuthoredStatusAnchor,
  type AuthoredTileLayer,
  type AuthoredTilePlacement,
  type AuthoredTownMap,
  type AuthoredWorkstation,
  CREW_ACTIVITY_CATEGORIES,
  type CrewActivityCategory,
  type PanelSide,
  QUEST_ENGINEERING_MAP_VERSION,
  REQUIRED_LOCATION_IDS,
  REQUIRED_LOCATION_LABELS,
  type TownPoint,
  type TownRect,
  type WorkstationVariant,
} from "./map-schema";
import type {
  TiledMapJson,
  TiledObject,
  TiledObjectLayer,
  TiledTileLayer,
  TiledTilesetJson,
} from "./tiled-types";

const AUTHORING_REFERENCE =
  "client/src/world/maps/reference/town-reference-v0.14b.tmj";
const FLIPPED_HORIZONTALLY = 0x80000000;
const FLIPPED_VERTICALLY = 0x40000000;
const FLIPPED_DIAGONALLY = 0x20000000;
const GID_MASK = 0x0fffffff;

const REQUIRED_TILE_LAYERS = [
  "Ground",
  "Ground Detail",
  "Water",
  "Paths",
  "Building Base",
  "Building Walls",
  "Building Roofs",
  "Building Detail",
  "Fences",
  "Props Below Members",
  "Foreground Canopy",
] as const;
const ALLOWED_QE_PROPERTIES = new Set([
  "qeActivity",
  "qeGroup",
  "qeLabel",
  "qeLocation",
  "qePanelSide",
  "qeVariant",
  "qeZoom",
]);
const REQUIRED_OBJECT_LAYERS = [
  "Static Objects Below Members",
  "Locations",
  "Interaction Regions",
  "Camera Anchors",
  "Ambient Zones",
  "Animal Routes",
  "Status Anchors",
  "Reserved Sites",
] as const;

export interface TiledTilesetResource {
  source: string;
  basePath: string;
  json: unknown;
  resolveImage(source: string): string | null;
}

export class TownMapValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Town map validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "TownMapValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function propertyString(
  object: TiledObject,
  name: string,
  issues: string[],
): string {
  const property = object.properties?.find((value) => value.name === name);
  if (
    property?.type === "string" &&
    typeof property.value === "string" &&
    property.value.length > 0
  )
    return property.value;
  issues.push(
    `${object.type ?? object.class ?? "object"} '${object.name}' requires string property ${name}`,
  );
  return "";
}

function propertyOptionalString(
  object: TiledObject,
  name: string,
): string | null {
  const property = object.properties?.find((value) => value.name === name);
  return property?.type === "string" &&
    typeof property.value === "string" &&
    property.value.length > 0
    ? property.value
    : null;
}

function propertyInteger(
  object: TiledObject,
  name: string,
  issues: string[],
): number {
  const property = object.properties?.find((value) => value.name === name);
  if (
    property?.type === "int" &&
    typeof property.value === "number" &&
    Number.isInteger(property.value)
  )
    return property.value;
  issues.push(
    `${object.type ?? object.class ?? "object"} '${object.name}' requires integer property ${name}`,
  );
  return 0;
}

function objectType(object: TiledObject): string {
  return object.class || object.type || "";
}

function assertUnique(values: string[], label: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) issues.push(`${label} has an empty stable ID`);
    else if (seen.has(value)) issues.push(`duplicate ${label} ID '${value}'`);
    seen.add(value);
  }
}

function inBounds(point: TownPoint, bounds: TownRect): boolean {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height
  );
}

function rectInBounds(rect: TownRect, bounds: TownRect): boolean {
  return (
    inBounds(rect, bounds) &&
    rect.x + rect.width <= bounds.x + bounds.width &&
    rect.y + rect.height <= bounds.y + bounds.height
  );
}

function parseJsonMap(value: unknown, issues: string[]): TiledMapJson {
  if (!isRecord(value) || value.type !== "map") {
    issues.push("root must be a Tiled JSON map");
    return {} as TiledMapJson;
  }
  return value as unknown as TiledMapJson;
}

function parseTileset(
  value: unknown,
  source: string,
  issues: string[],
): TiledTilesetJson {
  if (!isRecord(value) || value.type !== "tileset") {
    issues.push(`tileset '${source}' is not Tiled JSON`);
    return {} as TiledTilesetJson;
  }
  return value as unknown as TiledTilesetJson;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseAuthoredTownMap(
  value: unknown,
  resources: Record<string, TiledTilesetResource>,
  source = "world/maps/town.tmj",
): AuthoredTownMap {
  const issues: string[] = [];
  const map = parseJsonMap(value, issues);
  if (map.orientation !== "orthogonal")
    issues.push("map orientation must be orthogonal");
  if (map.infinite) issues.push("town map must be finite");
  if (map.tilewidth !== 16 || map.tileheight !== 16)
    issues.push("town map must use 16x16 logical tiles");
  if (
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width <= 0 ||
    map.height <= 0
  )
    issues.push("map width and height must be positive integers");
  const mapVersion = map.properties?.find(
    (property) => property.name === "questEngineeringMapVersion",
  );
  if (
    mapVersion?.type !== "int" ||
    mapVersion.value !== QUEST_ENGINEERING_MAP_VERSION
  )
    issues.push(
      `questEngineeringMapVersion must equal ${QUEST_ENGINEERING_MAP_VERSION}`,
    );

  const layers = Array.isArray(map.layers) ? map.layers : [];
  const layerNames = new Set(layers.map((layer) => layer.name));
  for (const name of [...REQUIRED_TILE_LAYERS, ...REQUIRED_OBJECT_LAYERS])
    if (!layerNames.has(name))
      issues.push(
        `Required layer '${name}' is missing. Undo the deletion in Tiled or copy the layer from ${AUTHORING_REFERENCE}.`,
      );

  const bounds: TownRect = {
    x: 0,
    y: 0,
    width: (map.width || 0) * 16,
    height: (map.height || 0) * 16,
  };

  const tilesets = (map.tilesets ?? [])
    .map((reference) => {
      const resource = resources[reference.source];
      if (!resource) {
        issues.push(`missing external tileset '${reference.source}'`);
        return null;
      }
      const json = parseTileset(resource.json, reference.source, issues);
      return { firstgid: reference.firstgid, resource, json };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => a.firstgid - b.firstgid);

  function imageForGid(rawGid: number): AuthoredImageTile | null {
    const unsigned = rawGid >>> 0;
    const gid = unsigned & GID_MASK;
    const entry = [...tilesets].reverse().find((item) => gid >= item.firstgid);
    if (!entry) {
      issues.push(`tile GID ${gid} does not resolve to a tileset`);
      return null;
    }
    const localId = gid - entry.firstgid;
    const collection = entry.json.tiles?.find((tile) => tile.id === localId);
    const imageSource = collection?.image ?? entry.json.image;
    if (!imageSource) {
      issues.push(`tile ${gid} in '${entry.resource.source}' has no image`);
      return null;
    }
    const url = entry.resource.resolveImage(imageSource);
    if (!url) {
      issues.push(
        `tileset image '${imageSource}' referenced by '${entry.resource.source}' was not found`,
      );
      return null;
    }
    const imageWidth = collection?.imagewidth ?? entry.json.imagewidth ?? 0;
    const imageHeight = collection?.imageheight ?? entry.json.imageheight ?? 0;
    const columns = entry.json.columns ?? 0;
    if (!collection && (localId < 0 || localId >= entry.json.tilecount))
      issues.push(`tile ${gid} exceeds '${entry.resource.source}' tilecount`);
    return {
      tileset: entry.json.name,
      localId,
      url,
      source: imageSource,
      sourceWidth: collection?.imagewidth ?? entry.json.tilewidth,
      sourceHeight: collection?.imageheight ?? entry.json.tileheight,
      tileWidth: entry.json.tilewidth,
      tileHeight: entry.json.tileheight,
      columns,
      imageWidth,
      imageHeight,
      ...(collection ? { collectionImage: true } : {}),
    };
  }

  const tileLayers: AuthoredTileLayer[] = [];
  for (const layer of layers.filter(
    (item): item is TiledTileLayer => item.type === "tilelayer",
  )) {
    if (
      !Array.isArray(layer.data) ||
      layer.data.length !== layer.width * layer.height
    ) {
      issues.push(
        `tile layer '${layer.name}' data length does not match its dimensions`,
      );
      continue;
    }
    const tiles: AuthoredTilePlacement[] = [];
    for (const [index, rawGid] of layer.data.entries()) {
      if (!rawGid) continue;
      const image = imageForGid(rawGid);
      if (!image) continue;
      const unsigned = rawGid >>> 0;
      const cellX = index % layer.width;
      const cellY = Math.floor(index / layer.width);
      tiles.push({
        id: `${layer.name}:${cellX}:${cellY}`,
        layer: layer.name,
        image,
        x: (cellX + (layer.x ?? 0)) * 16,
        y: (cellY + (layer.y ?? 0)) * 16,
        flipHorizontal: !!(unsigned & FLIPPED_HORIZONTALLY),
        flipVertical: !!(unsigned & FLIPPED_VERTICALLY),
        flipDiagonal: !!(unsigned & FLIPPED_DIAGONALLY),
        anchor: "top-left",
      });
    }
    tileLayers.push({
      name: layer.name,
      foreground: layer.name === "Foreground Canopy",
      tiles,
    });
  }

  const objectLayerValues = layers.filter(
    (item): item is TiledObjectLayer => item.type === "objectgroup",
  );
  for (const layer of objectLayerValues)
    for (const object of layer.objects)
      for (const property of object.properties ?? [])
        if (
          property.name.startsWith("qe") &&
          !ALLOWED_QE_PROPERTIES.has(property.name)
        )
          issues.push(
            `object '${object.name}' uses unknown Quest Engineering property '${property.name}'`,
          );
  const objectLayers = new Map(
    objectLayerValues.map((layer) => [layer.name, layer]),
  );
  const objects = (name: string): TiledObject[] =>
    objectLayers.get(name)?.objects ?? [];
  const typed = (name: string, type: string): TiledObject[] =>
    objects(name).filter((object) => objectType(object) === type);

  const staticObjects: AuthoredTilePlacement[] = [];
  for (const object of typed("Static Objects Below Members", "static_sprite")) {
    if (!object.gid) {
      issues.push(`static_sprite '${object.name}' requires a tile GID`);
      continue;
    }
    const image = imageForGid(object.gid);
    if (!image) continue;
    const unsigned = object.gid >>> 0;
    staticObjects.push({
      id: object.name,
      layer: "Static Objects Below Members",
      image,
      x: object.x,
      y: object.y,
      ...(object.width !== undefined ? { width: object.width } : {}),
      ...(object.height !== undefined ? { height: object.height } : {}),
      flipHorizontal: !!(unsigned & FLIPPED_HORIZONTALLY),
      flipVertical: !!(unsigned & FLIPPED_VERTICALLY),
      flipDiagonal: !!(unsigned & FLIPPED_DIAGONALLY),
      anchor: "bottom-left",
    });
  }
  assertUnique(
    staticObjects.map((object) => object.id),
    "static object",
    issues,
  );

  const locations = typed("Locations", "location").map<AuthoredLocation>(
    (object) => ({
      id: object.name as AuthoredLocationId,
      label: propertyString(object, "qeLabel", issues),
      x: object.x,
      y: object.y,
    }),
  );
  assertUnique(
    locations.map((location) => location.id),
    "location",
    issues,
  );
  for (const required of REQUIRED_LOCATION_IDS)
    if (!locations.some((location) => location.id === required))
      issues.push(
        `Required location '${required}' is missing from the Locations layer. Undo the deletion in Tiled or copy it from ${AUTHORING_REFERENCE}.`,
      );
  for (const location of locations) {
    if (!REQUIRED_LOCATION_IDS.includes(location.id)) {
      issues.push(`unknown semantic location '${location.id}'`);
      continue;
    }
    const expectedLabel = REQUIRED_LOCATION_LABELS[location.id];
    if (location.label !== expectedLabel)
      issues.push(
        `Location '${location.id}' must use the semantic label '${expectedLabel}'`,
      );
  }

  const interactionRegions = typed(
    "Interaction Regions",
    "interaction_region",
  ).map<AuthoredInteractionRegion>((object) => ({
    id: object.name,
    locationId: propertyString(
      object,
      "qeLocation",
      issues,
    ) as AuthoredLocationId,
    x: object.x,
    y: object.y,
    width: object.width ?? 0,
    height: object.height ?? 0,
    ...(object.polygon
      ? { polygon: object.polygon.map((point) => ({ x: point.x, y: point.y })) }
      : {}),
  }));
  assertUnique(
    interactionRegions.map((region) => region.id),
    "interaction region",
    issues,
  );

  const cameraObjects = typed("Camera Anchors", "camera_anchor");
  const cameraAnchors = cameraObjects.map<AuthoredCameraAnchor>((object) => {
    const zoom = propertyInteger(object, "qeZoom", issues);
    const panelSide = propertyString(object, "qePanelSide", issues);
    if (![1, 2, 3].includes(zoom))
      issues.push(`camera anchor '${object.name}' qeZoom must be 1, 2, or 3`);
    if (!["left", "right"].includes(panelSide))
      issues.push(
        `camera anchor '${object.name}' qePanelSide must be left or right`,
      );
    return {
      id: propertyString(object, "qeLocation", issues) as AuthoredLocationId,
      x: object.x,
      y: object.y,
      zoom: zoom as 1 | 2 | 3,
      panelSide: panelSide as PanelSide,
    };
  });
  assertUnique(
    cameraAnchors.map((anchor) => anchor.id),
    "camera anchor",
    issues,
  );
  const overviewObjects = typed("Camera Anchors", "overview_bounds");
  const functionalTownBoundsObjects = overviewObjects.filter(
    (object) => object.name === "functional-town-bounds",
  );
  if (overviewObjects.length !== 1 || functionalTownBoundsObjects.length !== 1)
    issues.push(
      "Camera Anchors must contain exactly one 'functional-town-bounds' overview_bounds object",
    );
  const overview = functionalTownBoundsObjects[0];
  const functionalTownBounds: TownRect = overview
    ? {
        x: overview.x,
        y: overview.y,
        width: overview.width ?? 0,
        height: overview.height ?? 0,
      }
    : { ...bounds };

  const variants: WorkstationVariant[] = [
    "desk",
    "bench",
    "general",
    "standing",
  ];
  const workstations = typed(
    "Workstations",
    "workstation",
  ).map<AuthoredWorkstation>((object) => {
    const variant = propertyString(object, "qeVariant", issues);
    if (!variants.includes(variant as WorkstationVariant))
      issues.push(
        `workstation '${object.name}' has invalid qeVariant '${variant}'`,
      );
    return {
      id: object.name,
      group: propertyString(object, "qeGroup", issues),
      variant: variant as WorkstationVariant,
      x: object.x,
      y: object.y,
    };
  });
  assertUnique(
    workstations.map((station) => station.id),
    "workstation",
    issues,
  );

  const memberHomes = typed(
    "Member Homes",
    "member_home",
  ).map<AuthoredMemberHome>((object) => ({
    id: object.name,
    group: propertyString(object, "qeGroup", issues),
    x: object.x,
    y: object.y,
  }));
  assertUnique(
    memberHomes.map((home) => home.id),
    "Member home",
    issues,
  );

  const crewLayerNames = [
    "Crew Entrances",
    "Crew Navigation",
    "Crew Activity Zones",
  ] as const;
  const presentCrewLayers = crewLayerNames.filter((name) =>
    objectLayers.has(name),
  );
  const crewEnabled = presentCrewLayers.length > 0;
  if (crewEnabled && presentCrewLayers.length !== crewLayerNames.length)
    issues.push(
      `Crew navigation authoring is incomplete. Add object layers: ${crewLayerNames
        .filter((name) => !objectLayers.has(name))
        .join(", ")}.`,
    );

  const crewSpawns = typed(
    "Crew Entrances",
    "crew_spawn",
  ).map<AuthoredCrewSpawn>((object) => {
    if (!object.point)
      issues.push(`crew_spawn '${object.name}' must be a point object`);
    return { id: object.name, x: object.x, y: object.y };
  });
  assertUnique(
    crewSpawns.map((spawn) => spawn.id),
    "crew spawn",
    issues,
  );

  const crewRoutes = typed(
    "Crew Navigation",
    "crew_route",
  ).map<AuthoredCrewRoute>((object) => {
    const points = (object.polyline ?? []).map((point) => ({
      x: object.x + point.x,
      y: object.y + point.y,
    }));
    if (points.length < 2)
      issues.push(
        `crew_route '${object.name}' requires a polyline with at least two vertices`,
      );
    if (
      points.some(
        (point, index) =>
          index > 0 &&
          Math.hypot(
            point.x - (points[index - 1]?.x ?? point.x),
            point.y - (points[index - 1]?.y ?? point.y),
          ) <= CREW_ROUTE_CONNECTION_TOLERANCE,
      )
    )
      issues.push(
        `crew_route '${object.name}' contains a segment at or below the ${CREW_ROUTE_CONNECTION_TOLERANCE}-pixel connection tolerance`,
      );
    return { id: object.name, points };
  });
  assertUnique(
    crewRoutes.map((route) => route.id),
    "crew route",
    issues,
  );

  const crewActivities = typed(
    "Crew Activity Zones",
    "crew_activity",
  ).map<AuthoredCrewActivity>((object) => {
    const activity = propertyString(object, "qeActivity", issues);
    if (!CREW_ACTIVITY_CATEGORIES.includes(activity as CrewActivityCategory))
      issues.push(
        `crew_activity '${object.name}' has unknown qeActivity '${activity}'. Use ${CREW_ACTIVITY_CATEGORIES.join(", ")}.`,
      );
    const point = object.point === true;
    const width = object.width ?? 0;
    const height = object.height ?? 0;
    if (!point && (width <= 0 || height <= 0))
      issues.push(
        `crew_activity '${object.name}' must be a point or positive rectangle`,
      );
    return {
      id: object.name,
      activity: activity as CrewActivityCategory,
      shape: point ? "point" : "rectangle",
      x: object.x,
      y: object.y,
      width: point ? 0 : width,
      height: point ? 0 : height,
    };
  });
  assertUnique(
    crewActivities.map((activity) => activity.id),
    "crew activity",
    issues,
  );

  const crewGraph = buildCrewRouteGraph(crewRoutes);
  if (crewEnabled) {
    if (crewSpawns.length === 0)
      issues.push("Crew Entrances requires at least one crew_spawn point.");
    if (crewRoutes.length === 0)
      issues.push("Crew Navigation requires at least one crew_route polyline.");
    if (!crewActivities.some((activity) => activity.activity === "general"))
      issues.push(
        "Crew Activity Zones requires at least one general crew_activity fallback.",
      );
    if (crewGraph.nodes.length > 0 && crewRouteComponents(crewGraph).length > 1)
      issues.push(
        `Crew Navigation routes form disconnected networks. Make route vertices coincide within ${CREW_ROUTE_CONNECTION_TOLERANCE} world pixel.`,
      );
    for (const spawn of crewSpawns) {
      const connection = nearestCrewRouteConnection(spawn, crewGraph);
      if (!connection || connection.distance > CREW_ROUTE_ACCESS_TOLERANCE)
        issues.push(
          `crew_spawn '${spawn.id}' is unreachable; place it within ${CREW_ROUTE_ACCESS_TOLERANCE} world pixels of a crew_route.`,
        );
    }
    for (const activity of crewActivities) {
      const connection = nearestCrewRouteConnection(activity, crewGraph);
      if (!connection || connection.distance > CREW_ROUTE_ACCESS_TOLERANCE)
        issues.push(
          `crew_activity '${activity.id}' is unreachable; place it within ${CREW_ROUTE_ACCESS_TOLERANCE} world pixels of a crew_route.`,
        );
    }
  }

  const ambientZones = typed(
    "Ambient Zones",
    "ambient_zone",
  ).map<AuthoredAmbientZone>((object) => ({
    id: object.name,
    variant: propertyString(object, "qeVariant", issues),
    x: object.x,
    y: object.y,
    width: object.width ?? 0,
    height: object.height ?? 0,
  }));
  assertUnique(
    ambientZones.map((zone) => zone.id),
    "ambient zone",
    issues,
  );

  const animalRoutes = typed(
    "Animal Routes",
    "animal_route",
  ).map<AuthoredAnimalRoute>((object) => ({
    id: object.name,
    variant: propertyString(object, "qeVariant", issues),
    points: (object.polyline ?? []).map((point) => ({
      x: object.x + point.x,
      y: object.y + point.y,
    })),
  }));
  assertUnique(
    animalRoutes.map((route) => route.id),
    "animal route",
    issues,
  );

  const statusAnchors = typed(
    "Status Anchors",
    "status_anchor",
  ).map<AuthoredStatusAnchor>((object) => ({
    id: object.name,
    locationId: propertyString(
      object,
      "qeLocation",
      issues,
    ) as AuthoredLocationId,
    variant: propertyString(object, "qeVariant", issues),
    x: object.x,
    y: object.y,
  }));
  assertUnique(
    statusAnchors.map((anchor) => anchor.id),
    "status anchor",
    issues,
  );

  const reservedSites = typed(
    "Reserved Sites",
    "reserved_site",
  ).map<AuthoredReservedSite>((object) => ({
    id: object.name,
    variant: propertyOptionalString(object, "qeVariant") ?? "reserved",
    x: object.x,
    y: object.y,
    width: object.width ?? 0,
    height: object.height ?? 0,
  }));
  assertUnique(
    reservedSites.map((site) => site.id),
    "reserved site",
    issues,
  );
  const locationIds = new Set(locations.map((location) => location.id));
  for (const reference of [...interactionRegions, ...statusAnchors])
    if (!locationIds.has(reference.locationId))
      issues.push(
        `'${reference.id}' references unknown location '${reference.locationId}'`,
      );
  for (const anchor of cameraAnchors)
    if (!locationIds.has(anchor.id))
      issues.push(
        `camera anchor '${anchor.id}' references an unknown location`,
      );
  for (const location of locations) {
    const matchingRegions = interactionRegions.filter(
      (region) => region.locationId === location.id,
    );
    if (matchingRegions.length === 0)
      issues.push(`Required interaction region '${location.id}' is missing.`);
    else if (matchingRegions.length > 1)
      issues.push(
        `Location '${location.id}' has multiple interaction regions; exactly one is required.`,
      );
    const matchingAnchors = cameraAnchors.filter(
      (anchor) => anchor.id === location.id,
    );
    if (matchingAnchors.length === 0)
      issues.push(`Required camera anchor '${location.id}' is missing.`);
    else if (matchingAnchors.length > 1)
      issues.push(
        `Location '${location.id}' has multiple camera anchors; exactly one is required.`,
      );
  }
  const questBoardStatusAnchors = statusAnchors.filter(
    (anchor) => anchor.locationId === "quest-board",
  );
  if (questBoardStatusAnchors.length === 0)
    issues.push("Required status anchor 'quest-board' is missing.");
  else if (questBoardStatusAnchors.length > 1)
    issues.push(
      "Location 'quest-board' has multiple status anchors; exactly one is required.",
    );
  for (const point of [
    ...locations,
    ...cameraAnchors,
    ...workstations,
    ...memberHomes,
    ...crewSpawns,
    ...statusAnchors,
  ])
    if (!inBounds(point, bounds))
      issues.push(`authored point '${point.id}' lies outside map bounds`);
  for (const region of [
    ...interactionRegions,
    ...crewActivities.filter((activity) => activity.shape === "rectangle"),
    ...ambientZones,
    ...reservedSites,
  ])
    if (
      region.width <= 0 ||
      region.height <= 0 ||
      !rectInBounds(region, bounds)
    )
      issues.push(
        `authored region '${region.id}' must be a positive rectangle inside map bounds`,
      );
  for (const route of animalRoutes)
    if (
      route.points.length < 2 ||
      route.points.some((point) => !inBounds(point, bounds))
    )
      issues.push(
        `animal route '${route.id}' requires at least two in-bounds points`,
      );
  for (const route of crewRoutes)
    if (route.points.some((point) => !inBounds(point, bounds)))
      issues.push(
        `crew_route '${route.id}' contains a point outside map bounds`,
      );
  for (const activity of crewActivities.filter(
    (value) => value.shape === "point",
  ))
    if (!inBounds(activity, bounds))
      issues.push(`authored point '${activity.id}' lies outside map bounds`);
  if (functionalTownBounds.width <= 0 || functionalTownBounds.height <= 0)
    issues.push("functional-town-bounds must have positive dimensions.");
  else if (!rectInBounds(functionalTownBounds, bounds))
    issues.push("functional-town-bounds extends outside the authored map.");

  if (issues.length) throw new TownMapValidationError(issues);
  return {
    schemaVersion: QUEST_ENGINEERING_MAP_VERSION,
    source,
    hash: fnv1a(JSON.stringify(value)),
    tileSize: 16,
    bounds,
    functionalTownBounds,
    tileLayers,
    staticObjects,
    locations,
    interactionRegions,
    cameraAnchors,
    workstations,
    memberHomes,
    crewNavigation: {
      enabled: crewEnabled,
      spawns: crewSpawns,
      routes: crewRoutes,
      activities: crewActivities,
      graph: crewGraph,
    },
    ambientZones,
    animalRoutes,
    statusAnchors,
    reservedSites,
  };
}
