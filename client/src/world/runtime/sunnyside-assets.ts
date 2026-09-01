import type { Texture } from "pixi.js";

export type SunnysideAssetGroup =
  | "terrain"
  | "building"
  | "character"
  | "animal"
  | "effect"
  | "foliage"
  | "prop"
  | "ui";

export interface SunnysideAsset {
  group: SunnysideAssetGroup;
  url: string;
  archive: "Sunnyside World Asset Pack 2.1";
  sourceFile: string;
  rect?: { x: number; y: number; width: number; height: number };
  frames?: number;
  frameDurationMs?: number;
  anchor: readonly [number, number];
  purpose: string;
}

// Keep the runtime subset explicit. The complete authoring library lives in
// assets/sunnyside/imported and must not turn into eager runtime texture URLs.
const modules = import.meta.glob<string>(
  "../../assets/sunnyside/{animals,buildings,characters,effects,foliage,props,terrain,ui}/*.png",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

function url(path: string): string {
  const value = modules[`../../assets/sunnyside/${path}`];
  if (!value) throw new Error(`Missing Sunnyside spike asset: ${path}`);
  return value;
}

const archive = "Sunnyside World Asset Pack 2.1" as const;
const sourceRoot = "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets";

function file(
  group: SunnysideAssetGroup,
  path: string,
  sourceFile: string,
  purpose: string,
  options: Partial<
    Pick<SunnysideAsset, "rect" | "frames" | "frameDurationMs" | "anchor">
  > = {},
): SunnysideAsset {
  return {
    group,
    url: url(path),
    archive,
    sourceFile,
    anchor: options.anchor ?? [0.5, 1],
    purpose,
    ...(options.rect ? { rect: options.rect } : {}),
    ...(options.frames ? { frames: options.frames } : {}),
    ...(options.frameDurationMs
      ? { frameDurationMs: options.frameDurationMs }
      : {}),
  };
}

export const hairStyles = [
  "bowlhair",
  "shorthair",
  "mophair",
  "spikeyhair",
  "curlyhair",
  "longhair",
] as const;
export type HairStyle = (typeof hairStyles)[number];
export type SpikeCharacterAction = "idle" | "walk" | "doing";

const actionSource = {
  idle: "IDLE",
  walk: "WALKING",
  doing: "DOING",
} as const;
const actionFrames = { idle: 9, walk: 8, doing: 8 } as const;

function characterPart(
  action: SpikeCharacterAction,
  part: "base" | HairStyle,
): SunnysideAsset {
  const sourceName =
    action === "walk"
      ? `${part}_walk_strip8.png`
      : action === "doing"
        ? `${part}_doing_strip8.png`
        : `${part}_idle_strip9.png`;
  return file(
    "character",
    `characters/${action}-${part}.png`,
    `${sourceRoot}/Characters/Human/${actionSource[action]}/${sourceName}`,
    `${action} ${part} compositing layer`,
    {
      rect: { x: 0, y: 0, width: 96, height: 64 },
      frames: actionFrames[action],
      frameDurationMs: 75,
      anchor: [0.5, 1],
    },
  );
}

const characterAnimations = Object.fromEntries(
  (["idle", "walk", "doing"] as const).map((action) => [
    action,
    {
      base: characterPart(action, "base"),
      hair: Object.fromEntries(
        hairStyles.map((style) => [style, characterPart(action, style)]),
      ) as Record<HairStyle, SunnysideAsset>,
      frames: actionFrames[action],
    },
  ]),
) as Record<
  SpikeCharacterAction,
  {
    base: SunnysideAsset;
    hair: Record<HairStyle, SunnysideAsset>;
    frames: number;
  }
>;

const gm = "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/sprites";

export const SunnysideAssets = {
  terrain: {
    world: file(
      "terrain",
      "terrain/world-16px.png",
      `${sourceRoot}/Tileset/spr_tileset_sunnysideworld_16px.png`,
      "16px terrain, path, water, building, and decoration source sheet",
      { anchor: [0, 0] },
    ),
    forest: file(
      "terrain",
      "terrain/forest-32px.png",
      `${sourceRoot}/Tileset/spr_tileset_sunnysideworld_forest_32px.png`,
      "32px forest autotile source sheet",
      { anchor: [0.5, 1] },
    ),
  },
  foliage: {
    roundTree: file(
      "foliage",
      "foliage/tree-round.png",
      `${gm}/spr_deco_tree_01/3be2aa9b-d727-4261-8d25-80e846d3189c.png`,
      "rounded district tree",
    ),
    pineTree: file(
      "foliage",
      "foliage/tree-pine.png",
      `${gm}/spr_deco_tree_02/203e8642-ec7b-4c07-8f7e-dc272e6c2b2e.png`,
      "pine district tree",
    ),
  },
  buildings: {
    guild: file(
      "building",
      "buildings/guild.png",
      "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy + Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png",
      "derived blue Guild Hall facade assembled from the example room tile recipe",
    ),
    forge: file(
      "building",
      "buildings/forge.png",
      "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy + Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png",
      "derived orange Forge facade assembled from the example room tile recipe",
    ),
    tavern: file(
      "building",
      "buildings/tavern.png",
      "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy + Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png",
      "derived red Tavern facade assembled from the example room tile recipe",
    ),
    projects: file(
      "building",
      "buildings/projects.png",
      "Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy + Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png",
      "derived green Projects gatehouse assembled from the example room tile recipe",
    ),
  },
  characters: characterAnimations,
  animals: {
    bird: file(
      "animal",
      "animals/bird_01_strip4.png",
      `${sourceRoot}/Elements/Animals/spr_deco_bird_01_strip4.png`,
      "ambient bird",
      {
        rect: { x: 0, y: 0, width: 16, height: 16 },
        frames: 4,
        frameDurationMs: 125,
      },
    ),
    chicken: file(
      "animal",
      "animals/chicken_01_strip4.png",
      `${sourceRoot}/Elements/Animals/spr_deco_chicken_01_strip4.png`,
      "ambient chicken",
      {
        rect: { x: 0, y: 0, width: 32, height: 32 },
        frames: 4,
        frameDurationMs: 180,
      },
    ),
    duck: file(
      "animal",
      "animals/duck_01_strip4.png",
      `${sourceRoot}/Elements/Animals/spr_deco_duck_01_strip4.png`,
      "ambient pond duck",
      {
        rect: { x: 0, y: 0, width: 16, height: 16 },
        frames: 4,
        frameDurationMs: 180,
      },
    ),
  },
  effects: {
    smoke: file(
      "effect",
      "effects/chimney-smoke-strip30.png",
      `${sourceRoot}/Elements/VFX/Chimney Smoke/chimneysmoke_03_strip30.png`,
      "ambient chimney smoke",
      {
        rect: { x: 0, y: 0, width: 18, height: 21 },
        frames: 30,
        frameDurationMs: 75,
      },
    ),
    fire: file(
      "effect",
      "effects/fire-strip4.png",
      `${sourceRoot}/Elements/VFX/Fire/spr_deco_fire_01_strip4.png`,
      "Forge fire",
      {
        rect: { x: 0, y: 0, width: 5, height: 10 },
        frames: 4,
        frameDurationMs: 120,
      },
    ),
    glint: file(
      "effect",
      "effects/glint-strip6.png",
      `${sourceRoot}/Elements/VFX/Glint/spr_deco_glint_01_strip6.png`,
      "restrained completion/environment glint",
      {
        rect: { x: 0, y: 0, width: 7, height: 7 },
        frames: 6,
        frameDurationMs: 120,
      },
    ),
  },
  props: {
    anvil: file(
      "prop",
      "props/anvil.png",
      `${gm}/spr_deco_anvil/57ceffeb-4f94-4e27-bb37-7b4d7f393dbf.png`,
      "Forge anvil",
    ),
    barrel: file(
      "prop",
      "props/barrel.png",
      `${gm}/spr_deco_barrel_closed/b4310058-6dec-4d35-8a31-9e73bf28de81.png`,
      "storage barrel",
    ),
    barrelSwords: file(
      "prop",
      "props/barrel-swords.png",
      `${gm}/spr_deco_barrel_swords/32e8bdd4-0a9c-4c60-95b6-668dfd3cf8fa.png`,
      "Forge tool barrel",
    ),
    crate: file(
      "prop",
      "props/crate.png",
      `${gm}/spr_deco_crate_01/658157b4-7ff5-452e-9e1d-c4cad561928b.png`,
      "storage crate",
    ),
    crateAlt: file(
      "prop",
      "props/crate-alt.png",
      `${gm}/spr_deco_crate_02/d9ac3d57-03c4-4730-98eb-600ee4457ee2.png`,
      "alternate storage crate",
    ),
    well: file(
      "prop",
      "props/well.png",
      `${gm}/spr_deco_well_covered/28ee3935-0d63-4141-b01a-2338fa50e040.png`,
      "town-square well",
    ),
    minecart: file(
      "prop",
      "props/minecart.png",
      `${gm}/spr_deco_minecart/93e55657-819e-4c24-b31d-1eee61932f2c.png`,
      "Forge cart",
    ),
    chest: file(
      "prop",
      "props/chest.png",
      `${gm}/spr_deco_chest_01_closed/496b079e-4729-46a2-8b47-cff42b294c71.png`,
      "Projects storage",
    ),
    chair: file(
      "prop",
      "props/chair.png",
      `${gm}/spr_deco_chair_01/feef7d7c-b629-41cb-8196-d20519255aba.png`,
      "Tavern seating",
    ),
    sideTable: file(
      "prop",
      "props/side-table.png",
      `${gm}/spr_deco_sidetable_01/e6e599b0-3edb-47fe-95cc-6aa5a7510470.png`,
      "work table",
    ),
    oreCoal: file(
      "prop",
      "props/ore-coal.png",
      `${gm}/spr_deco_ore_coal/d341ef0a-1c5d-43e8-9668-89fc3dc15dca.png`,
      "Forge ore",
    ),
    oreStone: file(
      "prop",
      "props/ore-stone.png",
      `${gm}/spr_deco_ore_stone/78f8c46b-7de9-43aa-95f7-4d8433071827.png`,
      "Forge ore",
    ),
    bucket: file(
      "prop",
      "props/bucket.png",
      `${gm}/spr_deco_bucket/ab70be7f-a053-4a5a-935d-832e8974d477.png`,
      "yard prop",
    ),
    beam: file(
      "prop",
      "props/beam.png",
      `${gm}/spr_deco_beam/12bd53e7-32e4-4a56-9cbe-87d03fc99557.png`,
      "work bench material",
    ),
    flowers: file(
      "prop",
      "props/flowers.png",
      `${gm}/spr_deco_flowers_house_01/36388643-e82c-4037-97b4-3d1fa4cb65fb.png`,
      "district flowers",
    ),
    trough: file(
      "prop",
      "props/trough.png",
      `${gm}/spr_deco_trough/e83dc18e-a89c-4aae-999e-4531c1c9bb02.png`,
      "ambient animal trough",
    ),
  },
  ui: {
    alerted: file(
      "ui",
      "ui/expression_alerted.png",
      `${sourceRoot}/UI/expression_alerted.png`,
      "review notification",
      { anchor: [0.5, 0.5] },
    ),
    confused: file(
      "ui",
      "ui/expression_confused.png",
      `${sourceRoot}/UI/expression_confused.png`,
      "uncertainty marker",
      { anchor: [0.5, 0.5] },
    ),
    working: file(
      "ui",
      "ui/expression_working.png",
      `${sourceRoot}/UI/expression_working.png`,
      "working marker",
      { anchor: [0.5, 0.5] },
    ),
    plan: file(
      "ui",
      "ui/plan-alt.png",
      `${sourceRoot}/UI/plan alt.png`,
      "work-order notice",
      { anchor: [0.5, 0.5] },
    ),
  },
} as const;

export type LoadedSunnysideTextures = Map<string, Texture>;

export function allRuntimeAssets(): SunnysideAsset[] {
  const values: SunnysideAsset[] = [
    SunnysideAssets.terrain.world,
    SunnysideAssets.terrain.forest,
    ...Object.values(SunnysideAssets.foliage),
    ...Object.values(SunnysideAssets.buildings),
    ...Object.values(SunnysideAssets.animals),
    ...Object.values(SunnysideAssets.effects),
    ...Object.values(SunnysideAssets.props),
    ...Object.values(SunnysideAssets.ui),
  ];
  for (const action of Object.values(SunnysideAssets.characters)) {
    values.push(action.base, ...Object.values(action.hair));
  }
  return values;
}
