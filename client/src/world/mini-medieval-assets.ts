import animalsUrl from "../assets/mini-medieval/base-2.4.1/Animals.png";
import miscUrl from "../assets/mini-medieval/base-2.4.1/Misc.png";
import overworldUrl from "../assets/mini-medieval/base-2.4.1/Overworld.png";
import structuresUrl from "../assets/mini-medieval/base-2.4.1/Structures.png";
import unitsUrl from "../assets/mini-medieval/base-2.4.1/Units.png";
import furnitureUrl from "../assets/mini-medieval/kingdom-interior-1.2/Furniture.png";
import interiorUnitsUrl from "../assets/mini-medieval/kingdom-interior-1.2/Units.png";
import uiBannersUrl from "../assets/mini-medieval/ui-1.1/Banners.png";
import uiIconsUrl from "../assets/mini-medieval/ui-1.1/Icons.png";

export type MiniMedievalSheet =
  | "overworld"
  | "structures"
  | "units"
  | "animals"
  | "misc"
  | "furniture"
  | "interiorUnits"
  | "uiIcons"
  | "uiBanners";

export interface MiniMedievalFrame {
  sheet: MiniMedievalSheet;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor?: readonly [number, number];
  source: string;
}

export const miniMedievalSheets: Record<MiniMedievalSheet, string> = {
  overworld: overworldUrl,
  structures: structuresUrl,
  units: unitsUrl,
  animals: animalsUrl,
  misc: miscUrl,
  furniture: furnitureUrl,
  interiorUnits: interiorUnitsUrl,
  uiIcons: uiIconsUrl,
  uiBanners: uiBannersUrl,
};

const base = "Mini Medieval 2.4.1";
const interior = "Mini Medieval Kingdom Interior 1.2";
const ui = "Mini Medieval User Interface 1.1";

/**
 * Coordinates refer to the original documented PNGs distributed by VEXED.
 * Source sheets are intentionally used directly; no generated atlas exists.
 */
export const miniMedievalFrames = {
  terrain: {
    grass: {
      sheet: "overworld",
      x: 8,
      y: 8,
      width: 8,
      height: 8,
      source: base,
    },
    grassFlowers: {
      sheet: "overworld",
      x: 40,
      y: 8,
      width: 8,
      height: 8,
      source: base,
    },
    path: {
      sheet: "overworld",
      x: 8,
      y: 56,
      width: 8,
      height: 8,
      source: base,
    },
    water: {
      sheet: "overworld",
      x: 8,
      y: 152,
      width: 8,
      height: 8,
      source: base,
    },
    treeRound: {
      sheet: "overworld",
      x: 8,
      y: 528,
      width: 24,
      height: 24,
      anchor: [0.5, 1],
      source: base,
    },
    treePine: {
      sheet: "overworld",
      x: 8,
      y: 744,
      width: 24,
      height: 32,
      anchor: [0.5, 1],
      source: base,
    },
    bush: {
      sheet: "overworld",
      x: 8,
      y: 864,
      width: 16,
      height: 16,
      anchor: [0.5, 1],
      source: base,
    },
  },
  buildings: {
    roofOrange: {
      sheet: "structures",
      x: 8,
      y: 96,
      width: 48,
      height: 32,
      anchor: [0.5, 1],
      source: base,
    },
    roofBlue: {
      sheet: "structures",
      x: 8,
      y: 56,
      width: 48,
      height: 32,
      anchor: [0.5, 1],
      source: base,
    },
    roofThatch: {
      sheet: "structures",
      x: 8,
      y: 8,
      width: 48,
      height: 32,
      anchor: [0.5, 1],
      source: base,
    },
    wallStone: {
      sheet: "structures",
      x: 8,
      y: 240,
      width: 16,
      height: 16,
      source: base,
    },
    wallTimber: {
      sheet: "structures",
      x: 72,
      y: 240,
      width: 16,
      height: 16,
      source: base,
    },
    doorOrange: {
      sheet: "structures",
      x: 8,
      y: 352,
      width: 8,
      height: 16,
      anchor: [0.5, 1],
      source: base,
    },
    doorBlue: {
      sheet: "structures",
      x: 104,
      y: 352,
      width: 8,
      height: 16,
      anchor: [0.5, 1],
      source: base,
    },
  },
  units: {
    idle: [8, 16, 24, 32, 40, 48, 56, 64].map((y) => ({
      sheet: "units" as const,
      x: 8,
      y,
      width: 8,
      height: 8,
      anchor: [0.5, 1] as const,
      source: base,
    })),
    run: [80, 88, 96, 104].map((x) => ({
      sheet: "units" as const,
      x,
      y: 16,
      width: 8,
      height: 8,
      anchor: [0.5, 1] as const,
      source: base,
    })),
    work: [0, 8, 16, 24].map((x) => ({
      sheet: "interiorUnits" as const,
      x,
      y: 56,
      width: 8,
      height: 8,
      anchor: [0.5, 1] as const,
      source: interior,
    })),
  },
  animals: {
    chickenIdle: [96, 104].map((x) => ({
      sheet: "animals" as const,
      x,
      y: 32,
      width: 8,
      height: 8,
      anchor: [0.5, 1] as const,
      source: base,
    })),
    chickenWalk: [176, 184, 192, 200].map((x) => ({
      sheet: "animals" as const,
      x,
      y: 32,
      width: 8,
      height: 8,
      anchor: [0.5, 1] as const,
      source: base,
    })),
  },
  props: {
    sign: {
      sheet: "misc",
      x: 8,
      y: 264,
      width: 8,
      height: 8,
      anchor: [0.5, 1],
      source: base,
    },
    chest: {
      sheet: "misc",
      x: 8,
      y: 240,
      width: 16,
      height: 8,
      anchor: [0.5, 1],
      source: base,
    },
    storage: {
      sheet: "misc",
      x: 8,
      y: 296,
      width: 8,
      height: 8,
      anchor: [0.5, 1],
      source: base,
    },
    anvil: {
      sheet: "misc",
      x: 8,
      y: 352,
      width: 8,
      height: 8,
      anchor: [0.5, 1],
      source: base,
    },
    lantern: {
      sheet: "misc",
      x: 104,
      y: 384,
      width: 8,
      height: 8,
      anchor: [0.5, 1],
      source: base,
    },
    flag: {
      sheet: "misc",
      x: 8,
      y: 128,
      width: 16,
      height: 16,
      anchor: [0.5, 1],
      source: base,
    },
    table: {
      sheet: "furniture",
      x: 8,
      y: 232,
      width: 16,
      height: 16,
      anchor: [0.5, 1],
      source: interior,
    },
  },
  overlays: {
    review: { sheet: "uiIcons", x: 8, y: 336, width: 8, height: 8, source: ui },
    banner: {
      sheet: "uiBanners",
      x: 8,
      y: 8,
      width: 16,
      height: 16,
      source: ui,
    },
  },
} satisfies Record<
  string,
  Record<string, MiniMedievalFrame | MiniMedievalFrame[]>
>;

export type MiniMedievalSemanticFrame = MiniMedievalFrame;
