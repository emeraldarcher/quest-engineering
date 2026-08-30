import type { BuildingId } from "../state/app-store";

export const SOURCE_TILE = 8;
export const TOWN_TILES = { width: 88, height: 56 } as const;
export const TOWN_SIZE = {
  width: TOWN_TILES.width * SOURCE_TILE,
  height: TOWN_TILES.height * SOURCE_TILE,
} as const;

export interface TownBuilding {
  id: BuildingId;
  label: string;
  functionLabel: string;
  x: number;
  y: number;
  roof: "orange" | "blue" | "thatch";
  width: number;
  height: number;
}

export const townBuildings: TownBuilding[] = [
  {
    id: "gatehouse",
    label: "Projects",
    functionLabel: "Projects and repositories",
    x: 104,
    y: 190,
    roof: "blue",
    width: 56,
    height: 48,
  },
  {
    id: "guild",
    label: "Guild Hall",
    functionLabel: "Classes",
    x: 280,
    y: 108,
    roof: "thatch",
    width: 64,
    height: 52,
  },
  {
    id: "blacksmith",
    label: "Forge",
    functionLabel: "Loadouts",
    x: 470,
    y: 124,
    roof: "orange",
    width: 56,
    height: 48,
  },
  {
    id: "tavern",
    label: "Tavern",
    functionLabel: "Squads",
    x: 168,
    y: 322,
    roof: "orange",
    width: 64,
    height: 52,
  },
  {
    id: "quest-board",
    label: "Quest Board",
    functionLabel: "Quests and delivery",
    x: 328,
    y: 232,
    roof: "thatch",
    width: 48,
    height: 40,
  },
  {
    id: "work-area",
    label: "Work Yard",
    functionLabel: "Selected Run execution",
    x: 360,
    y: 326,
    roof: "blue",
    width: 88,
    height: 64,
  },
];

export const futureWarRoom = {
  label: "Future command site",
  x: 604,
  y: 204,
  width: 72,
  height: 56,
} as const;

export const workSites = [
  { x: 296, y: 286, kind: "table" },
  { x: 320, y: 286, kind: "bench" },
  { x: 344, y: 286, kind: "table" },
  { x: 368, y: 286, kind: "bench" },
  { x: 296, y: 316, kind: "pad" },
  { x: 320, y: 316, kind: "table" },
  { x: 344, y: 316, kind: "pad" },
  { x: 368, y: 316, kind: "table" },
  { x: 308, y: 346, kind: "trestle" },
  { x: 356, y: 346, kind: "trestle" },
] as const;

export const idleHomes = [
  { x: 208, y: 258 },
  { x: 232, y: 266 },
  { x: 256, y: 258 },
  { x: 280, y: 270 },
  { x: 208, y: 294 },
  { x: 234, y: 304 },
  { x: 260, y: 296 },
  { x: 282, y: 310 },
  { x: 214, y: 330 },
  { x: 240, y: 340 },
  { x: 266, y: 334 },
  { x: 288, y: 350 },
] as const;
