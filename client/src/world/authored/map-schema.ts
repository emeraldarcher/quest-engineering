export const QUEST_ENGINEERING_MAP_VERSION = 1;
export const REQUIRED_LOCATION_IDS = [
  "gatehouse",
  "guild",
  "blacksmith",
  "tavern",
  "quest-board",
  "work-area",
] as const;
export type AuthoredLocationId = (typeof REQUIRED_LOCATION_IDS)[number];
export const REQUIRED_LOCATION_LABELS: Record<AuthoredLocationId, string> = {
  gatehouse: "Projects",
  guild: "Guild Hall",
  blacksmith: "Forge",
  tavern: "Tavern",
  "quest-board": "Quest Board",
  "work-area": "Work Yard",
};
export type PanelSide = "left" | "right";
export type WorkstationVariant = "desk" | "bench" | "general" | "standing";

export interface TownPoint {
  x: number;
  y: number;
}

export interface TownRect extends TownPoint {
  width: number;
  height: number;
}

export interface AuthoredImageTile {
  tileset: string;
  localId: number;
  url: string;
  source: string;
  sourceWidth: number;
  sourceHeight: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  imageWidth: number;
  imageHeight: number;
  collectionImage?: boolean;
}

export interface AuthoredTilePlacement extends TownPoint {
  id: string;
  layer: string;
  image: AuthoredImageTile;
  flipHorizontal: boolean;
  flipVertical: boolean;
  flipDiagonal: boolean;
  width?: number;
  height?: number;
  anchor: "top-left" | "bottom-left";
}

export interface AuthoredTileLayer {
  name: string;
  foreground: boolean;
  tiles: AuthoredTilePlacement[];
}

export interface AuthoredLocation extends TownPoint {
  id: AuthoredLocationId;
  label: string;
}

export interface AuthoredInteractionRegion {
  id: string;
  locationId: AuthoredLocationId;
  x: number;
  y: number;
  width: number;
  height: number;
  polygon?: TownPoint[];
}

export interface AuthoredCameraAnchor extends TownPoint {
  id: AuthoredLocationId;
  zoom: 1 | 2 | 3;
  panelSide: PanelSide;
}

export interface AuthoredWorkstation extends TownPoint {
  id: string;
  group: string;
  variant: WorkstationVariant;
}

export interface AuthoredMemberHome extends TownPoint {
  id: string;
  group: string;
}

export interface AuthoredAmbientZone extends TownRect {
  id: string;
  variant: string;
}

export interface AuthoredAnimalRoute {
  id: string;
  variant: string;
  points: TownPoint[];
}

export interface AuthoredStatusAnchor extends TownPoint {
  id: string;
  locationId: AuthoredLocationId;
  variant: string;
}

export interface AuthoredReservedSite extends TownRect {
  id: string;
  variant: string;
}

export interface AuthoredTownMap {
  schemaVersion: 1;
  source: string;
  hash: string;
  tileSize: 16;
  bounds: TownRect;
  functionalTownBounds: TownRect;
  tileLayers: AuthoredTileLayer[];
  staticObjects: AuthoredTilePlacement[];
  locations: AuthoredLocation[];
  interactionRegions: AuthoredInteractionRegion[];
  cameraAnchors: AuthoredCameraAnchor[];
  workstations: AuthoredWorkstation[];
  memberHomes: AuthoredMemberHome[];
  ambientZones: AuthoredAmbientZone[];
  animalRoutes: AuthoredAnimalRoute[];
  statusAnchors: AuthoredStatusAnchor[];
  reservedSites: AuthoredReservedSite[];
}
